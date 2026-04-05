import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { MessageType } from '../generated/prisma/enums';
import {
  MAX_PARTICIPANT_NAMES,
  MAX_TOKENS,
  RECENT_MESSAGE_COUNT,
} from '../@types/constants/ai';
import { AI_MODEL_REPOSITORY } from '../@types/constants/queue';
import { AiModelRepository } from './repositories/ai-model.repository';
import { ChatMessage } from '../@types/interface/ai';

@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_MODEL_REPOSITORY) private readonly aiModel: AiModelRepository,
  ) {}

  /**
   * Builds the ChatMessage array for a given room and question.
   *
   * - If the room has ≤50 messages: includes all of them verbatim.
   * - If the room has >50 messages: uses the stored contextSummary as a
   *   system message + the last 15 messages.
   * - AI messages map to role "assistant"; human messages map to role "user"
   *   and are prefixed with the speaker's name ("Alice: {content}").
   * - A system prompt describing the room and its participants is prepended.
   * - The question is appended as the final user turn (with "siri" stripped).
   * - If the estimated token count exceeds 100 000, oldest messages are trimmed.
   * - Fires triggerSummaryUpdate() as a side-effect when count > 50 (fire-and-forget).
   */
  async buildContext(
    roomId: string,
    question: string,
    askedBy?: string,
  ): Promise<ChatMessage[]> {
    // 1. Total message count in room
    const totalCount = await this.prisma.message.count({ where: { roomId } });

    // 2. Fetch room info + a capped list of member names for the system prompt.
    //    Limiting members avoids a full table scan on large rooms.
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: {
        name: true,
        contextSummary: true,
        members: {
          take: MAX_PARTICIPANT_NAMES,
          select: { user: { select: { name: true } } },
        },
      },
    });

    const roomName = room?.name ?? 'Unnamed Room';
    const participantNames = (room?.members ?? [])
      .map((m) => m.user.name)
      .filter(Boolean)
      .join(', ');

    const addressee = askedBy ? `@${askedBy}` : null;

    const systemPrompt = `You are an active, friendly member of this group chat, not a detached assistant.
    Your goal is to respond like a knowledgeable teammate who is part of the conversation.
    Room: ${roomName}. Participants: ${participantNames}.

    When responding, follow these rules:

    1. ADDRESS THE TRIGGERING USER DIRECTLY
    ${
      addressee
        ? `   - The user who triggered you is ${addressee}. Mention them naturally at the start or early in your reply:
        - "${addressee}, you should..."
        - "${addressee}, Docker is great for that; you could try..."
        - "${addressee}, maybe you'd want to..."`
        : `   - No specific user triggered you. Infer the primary interlocutor from context and address them as "you".`
    }

    2. USE PRONOUNS LIKE A HUMAN TEAMMATE
      - Use second-person pronouns (you, your, yours) when giving advice, explaining, or suggesting actions to the person you're addressing.
      - Use third-person pronouns (he, she, they, it) when referring to other people, tools, services, or concepts in the conversation.
      - Avoid overusing the user's name; mention them once, then rely on "you".

    3. SOUND CONVERSATIONAL AND NATURAL
      - Use contractions (you're, it's, don't, can't).
      - Use softeners and collaborative phrasing: "maybe", "you could", "I'd suggest", "have you tried", "what if we".
      - Avoid robotic or self-referential phrases like "As an AI", "I am an assistant", "I cannot", or overly formal language.
      - Keep tone warm, confident, and helpful, like a senior engineer or product teammate in a Slack/Teams channel.

    4. BE CONCISE AND CONTEXT-AWARE
      - Default to 1–4 sentences unless the question clearly requires depth.
      - Stay on topic and aware of prior messages in the thread.
      - If clarification is needed, ask a short, direct question instead of making assumptions.

    5. FORMAT CODE SNIPPETS PROPERLY
      - Always wrap code in triple backticks with the correct language identifier (e.g., \`\`\`ts, \`\`\`js, \`\`\`bash, \`\`\`json).
      - Keep snippets focused and minimal; only include relevant lines unless full context is requested.
      - Never paste unformatted code blocks or inline large chunks without fencing.

    Always prioritize clarity, warmth, and sounding like a real person in the group.`;

    let conversationMessages: ChatMessage[];

    if (totalCount <= 50) {
      // 3a. Fetch all messages with user info
      const messages = await this.prisma.message.findMany({
        where: { roomId },
        orderBy: { createdAt: 'asc' },
        select: {
          content: true,
          type: true,
          user: { select: { name: true } },
        },
      });

      conversationMessages = messages.map((m) => this.toChatMessage(m));
    } else {
      // 3b. Use contextSummary + last 15 messages
      const summaryContent = room?.contextSummary ?? 'No prior context';

      const recentMessages = await this.prisma.message.findMany({
        where: { roomId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_MESSAGE_COUNT,
        select: {
          content: true,
          type: true,
          user: { select: { name: true } },
        },
      });

      // Reverse so they are in chronological order
      recentMessages.reverse();

      conversationMessages = [
        { role: 'system', content: summaryContent },
        ...recentMessages.map((m) => this.toChatMessage(m)),
      ];

      // Fire-and-forget: update the summary in the background
      this.triggerSummaryUpdate(roomId).catch((err) =>
        this.logger.error('triggerSummaryUpdate failed', err),
      );
    }

    // 4. Strip "siri" trigger word so it isn't sent to the model as part of the question.
    const cleanQuestion = question.replace(/\bsiri\b[,\s]*/gi, '').trim();

    const attributedQuestion = askedBy
      ? `${askedBy}: ${cleanQuestion}`
      : cleanQuestion;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...conversationMessages,
      { role: 'user', content: attributedQuestion },
    ];

    // 5. Token guard: rough estimate (1 token ≈ 4 chars), trim oldest if over limit
    return this.trimToTokenBudget(messages);
  }

  /**
   * Asynchronously rebuilds the room's contextSummary from all messages except
   * the last 15. Only the older messages are fetched from the DB — the recent
   * window is intentionally excluded so it stays as verbatim context.
   * Designed to run fire-and-forget — never awaited in the request path.
   */
  async triggerSummaryUpdate(roomId: string): Promise<void> {
    const totalCount = await this.prisma.message.count({ where: { roomId } });
    const olderCount = totalCount - RECENT_MESSAGE_COUNT;

    if (olderCount <= 0) return;

    // Fetch only the older portion — skip loading the last 15 from the DB
    const messagesToSummarize = await this.prisma.message.findMany({
      where: { roomId },
      orderBy: { createdAt: 'asc' },
      take: olderCount,
      select: {
        content: true,
        type: true,
        user: { select: { name: true } },
      },
    });

    const chatMessages = messagesToSummarize.map((m) => this.toChatMessage(m));
    const summary = await this.aiModel.summarize(chatMessages);

    await this.prisma.room.update({
      where: { id: roomId },
      data: { contextSummary: summary },
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Maps a DB message row to the model-agnostic ChatMessage type.
   * AI messages become role "assistant"; human messages become role "user"
   * prefixed with the speaker's name.
   */
  private toChatMessage(m: {
    content: string;
    type: string;
    user: { name: string } | null;
  }): ChatMessage {
    if (m.type === MessageType.AI) {
      return { role: 'assistant', content: m.content };
    }
    const speakerName = m.user?.name ?? 'Unknown';
    return { role: 'user', content: `${speakerName}: ${m.content}` };
  }

  private trimToTokenBudget(messages: ChatMessage[]): ChatMessage[] {
    const estimate = (msgs: ChatMessage[]) =>
      msgs.reduce(
        (acc, m) =>
          acc + (typeof m.content === 'string' ? m.content.length : 0),
        0,
      ) / 4;

    // Keep the first message (system prompt) and last message (question) intact
    const head = messages[0];
    const tail = messages[messages.length - 1];
    let middle = messages.slice(1, -1);

    while (
      middle.length > 0 &&
      estimate([head, ...middle, tail]) > MAX_TOKENS
    ) {
      middle = middle.slice(1); // drop oldest conversation message
    }

    return [head, ...middle, tail];
  }
}
