import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { AI_QUEUE } from '../@types/constants/queue';
import { AiService } from 'src/ai/ai.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: AI_QUEUE,
    }),
  ],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {
  constructor() {}
}
