import { Module } from '@nestjs/common';

import { ChatGateway } from './chat.gateway';
import { WsJwtGuard } from '../auth/guards/ws-jwt.guard';
import { RoomMemberGuard } from '../auth/guards/room-member.guard';
import { PresenceService } from './presence.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AiModule],
  providers: [ChatGateway, WsJwtGuard, RoomMemberGuard, PresenceService],
  exports: [PresenceService, ChatGateway],
})
export class GatewayModule {}
