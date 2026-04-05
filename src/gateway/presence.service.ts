import { Inject, Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { Redis } from 'ioredis';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  // Injected by gateway after server is ready
  server: Server;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Mark user online. Called on heartbeat and on socket connection.
   * SETEX resets the TTL each call — key expires 35s after the LAST heartbeat.
   * 35s > heartbeat interval (20s) so one missed beat is tolerated.
   */
  async setOnline(userId: string): Promise<void> {
    await this.redis.setex(`presence:${userId}`, 35, 'online');
  }

  /**
   * Mark user offline explicitly. Called on clean disconnect.
   * Also writes updatedAt to DB so the user record has a lastSeen timestamp.
   * The key expires naturally via TTL anyway — this just handles clean disconnects.
   */
  async setOffline(userId: string): Promise<void> {
    await Promise.all([
      this.redis.del(`presence:${userId}`),
      this.prisma.user.updateMany({
        where: { id: userId },
        data: { lastSeenAt: new Date() },
      }),
    ]);
  }

  /**
   * Returns true if the user has an active presence key in Redis.
   */
  async isOnline(userId: string): Promise<boolean> {
    const val = await this.redis.get(`presence:${userId}`);
    return val === 'online';
  }

  /**
   * Batch presence check for multiple users — single MGET round trip.
   * Returns a map of userId → true/false.
   * NEVER loop individual GET calls — MGET is O(N) in one round trip.
   */
  async getPresenceBatch(userIds: string[]): Promise<Record<string, boolean>> {
    if (userIds.length === 0) return {};
    const keys = userIds.map((id) => `presence:${id}`);
    const values = await this.redis.mget(...keys);
    return Object.fromEntries(
      userIds.map((id, i) => [id, values[i] === 'online']),
    );
  }

  /**
   * Set a typing indicator for a user in a room.
   * Key expires in 5s — if the client never sends typing_stop (e.g. crashes),
   * the indicator disappears automatically.
   * Broadcasts typing_update to the room so all members see the indicator.
   */
  async setTyping(roomId: string, userId: string, name: string): Promise<void> {
    await this.redis.setex(`typing:${roomId}:${userId}`, 5, name);
    this.server?.to(roomId).emit('typing_update', {
      roomId,
      userId,
      name,
      isTyping: true,
    });
  }

  /**
   * Clear a typing indicator. Called on typing_stop or after message is sent.
   * Broadcasts typing_update with isTyping: false so clients hide the indicator.
   */
  async clearTyping(roomId: string, userId: string): Promise<void> {
    await this.redis.del(`typing:${roomId}:${userId}`);
    this.server?.to(roomId).emit('typing_update', {
      roomId,
      userId,
      isTyping: false,
    });
  }

}
