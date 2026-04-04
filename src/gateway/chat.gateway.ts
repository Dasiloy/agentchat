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
import { Server, Socket } from 'socket.io';
import { Redis } from 'ioredis';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { WsJwtGuard } from '../auth/guards/ws-jwt.guard';
import { RoomMemberGuard } from '../auth/guards/room-member.guard';
import { WsExceptionFilter } from '../common/filters/ws-exception.filter';
import { PresenceService } from './presence.service';
import { MessageType } from '../generated/prisma/enums';

// bugs
// add misising socket events to room service => add leave rrom too
// user out of the group does not get that a room has updated message => need lastmessage to shwo with iunread count uipdated
// message should shopw in ui directly on send without waiting => and sending message from a user should not send the message to that same user
// when tab srays inactive for a while, sending message does not go through for sender, apparently message went but no socket connection, for receciver , nothing, then a join room without refresh shows justb that klast message

interface JoinRoomPayload {
  roomId: string;
  lastMessageId?: string; // client's most recent message — skip fetch if already up to date
}

interface SendMessagePayload {
  roomId: string;
  content: string;
}

interface TypingPayload {
  roomId: string;
}

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
    if (!trimmed) {
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

    // Broadcast to entire room (including sender)
    this.server.to(roomId).emit('new_message', message);

    // @ai detection — queued in PROMPT 8
    if (trimmed.toLowerCase().startsWith('@ai')) {
      // TODO (PROMPT 8): AiService.queueAiResponse(roomId, message.id, user.id, trimmed)
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
}
