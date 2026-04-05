import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChatMessage, ChatOptions } from '../@types/interface/ai';
import { AiModelRepository } from './repositories/ai-model.repository';
import { AnthropicModelRepository } from './repositories/anthropic-model.repository';
import { OpenAiModelRepository } from './repositories/openai-model.repository';

/**
 * Routes every AI operation to the correct provider based on model name.
 *
 * Routing rules (evaluated in order):
 *   "claude-*"  → AnthropicModelRepository
 *   "gpt-*"     → OpenAiModelRepository
 *   (no model)  → provider for DEFAULT_AI_MODEL env var (fallback: "gpt-4o")
 *
 * summarize() uses the same routing — it resolves against DEFAULT_AI_MODEL
 * so the summary provider matches the chat provider automatically.
 *
 * To add a new provider (e.g. Gemini):
 *   1. Create GeminiModelRepository extends AiModelRepository
 *   2. Add it to the constructor + add a "gemini-*" case in resolve()
 *   3. Register it as a provider in AiModule
 *   4. update the ressolve function to capture that model
 *   No other files need to change.
 */
@Injectable()
export class ModelRouterService extends AiModelRepository {
  private readonly logger = new Logger(ModelRouterService.name);
  private readonly defaultModel: string;

  constructor(
    private readonly openai: OpenAiModelRepository,
    private readonly anthropic: AnthropicModelRepository,
    config: ConfigService,
  ) {
    super();
    this.defaultModel = config.get<string>('DEFAULT_AI_MODEL') ?? 'gpt-4o';
  }

  stream(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<string> {
    return this.resolve(opts?.model).stream(messages, opts);
  }

  transcribe(audio: Buffer, mimeType: string): Promise<string> {
    // Transcription is OpenAI Whisper — always route there regardless of chat model
    return this.openai.transcribe(audio, mimeType);
  }

  synthesize(text: string): Promise<Buffer> {
    // TTS is OpenAI — always route there regardless of chat model
    return this.openai.synthesize(text);
  }

  summarize(messages: ChatMessage[]): Promise<string> {
    // Route summarize to whichever provider owns the default model
    return this.resolve(this.defaultModel).summarize(messages);
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private resolve(model?: string): AiModelRepository {
    if (!model) return this.resolve(this.defaultModel); // recursion is safe here since, we have the base case

    if (model.startsWith('claude-')) {
      this.logger.debug(`Routing to Anthropic — model: ${model}`);
      return this.anthropic;
    }

    if (model.startsWith('gpt-')) {
      this.logger.debug(`Routing to OpenAI — model: ${model}`);
      return this.openai;
    }

    // wrong provider =>
    throw new NotFoundException(`Unknown model provider for model: "${model}"`);
  }
}
