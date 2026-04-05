import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { ChatGateway } from '../gateway/chat.gateway';
import { MemberRole, RoomType } from '../generated/prisma/enums';
import { CreateRoomDto } from './dto/create-room.dto';
import { Prisma } from '../generated/prisma/client';

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Creates a new room and registers the caller as OWNER.
   *
   */
  async createRoom(dto: CreateRoomDto, creatorId: string) {
    try {
      return await this.prisma.room.create({
        data: {
          name: dto.name,
          description: dto.description,
          createdBy: creatorId,
          memberCount: 1,
          members: {
            create: { userId: creatorId, role: MemberRole.OWNER },
          },
        },
      });
    } catch (error) {
      this.logger.error('createRoom error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Returns all rooms the caller belongs to.
   * Each entry includes a lastMessage preview and an unreadCount.
   * Unread = messages created after joinedAt with no readAt receipt for this user.
   */
  async getMyRooms(userId: string, limit = 50) {
    try {
      const memberships = await this.prisma.roomMember.findMany({
        where: { userId },
        take: limit,
        include: {
          room: {
            include: {
              messages: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  content: true,
                  type: true,
                  createdAt: true,
                  userId: true,
                },
              },
            },
          },
        },
        orderBy: { room: { updatedAt: 'desc' } }, // most recently active first
      });

      // Batch fetch DM partners in one query
      const dmRoomIds = memberships
        .filter((m) => m.room.type === RoomType.DM)
        .map((m) => m.roomId);

      const dmPartnerRows =
        dmRoomIds.length > 0
          ? await this.prisma.roomMember.findMany({
              where: { roomId: { in: dmRoomIds }, userId: { not: userId } },
              select: {
                roomId: true,
                user: { select: { id: true, name: true, avatar: true } },
              },
            })
          : [];

      const partnerByRoom = new Map(
        dmPartnerRows.map((r) => [r.roomId, r.user]),
      );

      // Single aggregated query for all unread counts => Improve performace here using native sql  aggregation
      const roomIds = memberships.map((m) => m.roomId);
      const unreadCounts =
        roomIds.length > 0
          ? await this.prisma.$queryRaw<
              Array<{ roomId: string; unreadCount: bigint }>
            >`
              SELECT
                m."roomId",
                COUNT(*)::bigint AS "unreadCount"
              FROM "Message" m
              WHERE m."roomId" = ANY(${roomIds}::text[])
                AND m."userId" != ${userId}
                AND m."createdAt" > (
                  SELECT rm."joinedAt"
                  FROM "RoomMember" rm
                  WHERE rm."roomId" = m."roomId" AND rm."userId" = ${userId}
                )
                AND NOT EXISTS (
                  SELECT 1 FROM "MessageReceipt" mr
                  WHERE mr."messageId" = m.id
                    AND mr."userId" = ${userId}
                    AND mr."readAt" IS NOT NULL
                )
              GROUP BY m."roomId"
            `
          : [];

      const countMap = new Map(
        unreadCounts.map((r) => [r.roomId, Number(r.unreadCount)]),
      );

      return memberships.map((m) => {
        const { messages, ...roomData } = m.room;
        return {
          ...roomData,
          role: m.role,
          lastMessage: messages[0] ?? null,
          unreadCount: countMap.get(m.roomId) ?? 0,
          dmPartner: partnerByRoom.get(m.roomId) ?? null,
        };
      });
    } catch (error) {
      this.logger.error('getMyRooms error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Returns a single room by ID.
   * Throws NotFoundException if the caller is not a member.
   */
  async getRoom(roomId: string, userId: string) {
    try {
      const membership = await this.prisma.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId } },
        include: { room: true },
      });

      if (!membership) throw new NotFoundException('Room not found');

      return membership.room;
    } catch (error) {
      this.logger.error('getRoom error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Removes the caller from a room.
   * - Regular MEMBER: deleted, memberCount decremented atomically.
   * - OWNER, other members present: promotes earliest-joined member to OWNER,
   *   updates createdBy, removes old owner — all in one transaction.
   * - OWNER as last member: room deleted entirely (no orphan rooms).
   */
  async leaveRoom(roomId: string, userId: string) {
    try {
      const member = await this.prisma.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId } },
        select: { role: true },
      });

      if (!member)
        throw new NotFoundException('You are not a member of this room');

      if (member.role === MemberRole.OWNER) {
        const nextMember = await this.prisma.roomMember.findFirst({
          where: { roomId, userId: { not: userId } },
          orderBy: { joinedAt: 'asc' },
          select: { userId: true },
        });

        this.logger.log('nextmember', nextMember);

        if (!nextMember) {
          // Broadcast before deletion so sockets still in the room receive it
          this.gateway.emitToRoom(roomId, 'room_deleted', { roomId });
          await this.prisma.room.delete({ where: { id: roomId } });
          return;
        }

        await this.prisma.$transaction(
          async (tx) => {
            await tx.roomMember.update({
              where: { roomId_userId: { roomId, userId: nextMember.userId } },
              data: { role: MemberRole.OWNER },
            });
            await tx.room.update({
              where: { id: roomId },
              data: {
                createdBy: nextMember.userId,
                memberCount: { decrement: 1 },
              },
            });
            await tx.roomMember.delete({
              where: { roomId_userId: { roomId, userId } },
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10000,
            timeout: 30000,
          },
        );
        this.gateway.emitToRoom(roomId, 'user_left', { userId, roomId });
        return;
      }

      await this.prisma.$transaction(
        async (tx) => {
          await tx.roomMember.delete({
            where: { roomId_userId: { roomId, userId } },
          });
          await tx.room.update({
            where: { id: roomId },
            data: { memberCount: { decrement: 1 } },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10000,
          timeout: 30000,
        },
      );
      this.gateway.emitToRoom(roomId, 'user_left', { userId, roomId });
    } catch (error) {
      this.logger.error('leaveRoom error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Permanently deletes a room. OWNER only.
   * Cascade via Prisma onDelete handles members, messages, and receipts.
   */
  async deleteRoom(roomId: string, userId: string) {
    try {
      await this.assertOwner(roomId, userId);
      this.gateway.emitToRoom(roomId, 'room_deleted', { roomId });
      await this.prisma.room.delete({ where: { id: roomId } });
    } catch (error) {
      this.logger.error('deleteRoom error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Invites a user into a room by email. OWNER only.
   * Resolves the email to a userId first, then upserts the membership.
   * The existence check and conditional memberCount increment run inside a
   * transaction to prevent concurrent invites double-incrementing the count.
   */
  async inviteUser(roomId: string, callerId: string, email: string) {
    try {
      await this.assertOwner(roomId, callerId);

      const target = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (!target)
        throw new NotFoundException('No user found with that email address');

      await this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId: target.id } },
            select: { userId: true },
          });

          await tx.roomMember.upsert({
            where: { roomId_userId: { roomId, userId: target.id } },
            create: { roomId, userId: target.id, role: MemberRole.MEMBER },
            update: {},
          });

          if (!existing) {
            await tx.room.update({
              where: { id: roomId },
              data: { memberCount: { increment: 1 } },
            });
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      // Fetch target user info for the broadcast
      const targetUser = await this.prisma.user.findUnique({
        where: { id: target.id },
        select: { id: true, name: true, avatar: true },
      });

      // Notify existing room members that someone new joined
      this.gateway.emitToRoom(roomId, 'user_joined', {
        userId: target.id,
        name: targetUser?.name,
        roomId,
      });

      // Push the room to the invited user immediately if they are online
      const invitedSocketId = await this.redis.get(`socket:${target.id}`);
      if (invitedSocketId) {
        const room = await this.prisma.room.findUnique({
          where: { id: roomId },
        });
        this.gateway.emitToSocket(invitedSocketId, 'room_pushed', { room });
      }
    } catch (error) {
      this.logger.error('inviteUser error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Removes a member from a room. OWNER only. Idempotent if member doesn't exist.
   * The existence check, delete, and memberCount decrement run inside a transaction
   * to prevent concurrent removals from decrementing the count more than once.
   */
  async removeMember(roomId: string, callerId: string, email: string) {
    try {
      await this.assertOwner(roomId, callerId);

      const target = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });

      if (!target)
        throw new NotFoundException('No user found with that email address');

      if (target.id === callerId)
        throw new ForbiddenException('You can leave the room!');

      let wasMember = false;
      await this.prisma.$transaction(
        async (tx) => {
          const member = await tx.roomMember.findUnique({
            where: { roomId_userId: { roomId, userId: target.id } },
            select: { userId: true },
          });

          if (!member) return;
          wasMember = true;

          await tx.roomMember.delete({
            where: { roomId_userId: { roomId, userId: target.id } },
          });
          await tx.room.update({
            where: { id: roomId },
            data: { memberCount: { decrement: 1 } },
          });
        },
        {
          maxWait: 10000,
          timeout: 30000,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      if (wasMember) {
        // Tell everyone remaining the member left
        this.gateway.emitToRoom(roomId, 'user_left', {
          userId: target.id,
          roomId,
        });
        // Tell the removed user their room was taken away
        const removedSocketId = await this.redis.get(`socket:${target.id}`);
        if (removedSocketId) {
          this.gateway.emitToSocket(removedSocketId, 'room_removed', {
            roomId,
          });
        }
      }
    } catch (error) {
      this.logger.error('removeMember error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Returns all members of a room with their user details.
   * Caller must be a member.
   */
  async getRoomMembers(roomId: string, callerId: string) {
    try {
      const membership = await this.prisma.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId: callerId } },
        select: { role: true },
      });

      if (!membership) throw new NotFoundException('Room not found');

      return await this.prisma.roomMember.findMany({
        where: { roomId },
        select: {
          userId: true,
          role: true,
          joinedAt: true,
          user: { select: { id: true, name: true, email: true, avatar: true } },
        },
        orderBy: { joinedAt: 'asc' },
      });
    } catch (error) {
      this.logger.error('getRoomMembers error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  /**
   * Returns the existing DM room between two users, or creates one.
   * Resolves the target by email first. Self-DMs are rejected.
   * Both users are added as MEMBER (DM rooms have no OWNER).
   * Uses memberCount: 2 to uniquely identify the pair without scanning all members.
   */
  async createOrGetDm(callerId: string, targetEmail: string) {
    try {
      const target = await this.prisma.user.findUnique({
        where: { email: targetEmail },
        select: { id: true },
      });

      if (!target)
        throw new NotFoundException('No user found with that email address');

      const targetUserId = target.id;

      if (callerId === targetUserId) {
        throw new ForbiddenException('Cannot start a DM with yourself');
      }

      const existing = await this.prisma.room.findFirst({
        where: {
          type: RoomType.DM,
          memberCount: 2,
          AND: [
            { members: { some: { userId: callerId } } },
            { members: { some: { userId: targetUserId } } },
          ],
        },
      });

      if (existing) return existing;

      const dm = await this.prisma.room.create({
        data: {
          type: RoomType.DM,
          memberCount: 2,
          members: {
            create: [
              { userId: callerId, role: MemberRole.MEMBER },
              { userId: targetUserId, role: MemberRole.MEMBER },
            ],
          },
        },
      });

      // Push the room to the dm user immediately if they are online
      const invitedSocketId = await this.redis.get(`socket:${target.id}`);
      if (invitedSocketId) {
        const room = await this.prisma.room.findUnique({
          where: { id: dm.id },
        });
        this.gateway.emitToSocket(invitedSocketId, 'room_pushed', { room });
      }

      return dm;
    } catch (error) {
      this.logger.error('createOrGetDm error:', error);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('An error occurred');
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async assertOwner(roomId: string, userId: string): Promise<void> {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { role: true },
    });

    if (!member || member.role !== MemberRole.OWNER) {
      throw new ForbiddenException(
        'Only the room owner can perform this action',
      );
    }
  }
}
