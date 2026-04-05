import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { App } from 'supertest/types';

import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { REDIS_CLIENT } from '../src/common/redis/redis.provider';

const TEST_JWT_SECRET = 'e2e-test-secret';

// ── Shared mocks ───────────────────────────────────────────────────────────
const mockAppService = { getHealth: jest.fn() };
const mockAuthService = {
  register: jest.fn(),
  login: jest.fn(),
  getMe: jest.fn(),
  logout: jest.fn(),
};
const mockPrisma = { user: { findUnique: jest.fn() } };
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
};
const mockConfig = {
  getOrThrow: jest.fn().mockReturnValue(TEST_JWT_SECRET),
  get: jest.fn().mockReturnValue(TEST_JWT_SECRET),
};

// ── Test application ───────────────────────────────────────────────────────
describe('Auth & Health (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
      ],
      controllers: [AppController, AuthController],
      providers: [
        { provide: AppService, useValue: mockAppService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['/health'] });
    await app.init();

    jwtService = moduleFixture.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAppService.getHealth.mockResolvedValue(undefined);
  });

  // ── Health check ────────────────────────────────────────────────────────
  describe('GET /health', () => {
    it('is public and returns 200 with the standard success envelope', async () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect((res) => {
          expect(res.body).toMatchObject({
            success: true,
            statusCode: 200,
          });
        });
    });
  });

  // ── JWT guard ───────────────────────────────────────────────────────────
  describe('GET /api/auth/me', () => {
    it('returns 401 when no Authorization header is sent', async () => {
      return request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });

    it('returns 401 when an invalid/expired token is sent', async () => {
      return request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', 'Bearer not.a.real.token')
        .expect(401);
    });

    it('returns 200 and user data when a valid token is sent', async () => {
      const user = { id: 'u1', email: 'alice@example.com', name: 'Alice' };
      const token = jwtService.sign({ sub: user.id, email: user.email });

      // Redis cache hit — no DB call needed
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(user));
      mockAuthService.getMe.mockResolvedValueOnce(user);

      return request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.data).toMatchObject({ id: user.id, email: user.email });
        });
    });
  });

  // ── Register validation ─────────────────────────────────────────────────
  describe('POST /api/auth/register', () => {
    it('returns 400 when password is too weak (fails IsStrongPassword)', async () => {
      return request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email: 'alice@example.com', password: 'weak', name: 'Alice' })
        .expect(400);
    });

    it('returns 400 when email is missing', async () => {
      return request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ password: '$Strong1!', name: 'Alice' })
        .expect(400);
    });

    it('returns 201 with an accessToken on a valid payload', async () => {
      mockAuthService.register.mockResolvedValueOnce({ accessToken: 'signed-token' });

      return request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email: 'alice@example.com', password: '$Strong1!', name: 'Alice Becca' })
        .expect(201)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.data.accessToken).toBeDefined();
        });
    });

    it('returns 409 when the email is already registered', async () => {
      const { ConflictException } = await import('@nestjs/common');
      mockAuthService.register.mockRejectedValueOnce(
        new ConflictException('Email already registered'),
      );

      return request(app.getHttpServer())
        .post('/api/auth/register')
        .send({ email: 'taken@example.com', password: '$Strong1!', name: 'Alice' })
        .expect(409);
    });
  });

  // ── Login ───────────────────────────────────────────────────────────────
  describe('POST /api/auth/login', () => {
    it('returns 200 with an accessToken on valid credentials', async () => {
      mockAuthService.login.mockResolvedValueOnce({ accessToken: 'signed-token' });

      return request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: '$Strong1!' })
        .expect(200)
        .expect((res) => {
          expect(res.body.success).toBe(true);
          expect(res.body.data.accessToken).toBeDefined();
        });
    });

    it('returns 401 on wrong credentials', async () => {
      mockAuthService.login.mockRejectedValueOnce(
        new UnauthorizedException('Invalid credentials'),
      );

      return request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'WrongPass1!' })
        .expect(401);
    });
  });
});
