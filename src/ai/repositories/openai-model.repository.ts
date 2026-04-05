import OpenAI, { toFile } from 'openai';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChatMessage, ChatOptions } from '../../@types/interface/ai';
import { AiModelRepository } from './ai-model.repository';

/**
 * OpenAI implementation of AiModelRepository.
 *
 * Maps the model-agnostic ChatMessage type to OpenAI SDK types internally.
 * The caller never needs to know which provider is in use — all provider
 * details are contained here.
 *
 * Model selection:
 *   - stream/summarize honour opts.model so the caller (processor) can pass
 *     a user-selected model name (e.g. "gpt-4o-mini") without this class
 *     needing to change.
 *
 * @class OpenAiModelRepository
 */
@Injectable()
export class OpenAiModelRepository extends AiModelRepository {
  private readonly openai: OpenAI;

  constructor(private readonly config: ConfigService) {
    super();
    this.openai = new OpenAI({
      apiKey: this.config.get<string>('OPENAI_API_KEY'),
    });
  }

  /**
   * Streams chat completion tokens as an async iterable of strings.
   * Errors are intentionally NOT caught here — the processor handles retries.
   */
  async *stream(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<string> {
    const completion = await this.openai.chat.completions.create({
      model: opts?.model ?? 'gpt-4o',
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    for await (const chunk of completion) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
  }

  /**
   * Transcribes audio using OpenAI Whisper.
   */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const file = await toFile(audio, 'audio.webm', { type: mimeType });
    const result = await this.openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
    });
    return result.text;
  }

  /**
   * Synthesizes text to speech using OpenAI TTS-1.
   */
  async synthesize(text: string): Promise<Buffer> {
    const response = await this.openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
    });
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * Summarizes a conversation using gpt-4o-mini (cost-effective).
   */
  async summarize(messages: ChatMessage[]): Promise<string> {
    const result = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Summarize this conversation preserving names, decisions, and key facts.',
        },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    return result.choices[0]?.message?.content ?? '';
  }
}
