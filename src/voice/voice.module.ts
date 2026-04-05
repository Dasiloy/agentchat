import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';

import { AI_QUEUE, VOICE_QUEUE } from '../@types/constants/queue';
import { AiModule } from '../ai/ai.module';
import { GatewayModule } from '../gateway/gateway.module';
import { VoiceController } from './voice.controller';
import { VoiceProcessor } from './voice.processor';
import { VoiceService } from './voice.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: VOICE_QUEUE }),
    BullModule.registerQueue({ name: AI_QUEUE }),
    AiModule,
    forwardRef(() => GatewayModule),
  ],
  controllers: [VoiceController],
  providers: [VoiceService, VoiceProcessor],
  exports: [VoiceService],
})
export class VoiceModule {}
