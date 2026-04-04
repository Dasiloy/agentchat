import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { PresenceService } from './presence.service';

const ROOM_ID = 'room-1';
const USER_ID = 'user-1';
const USER_NAME = 'Alice';

function buildRedisMock() {
  return {
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn(),
    mget: jest.fn().mockResolvedValue([]),
    keys: jest.fn().mockResolvedValue([]),
  };
}

function buildPrismaMock() {
  return {
    user: { update: jest.fn().mockResolvedValue({}) },
  };
}

describe('PresenceService', () => {
  let service: PresenceService;
  let redis: ReturnType<typeof buildRedisMock>;
  let serverMock: { to: jest.Mock };

  beforeEach(async () => {
    redis = buildRedisMock();
    const prisma = buildPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PresenceService,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get<PresenceService>(PresenceService);

    // inject a mock server so broadcast assertions work
    serverMock = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
    service.server = serverMock as any;
  });

  // ─── setTyping ───────────────────────────────────────────────────────────────

  describe('setTyping', () => {
    it('should set Redis key with 5s TTL', async () => {
      await service.setTyping(ROOM_ID, USER_ID, USER_NAME);

      expect(redis.setex).toHaveBeenCalledWith(
        `typing:${ROOM_ID}:${USER_ID}`,
        5,
        USER_NAME,
      );
    });

    it('should broadcast typing_update with isTyping: true to the room', async () => {
      await service.setTyping(ROOM_ID, USER_ID, USER_NAME);

      expect(serverMock.to).toHaveBeenCalledWith(ROOM_ID);
      expect(serverMock.to(ROOM_ID).emit).toHaveBeenCalledWith(
        'typing_update',
        expect.objectContaining({ isTyping: true, userId: USER_ID }),
      );
    });
  });

  // ─── clearTyping ─────────────────────────────────────────────────────────────

  describe('clearTyping', () => {
    it('should delete the Redis typing key', async () => {
      await service.clearTyping(ROOM_ID, USER_ID);

      expect(redis.del).toHaveBeenCalledWith(`typing:${ROOM_ID}:${USER_ID}`);
    });

    it('should broadcast typing_update with isTyping: false', async () => {
      await service.clearTyping(ROOM_ID, USER_ID);

      expect(serverMock.to).toHaveBeenCalledWith(ROOM_ID);
      expect(serverMock.to(ROOM_ID).emit).toHaveBeenCalledWith(
        'typing_update',
        expect.objectContaining({ isTyping: false, userId: USER_ID }),
      );
    });
  });

  // ─── getPresenceBatch ─────────────────────────────────────────────────────────

  describe('getPresenceBatch', () => {
    it('should return a map of userId → online status', async () => {
      redis.mget.mockResolvedValue(['online', null, 'online']);
      const userIds = ['u1', 'u2', 'u3'];

      const result = await service.getPresenceBatch(userIds);

      expect(result).toEqual({ u1: true, u2: false, u3: true });
    });

    it('should use a single MGET call — never loop individual GETs', async () => {
      redis.mget.mockResolvedValue(['online', 'online']);
      await service.getPresenceBatch(['u1', 'u2']);

      // MGET called once with all keys
      expect(redis.mget).toHaveBeenCalledTimes(1);
      expect(redis.mget).toHaveBeenCalledWith('presence:u1', 'presence:u2');
      // individual GET never called
      expect(redis.get).not.toHaveBeenCalled();
    });

    it('should return empty object for empty input without calling Redis', async () => {
      const result = await service.getPresenceBatch([]);

      expect(result).toEqual({});
      expect(redis.mget).not.toHaveBeenCalled();
    });
  });
});
