import { Server, Socket } from 'socket.io';
import { Redis } from 'ioredis';

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Inject, Logger, UseFilters, UseGuards } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { WsJwtGuard } from '../auth/guards/ws-jwt.guard';
import { RoomMemberGuard } from '../auth/guards/room-member.guard';
import { WsExceptionFilter } from '../common/filters/ws-exception.filter';
import { PresenceService } from './presence.service';
import { AiService } from '../ai/ai.service';
import { MessageType } from '../generated/prisma/enums';
import {
  JoinRoomPayload,
  MessageDeliveredPayload,
  MessagesReadPayload,
  SendMessagePayload,
  SubscribeRoomsPayload,
  TypingPayload,
} from '../@types/interface/chat';

@WebSocketGateway({
  cors: { origin: process.env.NEXT_PUBLIC_APP_URL },
  namespace: '/',
})
@UseFilters(WsExceptionFilter)
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presenceService: PresenceService,
    private readonly aiService: AiService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  afterInit(server: Server) {
    this.presenceService.server = server;
    this.logger.log('ChatGateway initialised');
  }

  async handleConnection(client: Socket) {
    const token: string | undefined = client.handshake.auth?.token;

    if (!token) {
      client.disconnect();
      return;
    }

    this.logger.log(`Client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    const userId: string | undefined = client.data.user?.id;
    if (!userId) return;

    this.logger.log(`Client disconnected: ${client.id} (user: ${userId})`);

    // Mark offline + clean up socket key
    await Promise.all([
      this.presenceService.setOffline(userId),
      this.redis.del(`socket:${userId}`),
    ]);

    // Broadcast user_left to all rooms this socket was in except this users own room
    const rooms = [...client.rooms].filter((r) => r !== client.id);
    for (const roomId of rooms) {
      this.server.to(roomId).emit('user_left', { userId, roomId });
      await this.redis.del(`typing:${roomId}:${userId}`);
    }
  }

  @UseGuards(WsJwtGuard, RoomMemberGuard)
  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinRoomPayload,
  ) {
    const { roomId, lastMessageId } = payload;
    const user = client.data.user;

    client.join(roomId);

    // Store socket mapping + mark online
    await Promise.all([
      this.redis.set(`socket:${user.id}`, client.id, 'EX', 86400),
      this.presenceService.setOnline(user.id),
    ]);

    // Resolve cursor timestamp once — used for both the up-to-date check and the fetch
    let cursorCreatedAt: Date | null = null;
    if (lastMessageId) {
      const cursor = await this.prisma.message.findUnique({
        where: { id: lastMessageId },
        select: { createdAt: true },
      });
      cursorCreatedAt = cursor?.createdAt ?? null;
    }

    // Check if client is already up to date — skip message fetch if so
    let messages: Awaited<ReturnType<typeof this.prisma.message.findMany>> = [];
    if (cursorCreatedAt) {
      const hasNewer = await this.prisma.message.findFirst({
        where: { roomId, createdAt: { gt: cursorCreatedAt } },
        select: { id: true },
      });
      if (hasNewer) {
        // fetch only what's new since the cursor
        messages = await this.prisma.message.findMany({
          where: { roomId, createdAt: { gt: cursorCreatedAt } },
          orderBy: { createdAt: 'asc' },
          take: 200,
          include: { user: { select: { id: true, name: true, avatar: true } } },
        });
      }
      // else: client is up to date, messages stays []
    } else {
      // first visit — fetch last 50
      messages = await this.prisma.message.findMany({
        where: { roomId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { user: { select: { id: true, name: true, avatar: true } } },
      });
      messages.reverse();
    }

    // Members always fetched — needed for presence and member list
    const members = await this.prisma.roomMember.findMany({
      where: { roomId },
      select: {
        userId: true,
        role: true,
        joinedAt: true,
        user: { select: { id: true, name: true, avatar: true } },
      },
    });

    // Presence per member (batch MGET)
    const presenceKeys = members.map((m) => `presence:${m.userId}`);
    const presenceValues =
      presenceKeys.length > 0 ? await this.redis.mget(...presenceKeys) : [];
    const presenceMap = Object.fromEntries(
      members.map((m, i) => [m.userId, presenceValues[i] === 'online']),
    );

    // Unread count for this user in this room
    const membership = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: user.id } },
      select: { joinedAt: true },
    });

    const unreadCount = membership
      ? await this.prisma.message.count({
          where: {
            roomId,
            createdAt: { gt: membership.joinedAt },
            receipts: { none: { userId: user.id, readAt: { not: null } } },
          },
        })
      : 0;

    client.emit('room_snapshot', {
      roomId,
      messages,
      members,
      presence: presenceMap,
      unreadCount,
    });

    // Broadcast to others in room
    client.to(roomId).emit('user_joined', {
      userId: user.id,
      name: user.name,
      roomId,
    });
  }

  @UseGuards(WsJwtGuard, RoomMemberGuard)
  @SubscribeMessage('send_message')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendMessagePayload,
  ) {
    const { roomId, content } = payload;
    const user = client.data.user;

    // Validate
    const trimmed = (content ?? '').replace(/<[^>]*>/g, '').trim(); // remove any html tag
    if (!trimmed || trimmed.length > 4000) {
      throw new WsException('Message must be between 1 and 4000 characters');
    }

    // Persist FIRST — never broadcast before DB write
    let message: Awaited<ReturnType<typeof this.prisma.message.create>>;
    try {
      message = await this.prisma.message.create({
        data: {
          roomId,
          userId: user.id,
          content: trimmed,
          type: MessageType.TEXT,
        },
        include: {
          user: { select: { id: true, name: true, avatar: true } },
        },
      });
    } catch (err) {
      this.logger.error(`send_message DB error for room ${roomId}:`, err);
      client.emit('ephemeral', {
        type: 'error',
        message: 'Failed to send message',
        ttl: 5000,
      });
      return;
    }

    // Clear typing indicator when message is sent
    await this.presenceService.clearTyping(roomId, user.id);

    // Broadcast to room EXCLUDING sender — sender adds optimistically on FE
    client.to(roomId).emit('new_message', message);

    // Siri trigger detection — queue AI response job
    if (/\bsiri\b/i.test(trimmed)) {
      await this.aiService.queueAiResponse({
        roomId,
        messageId: message.id,
        userId: user.id,
        userName: user.name,
        question: trimmed,
        server: this.server,
        client,
      });
    }

    return { status: 'ok', messageId: message.id };
  }

  // ── heartbeat ─────────────────────────────────────────────────────────────────
  // Client sends this every ~20s. We reset the presence TTL only.
  // No DB write. No broadcast. Just keep the Redis key alive.

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket) {
    const user = client.data.user;
    await this.presenceService.setOnline(user.id);
  }

  // ── typing_start ──────────────────────────────────────────────────────────────
  // Client sends this when the user begins typing in a room.
  // Sets a 5s Redis key. Broadcasts typing_update { isTyping: true } to room.
  // Key expires automatically if typing_stop never arrives.

  @UseGuards(WsJwtGuard, RoomMemberGuard)
  @SubscribeMessage('typing_start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TypingPayload,
  ) {
    const user = client.data.user;
    await this.presenceService.setTyping(payload.roomId, user.id, user.name);
  }

  // ── typing_stop ───────────────────────────────────────────────────────────────
  // Client sends this when user stops typing (blur, delete all text, or sends).
  // Deletes the Redis key. Broadcasts typing_update { isTyping: false } to room.

  @UseGuards(WsJwtGuard, RoomMemberGuard)
  @SubscribeMessage('typing_stop')
  async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TypingPayload,
  ) {
    const user = client.data.user;
    await this.presenceService.clearTyping(payload.roomId, user.id);
  }

  // ── subscribe_rooms ───────────────────────────────────────────────────────────
  // Client sends this after reconnect or login to receive room-level events
  // (new_message, user_joined, user_left, room_deleted, room_removed)
  // WITHOUT fetching a snapshot. No DB work beyond auth — just socket.join().

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('subscribe_rooms')
  async handleSubscribeRooms(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SubscribeRoomsPayload,
  ) {
    const { roomIds } = payload;

    // Always register the socket mapping so the user can receive direct events
    // (DM room_pushed, invite notifications) even if they haven't opened any room.
    const user = client.data.user;
    await this.redis.set(`socket:${user.id}`, client.id, 'EX', 86400);

    if (!Array.isArray(roomIds) || roomIds.length === 0) return;
    for (const roomId of roomIds) {
      client.join(roomId);
    }
  }

  // ── Public emit helpers (called by RoomsService) ──────────────────────────────

  /** Emit to every socket currently in a room. */
  emitToRoom(roomId: string, event: string, data: unknown) {
    this.server.to(roomId).emit(event, data);
  }

  /** Emit to a single socket by socketId (looked up from Redis by caller). */
  emitToSocket(socketId: string, event: string, data: unknown) {
    this.server.to(socketId).emit(event, data);
  }

  // ── message_delivered ─────────────────────────────────────────────────────────
  // Client emits this when a message arrives in their UI (not yet read).
  // Tiers by room size to avoid flooding large rooms with receipt noise.

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('message_delivered')
  async handleMessageDelivered(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: MessageDeliveredPayload,
  ) {
    const { messageId } = payload;
    const userId = client.data.user.id;

    // Look up the message to get its room and sender
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        roomId: true,
        userId: true,
        room: { select: { memberCount: true } },
      },
    });
    if (!message || !message.userId) return; // AI messages have no sender

    const memberCount = message.room.memberCount;

    // >= 100 members: no receipts
    if (memberCount >= 100) return;

    // Upsert deliveredAt receipt
    await this.prisma.messageReceipt.upsert({
      where: { messageId_userId: { messageId, userId } },
      create: { messageId, userId, deliveredAt: new Date() },
      update: { deliveredAt: new Date() },
    });

    if (memberCount >= 10) {
      // Debounce: only notify sender once every 3s per message
      const debounceKey = `receipt-debounce:${message.userId}:${messageId}`;
      const alreadyScheduled = await this.redis.set(
        debounceKey,
        '1',
        'EX',
        3,
        'NX',
      );
      if (!alreadyScheduled) return;

      // Schedule the actual emit after 3s
      setTimeout(async () => {
        const senderSocketId = await this.redis.get(`socket:${message.userId}`);
        if (!senderSocketId) return;
        const deliveredCount = await this.prisma.messageReceipt.count({
          where: { messageId, deliveredAt: { not: null } },
        });
        this.server
          .to(senderSocketId)
          .emit('receipt_update', { messageId, deliveredCount });
      }, 3000);
      return;
    }

    // < 10 members: notify sender immediately
    const senderSocketId = await this.redis.get(`socket:${message.userId}`);
    if (!senderSocketId) return;
    const deliveredCount = await this.prisma.messageReceipt.count({
      where: { messageId, deliveredAt: { not: null } },
    });
    this.server
      .to(senderSocketId)
      .emit('receipt_update', { messageId, deliveredCount });
  }

  // ── messages_read ─────────────────────────────────────────────────────────────
  // Client emits this when the user has seen all messages up to upToMessageId.
  // Bulk-marks them as read and notifies each unique sender.

  @UseGuards(WsJwtGuard, RoomMemberGuard)
  @SubscribeMessage('messages_read')
  async handleMessagesRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: MessagesReadPayload,
  ) {
    const { roomId, upToMessageId } = payload;
    const userId = client.data.user.id;

    // Get the cursor message's timestamp
    const cursor = await this.prisma.message.findUnique({
      where: { id: upToMessageId },
      select: { createdAt: true, room: { select: { memberCount: true } } },
    });
    if (!cursor) return;

    const memberCount = cursor.room.memberCount;
    if (memberCount >= 100) return; // no receipts for very large rooms

    // Find all unread messages up to cursor for this room
    const unread = await this.prisma.message.findMany({
      where: {
        roomId,
        createdAt: { lte: cursor.createdAt },
        userId: { not: null }, // skip AI messages
        receipts: { none: { userId, readAt: { not: null } } },
      },
      select: { id: true, userId: true },
    });

    if (unread.length === 0) return;

    const now = new Date();

    // Bulk upsert all receipts in a transaction
    await this.prisma.$transaction(
      unread.map((m) =>
        this.prisma.messageReceipt.upsert({
          where: { messageId_userId: { messageId: m.id, userId } },
          create: { messageId: m.id, userId, deliveredAt: now, readAt: now },
          update: { readAt: now },
        }),
      ),
    );

    if (memberCount >= 10) {
      // Debounce notifications per sender
      const senderIds = [...new Set(unread.map((m) => m.userId as string))];
      for (const senderId of senderIds) {
        const debounceKey = `receipt-debounce:${senderId}:read:${roomId}`;
        const alreadyScheduled = await this.redis.set(
          debounceKey,
          '1',
          'EX',
          3,
          'NX',
        );
        if (alreadyScheduled) {
          const senderIds_copy = senderId; // capture for closure
          setTimeout(async () => {
            const senderSocketId = await this.redis.get(
              `socket:${senderIds_copy}`,
            );
            if (!senderSocketId) return;
            this.server.to(senderSocketId).emit('receipt_update', {
              roomId,
              readBy: userId,
              upToMessageId,
            });
          }, 3000);
        }
      }
      return;
    }

    // < 10 members: notify each sender immediately
    const senderIds = [...new Set(unread.map((m) => m.userId as string))];
    for (const senderId of senderIds) {
      const senderSocketId = await this.redis.get(`socket:${senderId}`);
      if (!senderSocketId) continue;
      this.server.to(senderSocketId).emit('receipt_update', {
        roomId,
        readBy: userId,
        upToMessageId,
      });
    }
  }
}
