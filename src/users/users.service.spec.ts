import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { UsersService } from './users.service';

const MOCK_USER: any = { id: 'caller-1', name: 'Caller', email: 'caller@example.com' };

function buildPrismaMock() {
  return {
    user: {
      findMany: jest.fn(),
    },
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe('searchUsers', () => {
    it('should return max 10 results', async () => {
      const users = Array.from({ length: 10 }, (_, i) => ({
        id: `user-${i}`,
        name: `Alice ${i}`,
        email: `alice${i}@example.com`,
        avatar: null,
      }));
      prisma.user.findMany.mockResolvedValue(users);

      const result = await service.searchUsers('ali', MOCK_USER);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
      expect(result).toHaveLength(10);
    });

    it('should throw BadRequestException if q is less than 3 chars', async () => {
      await expect(service.searchUsers('al', MOCK_USER)).rejects.toThrow(BadRequestException);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException for empty string', async () => {
      await expect(service.searchUsers('', MOCK_USER)).rejects.toThrow(BadRequestException);
    });

    it('should search by email and name prefix case-insensitively', async () => {
      prisma.user.findMany.mockResolvedValue([]);

      await service.searchUsers('Ali', MOCK_USER);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { email: { startsWith: 'Ali', mode: 'insensitive' } },
              { name: { startsWith: 'Ali', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('should never return hashedPassword in results', async () => {
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', name: 'Alice', email: 'alice@example.com', avatar: null },
      ]);

      const result = await service.searchUsers('ali', MOCK_USER);

      result.forEach((u: any) => {
        expect(u).not.toHaveProperty('hashedPassword');
      });
      // Verify select excludes hashedPassword
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { id: true, name: true, email: true, avatar: true },
        }),
      );
    });
  });
});
