import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue('postgresql://localhost/test'),
};

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrismaService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should connect without throwing', async () => {
    jest.spyOn(service, '$connect').mockResolvedValue(undefined);
    await expect(service.onModuleInit()).resolves.not.toThrow();
  });
});
