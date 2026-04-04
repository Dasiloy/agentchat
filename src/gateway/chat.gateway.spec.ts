import { Test, TestingModule } from '@nestjs/testing';
import { WsException } from '@nestjs/websockets';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { ChatGateway } from './chat.gateway';
import { PresenceService } from './presence.service';
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
      ],
    }).compile();

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
      // broadcast happened after
      expect((gateway as any).server.to).toHaveBeenCalledWith(ROOM_ID);
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
