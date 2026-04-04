import { Socket } from 'socket.io';

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class RoomMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ws = context.switchToWs();
    const data = ws.getData();
    const client: Socket = ws.getClient();

    const roomId: string | undefined = data?.roomId;
    const userId: string | undefined = client.data.user?.id;

    if (!roomId || !userId) {
      throw new WsException('Access denied');
    }

    const membership = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { role: true },
    });

    if (!membership) {
      throw new WsException('Access Denied');
    }

    // attach role so gateway can use it without another DB call
    client.data.roomRole = membership.role;
    return true;
  }
}
