import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { MessageType } from '../generated/prisma/enums';
import { AI_MODEL_REPOSITORY } from '../@types/constants/queue';
import { ContextService } from './context.service';

function buildPrismaMock() {
  return {
    message: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
    room: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function buildAiModelMock() {
  return {
    summarize: jest.fn().mockResolvedValue('summary text'),
    stream: jest.fn(),
    transcribe: jest.fn(),
    synthesize: jest.fn(),
  };
}

const ROOM_ID = 'room-1';
const QUESTION = '@ai what is TypeScript?';

const MOCK_ROOM = {
  name: 'Dev Team',
  contextSummary: null,
  members: [
    { user: { name: 'Alice' } },
    { user: { name: 'Bob' } },
  ],
};

describe('ContextService', () => {
  let service: ContextService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let aiModel: ReturnType<typeof buildAiModelMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    aiModel = buildAiModelMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextService,
        { provide: PrismaService, useValue: prisma },
        { provide: AI_MODEL_REPOSITORY, useValue: aiModel },
      ],
    }).compile();

    service = module.get<ContextService>(ContextService);
  });

  describe('buildContext', () => {
    it('should return all messages verbatim when count <= 50', async () => {
      prisma.message.count.mockResolvedValue(3);
      prisma.room.findUnique.mockResolvedValue(MOCK_ROOM);
      prisma.message.findMany.mockResolvedValue([
        { content: 'hello', type: MessageType.TEXT, user: { name: 'Alice' } },
        { content: 'world', type: MessageType.TEXT, user: { name: 'Bob' } },
        { content: 'ai response', type: MessageType.AI, user: null },
      ]);

      const result = await service.buildContext(ROOM_ID, QUESTION);

      // Should have: system prompt + 3 conversation messages + final user question
      expect(result).toHaveLength(5);
      // All messages fetched — no skip/take aside from order
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { roomId: ROOM_ID }, orderBy: { createdAt: 'asc' } }),
      );
    });

    it('should return summary + last 15 when count > 50', async () => {
      prisma.message.count.mockResolvedValue(60);
      prisma.room.findUnique.mockResolvedValue({
        ...MOCK_ROOM,
        contextSummary: 'prior summary',
      });

      const last15 = Array.from({ length: 15 }, (_, i) => ({
        content: `msg ${i}`,
        type: MessageType.TEXT,
        user: { name: 'Alice' },
      }));
      prisma.message.findMany.mockResolvedValue(last15);

      const result = await service.buildContext(ROOM_ID, QUESTION);

      // system prompt + summary system msg + 15 msgs + final user question = 18
      expect(result).toHaveLength(18);

      // The summary message should appear in the result
      const summaryMsg = result.find(
        (m) => m.role === 'system' && m.content === 'prior summary',
      );
      expect(summaryMsg).toBeDefined();

      // Fetched with take: 15
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 15 }),
      );
    });

    it('should include AI messages as role "assistant"', async () => {
      prisma.message.count.mockResolvedValue(1);
      prisma.room.findUnique.mockResolvedValue(MOCK_ROOM);
      prisma.message.findMany.mockResolvedValue([
        { content: 'I am the AI', type: MessageType.AI, user: null },
      ]);

      const result = await service.buildContext(ROOM_ID, QUESTION);

      const aiMsg = result.find((m) => m.role === 'assistant');
      expect(aiMsg).toBeDefined();
      expect(aiMsg?.content).toBe('I am the AI');
    });

    it('should prefix human messages with speaker name', async () => {
      prisma.message.count.mockResolvedValue(1);
      prisma.room.findUnique.mockResolvedValue(MOCK_ROOM);
      prisma.message.findMany.mockResolvedValue([
        { content: 'hello there', type: MessageType.TEXT, user: { name: 'Alice' } },
      ]);

      const result = await service.buildContext(ROOM_ID, QUESTION);

      const humanMsg = result.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('Alice:'));
      expect(humanMsg).toBeDefined();
      expect(humanMsg?.content).toBe('Alice: hello there');
    });

    it('should trigger summary update when count > 50 (fire and forget — does not await)', async () => {
      prisma.message.count.mockResolvedValue(60);
      prisma.room.findUnique.mockResolvedValue({
        ...MOCK_ROOM,
        contextSummary: 'existing summary',
      });
      prisma.message.findMany.mockResolvedValue([]);

      const triggerSpy = jest
        .spyOn(service, 'triggerSummaryUpdate')
        .mockResolvedValue(undefined);

      await service.buildContext(ROOM_ID, QUESTION);

      // Should be called but NOT awaited — so it returns before summary completes
      expect(triggerSpy).toHaveBeenCalledWith(ROOM_ID);
    });
  });
});
