import { Test, TestingModule } from '@nestjs/testing';
import { WsException } from '@nestjs/websockets';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';
import { AiService } from '../ai/ai.service';
import { WsJwtGuard } from '../auth/guards/ws-jwt.guard';
import { RoomMemberGuard } from '../auth/guards/room-member.guard';
import { MessageType } from '../generated/prisma/enums';

const ROOM_ID = 'room-1';
const USER_ID = 'user-1';

function makeClient(overrides: Record<string, any> = {}): any {
  return {
    id: 'socket-1',
    data: { user: { id: USER_ID, name: 'Alice', avatar: null } },
    rooms: new Set(['socket-1', ROOM_ID]),
    join: jest.fn(),
    emit: jest.fn(),
    to: jest.fn().mockReturnThis(),
    disconnect: jest.fn(),
    handshake: { auth: { token: 'tok' } },
    ...overrides,
  };
}

function buildPrismaMock() {
  return {
    message: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn(),
    },
    roomMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    messageReceipt: {
      upsert: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
    },
    $transaction: jest.fn().mockImplementation((ops: any[]) => Promise.all(ops)),
  };
}

function buildRedisMock() {
  return {
    set: jest.fn(),
    del: jest.fn(),
    get: jest.fn(),
    mget: jest.fn().mockResolvedValue([]),
  };
}

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let redis: ReturnType<typeof buildRedisMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    redis = buildRedisMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
        {
          provide: PresenceService,
          useValue: {
            setOnline: jest.fn().mockResolvedValue(undefined),
            setOffline: jest.fn().mockResolvedValue(undefined),
            clearTyping: jest.fn().mockResolvedValue(undefined),
            server: null,
          },
        },
        {
          provide: AiService,
          useValue: {
            queueAiResponse: jest.fn().mockResolvedValue('job-1'),
          },
        },
      ],
    })
      .overrideGuard(WsJwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RoomMemberGuard)
      .useValue({ canActivate: () => true })
      .compile();

    gateway = module.get<ChatGateway>(ChatGateway);

    // stub server.to(...).emit(...)
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      emit: jest.fn(),
    };
  });

  // ─── send_message ────────────────────────────────────────────────────────────

  describe('send_message', () => {
    it('should persist to DB before broadcasting', async () => {
      const client = makeClient();
      const savedMessage = { id: 'msg-1', content: 'hello', roomId: ROOM_ID, userId: USER_ID, type: MessageType.TEXT, createdAt: new Date(), user: { id: USER_ID, name: 'Alice', avatar: null } };
      prisma.message.create.mockResolvedValue(savedMessage);

      await gateway.handleSendMessage(client, { roomId: ROOM_ID, content: 'hello' });

      // DB write happened
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ roomId: ROOM_ID, content: 'hello', type: MessageType.TEXT }),
        }),
      );
      // broadcast happened via client.to (excludes sender)
      expect(client.to).toHaveBeenCalledWith(ROOM_ID);
    });

    it('should emit ephemeral error to sender only if DB fails — no broadcast', async () => {
      const client = makeClient();
      prisma.message.create.mockRejectedValue(new Error('DB down'));

      await gateway.handleSendMessage(client, { roomId: ROOM_ID, content: 'hello' });

      expect(client.emit).toHaveBeenCalledWith('ephemeral', expect.objectContaining({ type: 'error' }));
      expect((gateway as any).server.to).not.toHaveBeenCalled();
    });

    it('should throw WsException for empty content', async () => {
      const client = makeClient();

      await expect(
        gateway.handleSendMessage(client, { roomId: ROOM_ID, content: '   ' }),
      ).rejects.toThrow(WsException);

      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('should throw WsException for content exceeding 4000 chars', async () => {
      const client = makeClient();

      await expect(
        gateway.handleSendMessage(client, { roomId: ROOM_ID, content: 'a'.repeat(4001) }),
      ).rejects.toThrow(WsException);

      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('should detect @ai prefix case-insensitively and not crash', async () => {
      const client = makeClient();
      const savedMessage = { id: 'msg-2', content: '@AI what is NestJS?', roomId: ROOM_ID, userId: USER_ID, type: MessageType.TEXT, createdAt: new Date(), user: { id: USER_ID, name: 'Alice', avatar: null } };
      prisma.message.create.mockResolvedValue(savedMessage);

      // should not throw even with @AI prefix (PROMPT 8 wires the actual handler)
      await expect(
        gateway.handleSendMessage(client, { roomId: ROOM_ID, content: '@AI what is NestJS?' }),
      ).resolves.toEqual({ status: 'ok', messageId: 'msg-2' });
    });
  });

  // ─── message_delivered ───────────────────────────────────────────────────────

  describe('message_delivered', () => {
    it('should not emit receipt_update for rooms with >= 100 members', async () => {
      const client = makeClient();
      prisma.message.findUnique.mockResolvedValue({
        roomId: ROOM_ID,
        userId: 'sender-1',
        room: { memberCount: 100 },
      });

      await gateway.handleMessageDelivered(client, { messageId: 'msg-1' });

      expect(prisma.messageReceipt.upsert).not.toHaveBeenCalled();
      expect((gateway as any).server.to).not.toHaveBeenCalled();
    });

    it('should upsert deliveredAt and notify sender immediately for small rooms', async () => {
      const client = makeClient();
      prisma.message.findUnique.mockResolvedValue({
        roomId: ROOM_ID,
        userId: 'sender-1',
        room: { memberCount: 5 },
      });
      prisma.messageReceipt.upsert.mockResolvedValue({});
      prisma.messageReceipt.count.mockResolvedValue(2);
      redis.get.mockResolvedValue('socket-sender-1');

      await gateway.handleMessageDelivered(client, { messageId: 'msg-1' });

      expect(prisma.messageReceipt.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { messageId_userId: { messageId: 'msg-1', userId: USER_ID } },
        }),
      );
      expect(redis.get).toHaveBeenCalledWith('socket:sender-1');
      expect((gateway as any).server.to).toHaveBeenCalledWith('socket-sender-1');
    });
  });

  // ─── messages_read ───────────────────────────────────────────────────────────

  describe('messages_read', () => {
    it('should bulk upsert receipts in one $transaction', async () => {
      const client = makeClient();
      const createdAt = new Date();
      prisma.message.findUnique.mockResolvedValue({
        createdAt,
        room: { memberCount: 5 },
      });
      prisma.message.findMany.mockResolvedValue([
        { id: 'msg-1', userId: 'sender-1' },
        { id: 'msg-2', userId: 'sender-1' },
      ]);
      redis.get.mockResolvedValue(null);

      await gateway.handleMessagesRead(client, { roomId: ROOM_ID, upToMessageId: 'msg-2' });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.messageReceipt.upsert).toHaveBeenCalledTimes(2);
    });

    it('should only notify affected senders, not everyone in the room', async () => {
      const client = makeClient();
      const createdAt = new Date();
      prisma.message.findUnique.mockResolvedValue({
        createdAt,
        room: { memberCount: 3 },
      });
      // Two messages from two different senders
      prisma.message.findMany.mockResolvedValue([
        { id: 'msg-1', userId: 'sender-A' },
        { id: 'msg-2', userId: 'sender-B' },
      ]);
      redis.get
        .mockResolvedValueOnce('socket-A')
        .mockResolvedValueOnce('socket-B');

      await gateway.handleMessagesRead(client, { roomId: ROOM_ID, upToMessageId: 'msg-2' });

      // Only the two unique senders are notified — not the whole room
      expect((gateway as any).server.to).toHaveBeenCalledWith('socket-A');
      expect((gateway as any).server.to).toHaveBeenCalledWith('socket-B');
      expect((gateway as any).server.to).toHaveBeenCalledTimes(2);
    });

    it('should do nothing for rooms with >= 100 members', async () => {
      const client = makeClient();
      prisma.message.findUnique.mockResolvedValue({
        createdAt: new Date(),
        room: { memberCount: 100 },
      });

      await gateway.handleMessagesRead(client, { roomId: ROOM_ID, upToMessageId: 'msg-1' });

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ─── join_room ───────────────────────────────────────────────────────────────

  describe('join_room', () => {
    it('should emit room_snapshot to joining user only', async () => {
      const client = makeClient();
      prisma.message.findMany.mockResolvedValue([]);
      prisma.roomMember.findMany.mockResolvedValue([]);
      prisma.roomMember.findUnique.mockResolvedValue({ joinedAt: new Date() });
      prisma.message.count.mockResolvedValue(0);
      redis.mget.mockResolvedValue([]);

      await gateway.handleJoinRoom(client, { roomId: ROOM_ID });

      // snapshot goes to sender only
      expect(client.emit).toHaveBeenCalledWith('room_snapshot', expect.objectContaining({ roomId: ROOM_ID }));
      // NOT broadcast to the room
      expect((gateway as any).server.to).not.toHaveBeenCalledWith(expect.objectContaining({ roomId: ROOM_ID }));
    });
  });
});
