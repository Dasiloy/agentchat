import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service';
import { redisProvider, REDIS_CLIENT } from './redis/redis.provider';

@Global()
@Module({
  providers: [PrismaService, redisProvider],
  exports: [PrismaService, REDIS_CLIENT],
})
export class CommonModule {}
