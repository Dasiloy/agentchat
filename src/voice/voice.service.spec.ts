import { Test, TestingModule } from '@nestjs/testing';

import { getQueueToken } from '@nestjs/bullmq';
import { AI_MODEL_REPOSITORY, VOICE_QUEUE } from '../@types/constants/queue';
import { PrismaService } from '../common/prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { VoiceService } from './voice.service';

// ─── Cloudinary mock ─────────────────────────────────────────────────────────

const mockUploadStream = jest.fn();
jest.mock('cloudinary', () => ({
  v2: {
    uploader: {
      upload_stream: jest.fn((_opts, cb) => {
        mockUploadStream(_opts, cb);
        // Return a writable-like object (pipe target)
        const { PassThrough } = require('stream');
        const pt = new PassThrough();
        // Simulate immediate success
        process.nextTick(() => cb(null, { secure_url: 'https://cdn.example.com/audio.webm' }));
        return pt;
      }),
    },
  },
}));

// ─── Helpers ─────────────────────────────────="────────────────────────────────

function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.webm',
    encoding: '7bit',
    mimetype: 'audio/webm',
    size: 1024,
    buffer: Buffer.from('fake-audio'),
    stream: null as any,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}

function buildMocks() {
  return {
    voiceQueue: { add: jest.fn().mockResolvedValue(undefined) },
    prisma: {
      message: {
        create: jest.fn().mockResolvedValue({
          id: 'msg-1',
          roomId: 'room-1',
          content: 'Voice message (transcribing...)',
          user: { id: 'user-1', name: 'Alice', avatar: null },
        }),
        update: jest.fn(),
      },
    },
    gateway: { emitToRoom: jest.fn() },
    aiModel: {
      transcribe: jest.fn().mockResolvedValue('hello world'),
      synthesize: jest.fn().mockResolvedValue(Buffer.from('audio')),
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('VoiceService', () => {
  let service: VoiceService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VoiceService,
        { provide: PrismaService, useValue: mocks.prisma },
        { provide: ChatGateway, useValue: mocks.gateway },
        { provide: AI_MODEL_REPOSITORY, useValue: mocks.aiModel },
        { provide: getQueueToken(VOICE_QUEUE), useValue: mocks.voiceQueue },
      ],
    }).compile();

    service = module.get<VoiceService>(VoiceService);
    jest.clearAllMocks();
  });

  describe('uploadVoice', () => {
    it('should persist message before broadcasting', async () => {
      const file = makeFile();
      const createOrder: string[] = [];

      mocks.prisma.message.create.mockImplementation(async () => {
        createOrder.push('db');
        return { id: 'msg-1', roomId: 'room-1', content: 'Voice message (transcribing...)', user: null };
      });
      mocks.gateway.emitToRoom.mockImplementation(() => {
        createOrder.push('emit');
      });

      await service.uploadVoice(file, 'room-1', 'user-1');

      expect(createOrder).toEqual(['db', 'emit']);
    });

    it('should NOT await transcription — returns immediately after broadcast', async () => {
      const file = makeFile();
      // Mock prisma create to track when called
      mocks.prisma.message.create.mockResolvedValue({
        id: 'msg-1',
        roomId: 'room-1',
        content: 'Voice message (transcribing...)',
        user: null,
      });

      const result = await service.uploadVoice(file, 'room-1', 'user-1');

      // Returns upload result without waiting for transcription
      expect(result).toEqual({ messageId: 'msg-1', status: 'transcribing' });
      // Transcription is NOT called here — it runs via VoiceProcessor job
      expect(mocks.aiModel.transcribe).not.toHaveBeenCalled();
    });
  });
});
