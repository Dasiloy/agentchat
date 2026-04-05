import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { User } from '../generated/prisma/client';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Search users by email prefix or name prefix (case-insensitive).
   * Returns at most 10 results. Never exposes hashedPassword.
   */
  async searchUsers(searchTerm: string, user: User) {
    if (!searchTerm || searchTerm.trim().length < 3) {
      throw new BadRequestException('Search query must be at least 3 characters');
    }
    try {
      const users = await this.prisma.user.findMany({
        where: {
          id: { not: user.id },
          OR: [
            { email: { startsWith: searchTerm, mode: 'insensitive' } },
            { name: { startsWith: searchTerm, mode: 'insensitive' } },
          ],
        },
        select: { id: true, name: true, email: true, avatar: true },
        take: 10,
      });

      return users;
    } catch (error) {
      this.logger.log('Error in searchUsers', error);
      throw new InternalServerErrorException('An error occured');
    }
  }
}
