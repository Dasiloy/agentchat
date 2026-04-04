import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: { getHealth: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  it('should return healthy response', async () => {
    const result = await appController.getHealth();
    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
  });
});
