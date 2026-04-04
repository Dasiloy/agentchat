import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';

import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaClient } from '../../generated/prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly configService: ConfigService) {
    const adapter = new PrismaNeon({
      connectionString: configService.getOrThrow('DATABASE_URL'!),
    });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }
}
