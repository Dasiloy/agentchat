# Agentchat Backend

A real-time team workspace backend with an on-demand AI assistant. Built with NestJS, TypeScript, Socket.io, PostgreSQL, Redis, and OpenAI.

---

## Chief Contributor

| ![dasiloy](https://avatars.githubusercontent.com/dasiloy?v=4&s=150) |
| :-----------------------------------------------------------------: |
|              **[dasiloy](https://github.com/dasiloy)**              |
|                    _Lead Architect / Developer_                     |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                         CLIENTS                              │
│              Browser — WebSocket + REST HTTP                 │
└───────────────────┬──────────────────────┬───────────────────┘
                    │ Socket.io             │ REST (HTTPS)
                    │                       │
┌───────────────────▼───────────────────────▼───────────────────┐
│                    NESTJS APPLICATION                          │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Auth    │  │  Rooms   │  │  Users   │  │  AI Module   │  │
│  │  Module  │  │  Module  │  │  Module  │  │  + Processor │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │
│  ┌──────────┐  ┌────────────────────────────────────────────┐  │
│  │  Voice   │  │  WebSocket Gateway (Socket.io)             │  │
│  │  Module  │  │  + Redis Adapter (multi-instance pub/sub)  │  │
│  └──────────┘  └────────────────────────────────────────────┘  │
└────────────────────────────┬───────────────────────────────────┘
                             │
            ┌────────────────┼─────────────────┐
            │                │                 │
   ┌────────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
   │  PostgreSQL   │  │    Redis    │  │   OpenAI    │
   │               │  │             │  │             │
   │  users        │  │  presence   │  │  gpt-4o     │
   │  rooms        │  │  typing     │  │  whisper-1  │
   │  messages     │  │  ai-queue   │  │  tts-1      │
   │  receipts     │  │  rate-limit │  └─────────────┘
   │  sessions     │  └─────────────┘
   └───────────────┘
```

---

## Technology Choices

| Concern       | Choice                        | Why                                                                           |
| ------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| Frameworks    | NestJS + TypeScript           | Module system, DI, guards, gateways all used deliberately                     |
| Real-time     | Socket.io + Redis Adapter     | Named rooms, auto-reconnect, multi-instance pub/sub built in                  |
| Database      | PostgreSQL + Prisma           | Relational model fits chat data. Typed ORM. Cursor pagination.                |
| Cache         | Redis (ioredis)               | Ephemeral state (typing, presence) never touches PostgreSQL                   |
| Queue         | BullMQ                        | AI job sequencing, retry with backoff, dead-letter queue                      |
| Auth          | JWT + Passport + Google OAuth | Access token (1d) + refresh token (7d), session table, token-type enforcement |
| AI            | OpenAI gpt-4o streaming       | Token streaming via Socket.io to whole room in real time                      |
| STT           | OpenAI Whisper                | Same API key, non-blocking transcription via BullMQ queue                     |
| TTS           | OpenAI TTS-1                  | Same API key, runs after text response completes, voice-in → audio-out only   |
| Audio Storage | Cloudinary                    | Buffer streaming, CDN delivery, survives redeployment                         |
| API Docs      | Swagger                       | Auto-generated from decorators at `/docs`                                     |
| Deployment    | Render                        | GitHub push → auto-deploy, managed PostgreSQL + Redis via blueprint           |

---

## URL Structure

The server exposes three namespaces:

| Namespace        | URL                      | Notes                                                 |
| ---------------- | ------------------------ | ----------------------------------------------------- |
| REST API         | `{SERVER_URL}/api/*`     | All REST endpoints live under `/api/`                 |
| Swagger UI       | `{SERVER_URL}/docs`      | Interactive API docs — excluded from `/api/` prefix   |
| Health check     | `{SERVER_URL}/health`    | Returns 200 — excluded from `/api/` prefix            |
| Test client (FE) | `{SERVER_URL}/`          | Static HTML/JS test client served from `test-client/` |
| WebSocket        | `{SERVER_URL}/` (ws/wss) | Socket.io on the root namespace                       |

**Live instance:**

- API base: `https://agentchat-pcjs.onrender.com/api`
- Swagger: `https://agentchat-pcjs.onrender.com/docs`
- Test client: `https://agentchat-pcjs.onrender.com`

---

## REST API Reference

Full interactive documentation at `/docs`. All endpoints except `register`, `login`, `refresh`, `google`, and `health` require `Authorization: Bearer <accessToken>`.

Per-module endpoint documentation (request shapes, response examples, error codes) lives alongside each controller:

| Module | Reference file                                   |
| ------ | ------------------------------------------------ |
| Auth   | [src/auth/api_doc.json](src/auth/api_doc.json)   |
| Rooms  | [src/rooms/api_doc.json](src/rooms/api_doc.json) |
| Voice  | [src/voice/api_doc.json](src/voice/api_doc.json) |
| Users  | [src/users/api_doc.json](src/users/api_doc.json) |

---

## Standard Response Envelope

Every REST endpoint returns the same shape:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Human-readable result",
  "data": { ... }
}
```

Errors use the same envelope with `success: false` and include a `message` field.

---

## WebSocket API

Connect with Socket.io to `{SERVER_URL}/`. Pass the JWT in the handshake:

```js
const socket = io('https://agentchat-pcjs.onrender.com', {
  auth: { token: '<your-jwt>' },
});
```

### Events the client emits (client → server)

| Event               | Payload                      | Description                                                                                              |
| ------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `join_room`         | `{ roomId, lastMessageId? }` | Join a room. Receives `room_snapshot`. `lastMessageId` skips full fetch if client is already up to date. |
| `send_message`      | `{ roomId, content }`        | Send a text message. Include the word `siri` anywhere to invoke Siri.                                    |
| `typing_start`      | `{ roomId }`                 | User started typing. Auto-expires after 5 s.                                                             |
| `typing_stop`       | `{ roomId }`                 | User stopped typing.                                                                                     |
| `message_delivered` | `{ messageId }`              | Mark a message as delivered (seen in viewport).                                                          |
| `messages_read`     | `{ roomId, upToMessageId }`  | Mark all messages up to `upToMessageId` as read.                                                         |
| `subscribe_rooms`   | `{ roomIds: string[] }`      | Subscribe to room-level events after reconnect without fetching snapshots.                               |
| `heartbeat`         | _(no payload)_               | Resets the 35 s presence TTL. Send every ~30 s.                                                          |

### Events the server emits (server → client)

| Event                  | Payload                                                                | Description                                                             |
| ---------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `room_snapshot`        | `{ roomId, messages, members, presence, unreadCount }`                 | Full state when joining a room                                          |
| `new_message`          | Full message object with user                                          | A new message was sent to the room                                      |
| `user_joined`          | `{ userId, name, roomId }`                                             | A user joined the room                                                  |
| `user_left`            | `{ userId, roomId }`                                                   | A user disconnected                                                     |
| `typing_update`        | `{ roomId, userId, name, isTyping }`                                   | Typing state changed for a user                                         |
| `presence_update`      | `{ userId, status: 'online' \| 'offline' }`                            | User presence changed                                                   |
| `receipt_update`       | `{ messageId, deliveredCount }` or `{ roomId, readBy, upToMessageId }` | Delivery or read receipt update                                         |
| `ai_thinking`          | `{ triggeredBy }`                                                      | AI is processing — show loading indicator                               |
| `ai_token`             | `{ token, tempMessageId }`                                             | Single streamed token from AI response                                  |
| `ai_response_complete` | `{ messageId, tempMessageId, content }`                                | Siri response finished — replace temp bubble with final deduped content |
| `voice_transcribed`    | `{ messageId, transcript, audioUrl }`                                  | Voice message transcription finished                                    |
| `ai_audio_ready`       | `{ messageId, audioUrl }`                                              | TTS audio for an AI response is ready (voice-triggered AI only)         |
| `ephemeral`            | `{ type, message, ttl? }`                                              | Transient notification (error, rate limit). Do not persist.             |

---

## Real-Time Communication

Messages flow: **validate → persist to PostgreSQL → broadcast via Socket.io → acknowledge**

The message is saved to the database **before** being broadcast. If broadcast fails, the recipient requests missed messages on reconnect using their `lastMessageId`. A message is never lost.

Presence and typing indicators live in **Redis only** — never written to PostgreSQL. Presence uses a 35-second TTL key reset by a 30-second client heartbeat. Typing uses a 5-second TTL that auto-expires if the client crashes. The Redis Adapter broadcasts events across multiple server instances (prepared for horizontal scaling).

When a user joins a room mid-conversation, they receive a complete `room_snapshot` containing: last 50 messages, all member profiles, presence status for each member, active typing indicators, and their unread message count.

---

## AI Integration (Siri)

Siri is invoked by including the word `siri` anywhere in a message or voice transcript — no prefix required. It never processes messages that do not mention it — it is a friendly team member that joins when called, not a passive interceptor.

---

### Structured Prompt Strategy

Siri's personality and behaviour are enforced through a structured system prompt generated at runtime in `ContextService.buildContext()`. The prompt is not static — it is dynamically composed from live room data (room name, participant list, triggering user) before every AI call.

The prompt is structured into five explicit numbered rules so the model follows each constraint independently rather than blending them into a vague instruction:

````
You are an active, friendly member of this group chat, not a detached assistant.
Room: {roomName}. Participants: {participantNames}.

1. ADDRESS THE TRIGGERING USER DIRECTLY
   - The user who triggered you is @john. Mention them naturally at the start:
     "@john, you should...", "@john, Docker is great for that..."
   [or, if no user is known:]
   - No specific user triggered you. Infer the primary interlocutor from context.

2. USE PRONOUNS LIKE A HUMAN TEAMMATE
   - Second-person (you, your) for the person you're addressing.
   - Third-person (he, she, they, it) for others, tools, and concepts.
   - Mention the user's name once, then rely on "you".

3. SOUND CONVERSATIONAL AND NATURAL
   - Use contractions (you're, it's, don't, can't).
   - Use softeners: "maybe", "you could", "I'd suggest", "have you tried".
   - Avoid "As an AI", "I am an assistant", or formal language.

4. BE CONCISE AND CONTEXT-AWARE
   - Default to 1–4 sentences unless depth is clearly needed.
   - Ask a short question rather than assume when clarification is needed.

5. FORMAT CODE SNIPPETS PROPERLY
   - Always fence code in triple backticks with a language identifier (```ts, ```bash, etc.).
   - Keep snippets minimal and focused.

Always prioritize clarity, warmth, and sounding like a real person in the group.
````

**Why this approach over a single paragraph prompt:**

| Concern             | Decision                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Addressee injection | Injected dynamically — `@john` appears in rule 1 only when `askedBy` is known; falls back to context inference otherwise  |
| Pronoun discipline  | Explicitly split second/third person to prevent the model from switching to third-person when giving advice to the caller |
| Tone                | Named anti-patterns ("As an AI") are banned by name — models reliably suppress exact phrases they are told to avoid       |
| Code formatting     | Explicit rule with language identifier requirement — prevents bare code blocks in chat                                    |
| Conciseness         | Hard sentence limit (1–4) prevents essay-style responses in a real-time chat context                                      |

---

### Context Window Strategy

Strategy: **compaction + sliding window** (RAG can be added incrementally):

- The structured system prompt above (room + participants + addressee + rules)
- For conversations ≤ 50 messages: all messages verbatim, each prefixed with the speaker's name
- For conversations > 50 messages: a rolling GPT-generated summary of older messages + last 15 verbatim
- Siri's own prior responses are included — it has awareness of its own conversation history
- Token guard: if assembled context exceeds ~100k characters, oldest messages are trimmed first; system prompt and current question are always preserved

**Concurrent invocations** are handled by a BullMQ queue. Every question gets answered in order. Nothing is silently dropped. Rate limit: 5 `siri` calls per user per minute.

**Streaming:** Tokens are broadcast via `ai_token` events to every member of the room as they arrive from OpenAI. All participants see the response being written in real time.

**Voice → Siri bridge:** If a voice message transcript contains the word `siri`, the `VoiceProcessor` automatically queues an AI response job with `tts: true`. Siri streams its reply as normal, then the `AiProcessor` queues a TTS job — resulting in an audio response. Voice in → audio out.

---

## Voice Pipeline

```
POST /api/voice/upload
      │
      ├─ Validate (type + size in controller)
      ├─ Upload buffer to Cloudinary → audioUrl
      ├─ Persist VOICE message (content: "Voice message (transcribing...)")
      ├─ Broadcast new_message to room
      └─ Queue VOICE_TRANSCRIBE job
                │
                └─ VoiceProcessor
                        ├─ Fetch audio from Cloudinary URL
                        ├─ Transcribe via Whisper
                        ├─ Update message.content
                        ├─ Broadcast voice_transcribed
                        └─ If transcript contains "siri":
                                ├─ Broadcast ai_thinking
                                └─ Queue AI_RESPONSE job (tts: true)
                                          │
                                          └─ AiProcessor
                                                  ├─ Stream AI tokens
                                                  ├─ Persist AI message
                                                  ├─ Broadcast ai_response_complete
                                                  └─ Queue VOICE_TTS job
                                                            │
                                                            └─ VoiceProcessor
                                                                    ├─ Synthesize audio (TTS-1)
                                                                    ├─ Upload to Cloudinary
                                                                    ├─ Update message.audioUrl
                                                                    └─ Broadcast ai_audio_ready
```

---

## Read Receipts

The system uses a three-tier approach to avoid flooding large rooms with receipt noise:

| Room size     | Delivery receipts | Read receipts        |
| ------------- | ----------------- | -------------------- |
| < 10 members  | Immediate         | Immediate            |
| 10–99 members | Debounced (3 s)   | Debounced per sender |
| ≥ 100 members | Disabled          | Disabled             |

---

## Ambiguity Resolutions

| Question                          | Decision                                                                                  | Why                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Public vs private rooms?          | Private by default, invite-only                                                           | Professional workspace — security first                         |
| AI invocation mechanism?          | Word `siri` anywhere in message/transcript                                                | Whisper reliably transcribes "Siri"; works anywhere in sentence |
| Multiple simultaneous siri calls? | Sequential queue per room                                                                 | Every question answered, nothing dropped                        |
| How much history for AI?          | Last 15 + rolling summary                                                                 | Cost-effective, full conversation awareness                     |
| Room permissions?                 | OWNER/MEMBER, invite by OWNER only                                                        | Simple, extensible, secure                                      |
| Voice blocking?                   | Non-blocking — placeholder then transcript                                                | Conversation keeps flowing                                      |
| Session management?               | Access token (1d) + refresh token (7d), DB session row per refresh token, rotation on use | Short-lived access + revocable refresh mitigates token theft    |
| Voice siri response format?       | Always TTS — voice in → audio out                                                         | Consistent UX — if you speak, you get spoken back to            |

---

## Known Limitations and Tradeoffs

### Auth

**No server-side access token revocation:** Access tokens are valid for 24 hours with no blacklist. A stolen access token cannot be invalidated before expiry — only the refresh token session can be revoked. Production fix: Redis blacklist for access tokens on logout, with short-lived access tokens (15 min).

**One session per login, no multi-device session list:** Each login creates one `Session` row. Users cannot see or revoke individual device sessions from a UI. Production fix: expose a `GET /auth/sessions` endpoint and allow targeted session revocation.

### Real-time

**Single socket per user:** Only the most recently connected socket ID is tracked in Redis. If a user opens two browser tabs, private events (read receipts, error notices, ephemeral messages) go only to the tab that connected last. Production fix: store a Redis SET of socketIds per user and broadcast to all.

**200-message catch-up cap on rejoin:** When a user reconnects to a room and `lastMessageId` is stale, at most 200 messages newer than their cursor are fetched. If a user was offline during a very high-traffic window, they may miss messages older than the 200-message window from that gap. Production fix: paginated history fetch on the client.

### AI Context Building

**Participant cap (20):** The system prompt given to the AI includes at most 20 participant names (via `take: MAX_PARTICIPANT_NAMES`). In rooms with more than 20 members, later-joined members' names will not appear in the participant list. The AI will still respond correctly but won't know those names.

**Message window (15 + summary):** When a room has more than 50 messages, the AI only sees the last 15 verbatim. Older messages are condensed into a rolling summary via a separate GPT call. Nuance in those older messages can be lost — the summary may miss specifics that a human would remember.

**Token budget trim:** Context is estimated at 1 token ≈ 4 characters. If the assembled context exceeds 100,000 characters (~25,000 tokens), the oldest conversation messages are dropped one by one. Very long rooms under heavy use may have significant context trimmed. The system prompt and the current question are always preserved.

**Summary updates are fire-and-forget:** When `triggerSummaryUpdate` is called, it runs asynchronously with no retry. If it fails (e.g., transient network error, OpenAI timeout), the next AI call uses a stale summary. Errors are only logged — no alerting.

**Rolling summary cost:** Every AI response in a room with >50 messages triggers a second OpenAI call to refresh the summary. This doubles API cost in active, long rooms. Production fix: debounce summary updates (e.g., only if 10+ messages have been added since last summary).

### AI Rate Limiting

**Per-user rate limit is in-memory per instance:** The Redis-backed rate limit (5 `siri` calls/minute/user) is correct for multi-instance deployments. However, the `ai_thinking` broadcast and the job queuing happen after the rate check — a user who is rate-limited will see an ephemeral error, not a suppressed `ai_thinking` event (this ordering is intentional but worth noting).

### Voice

**Transcription re-fetches from Cloudinary:** After upload, the audio buffer is not kept in memory. The `VoiceProcessor` job re-fetches the audio from its Cloudinary URL over HTTP before sending to Whisper. This adds one extra network round-trip (~100–500 ms) to transcription latency, and is susceptible to Cloudinary CDN propagation delay on fresh uploads.

**TTS only for voice-triggered Siri:** Text-based `siri` invocations never receive a TTS (audio) response, regardless of user preference. There is no opt-in flag for text users to request audio. This is intentional — TTS adds Cloudinary upload latency and cost, so it is reserved for the voice-in → audio-out flow only.

**No audio expiry policy:** Voice messages and TTS audio are uploaded to Cloudinary indefinitely. There is no TTL or cleanup job. Over time, storage costs will grow proportionally to message volume.

### Multi-Provider AI Routing

**Anthropic is a stub:** The `ModelRouterService` routes `claude-*` model names to `AnthropicModelRepository`, but all methods in that class throw `NotImplementedException`. Only OpenAI is production-ready. The routing architecture is in place for adding providers without changing any call sites.

**Model routing is prefix-only:** Routing is determined by the model name prefix (`gpt-*` → OpenAI, `claude-*` → Anthropic). If an unknown prefix is passed via the `model` option, a `NotFoundException` is thrown. There is no fallback to the default model on unrecognised names. In production code, we use Langraph here for better handling

### Receipts

**Debounced receipts for mid-size rooms:** For rooms with 10–99 members, delivery and read receipt notifications are debounced via a 3-second Redis key. A sender may see receipt counts update in batches rather than in real time.

**Receipts suppressed for large rooms:** Rooms with ≥ 100 members generate no delivery or read receipt traffic. Senders cannot know if their message was seen.

### General

**No full-text message search:** Not implemented. Production path: PostgreSQL `tsvector` GIN index on `messages.content`.

**No message pagination REST endpoint:** Message history is delivered only via the WebSocket `room_snapshot` on `join_room` (last 50 on first join, up to 200 on reconnect). There is no HTTP endpoint for scrolling history. Frontend must request older messages via the gateway. This is an extra 1h task.

**No message reactions, edit, or threads:** Scope management — these are the first features to add with more time.

**Google OAuth only:** Satisfies the one social provider requirement. Additional providers (GitHub, Microsoft) follow the identical Passport strategy pattern.

**Rate limiter is global per IP:** `ThrottlerGuard` is applied globally at 20 requests/60 s per IP. There is no per-endpoint override — the voice upload endpoint (which can be legitimately slower) consumes from the same bucket as lightweight GET endpoints.

---

## What I Would Do With More Time

1. **Message reactions** (2–6 hr) — reactions table, emoji picker, broadcast
2. **Message history pagination** (3 hr) — REST endpoint with cursor, client scroll-up
3. **Message search** (3 hr) — PostgreSQL full-text GIN index
4. **Access token blacklist** (2 hr) — Redis blacklist on logout for immediate revocation
5. **Multi-device session management** (2 hr) — `GET /auth/sessions` + targeted revocation UI
6. **Multi-tab presence** (2 hr) — Redis SET of socketIds per user
7. **pgvector RAG** (8 hr) — embed messages, semantic retrieval for AI context instead of summary
8. **Summary debounce** (1 hr) — only update summary every N new messages, not every AI call
9. **File sharing + AI parsing** (4 hr) — Cloudinary upload, OpenAI vision/text
10. **Cloudinary audio expiry** (1 hr) — auto-delete voice recordings after N days
11. **Docker + Kubernetes** (4 hr) — containerisation, horizontal scaling manifests
12. **Anthropic provider** (2 hr) — implement `AnthropicModelRepository` with the official SDK
13. **Email invitations** (3–4 hr) — signed invitation tokens + email delivery for unregistered users

---

## Setup Instructions

### Prerequisites

```
Node.js >= 20
pnpm (npm install -g pnpm)
PostgreSQL >= 14
Redis >= 7
Cloudinary account
OpenAI API key
Google OAuth app (client ID + secret)
```

### Environment Variables

Copy `.env.example` and fill in all values:

```bash
cp .env.example .env
```

| Variable                          | Example                          | Description                                       |
| --------------------------------- | -------------------------------- | ------------------------------------------------- |
| `PORT`                            | `4000`                           | HTTP port the server listens on                   |
| `DATABASE_URL`                    | `postgresql://user:pw@host/db`   | Neon or standard PostgreSQL connection string     |
| `REDIS_URL`                       | `redis://localhost:6379`         | Redis connection URL (BullMQ + Socket.io adapter) |
| `JWT_SECRET`                      | `some-very-long-random-string`   | Signing secret for JWTs                           |
| `JWT_SECRET_EXPIRATION`           | `86400s`                         | Token lifetime (e.g. `86400s` = 24 h)             |
| `JWT_REFRESH_TOKEN_EXPIRATION`    | `604800s`                        | Refresh token lifetime (7 days)                   |
| `AES_KEY`                         | `32-char-hex-string`             | AES-256 key for any at-rest encryption            |
| `AUTH_GOOGLE_ID`                  | `xxx.apps.googleusercontent.com` | Google OAuth client ID                            |
| `AUTH_GOOGLE_SECRET`              | `GOCSPX-xxx`                     | Google OAuth client secret                        |
| `CLOUDINARY_URL`                  | `cloudinary://key:secret@cloud`  | Cloudinary SDK URL (from dashboard)               |
| `CLOUDINARY_SIGNATURE_EXPIRATION` | `600`                            | Signed URL expiry in seconds                      |
| `OPENAI_API_KEY`                  | `sk-proj-...`                    | OpenAI API key — needs Whisper, TTS, and GPT-4o   |
| `NEXT_PUBLIC_APP_URL`             | `http://localhost:4000`          | Allowed CORS origin (your frontend URL)           |

### Local Development

```bash
git clone https://github.com/Dasiloy/agentchat.git
cd agentchat
pnpm install
cp .env.example .env
# Fill in all values in .env

pnpm prisma migrate dev    # run database migrations
pnpm prisma generate
pnpm start:dev             # start with file-watching
```

The server starts on `http://localhost:{PORT}`.
Swagger UI is at `http://localhost:{PORT}/docs`.
The test client is at `http://localhost:{PORT}/`.

### Running Tests

```bash
pnpm test          # unit tests (Jest, ~65 tests)
pnpm test:cov      # with coverage report
pnpm test:e2e      # end-to-end tests
```

### Building for Production

```bash
pnpm build                   # compiles TypeScript → dist/
node dist/main.js            # run compiled output
# or
pnpm start:prod
```

---

### Test Credentials

| User  | Email                    | Password   |
| ----- | ------------------------ | ---------- |
| Alice | alice@chatagent-demo.com | $Demo1234! |
| Bob   | bob@chatagent-demo.com   | $Demo1235! |

### Google OAuth — Important Note

The Google OAuth app is currently in **Testing** mode in Google Cloud Console. In this mode, only explicitly whitelisted Google accounts can complete the OAuth flow — all other accounts will hit a "This app is blocked" error.

**Please use the email address you have been using to contact me** to test the Google OAuth flow, as that address has been added to the list of permitted test users in the console.

Email/password login (using the credentials above) works for everyone and has no such restriction.

### Testing Real-Time Features

1. Open `https://agentchat-pcjs.onrender.com` in **Tab 1** → Login as Alice
2. Open `https://agentchat-pcjs.onrender.com` in **Tab 2 (Incognito)** → Login as Bob
3. Alice creates a room and invites Bob via email
4. Both users join the room

**Test checklist:**

- [ ] Alice sends a message → Bob sees it instantly
- [ ] Alice starts typing → Bob sees "Alice is typing..."
- [ ] Close Bob's tab → Alice sees Bob go offline
- [ ] Reopen Bob's tab → Alice sees Bob come back online
- [ ] Alice types `siri, what causes Docker networking issues after restart?` → Siri streams response to both tabs
- [ ] Both mention `siri` simultaneously → both answered in order
- [ ] Alice sends a voice message saying `siri, ...` → transcript appears, then Siri responds in text and audio
- [ ] Close and reopen Alice's tab → full message history loads from the last seen message

---

## CI

A GitHub Actions workflow runs on every push and pull request to `master`:

1. **Unit tests** — installs dependencies, runs `pnpm test` (14 suites, 65 tests)
2. **E2E tests** — runs `pnpm test:e2e` against a focused NestJS test module (auth + health endpoints)

See [.github/workflows/ci.yml](.github/workflows/ci.yml).

---

## License

This project is **proprietary and unlicensed** — all rights reserved.
No part of this source code may be reproduced, distributed, or used without the prior written permission of the author.

Copyright &copy; 2026 [Dasiloy](https://github.com/dasiloy). See [LICENSE](LICENSE) for details.
