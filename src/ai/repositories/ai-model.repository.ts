import { ChatMessage, ChatOptions } from '../../@types/interface/ai';

export abstract class AiModelRepository {
  abstract stream(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<string>;

  abstract transcribe(audio: Buffer, mimeType: string): Promise<string>;

  abstract synthesize(text: string): Promise<Buffer>;

  abstract summarize(messages: ChatMessage[]): Promise<string>;
}
