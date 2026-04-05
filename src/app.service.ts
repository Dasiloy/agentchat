import { Redis } from 'ioredis';

import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from './common/prisma/prisma.service';
import { REDIS_CLIENT } from './common/redis/redis.provider';

@Injectable()
export class AppService {
  private logger = new Logger(AppService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * @description Check if the API Gateway and Database are running correctly
   *
   *
   * @returns {Promise<void>}
   * @throws {ServiceUnavailableException} If the database connection fails
   */
  async getHealth() {
    try {
      const [pgResult, redisResult] = await Promise.allSettled([
        this.prisma.$queryRaw`SELECT 1`,
        this.redis.ping(),
      ]);

      const postgres = pgResult.status === 'fulfilled';
      const redisOk =
        redisResult.status === 'fulfilled' &&
        (redisResult.value as string) === 'PONG';

      const status = postgres && redisOk ? 'ok' : 'degraded';

      if (status === 'degraded') {
        throw new ServiceUnavailableException('Database connection failed');
      }
    } catch (error) {
      this.logger.error(`Health check failed: ${error.message}`);
      throw new ServiceUnavailableException('Database connection failed');
    }
  }
}
