import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { AI_QUEUE, AI_RESPONSE } from '../@types/constants/queue';
import { QueueAiResponseParams } from '../@types/interface/ai';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @InjectQueue(AI_QUEUE) private readonly aiQueue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async queueAiResponse({
    roomId,
    messageId,
    userId,
    userName,
    question,
    server,
    client,
    tts = false,
  }: QueueAiResponseParams): Promise<string> {
    // Rate limit: max 5 requests per user per minute
    const minuteBucket = Math.floor(Date.now() / 60000).toString();
    const rateKey = `ai-rate:${userId}:${minuteBucket}`;

    const count = await this.redis.incr(rateKey);
    if (count === 1) {
      // Set expiry only on first increment to avoid resetting window
      await this.redis.expire(rateKey, 60);
    }

    if (count > 5) {
      client.emit('ephemeral', {
        type: 'rate_limited',
        message: 'You can only send 5 AI requests per minute',
        ttl: 5000,
      });
      return '';
    }

    // Broadcast ai_thinking to the whole room before queuing
    server.to(roomId).emit('ai_thinking', { triggeredBy: userName });

    // Add job to BullMQ
    const job = await this.aiQueue.add(
      AI_RESPONSE,
      { roomId, messageId, userId, userName, question, tts },
      {
        attempts: 2,
        backoff: { type: 'fixed', delay: 3000 },
      },
    );

    this.logger.log(`AI job queued: ${job.id} for room ${roomId}`);
    return job.id as string;
  }
}
