import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';

import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthService } from './auth.service';

// Decoded JWT payload with exp 7 days from now
const MOCK_DECODED = { sub: 'u1', email: 'a@b.com', type: 'refresh', exp: Math.floor(Date.now() / 1000) + 604800 };

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  session: {
    create: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
  },
};

const mockJwt = {
  sign: jest.fn().mockReturnValue('signed-token'),
  decode: jest.fn().mockReturnValue(MOCK_DECODED),
};
const mockConfig = { getOrThrow: jest.fn().mockReturnValue('test-value') };
const mockRedis = { set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) };

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jest.clearAllMocks();
    mockJwt.sign.mockReturnValue('signed-token');
    mockJwt.decode.mockReturnValue(MOCK_DECODED);
    mockPrisma.session.create.mockResolvedValue({});
  });

  describe('register', () => {
    it('should hash password before saving', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null); // no existing user
      mockPrisma.user.create.mockResolvedValue({ id: 'u1', email: 'a@b.com' });

      await service.register({
        email: 'a@b.com',
        password: 'password123',
        name: 'Alice',
      });

      const createCall = mockPrisma.user.create.mock.calls[0][0];
      const saved = createCall.data.hashedPassword;
      const isHashed = await bcrypt.compare('password123', saved);
      expect(isHashed).toBe(true);
    });

    it('should throw ConflictException if email exists with local account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        accounts: [{ provider: 'LOCAL' }],
      });

      await expect(
        service.register({
          email: 'a@b.com',
          password: 'password123',
          name: 'Alice',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException with Google message if email is Google-only', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        accounts: [{ provider: 'GOOGLE' }],
      });

      await expect(
        service.register({
          email: 'a@b.com',
          password: 'password123',
          name: 'Alice',
        }),
      ).rejects.toThrow('This email is linked to a Social account.');
    });
  });

  describe('login', () => {
    it('should return accessToken on valid credentials', async () => {
      const hashed = await bcrypt.hash('password123', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        hashedPassword: hashed,
      });

      const result = await service.login({
        email: 'a@b.com',
        password: 'password123',
      });
      expect(result.accessToken).toBe('signed-token');
      expect(result.refreshToken).toBe('signed-token');
    });

    it('should throw UnauthorizedException on wrong password', async () => {
      const hashed = await bcrypt.hash('correctpassword', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'a@b.com',
        hashedPassword: hashed,
      });

      await expect(
        service.login({ email: 'a@b.com', password: 'wrongpassword' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
