import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AiService {
  private readonly logger = new Logger();

  constructor() {}

  queueAiResponse({}: {
    roomId: string;
    messageId: string;
    userId: string;
    question: string;
  }) {}
}
