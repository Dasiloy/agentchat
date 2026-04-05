import { Readable } from 'stream';

import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  forwardRef,
} from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';

import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { AI_MODEL_REPOSITORY, VOICE_QUEUE, VOICE_TRANSCRIBE } from '../@types/constants/queue';
import { PrismaService } from '../common/prisma/prisma.service';
import { MessageType } from '../generated/prisma/enums';
import { ChatGateway } from '../gateway/chat.gateway';
import { AiModelRepository } from '../ai/repositories/ai-model.repository';
import { CloudinaryResult } from './response/response';

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
    @Inject(AI_MODEL_REPOSITORY) private readonly aiModel: AiModelRepository,
    @InjectQueue(VOICE_QUEUE) private readonly voiceQueue: Queue,
  ) {}

  /**
   * Validates, uploads to Cloudinary, persists a VOICE message, broadcasts
   * it to the room, and queues transcription — all without blocking the caller.
   */
  async uploadVoice(
    file: Express.Multer.File,
    roomId: string,
    userId: string,
    userName: string,
  ): Promise<{ messageId: string; status: string }> {
    let audioUrl: string;
    try {
      const result = await this.uploadToCloudinary(file.buffer, {
        resource_type: 'video',
        folder: 'kochanet/voice',
      });
      audioUrl = result.secure_url;
    } catch (error) {
      this.logger.error('Cloudinary upload failed', error);
      throw new InternalServerErrorException('Voice upload failed');
    }

    // Persist message BEFORE broadcasting (receiver sees it before transcription)
    const message = await this.prisma.message.create({
      data: {
        roomId,
        userId,
        content: 'Voice message (transcribing...)',
        type: MessageType.VOICE,
        audioUrl,
      },
      include: { user: { select: { id: true, name: true, avatar: true } } },
    });

    this.gateway.emitToRoom(roomId, 'new_message', message);

    // Fire-and-forget: transcription runs in VoiceProcessor
    // userId is forwarded so the processor can queue an AI job if "siri" is detected
    await this.voiceQueue.add(VOICE_TRANSCRIBE, {
      messageId: message.id,
      audioUrl,
      mimeType: file.mimetype,
      roomId,
      userId,
      userName,
    });

    return { messageId: message.id, status: 'transcribing' };
  }

  /**
   * Synthesizes AI text to speech, uploads to Cloudinary, updates the
   * message record, and notifies the room. Called by VoiceProcessor (fire-and-forget).
   */
  async generateAiAudio(
    messageId: string,
    text: string,
    roomId: string,
  ): Promise<void> {
    let buffer: Buffer;
    try {
      buffer = await this.aiModel.synthesize(text);
    } catch (error) {
      this.logger.error('TTS synthesis failed', error);
      return; // AI response is already saved — degrade gracefully
    }

    let audioUrl: string;
    try {
      const result = await this.uploadToCloudinary(buffer, {
        resource_type: 'video',
        folder: 'kochanet/voice',
      });
      audioUrl = result.secure_url;
    } catch (error) {
      this.logger.error('TTS Cloudinary upload failed', error);
      return;
    }

    await this.prisma.message.update({
      where: { id: messageId },
      data: { audioUrl },
    });

    this.gateway.emitToRoom(roomId, 'ai_audio_ready', { messageId, audioUrl });
  }

  /**
   * Transcribes an audio buffer via the AI model repository and updates the
   * message. Called by VoiceProcessor.
   */
  /**
   * Returns the transcript so VoiceProcessor can inspect it for "siri" triggers.
   */
  async transcribeVoice(
    messageId: string,
    audioUrl: string,
    mimeType: string,
    roomId: string,
  ): Promise<string> {
    // Fetch audio from Cloudinary (never written to disk — buffer stays in memory)
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const transcript = await this.aiModel.transcribe(buffer, mimeType);

    await this.prisma.message.update({
      where: { id: messageId },
      data: { content: transcript, metadata: { transcript } },
    });

    this.gateway.emitToRoom(roomId, 'voice_transcribed', {
      messageId,
      transcript,
      audioUrl,
    });

    return transcript;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private uploadToCloudinary(
    buffer: Buffer,
    options: object,
  ): Promise<CloudinaryResult> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        options,
        (error, result) => {
          if (error || !result)
            reject(error ?? new Error('Cloudinary upload failed'));
          else resolve(result as CloudinaryResult);
        },
      );
      Readable.from(buffer).pipe(stream);
    });
  }
}
