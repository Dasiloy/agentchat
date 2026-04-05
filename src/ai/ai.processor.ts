import { Job, Queue } from 'bullmq';
import { randomUUID } from 'crypto';

import {
  InjectQueue,
  OnWorkerEvent,
  Processor,
  WorkerHost,
} from '@nestjs/bullmq';
import { Inject, Logger, forwardRef } from '@nestjs/common';

import {
  AI_MODEL_REPOSITORY,
  AI_QUEUE,
  AI_RESPONSE,
  VOICE_QUEUE,
  VOICE_TTS,
} from '../@types/constants/queue';
import { PrismaService } from '../common/prisma/prisma.service';
import { MessageType } from '../generated/prisma/enums';
import { ChatGateway } from '../gateway/chat.gateway';
import { AiJobData } from '../@types/interface/ai';
import { ContextService } from './context.service';
import { AiModelRepository } from './repositories/ai-model.repository';
import { STREAM_TIMEOUT_MS } from '../@types/constants/ai';

@Processor(AI_QUEUE)
export class AiProcessor extends WorkerHost {
  private readonly logger = new Logger(AiProcessor.name);

  constructor(
    private readonly contextService: ContextService,
    @Inject(AI_MODEL_REPOSITORY) private readonly aiModel: AiModelRepository,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
    @InjectQueue(VOICE_QUEUE) private readonly voiceQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<AiJobData>): Promise<void> {
    switch (job.name) {
      case AI_RESPONSE:
        return this.handleAiResponse(job);
      default:
        this.logger.warn(`Unhandled job name: "${job.name}" — skipping`);
    }
  }

  /**
   * Handles the ai-response job.
   * 1. Build context from room history.
   * 2. Stream tokens to the room in real-time.
   * 3. Persist the complete response, broadcast completion.
   * 4. Queue TTS + kick off summary update as fire-and-forget.
   */
  private async handleAiResponse(job: Job<AiJobData>): Promise<void> {
    const { roomId, userId, question, tts, userName } = job.data;

    const context = await this.contextService.buildContext(roomId, question, userName);
    const tempMessageId = randomUUID();

    // Always open the response with the addressee so the room knows who the AI
    // is talking to — regardless of whether the model decides to include it.
    const prefix = userName ? `@${userName}, ` : '';
    let fullResponse = prefix;
    if (prefix) {
      this.gateway.emitToRoom(roomId, 'ai_token', { token: prefix, tempMessageId });
    }

    // Stream with a 30s timeout — any error (including timeout) is re-thrown
    // so BullMQ can retry based on job.opts.attempts
    try {
      const timeoutError = new Error('AI_TIMEOUT');
      let timeoutHandle: ReturnType<typeof setTimeout>;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(timeoutError),
          STREAM_TIMEOUT_MS,
        );
      });

      await Promise.race([
        (async () => {
          for await (const token of this.aiModel.stream(context)) {
            fullResponse += token;
            this.gateway.emitToRoom(roomId, 'ai_token', {
              token,
              tempMessageId,
            });
          }
          clearTimeout(timeoutHandle!);
        })(),
        timeoutPromise,
      ]);
    } catch (err: any) {
      if (err.message === 'AI_TIMEOUT') {
        throw new Error(
          `AI response timed out after ${STREAM_TIMEOUT_MS / 1000}s`,
        );
      }
      throw err; // BullMQ retries based on job.opts.attempts
    }

    // Persist the full AI message
    const saved = await this.prisma.message.create({
      data: {
        roomId,
        userId: null,
        content: fullResponse,
        type: MessageType.AI,
        metadata: { invokedBy: userId, contextSize: context.length },
      },
    });

    // Notify room the stream is done so clients can swap the temp bubble
    this.gateway.emitToRoom(roomId, 'ai_response_complete', {
      messageId: saved.id,
      tempMessageId,
    });

    // Queue TTS only when the trigger was a voice message — text @ai mentions skip it
    if (tts) {
      this.voiceQueue
        .add(VOICE_TTS, { messageId: saved.id, text: fullResponse, roomId })
        .catch((err) => this.logger.error('TTS queue failed', err));
    }

    // Fire-and-forget: roll the room's context summary
    this.contextService
      .triggerSummaryUpdate(roomId)
      .catch((err) => this.logger.error('Summary update failed', err));
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<AiJobData>, error: Error): void {
    this.logger.error(
      `AI job ${job.id} failed for room ${job.data.roomId}: ${error.message}`,
      error.stack,
    );
    // Broadcast a user-friendly error — never expose raw error details to the room
    this.gateway.emitToRoom(job.data.roomId, 'ephemeral', {
      type: 'ai_error',
      message: 'AI Assistant is temporarily unavailable. Please try again.',
    });
  }
}
