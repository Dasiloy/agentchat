import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';

import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Inject } from '@nestjs/common';
import { Redis } from 'ioredis';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { AccountProvider } from '../generated/prisma/enums';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponse } from './response/response';

const BCRYPT_ROUNDS = 10;
const USER_CACHE_TTL = 300; // 5 min

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    try {
      const existing = await this.prisma.user.findUnique({
        where: { email: dto.email },
        include: { accounts: { select: { provider: true } } },
      });

      if (existing) {
        const hasSocialAccount = existing.accounts.some(
          (a) => a.provider !== AccountProvider.LOCAL,
        );
        throw new ConflictException(
          hasSocialAccount
            ? 'This email is linked to a Social account.'
            : 'Email already registered',
        );
      }

      const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name,
          hashedPassword,
          accounts: {
            create: {
              provider: AccountProvider.LOCAL,
              providerAccountId: dto.email,
            },
          },
        },
      });

      return this.issueTokens(user.id, user.email);
    } catch (error) {
      this.logger.error('Register error in AuthService:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occured');
    }
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });

      if (!user || !user.hashedPassword) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const passwordMatch = await bcrypt.compare(
        dto.password,
        user.hashedPassword,
      );
      if (!passwordMatch) {
        throw new UnauthorizedException('Invalid credentials');
      }

      await this.redis.set(
        `user:${user.id}`,
        JSON.stringify(user),
        'EX',
        USER_CACHE_TTL,
      );
      return this.issueTokens(user.id, user.email);
    } catch (error) {
      this.logger.error('Login error in AuthService:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occured');
    }
  }

  async googleLogin(user: any): Promise<AuthResponse> {
    try {
      await this.redis.set(
        `user:${user.id}`,
        JSON.stringify(user),
        'EX',
        USER_CACHE_TTL,
      );
      return this.issueTokens(user.id, user.email);
    } catch (error) {
      this.logger.error('Google Login error in AuthService:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occured');
    }
  }

  /**
   * Validates a refresh token, rotates it (delete old session, create new),
   * and returns a fresh token pair.
   */
  async refresh(rawRefreshToken: string): Promise<AuthResponse> {
    // 1. Verify JWT signature + expiry
    let payload: { sub: string; email: string; type: string };
    try {
      payload = this.jwtService.verify(rawRefreshToken, {
        secret: this.configService.getOrThrow('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    // 2. Look up session by token hash
    const tokenHash = this.hashToken(rawRefreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
    });

    if (!session || session.expiresAt < new Date()) {
      // Expired or already rotated — delete stale row if present
      if (session)
        await this.prisma.session.delete({ where: { id: session.id } });
      throw new UnauthorizedException('Refresh token revoked or expired');
    }

    // 3. Rotate: delete old session and issue a fresh pair
    await this.prisma.session.delete({ where: { id: session.id } });
    return this.issueTokens(payload.sub, payload.email);
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        avatar: true,
        createdAt: true,
        name: true,
        updatedAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('Unauthorized');
    return user;
  }

  async logout(userId: string): Promise<void> {
    // Revoke all sessions for this user + clear Redis cache
    await Promise.all([
      this.prisma.session.deleteMany({ where: { userId } }),
      this.redis.del(`user:${userId}`),
    ]);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Issues an access token (1 day) + refresh token (7 days), persists a
   * session row keyed on the refresh token hash, and returns both tokens.
   */
  private async issueTokens(
    userId: string,
    email: string,
  ): Promise<AuthResponse> {
    try {
      const secret = this.configService.getOrThrow('JWT_SECRET');
      const accessExpiry = this.configService.getOrThrow(
        'JWT_SECRET_EXPIRATION',
      );
      const refreshExpiry = this.configService.getOrThrow(
        'JWT_REFRESH_TOKEN_EXPIRATION',
      );

      const accessToken = this.jwtService.sign(
        { sub: userId, email, type: 'access' },
        { secret, expiresIn: accessExpiry },
      );

      const refreshToken = this.jwtService.sign(
        { sub: userId, email, type: 'refresh' },
        { secret, expiresIn: refreshExpiry },
      );

      // Parse expiry to store an absolute datetime in the session row
      const refreshPayload = this.jwtService.decode(refreshToken) as {
        exp: number;
      };
      const expiresAt = new Date(refreshPayload.exp * 1000);

      await this.prisma.session.create({
        data: {
          userId,
          refreshTokenHash: this.hashToken(refreshToken),
          expiresAt,
        },
      });

      return { accessToken, refreshToken };
    } catch (error) {
      throw new InternalServerErrorException('An error occured!'); //hide error reason to prevent token rotation attack
    }
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
