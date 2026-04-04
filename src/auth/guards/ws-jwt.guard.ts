import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
import { Redis } from 'ioredis';

import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.provider';
import { USER_CACHE_TTL } from '../../@types/constants/constants';

@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient();
    const token: string | undefined = client.handshake.auth?.token;

    if (!token) {
      client.disconnect();
      return false;
    }

    try {
      const payload: { sub: string; email: string } =
        this.jwtService.verify(token);

      const cached = await this.redis.get(`user:${payload.sub}`);
      if (cached) {
        client.data.user = JSON.parse(cached);
        return true;
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user) {
        client.disconnect();
        return false;
      }

      await this.redis.set(
        `user:${payload.sub}`,
        JSON.stringify(user),
        'EX',
        USER_CACHE_TTL,
      );
      client.data.user = user;
      return true;
    } catch (err) {
      this.logger.error(
        `WS auth failed for client ${client.id}: ${err.message}`,
      );
      client.disconnect();
      return false;
    }
  }
}
