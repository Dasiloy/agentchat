import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export const redisProvider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis =>
    new Redis(config.getOrThrow('REDIS_URL'), {
      maxRetriesPerRequest: null,
    }),
};
