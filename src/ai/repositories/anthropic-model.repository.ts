import { Injectable, Logger } from '@nestjs/common';

import { ChatMessage, ChatOptions } from '../../@types/interface/ai';
import { AiModelRepository } from './ai-model.repository';

/**
 * Stub Anthropic implementation — replace method bodies with the real
 * @anthropic-ai/sdk calls when ready. The router dispatches here for any
 * model whose name starts with "claude-".
 */
@Injectable()
export class AnthropicModelRepository extends AiModelRepository {
  private readonly logger = new Logger(AnthropicModelRepository.name);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *stream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string> {
    this.logger.log(`[Anthropic] stream called — model: ${opts?.model ?? 'claude-3-5-sonnet'}`);
    // TODO: replace with real Anthropic SDK streaming
    yield '[Anthropic stub response]';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    // Anthropic does not have a transcription API — delegate to a shared Whisper
    throw new Error('Anthropic does not support transcription — use OpenAI Whisper');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async synthesize(text: string): Promise<Buffer> {
    // Anthropic does not have a TTS API — delegate to a shared TTS provider
    throw new Error('Anthropic does not support TTS — use OpenAI TTS');
  }

  async summarize(messages: ChatMessage[]): Promise<string> {
    this.logger.log(`[Anthropic] summarize called — ${messages.length} messages`);
    // TODO: replace with real Anthropic SDK call (claude-3-haiku is cost-effective for summaries)
    return '[Anthropic stub summary]';
  }
}
