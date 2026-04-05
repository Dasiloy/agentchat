import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../common/redis/redis.provider';
import { ChatGateway } from '../gateway/chat.gateway';
import { MemberRole, RoomType } from '../generated/prisma/enums';
import { RoomsService } from './rooms.service';

const OWNER_ID = 'user-owner';
const MEMBER_ID = 'user-member';
const ROOM_ID = 'room-1';

const mockRoom = { id: ROOM_ID, type: RoomType.CHANNEL, memberCount: 1 };
const ownerMembership = { roomId: ROOM_ID, userId: OWNER_ID, role: MemberRole.OWNER };
const memberMembership = { roomId: ROOM_ID, userId: MEMBER_ID, role: MemberRole.MEMBER };

function buildPrismaMock() {
  // tx shares the same mock fns so assertions work transparently
  const mock = {
    user: {
      findUnique: jest.fn(),
    },
    room: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    roomMember: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    message: { count: jest.fn() },
    $transaction: jest.fn(),
  };

  // by default, run the callback with the same mock as the tx client
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => unknown) => fn(mock));

  return mock;
}

describe('RoomsService', () => {
  let service: RoomsService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ChatGateway, useValue: { emitToRoom: jest.fn(), emitToSocket: jest.fn() } },
        { provide: REDIS_CLIENT, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    service = module.get<RoomsService>(RoomsService);
  });

  // ─── createRoom ─────────────────────────────────────────────────────────────

  describe('createRoom', () => {
    it('should set creator as OWNER and memberCount to 1', async () => {
      prisma.room.create.mockResolvedValue(mockRoom);

      await service.createRoom({ name: 'general' }, OWNER_ID);

      expect(prisma.room.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            createdBy: OWNER_ID,
            memberCount: 1,
            members: {
              create: { userId: OWNER_ID, role: MemberRole.OWNER },
            },
          }),
        }),
      );
    });
  });

  // ─── getRoomMembers ──────────────────────────────────────────────────────────

  describe('getRoomMembers', () => {
    it('should throw NotFoundException if caller is not a member', async () => {
      prisma.roomMember.findUnique.mockResolvedValue(null);

      await expect(
        service.getRoomMembers(ROOM_ID, OWNER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return members ordered by joinedAt', async () => {
      prisma.roomMember.findUnique.mockResolvedValue(ownerMembership);
      const members = [
        { userId: OWNER_ID, role: MemberRole.OWNER, joinedAt: new Date('2026-01-01'), user: { id: OWNER_ID, name: 'Owner', email: 'owner@example.com', avatar: null } },
        { userId: MEMBER_ID, role: MemberRole.MEMBER, joinedAt: new Date('2026-01-02'), user: { id: MEMBER_ID, name: 'Member', email: 'member@example.com', avatar: null } },
      ];
      prisma.roomMember.findMany.mockResolvedValue(members);

      const result = await service.getRoomMembers(ROOM_ID, OWNER_ID);

      expect(result).toEqual(members);
      expect(prisma.roomMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { roomId: ROOM_ID }, orderBy: { joinedAt: 'asc' } }),
      );
    });
  });

  // ─── inviteUser ──────────────────────────────────────────────────────────────

  describe('inviteUser', () => {
    it('should throw ForbiddenException if caller is not OWNER', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-new' });
      prisma.roomMember.findUnique.mockResolvedValue(memberMembership);

      await expect(
        service.inviteUser(ROOM_ID, MEMBER_ID, 'new@example.com'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should not throw on duplicate invite (upsert is idempotent)', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: MEMBER_ID });

      prisma.roomMember.findUnique
        .mockResolvedValueOnce(ownerMembership)   // assertOwner
        .mockResolvedValueOnce(memberMembership); // existing member check inside tx

      prisma.roomMember.upsert.mockResolvedValue(memberMembership);

      await expect(
        service.inviteUser(ROOM_ID, OWNER_ID, 'member@example.com'),
      ).resolves.not.toThrow();

      // memberCount must NOT be incremented for a duplicate invite
      expect(prisma.room.update).not.toHaveBeenCalled();
    });
  });

  // ─── removeMember ────────────────────────────────────────────────────────────

  describe('removeMember', () => {
    it('should throw ForbiddenException if owner tries to remove themselves', async () => {
      prisma.roomMember.findUnique.mockResolvedValue(ownerMembership); // assertOwner
      prisma.user.findUnique.mockResolvedValue({ id: OWNER_ID });      // email resolves to caller

      await expect(
        service.removeMember(ROOM_ID, OWNER_ID, 'owner@example.com'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ─── createOrGetDm ──────────────────────────────────────────────────────────

  describe('createOrGetDm', () => {
    it('should return existing DM room if one already exists', async () => {
      const dmRoom = { id: 'dm-room-1', type: RoomType.DM, memberCount: 2 };
      prisma.user.findUnique.mockResolvedValue({ id: MEMBER_ID });
      prisma.room.findFirst.mockResolvedValue(dmRoom);

      const result = await service.createOrGetDm(OWNER_ID, 'member@example.com');

      expect(result).toEqual(dmRoom);
      expect(prisma.room.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for unknown email', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.createOrGetDm(OWNER_ID, 'ghost@example.com'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException when user tries to DM themselves', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: OWNER_ID }); // email resolves to same user

      await expect(
        service.createOrGetDm(OWNER_ID, 'owner@example.com'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
