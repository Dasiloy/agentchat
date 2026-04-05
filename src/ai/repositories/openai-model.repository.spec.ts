import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

import { ChatMessage } from '../../@types/interface/ai';
import { OpenAiModelRepository } from './openai-model.repository';

// ─── OpenAI SDK mock ─────────────────────────────────────────────────────────

const mockCreate = jest.fn();
const mockTranscriptionsCreate = jest.fn();
const mockSpeechCreate = jest.fn();

jest.mock('openai', () => {
  const actual = jest.requireActual('openai');
  return {
    ...actual,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: { create: mockCreate },
      },
      audio: {
        transcriptions: { create: mockTranscriptionsCreate },
        speech: { create: mockSpeechCreate },
      },
    })),
    toFile: jest.fn().mockResolvedValue('mocked-file'),
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function* makeChunkStream(tokens: string[]) {
  for (const token of tokens) {
    yield { choices: [{ delta: { content: token } }] };
  }
}

const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'Alice: hello' },
  { role: 'assistant', content: 'Hi there' },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpenAiModelRepository', () => {
  let repo: OpenAiModelRepository;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenAiModelRepository,
        {
          provide: ConfigService,
          useValue: { get: () => 'test-api-key' },
        },
      ],
    }).compile();

    repo = module.get<OpenAiModelRepository>(OpenAiModelRepository);
  });

  describe('stream', () => {
    it('should call openai with gpt-4o and stream: true', async () => {
      mockCreate.mockResolvedValue(makeChunkStream(['Hello', ' world']));

      const tokens: string[] = [];
      for await (const token of repo.stream(MESSAGES)) {
        tokens.push(token);
      }

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o', stream: true }),
      );
      expect(tokens).toEqual(['Hello', ' world']);
    });

    it('should use opts.model when provided', async () => {
      mockCreate.mockResolvedValue(makeChunkStream([]));

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of repo.stream(MESSAGES, { model: 'gpt-4o-mini' })) {
        // drain
      }

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o-mini' }),
      );
    });
  });

  describe('transcribe', () => {
    it('should pass buffer to openai whisper and return text', async () => {
      mockTranscriptionsCreate.mockResolvedValue({ text: 'hello world' });

      const audio = Buffer.from('fake-audio');
      const result = await repo.transcribe(audio, 'audio/webm');

      expect(mockTranscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'whisper-1' }),
      );
      expect(result).toBe('hello world');
    });
  });

  describe('synthesize', () => {
    it('should return Buffer from TTS response', async () => {
      const fakeArrayBuffer = new ArrayBuffer(8);
      mockSpeechCreate.mockResolvedValue({ arrayBuffer: async () => fakeArrayBuffer });

      const result = await repo.synthesize('hello');

      expect(mockSpeechCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'tts-1', voice: 'alloy', input: 'hello' }),
      );
      expect(result).toBeInstanceOf(Buffer);
    });
  });
});
