import { BullModule } from '@nestjs/bullmq';
import { Module, forwardRef } from '@nestjs/common';

import { AI_MODEL_REPOSITORY, AI_QUEUE, VOICE_QUEUE } from '../@types/constants/queue';
import { GatewayModule } from '../gateway/gateway.module';
import { AiProcessor } from './ai.processor';
import { AiService } from './ai.service';
import { ContextService } from './context.service';
import { ModelRouterService } from './model-router.service';
import { AnthropicModelRepository } from './repositories/anthropic-model.repository';
import { OpenAiModelRepository } from './repositories/openai-model.repository';

@Module({
  imports: [
    BullModule.registerQueue({ name: AI_QUEUE }),
    // AiProcessor queues VOICE_TTS jobs — register the queue here so the
    // producer is available without importing VoiceModule (avoids circular dep)
    BullModule.registerQueue({ name: VOICE_QUEUE }),
    forwardRef(() => GatewayModule),
  ],
  providers: [
    AiService,
    ContextService,
    AiProcessor,
    OpenAiModelRepository,
    AnthropicModelRepository,
    { provide: AI_MODEL_REPOSITORY, useClass: ModelRouterService },
  ],
  // Export AI_MODEL_REPOSITORY so VoiceModule (and others) can inject it
  exports: [AiService, ContextService, AI_MODEL_REPOSITORY],
})
export class AiModule {}
