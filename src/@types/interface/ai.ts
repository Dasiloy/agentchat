import { Server, Socket } from 'socket.io';

/**
 * Model-agnostic chat message. Each repository implementation is responsible
 * for mapping this to its own SDK type (e.g. ChatCompletionMessageParam for
 * OpenAI, MessageParam for Anthropic, Content for Gemini).
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AiJobData {
  roomId: string;
  messageId: string;
  userId: string;
  userName: string;
  question: string;
  tts?: boolean;
}

export interface QueueAiResponseParams {
  roomId: string;
  messageId: string;
  userId: string;
  userName: string;
  question: string;
  server: Server;
  client: Socket;
  /** When true, VoiceProcessor synthesizes the response to audio after streaming.
   *  Set only when the trigger was a voice message — text @ai mentions do not need TTS. */
  tts?: boolean;
}
