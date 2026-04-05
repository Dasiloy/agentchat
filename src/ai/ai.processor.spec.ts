import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';

import { AI_MODEL_REPOSITORY, AI_RESPONSE, VOICE_QUEUE } from '../@types/constants/queue';
import { PrismaService } from '../common/prisma/prisma.service';
import { MessageType } from '../generated/prisma/enums';
import { ChatGateway } from '../gateway/chat.gateway';
import { AiProcessor } from './ai.processor';
import { ContextService } from './context.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function* makeTokenStream(tokens: string[]) {
  for (const token of tokens) yield token;
}

function buildMocks() {
  return {
    contextService: {
      buildContext: jest.fn(),
      triggerSummaryUpdate: jest.fn().mockResolvedValue(undefined),
    },
    aiModel: { stream: jest.fn() },
    prisma: { message: { create: jest.fn() } },
    gateway: { emitToRoom: jest.fn() },
    voiceQueue: { add: jest.fn().mockResolvedValue(undefined) },
  };
}

function makeJob(
  overrides: Partial<{ roomId: string; messageId: string; userId: string; question: string; tts: boolean }> = {},
): Job<any> {
  return {
    id: 'job-1',
    name: AI_RESPONSE,
    data: {
      roomId: 'room-1',
      messageId: 'msg-1',
      userId: 'user-1',
      question: '@ai what is TypeScript?',
      ...overrides,
    },
  } as Job<any>;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AiProcessor', () => {
  let processor: AiProcessor;
  let mocks: ReturnType<typeof buildMocks>;

  const CONTEXT = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Alice: hello' },
  ];
  const SAVED_MESSAGE = { id: 'ai-msg-1', content: 'Hello world', type: MessageType.AI };

  beforeEach(async () => {
    mocks = buildMocks();
    mocks.contextService.buildContext.mockResolvedValue(CONTEXT);
    mocks.prisma.message.create.mockResolvedValue(SAVED_MESSAGE);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiProcessor,
        { provide: ContextService, useValue: mocks.contextService },
        { provide: AI_MODEL_REPOSITORY, useValue: mocks.aiModel },
        { provide: PrismaService, useValue: mocks.prisma },
        { provide: ChatGateway, useValue: mocks.gateway },
        { provide: getQueueToken(VOICE_QUEUE), useValue: mocks.voiceQueue },
      ],
    }).compile();

    processor = module.get<AiProcessor>(AiProcessor);
  });

  describe('process', () => {
    it('should broadcast ai_token for each streamed token', async () => {
      mocks.aiModel.stream.mockReturnValue(makeTokenStream(['Hello', ' world']));

      await processor.process(makeJob());

      expect(mocks.gateway.emitToRoom).toHaveBeenCalledWith(
        'room-1', 'ai_token', expect.objectContaining({ token: 'Hello' }),
      );
      expect(mocks.gateway.emitToRoom).toHaveBeenCalledWith(
        'room-1', 'ai_token', expect.objectContaining({ token: ' world' }),
      );
    });

    it('should save complete response to DB after stream ends', async () => {
      mocks.aiModel.stream.mockReturnValue(makeTokenStream(['Hello', ' world']));

      await processor.process(makeJob());

      expect(mocks.prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            content: 'Hello world',
            type: MessageType.AI,
            userId: null,
            roomId: 'room-1',
          }),
        }),
      );
      expect(mocks.gateway.emitToRoom).toHaveBeenCalledWith(
        'room-1', 'ai_response_complete', expect.objectContaining({ messageId: SAVED_MESSAGE.id }),
      );
    });

    it('should queue TTS job when tts=true (fire-and-forget)', async () => {
      mocks.aiModel.stream.mockReturnValue(makeTokenStream(['Hi']));

      let queueResolve: () => void;
      const slowQueue = new Promise<void>((res) => { queueResolve = res; });
      mocks.voiceQueue.add.mockReturnValue(slowQueue);

      await processor.process(makeJob({ tts: true }));

      expect(mocks.voiceQueue.add).toHaveBeenCalledWith(
        'voice-tts',
        expect.objectContaining({ messageId: SAVED_MESSAGE.id, text: 'Hi' }),
      );

      queueResolve!();
    });

    it('should NOT queue TTS when tts is not set (text @ai mention)', async () => {
      mocks.aiModel.stream.mockReturnValue(makeTokenStream(['Hi']));

      await processor.process(makeJob());

      expect(mocks.voiceQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    it('should broadcast friendly error to room, not raw error message', () => {
      processor.onFailed(makeJob(), new Error('Connection refused to OpenAI endpoint'));

      const call = mocks.gateway.emitToRoom.mock.calls[0];
      expect(call[0]).toBe('room-1');
      expect(call[1]).toBe('ephemeral');
      expect(call[2].message).not.toContain('Connection refused');
      expect(call[2].message).toContain('temporarily unavailable');
    });
  });
});
