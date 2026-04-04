import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { PrismaService } from './common/prisma/prisma.service';

const mockPrismaService = {
  $queryRaw: jest.fn(),
};

describe('AppService', () => {
  let service: AppService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<AppService>(AppService);
    jest.clearAllMocks();
  });

  it('should resolve when the database is reachable', async () => {
    mockPrismaService.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    await expect(service.getHealth()).resolves.toBeUndefined();
  });

  it('should throw ServiceUnavailableException when the database is unreachable', async () => {
    mockPrismaService.$queryRaw.mockRejectedValue(
      new Error('connection refused'),
    );
    await expect(service.getHealth()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
