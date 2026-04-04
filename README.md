# Agentchat Backend

A real-time team workspace backend with an on-demand AI assistant. Built with NestJS, TypeScript, Socket.io, PostgreSQL, Redis, and OpenAI.

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
│  │  Auth    │  │  Rooms   │  │ Messages │  │  AI Module   │  │
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
   │  receipts     │  │  sessions   │  └─────────────┘
   └───────────────┘  └─────────────┘

```

---

## Technology Choices

| Concern       | Choice                        | Why                                                                            |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| Framework     | NestJS + TypeScript           | Required. Module system, DI, guards, gateways all used deliberately            |
| Real-time     | Socket.io + Redis Adapter     | Named rooms, auto-reconnect, multi-instance pub/sub built in                   |
| Database      | PostgreSQL + Prisma           | Relational model fits chat data perfectly. Typed ORM. Cursor pagination.       |
| Cache         | Redis (ioredis)               | Ephemeral state (typing) never touches PostgreSQL , avoid high DB hit          |
| Queue         | BullMQ                        | AI job sequencing, retry with backoff, dead-letter queue (enables audit)       |
| Auth          | JWT + Passport + Google OAuth | Stateless, 24h expiry, one social provider                                     |
| AI            | OpenAI gpt-4o streaming       | Required. Token streaming via Socket.io to whole room                          |
| STT           | OpenAI Whisper                | Same API key, non-blocking transcription                                       |
| TTS           | OpenAI TTS-1                  | Same API key, runs after text response completes                               |
| Audio Storage | Cloudinary                    | Buffer streaming, CDN delivery, survives redeployment                          |
| API Docs      | Swagger                       | Auto-generated from decorators                                                 |
| Deployment    | Render                        | GitHub push → auto-deploy, managed PostgreSQL + Redis (managed with blueprint) |

---

## Real-Time Communication

Messages flow: **validate → persist to PostgreSQL → broadcast via Socket.io → acknowledge**

The message is saved to the database **before** being broadcast. If broadcast fails, the recipient requests missed messages on reconnect using their `lastMessageId`. A message is never lost.

Presence and typing indicators live in **Redis only** — never written to PostgreSQL. Presence uses a 35-second TTL key reset by a 30-second client heartbeat. Typing uses a 5-second TTL that auto-expires if the client crashes. The Redis Adapter broadcasts events across multiple server instances (prepared for scaling).Right now we only have just one server instance.

When a user joins a room mid-conversation, they receive a complete `room_snapshot` containing: last 50 messages (On Scroo up, they can request more), all member profiles, presence status for each member, active typing indicators, and unread message count.

---

## AI Integration

The AI is invoked by prefixing a message with `@ai`. It never processes messages that do not invoke it — it is a team member that joins when called, not a passive interceptor.

**What the AI receives as context:**

Strategy is compaction and sliding window => RAG can be added incrementally

- A system prompt naming all room participants and the room name
- For conversations ≤ 50 messages: all messages verbatim, prefixed with speaker names
- For conversations > 50 messages: a rolling summary of older messages + last 15 verbatim
- AI messages from previous turns are included — the AI has awareness of its own previous responses

**Concurrent @ai invocations** are handled by a BullMQ queue with sequential processing per room. Every question gets answered in order. Nothing is silently dropped. Rate limit: 5 @ai calls per user per minute to avoid brute force attack.

**Streaming:** Tokens are broadcast via Socket.io to every member of the room as they arrive from OpenAI. All participants see the AI response being written in real time. The Frontend can batch receive in miliseconds to avoid excessive state update.

---

## Ambiguity Resolutions

| Question                   | Decision                                   | Why                                              |
| -------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Public vs private rooms?   | Private by default, invite-only            | Professional workspace — security first,         |
| AI invocation mechanism?   | @ai prefix                                 | Explicit, unambiguous, matches @mention metaphor |
| Multiple simultaneous @ai? | Sequential queue per room                  | Every question answered, nothing dropped         |
| How much history for AI?   | Last 15 + rolling summary                  | Cost-effective, full conversation awareness      |
| Room permissions?          | OWNER/MEMBER, invite by OWNER only         | Simple, extensible, secure                       |
| Voice blocking?            | Non-blocking — placeholder then transcript | Conversation keeps flowing                       |
| Access token vs refresh?   | Access token only, 24h expiry              | 2-3 hours saved, sufficient for evaluation       |

---

## Known Limitations and Tradeoffs

**Access token only (no refresh):** Tokens are valid for 24 hours with no server-side revocation. A stolen token cannot be invalidated before expiry. Production fix: Redis blacklist + short-lived access tokens (15 min) with refresh rotation.

**Single socket per user:** If a user opens two browser tabs, private events (read receipts, error notices) go only to the most recently connected tab. Production fix: store a SET of socketIds per user in Redis.

**Sequential AI queue:** In a very active room, later @ai questions wait for earlier ones to complete. Could create a 10-15 second wait if multiple questions queue simultaneously. Tradeoff: correctness over throughput — every question is answered. This remains the biggest trade-off.

**No full-text message search:** Not implemented. Production path: PostgreSQL `tsvector` GIN index on `messages.content`.

**No message reactions, edit, or threads:** Scope management — these are explicitly documented below as the first features to add with more time.

**Google OAuth only:** Satisfies the one social provider requirement. Additional providers (GitHub, Microsoft) follow the identical Passport strategy pattern, approximately 1 hour each.

---

## What I Would Do With More Time

1. **Message reactions** (2-6hr) — reactions table, emoji picker, broadcast
2. **Message search** (3hr) — PostgreSQL full-text GIN index
3. **File sharing + AI parsing** (4hr) — Cloudinary upload, OpenAI vision/text
4. **Token refresh rotation** (3hr) — short-lived access + refresh with Redis blacklist
5. **pgvector RAG** (8hr) — embed messages, semantic retrieval for AI context
6. **Multi-tab presence** (2hr) — Redis SET of socketIds per user
7. **Docker + Kubernetes** (4hr) — containerisation, horizontal scaling manifests
8. **Email invitations for unregistered users** (3-4hr) — Currently only users with existing accounts can be invited to a room (invite-by-email resolves against registered users only, returning 404 for unknown addresses). With more time, the invite flow would generate a signed invitation token, persist it, and send an email to the address via a transactional email provider (e.g. Resend or SendGrid). Clicking the link would create the account and auto-join the room in one step.

---

## Setup Instructions

### Prerequisites

```bash
Node.js >= 18
pnpm (install: npm install -g pnpm)
PostgreSQL >= 14
Redis >= 7
```

### Local Development

```bash
git clone https://github.com/Dasiloy/agentchat.git
cd agentchat
pnpm install
cp .env.example .env
# Fill in all values in .env
pnpm prisma migrate dev
pnpm start:dev
```

### Running Tests

```bash
pnpm test          # unit tests
pnpm test:e2e      # integration tests
pnpm test:cov      # coverage report
```

---

## Live Demo

**API Base URL:** `https://chatagent.onrender.com`
**API Documentation:** `https://chatagent.onrender.com/docs`
**Test Client:** Open `test-client/index.html` in your browser ///?

