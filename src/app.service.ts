import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from './common/prisma/prisma.service';

@Injectable()
export class AppService {
  private logger = new Logger(AppService.name);

  constructor(private readonly prismaService: PrismaService) {}

  /**
   * @description Check if the API Gateway and Database are running correctly
   *
   *
   * @returns {Promise<void>}
   * @throws {ServiceUnavailableException} If the database connection fails
   */
  async getHealth() {
    try {
      await this.prismaService.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error(`Health check failed: ${error.message}`);
      throw new ServiceUnavailableException('Database connection failed');
    }
  }
}
