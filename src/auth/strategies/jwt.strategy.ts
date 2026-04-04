import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Redis } from 'ioredis';

import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.provider';
import { USER_CACHE_TTL } from '../../@types/constants/constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow('JWT_SECRET'),
    });
  }

  /**
   * @description Validates the JWT payload. Checks Redis cache first; falls back
   *   to PostgreSQL on cache miss and re-caches the result.
   * @param payload - Decoded JWT payload containing sub (userId) and email
   * @returns The user object attached to request.user
   * @throws {UnauthorizedException} when user is not found
   */
  async validate(payload: { sub: string; email: string }) {
    const cached = await this.redis.get(`user:${payload.sub}`);
    if (cached) {
      return JSON.parse(cached);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('Unauthorized');
    }

    await this.redis.set(
      `user:${payload.sub}`,
      JSON.stringify(user),
      'EX',
      USER_CACHE_TTL,
    );
    return user;
  }
}
