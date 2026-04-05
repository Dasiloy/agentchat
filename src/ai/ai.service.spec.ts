import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';

import { AiService } from './ai.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { AI_QUEUE } from '../@types/constants/queue';

function buildRedisMock() {
  return {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };
}

function buildQueueMock() {
  return {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  };
}

function buildServerMock() {
  return {
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  };
}

function buildClientMock() {
  return {
    emit: jest.fn(),
  };
}

const ROOM_ID = 'room-1';
const USER_ID = 'user-1';
const MESSAGE_ID = 'msg-1';
const USER_NAME = 'Alice';
const QUESTION = '@ai what is NestJS?';

describe('AiService', () => {
  let service: AiService;
  let redis: ReturnType<typeof buildRedisMock>;
  let queue: ReturnType<typeof buildQueueMock>;

  beforeEach(async () => {
    redis = buildRedisMock();
    queue = buildQueueMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: getQueueToken(AI_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  describe('queueAiResponse', () => {
    it('should add job to BullMQ queue', async () => {
      const server = buildServerMock();
      const client = buildClientMock();

      await service.queueAiResponse({
        roomId: ROOM_ID,
        messageId: MESSAGE_ID,
        userId: USER_ID,
        userName: USER_NAME,
        question: QUESTION,
        server: server as any,
        client: client as any,
      });

      expect(queue.add).toHaveBeenCalledWith(
        'ai-response',
        expect.objectContaining({ roomId: ROOM_ID, messageId: MESSAGE_ID, userId: USER_ID, question: QUESTION }),
        expect.objectContaining({ attempts: 2, backoff: { type: 'fixed', delay: 3000 } }),
      );
    });

    it('should broadcast ai_thinking to room before returning', async () => {
      const server = buildServerMock();
      const client = buildClientMock();

      await service.queueAiResponse({
        roomId: ROOM_ID,
        messageId: MESSAGE_ID,
        userId: USER_ID,
        userName: USER_NAME,
        question: QUESTION,
        server: server as any,
        client: client as any,
      });

      expect(server.to).toHaveBeenCalledWith(ROOM_ID);
      expect(server.to(ROOM_ID).emit).toHaveBeenCalledWith(
        'ai_thinking',
        { triggeredBy: USER_NAME },
      );
    });

    it('should emit ephemeral rate_limited to sender and skip queue on 6th call in same minute', async () => {
      redis.incr.mockResolvedValue(6);
      const server = buildServerMock();
      const client = buildClientMock();

      const jobId = await service.queueAiResponse({
        roomId: ROOM_ID,
        messageId: MESSAGE_ID,
        userId: USER_ID,
        userName: USER_NAME,
        question: QUESTION,
        server: server as any,
        client: client as any,
      });

      expect(client.emit).toHaveBeenCalledWith(
        'ephemeral',
        expect.objectContaining({ type: 'rate_limited' }),
      );
      expect(queue.add).not.toHaveBeenCalled();
      expect(jobId).toBe('');
    });

    it('should set Redis expiry only on first request in the minute', async () => {
      redis.incr.mockResolvedValue(1);
      const server = buildServerMock();
      const client = buildClientMock();

      await service.queueAiResponse({
        roomId: ROOM_ID,
        messageId: MESSAGE_ID,
        userId: USER_ID,
        userName: USER_NAME,
        question: QUESTION,
        server: server as any,
        client: client as any,
      });

      expect(redis.expire).toHaveBeenCalledTimes(1);
    });

    it('should not set Redis expiry on subsequent requests in same minute', async () => {
      redis.incr.mockResolvedValue(3);
      const server = buildServerMock();
      const client = buildClientMock();

      await service.queueAiResponse({
        roomId: ROOM_ID,
        messageId: MESSAGE_ID,
        userId: USER_ID,
        userName: USER_NAME,
        question: QUESTION,
        server: server as any,
        client: client as any,
      });

      expect(redis.expire).not.toHaveBeenCalled();
    });
  });
});