### Test Credentials

| User  | Email                    | Password   |
| ----- | ------------------------ | ---------- |
| Alice | alice@chatagent-demo.com | $Demo1234! |
| Bob   | bob@chatagent-demo.com   | $Demo1235! |

### Testing Real-Time Features

1. Open `test-client/index.html` in **Tab 1** → Login as Alice ///?
2. Open `test-client/index.html` in **Tab 2 (Incognito)** → Login as Bob ///?
3. Alice creates a room and invites Bob via email
4. Both users join the room

**Test checklist:**

- [ ] Alice sends a message → Bob sees it instantly
- [ ] Alice starts typing → Bob sees "Alice is typing..."
- [ ] Close Bob's tab → Alice sees Bob go offline
- [ ] Reopen Bob's tab → Alice sees Bob come back online
- [ ] Alice types `@ai what causes Docker networking issues after restart?` → AI streams response to both tabs
- [ ] Both type `@ai` questions simultaneously → both answered in order
- [ ] Alice sends a voice message → both see transcript when ready
- [ ] Close and reopen Alice's tab → full message history loads

### WebSocket Testing (Swagger/Manual)

Connect to `wss://chatagent.onrender.com` with: ///?

```json
{ "auth": { "token": "your-jwt-token" } }
```

Example events:

```json
// Join a room
{ "event": "join_room", "data": { "roomId": "room_id_here" } }

// Send a message
{ "event": "send_message", "data": { "roomId": "room_id", "content": "Hello!" } }

// Invoke AI
{ "event": "send_message", "data": { "roomId": "room_id", "content": "@ai explain Redis TTL" } }
```

---

## API Reference

Full documentation at `/docs`. Key endpoints:

| Method | Endpoint            | Auth         | Description                                       |
| ------ | ------------------- | ------------ | ------------------------------------------------- |
| POST   | /auth/register      | No           | Register with email + password                    |
| POST   | /auth/login         | No           | Login, receive JWT                                |
| GET    | /auth/google        | No           | Initiate Google OAuth                             |
| GET    | /auth/me            | Yes          | Get current user                                  |
| GET    | /rooms              | Yes          | Inbox: all rooms with last message + unread count |
| POST   | /rooms              | Yes          | Create a channel                                  |
| POST   | /dm                 | Yes          | Start or get a direct message                     |
| POST   | /rooms/:id/invite   | Yes (OWNER)  | Invite user by email                              |
| GET    | /rooms/:id/messages | Yes (member) | Message history with cursor pagination            |
| POST   | /voice/upload       | Yes (member) | Upload voice message                              |
| GET    | /users/search?q=    | Yes          | Search users by name or email                     |
| GET    | /health             | No           | Service health check                              |
