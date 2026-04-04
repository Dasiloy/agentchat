import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.provider';
import { JwtStrategy } from './jwt.strategy';

const mockPrisma = { user: { findUnique: jest.fn() } };
const mockRedis = { get: jest.fn(), set: jest.fn() };
const mockConfig = { getOrThrow: jest.fn().mockReturnValue('test-secret') };

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
    jest.clearAllMocks();
  });

  it('should return cached user without DB query on cache hit', async () => {
    const user = { id: 'u1', email: 'a@b.com' };
    mockRedis.get.mockResolvedValue(JSON.stringify(user));

    const result = await strategy.validate({ sub: 'u1', email: 'a@b.com' });

    expect(result).toEqual(user);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('should query DB and cache on cache miss', async () => {
    const user = { id: 'u1', email: 'a@b.com' };
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(user);
    mockRedis.set.mockResolvedValue('OK');

    const result = await strategy.validate({ sub: 'u1', email: 'a@b.com' });

    expect(result).toEqual(user);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u1' } });
    expect(mockRedis.set).toHaveBeenCalledWith('user:u1', JSON.stringify(user), 'EX', 300);
  });

  it('should throw UnauthorizedException if user not in DB', async () => {
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      strategy.validate({ sub: 'u1', email: 'a@b.com' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
