import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, forwardRef } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import {
  AI_QUEUE,
  AI_RESPONSE,
  VOICE_QUEUE,
  VOICE_TRANSCRIBE,
  VOICE_TTS,
} from '../@types/constants/queue';
import { ChatGateway } from '../gateway/chat.gateway';
import { VoiceService } from './voice.service';

@Processor(VOICE_QUEUE)
export class VoiceProcessor extends WorkerHost {
  private readonly logger = new Logger(VoiceProcessor.name);

  constructor(
    private readonly voiceService: VoiceService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
    @InjectQueue(AI_QUEUE) private readonly aiQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case VOICE_TRANSCRIBE:
        return this.handleTranscribe(job);
      case VOICE_TTS:
        return this.handleTts(job);
      default:
        this.logger.warn(`Unhandled voice job: "${job.name}" — skipping`);
    }
  }

  private async handleTranscribe(job: Job): Promise<void> {
    const { messageId, audioUrl, mimeType, roomId, userId, userName } =
      job.data;

    const transcript = await this.voiceService.transcribeVoice(
      messageId,
      audioUrl,
      mimeType,
      roomId,
    );

    // If the voice message mentions "Siri", queue an AI response with TTS.
    // Normalise smart quotes and strip diacritics Whisper occasionally adds
    // before testing, so "Siri." / "Siri," / ""Siri"" all match reliably.
    const AI_TRIGGER = /\bsiri\b/i;
    const normalised = transcript
      .replace(/[\u2018\u2019\u201c\u201d]/g, '')
      .trim();
    this.logger.log('TTS', AI_TRIGGER.test(normalised));
    if (AI_TRIGGER.test(normalised)) {
      this.gateway.emitToRoom(roomId, 'ai_thinking', { triggeredBy: 'Voice' });
      await this.aiQueue.add(
        AI_RESPONSE,
        {
          roomId,
          messageId,
          userId,
          userName,
          question: transcript,
          tts: true,
        },
        { attempts: 2, backoff: { type: 'fixed', delay: 3000 } },
      );
    }
  }

  private async handleTts(job: Job): Promise<void> {
    const { messageId, text, roomId } = job.data;
    await this.voiceService.generateAiAudio(messageId, text, roomId);
  }
}
