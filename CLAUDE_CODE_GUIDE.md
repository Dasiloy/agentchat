# Kochanet Collaborative Chat — Claude Code Implementation Guide

> **You are implementing a NestJS collaborative chat backend with an on-demand AI assistant.**
> This document is your single source of truth. Follow it exactly. Do not improvise.

---

## ABSOLUTE RULES — READ BEFORE ANY COMMAND

```
1. NEVER install axios. Use the native fetch API everywhere.
2. NEVER expose API keys. All secrets go in .env only.
3. NEVER log user data or tokens to the console.
4. NEVER use console.log in production code. Use NestJS Logger.
5. NEVER write to disk for audio. Stream directly to Cloudinary.
6. NEVER build a full feature in one prompt. Features are built in small, tested bits.
7. NEVER trust client-provided timestamps. Server assigns createdAt at DB insert.
8. NEVER broadcast before persisting. Persist to PostgreSQL first. Always.
9. NEVER write business logic in controllers or gateways. Delegate to services.
10. NEVER add a repository unless explicitly specified below. Only AiModelRepository (AI provider abstraction). Rooms and all other modules inject PrismaService directly.
11. Wrap all service methods in try and cactch, throw error direcvtly if http instance or throw internal server error
```

---

## DEFINITIONS

- **TTS** = Text-To-Speech (OpenAI TTS-1 converts text to audio)
- **TTL** = Time-To-Live (Redis key expiry duration in seconds)
- **STT** = Speech-To-Text (OpenAI Whisper converts audio to text)
- **TTFT** = Time To First Token (latency before AI starts streaming)
- **DM** = Direct Message (private 2-person room)
- **OWNER** = Room creator with invite/delete permissions
- **MEMBER** = Invited room participant

---

## TECH STACK — EXACT VERSIONS

```bash
# Core
@nestjs/core @nestjs/common @nestjs/platform-express
@nestjs/websockets @nestjs/platform-socket.io
@nestjs/config @nestjs/jwt @nestjs/passport

# Auth
passport passport-jwt passport-google-oauth20
@types/passport-jwt @types/passport-google-oauth20
bcrypt @types/bcrypt

# Database
@prisma/client prisma

# Redis + Queue
ioredis @nestjs/bullmq bullmq

# Socket.io Redis Adapter
@socket.io/redis-adapter

# OpenAI
openai

# Cloudinary
cloudinary

# Validation + Security
class-validator class-transformer
@nestjs/throttler helmet

# Swagger
@nestjs/swagger swagger-ui-express

# Testing
jest @nestjs/testing @types/jest ts-jest

# Dev
typescript ts-node @types/node
```

## ENVIRONMENT VARIABLES — .env

```env
# Application
NODE_ENV=development
# PORT
PORT=4000

 # Database
DATABASE_URL=''


# Redis
REDIS_URL=""

# JWT Configuration
JWT_SECRET=""
JWT_SECRET_EXPIRATION=""

# AES Encryption Key
AES_KEY= ""


# OAuth Providers
AUTH_GOOGLE_ID=""
AUTH_GOOGLE_SECRET=""

# Cloudinary
CLOUDINARY_URL=""
CLOUDINARY_SIGNATURE_EXPIRATION=""

# OpenAI
OPENAI_API_KEY=

# Standard client URLs
NEXT_PUBLIC_APP_URL=""
```

---

## PROJECT STRUCTURE

```
src/
├── main.ts                          # Already done, just validate
├── app.module.ts                    # Root module
│
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts           # /auth/register, /auth/login, /auth/google, /auth/me, /auth/logout
│   ├── auth.service.ts
│   ├── strategies/
│   │   ├── jwt.strategy.ts
│   │   └── google.strategy.ts
│   └── guards/
│       ├── jwt-auth.guard.ts        # REST endpoints
│       ├── ws-jwt.guard.ts          # WebSocket events
│       └── room-member.guard.ts     # Room-scoped WebSocket events
│
├── users/
│   ├── users.module.ts
│   ├── users.controller.ts          # /users/search
│   └── users.service.ts
│
├── rooms/
│   ├── rooms.module.ts
│   ├── rooms.controller.ts          # /rooms CRUD + /dm
│   ├── rooms.service.ts
│   └── repositories/
│       ├── room.repository.ts       # Abstract class
│       └── prisma-room.repository.ts # validate the ideal way for repository and how to use them
│
├── messages/
│   ├── messages.module.ts
│   ├── messages.controller.ts       # GET /rooms/:id/messages
│   └── messages.service.ts
│
├── gateway/
│   ├── gateway.module.ts
│   └── chat.gateway.ts              # All WebSocket event handlers
    └── presence.service.ts          # Redis heartbeat + online/offline
│
├── ai/
│   ├── ai.module.ts
│   ├── ai.service.ts                # @ai detection, queue, rate limit
│   ├── ai.processor.ts              # BullMQ worker
│   ├── context.service.ts           # Sliding window + rolling summary
│   └── repositories/
│       ├── ai-model.repository.ts   # Abstract class
│       └── openai-model.repository.ts # best way to add repository here,
│
├── voice/
│   ├── voice.module.ts
│   ├── voice.controller.ts          # POST /voice/upload
│   └── voice.service.ts             # Whisper STT + TTS + Cloudinary
│
└── common/
    ├── decorators/
    │   └── current-user.decorator.ts
    ├── filters/
    │   ├── http-exception.filter.ts
    │   └── ws-exception.filter.ts
```

---

## DATABASE SCHEMA — Prisma

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

enum RoomType {
  CHANNEL
  DM
}

enum MemberRole {
  OWNER
  MEMBER
}

enum MessageType {
  TEXT
  VOICE
  AI
}

enum AccountProvider {
  GOOGLE
  GITHUB
  APPLE
  LOCAL
}

model User {
  id             String          @id @default(cuid())
  email          String          @unique  // constraints plus index
  name           String
  avatar         String?
  hashedPassword String?         // null for OAuth users
  googleId       String?         @unique
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt

  accounts       Account[]
  memberships    RoomMember[]
  messages       Message[]
  receipts       MessageReceipt[]
}


model Account {
  id                String          @id @default(cuid())
  userId            String
  provider          AccountProvider
  providerAccountId String
  refreshToken      String?         @db.Text // encrypted at rest
  accessToken       String?         @db.Text // encrypted at rest
  expiresAt         Int?
  user              User            @relation(fields: [userId], references: [id], onDelete: Cascade)

  // time stamps
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([provider, providerAccountId])
}

model Room {
  id             String      @id @default(cuid())
  name           String?     // null for DM rooms
  description    String?
  type           RoomType    @default(CHANNEL)
  isPrivate      Boolean     @default(true)
  createdBy      String?      // cuid of owner, no relationshhip here so rooms can stay when owner deletes his accoount
  memberCount    Int         @default(0)
  contextSummary String?     // rolling AI context summary
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  members        RoomMember[]
  messages       Message[]
}

model RoomMember {
  roomId    String
  userId    String
  role      MemberRole @default(MEMBER)
  joinedAt  DateTime   @default(now())

  room      Room       @relation(fields: [roomId], references: [id], onDelete: Cascade)
  user      User       @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([roomId, userId])// compund id, so a user cant be invited to a room twice
  @@index([userId])
}

model Message {
  id        String        @id @default(cuid())
  roomId    String
  userId    String?       // null for AI messages
  content   String
  type      MessageType   @default(TEXT)
  audioUrl  String?
  metadata  Json?         // { invokedBy?, contextSize?, model?, audioDuration? }
  createdAt DateTime      @default(now())

  room      Room          @relation(fields: [roomId], references: [id], onDelete: Cascade)
  user      User?         @relation(fields: [userId], references: [id], onDelete: SetNull)
  receipts  MessageReceipt[]

  @@index([roomId, createdAt(sort: Desc)])
  @@index([userId])
}

model MessageReceipt {
  id          String    @id @default(cuid())
  messageId   String
  userId      String
  deliveredAt DateTime?
  readAt      DateTime?

  message     Message   @relation(fields: [messageId], references: [id], onDelete: Cascade)
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([messageId, userId])
  @@index([userId])
}
```

---

## REPOSITORY CONTRACTS — ABSTRACT CLASSES

> RoomRepository removed — RoomsService injects PrismaService directly. No abstraction needed for a single committed ORM.

### AiModelRepository

```typescript
// src/ai/repositories/ai-model.repository.ts
export abstract class AiModelRepository {
  abstract stream(
    messages: ChatMessage[],
    opts?: ChatOptions,
  ): AsyncIterable<string>;
  abstract transcribe(audio: Buffer, mimeType: string): Promise<string>;
  abstract synthesize(text: string): Promise<Buffer>;
  abstract summarize(messages: ChatMessage[]): Promise<string>;
}
```

---

## WEBSOCKET EVENTS REFERENCE

### Client → Server

| Event               | Payload                      | Guards             |
| ------------------- | ---------------------------- | ------------------ |
| `join_room`         | `{ roomId, lastMessageId? }` | WsJwt + RoomMember |
| `leave_room`        | `{ roomId }`                 | WsJwt              |
| `send_message`      | `{ roomId, content }`        | WsJwt + RoomMember |
| `typing_start`      | `{ roomId }`                 | WsJwt + RoomMember |
| `typing_stop`       | `{ roomId }`                 | WsJwt + RoomMember |
| `message_delivered` | `{ messageId }`              | WsJwt              |
| `messages_read`     | `{ roomId, upToMessageId }`  | WsJwt + RoomMember |
| `heartbeat`         | `{}`                         | WsJwt              |
| `room_active`       | `{ roomId }`                 | WsJwt + RoomMember |

### Server → Client

| Event                  | Recipient         | Payload                                                   |
| ---------------------- | ----------------- | --------------------------------------------------------- |
| `room_snapshot`        | Joining user      | `{ messages, members, presence, typingNow, unreadCount }` |
| `new_message`          | Whole room        | `{ id, content, type, user, roomId, createdAt }`          |
| `typing_update`        | Whole room        | `{ userId, name, isTyping }`                              |
| `user_joined`          | Whole room        | `{ userId, name }`                                        |
| `user_left`            | Whole room        | `{ userId }`                                              |
| `ai_thinking`          | Whole room        | `{ triggeredBy: name }`                                   |
| `ai_token`             | Whole room        | `{ token, tempMessageId }`                                |
| `ai_response_complete` | Whole room        | `{ messageId, tempMessageId }`                            |
| `ai_audio_ready`       | Whole room        | `{ messageId, audioUrl }`                                 |
| `voice_transcribed`    | Whole room        | `{ messageId, transcript, audioUrl }`                     |
| `receipt_update`       | Sender only       | `{ messageIds, userId, status }`                          |
| `ephemeral`            | Sender only       | `{ type, message, ttl }`                                  |
| `missed_messages`      | Reconnecting user | `Message[]`                                               |

---

## ERROR HANDLING RULES

```
Server errors  → log with NestJS Logger (logger.error)
User errors    → return friendly message, never expose stack trace
WebSocket      → emit ephemeral event to sender, never crash the gateway
Validation     → ValidationPipe formats field-level errors, return 400
OpenAI errors  → catch in processor, emit ai_error to room, move to DLQ after retries
DB errors      → catch in service, throw HttpException(503), never expose Prisma errors
Auth errors    → always return 401, never say "user not found" vs "wrong password"
```

**HttpExceptionFilter** must catch all exceptions and return:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "User-friendly message here",
  "timestamp": "2026-04-03T14:00:00Z"
}
```

Never include stack traces, Prisma error codes, or internal server details in responses.

---

## SECURITY RULES

```
1. Helmet on in main.ts — all security headers set
2. CORS restricted to FRONTEND_URL from .env
3. Global ValidationPipe — all DTOs validated before reaching controllers
4. JwtAuthGuard global — all REST endpoints protected except /auth/* and /health
5. WsJwtGuard on every WebSocket event
6. RoomMemberGuard on every room-scoped WebSocket event
7. HTML sanitisation — strip tags from message content before saving
8. Prompt injection — wrap user content in delimiters before sending to OpenAI
9. bcrypt rounds 10 — never store plain passwords
10. All secrets in .env — never in code, never logged
```

---

## REDIS KEY STRUCTURE

```
presence:{userId}              TTL: 35s   Value: "online"
typing:{roomId}:{userId}       TTL: 5s    Value: "1"
active:{roomId}:{userId}       TTL: 60s   Value: "1"
socket:{userId}                TTL: 86400s Value: socketId
user:{userId}                  TTL: 300s  Value: JSON user object (auth cache)
ai-rate:{userId}:{minuteBucket} TTL: 60s  Value: count (incr)
```

---

## AI CONTEXT BUILDING — EXACT LOGIC

```
1. Count total messages in room
2. If count ≤ 50: fetch ALL messages, map to ChatMessage array
3. If count > 50:
   a. Load room.contextSummary (may be null)
   b. Fetch last 15 messages verbatim
   c. Build: [system: summary || "No prior context"] + [last 15 messages]
4. Prefix every message with speaker name: "Alice: {content}"
5. AI messages use role: "assistant", human messages use role: "user"
6. Append system prompt:
   "You are a helpful AI assistant in a professional team workspace.
    Room: {roomName}. Participants: {names}.
    Be concise and direct. Address users by name when relevant."
7. Append the @ai question as the final user turn (strip @ai prefix)
8. Verify total token count < 100,000. If over, trim oldest messages.
9. Call AiModelRepository.stream()
```

---

## CLAUDE CODE PROMPTS — USE IN ORDER

> Use these prompts one at a time. Wait for each to complete and test before continuing.

---

### PROMPT 2 — Prisma Module

```
Create the Prisma database module for the Kochanet project.

Create:
1. src/prisma/prisma.service.ts
   - Extends PrismaClient
   - Implements OnModuleInit (calls this.$connect())
   - Implements OnModuleDestroy (calls this.$disconnect())
   - No console.log — use NestJS Logger

2. src/prisma/prisma.module.ts
   - Global module
   - Exports PrismaService

Rules:
- No other files needed for this step
- PrismaService must be injectable in any module

Test to write (ONE test only):
- prisma.service.spec.ts: test that the service connects without throwing

Verify: pnpm test passes.
```

---

### PROMPT 3 — Auth Module: Register and Login

```
Create the authentication register and login endpoints for cahatagent.

Create ONLY these files:
1. src/auth/dto/register.dto.ts — { email, password (min 8), name }
2. src/auth/dto/login.dto.ts — { email, password }
3. src/auth/auth.service.ts — register() and login() methods only
4. src/auth/auth.controller.ts — POST /auth/register and POST /auth/login
5. src/auth/auth.module.ts

Rules:
- Passwords hashed with bcrypt rounds 10
- JWT issued with 24h expiry
- JWT payload: { sub: userId, email }
- 409 if email already registered
- on register create local account
- 401 if credentials invalid — NEVER say "user not found", always "invalid credentials"
- User cached in Redis after login: SET user:{userId} {JSON} EX 300
- No refresh tokens
- Use NestJS Logger, not console.log

JSDoc required on every service method following this format:
/**
 * @description [what this method does]
 * @param name - description
 * @returns description
 * @throws {ConflictException} when email already exists
 */

Tests to write (business logic only, mock Prisma):
- register: should hash password before saving
- register: should throw ConflictException if email exists
- login: should return accessToken on valid credentials
- login: should throw UnauthorizedException on wrong password

Verify: pnpm test passes. Manually test POST /api/auth/register with Swagger.
```

---

### PROMPT 4 — Auth Module: JWT Guard + Google OAuth

```
Add JWT guard and Google OAuth to the existing auth module.

Create ONLY:
1. src/auth/strategies/jwt.strategy.ts
   - Validates JWT from Authorization: Bearer header
   - On each request: check Redis cache user:{userId} first
   - On Redis miss: query PostgreSQL, cache result for 300s
   - Attaches user to request.user

2. src/auth/strategies/google.strategy.ts
   - passport-google-oauth20 strategy
   - Callback: find or create user by googleId/email

3. src/common/guards/jwt-auth.guard.ts — extends AuthGuard('jwt')

4. src/common/guards/ws-jwt.guard.ts
   - Validates token from client.handshake.auth.token
   - Attaches user to client.data.user

5. src/common/decorators/current-user.decorator.ts
   - Extracts req.user for REST endpoints

6. Add to auth.controller.ts:
   - GET /auth/google
   - GET /auth/google/callback
   - GET /auth/me (protected)
   - POST /auth/logout (clears Redis cache)

Rules:
- Set JwtAuthGuard as GLOBAL guard in app.module.ts
- Mark /auth/register, /auth/login, /auth/google, /auth/google/callback, /health as @Public()
- Create @Public() decorator using SetMetadata
- On auth failure: return 401 with message "Unauthorized" — never expose reason

Tests (mock Redis + Prisma):
- jwt.strategy: should return cached user without DB query on cache hit
- jwt.strategy: should query DB and cache on cache miss
- jwt.strategy: should throw UnauthorizedException if user not in DB

Verify: pnpm test passes. GET /api/auth/me returns 401 without token.
```

---

### PROMPT 5 — Rooms Module

```
Create the rooms module. No repository layer — inject PrismaService directly.

Create ONLY:
1. src/rooms/dto/create-room.dto.ts — { name?, description?, type?: RoomType }
2. src/rooms/rooms.service.ts — createRoom(), getMyRooms(), getRoom(), deleteRoom(), inviteUser(), removeMember(), createOrGetDm()
3. src/rooms/rooms.controller.ts — all room endpoints from API contract
4. src/rooms/rooms.module.ts

Rules:
- RoomsService injects PrismaService (from CommonModule — no need to re-import).
- inviteUser: OWNER only. findOrCreate via upsert on RoomMember. Increment memberCount in same transaction.
- createOrGetDm: check for existing DM room before creating. Cannot DM yourself.
- deleteRoom: CASCADE handled by Prisma onDelete. Also broadcast room_deleted via gateway (emit event).
- GET /rooms: include lastMessage preview and unreadCount per room

JSDoc on every service method.

Tests (mock PrismaService):
- createRoom: should set creator as OWNER and increment memberCount
- inviteUser: should throw ForbiddenException if caller is not OWNER
- inviteUser: should not throw on duplicate invite (upsert)
- createOrGetDm: should return existing DM room if one exists

Verify: pnpm test passes. POST /api/rooms creates a room.
```

---

### PROMPT 6 — WebSocket Gateway: Connect + Join + Send

```
Create the WebSocket gateway with the core chat events.

Create ONLY:
1. src/auth/guards/room-member.guard.ts — WsGuard, validates roomId in payload via PrismaService (roomMember lookup directly)
2. src/gateway/chat.gateway.ts — ONLY these events: handleConnection, handleDisconnect, join_room, send_message
3. src/gateway/gateway.module.ts
4. src/common/filters/ws-exception.filter.ts

Rules for handleConnection:
- Validate token via WsJwtGuard (attach user to client.data.user)
- Store: SET socket:{userId} {socketId} EX 86400
- Store: SETEX presence:{userId} 35 "online"
- Reject connection if token invalid (client.disconnect())

Rules for handleDisconnect:
- DEL socket:{userId}
- Clear typing keys for this user
- Broadcast user_left to all rooms this user was in
- Presence expires naturally via TTL

Rules for join_room:
- @UseGuards(WsJwtGuard, RoomMemberGuard)
- client.join(roomId)
- If lastMessageId provided: fetch missed messages, emit missed_messages to sender only
- Fetch room snapshot: last 50 messages + member list + presence per member + typingNow + unreadCount
- Emit room_snapshot to sender only
- Broadcast user_joined to room

Rules for send_message:
- @UseGuards(WsJwtGuard, RoomMemberGuard)
- Validate content (min 1, max 4000 chars)
- Sanitize: strip HTML tags from content
- PERSIST TO POSTGRESQL FIRST
- On DB error: emit ephemeral error to sender, return — do NOT broadcast
- Broadcast new_message to room
- If content.toLowerCase().startsWith('@ai'): call AiService.queueAiResponse()
- Return { status: 'ok', messageId }

Tests (mock dependencies):
- send_message: should persist before broadcasting
- send_message: should emit ephemeral error if DB fails, not broadcast
- send_message: should detect @ai prefix case-insensitively
- join_room: should emit room_snapshot to joining user only

Verify: pnpm test passes. Two browser tabs can exchange messages.
```

---

### PROMPT 7 — Presence + Typing

```
Add presence heartbeat and typing indicators to the existing gateway.

Add to chat.gateway.ts ONLY:
- heartbeat event handler
- typing_start event handler
- typing_stop event handler
- room_active event handler

Create src/presence/presence.service.ts:
- setOnline(userId): SETEX presence:{userId} 35 "online"
- setOffline(userId): DEL presence:{userId}, update users.updatedAt as lastSeen
- isOnline(userId): GET presence:{userId} → boolean
- getPresenceBatch(userIds: string[]): MGET multiple keys → map of userId → online/offline
- setTyping(roomId, userId, name): SETEX typing:{roomId}:{userId} 5 "1", broadcast typing_update to room
- clearTyping(roomId, userId): DEL typing:{roomId}:{userId}, broadcast typing_update to room
- setRoomActive(roomId, userId): SETEX active:{roomId}:{userId} 60 "1"
- getActiveInRoom(roomId): SMEMBERS or scan active:{roomId}:* keys

Rules:
- heartbeat: reset presence TTL only. No broadcast. No DB.
- typing_start: set Redis key + broadcast to room. Do NOT store in DB.
- typing_stop: delete Redis key + broadcast to room.
- room_active: reset room activity TTL only.
- Use MGET for batch presence queries — never loop individual GET calls.

Tests:
- setTyping: should set Redis key with 5s TTL and broadcast typing_update
- clearTyping: should delete Redis key and broadcast isTyping: false
- getPresenceBatch: should return map from single MGET call (verify no loop)

Verify: typing indicator appears in second tab when first tab types.
```

---

### PROMPT 8 — AI Invocation + Queue

```
Create the AI invocation pipeline — detection, queue, rate limiting.

Create ONLY:
1. src/ai/ai.service.ts — queueAiResponse() only (no OpenAI calls yet)
2. src/ai/ai.module.ts — register BullMQ queue "ai-jobs"

Rules for queueAiResponse(roomId, messageId, userId, question):
- Check rate limit: INCR ai-rate:{userId}:{minuteBucket}, EXPIRE 60
- minuteBucket = Math.floor(Date.now() / 60000).toString()
- If count > 5: emit ephemeral rate_limited to sender socket only, return
- Add job to BullMQ: { roomId, messageId, userId, question, attempts: 2, backoff: { type: 'fixed', delay: 3000 } }
- Broadcast ai_thinking to whole room: { triggeredBy: userName }
- Return jobId

Rules:
- No OpenAI calls in this prompt
- No processor in this prompt
- Ephemeral error goes to sender ONLY — never to the room

Tests:
- queueAiResponse: should reject with ephemeral on 6th call in same minute
- queueAiResponse: should broadcast ai_thinking to room before returning
- queueAiResponse: should add job to BullMQ queue

Verify: @ai message shows "AI is thinking..." in both tabs. No AI response yet (processor not built).
```

---

### PROMPT 9 — AI Context Building

```
Create the context building service for the AI.

Create ONLY:
1. src/ai/context.service.ts

Rules for buildContext(roomId: string):
- Count total messages: prisma.message.count({ where: { roomId } })
- If count <= 50: fetch all, map to ChatCompletionMessageParam
- If count > 50:
  - Fetch room.contextSummary
  - Fetch last 15 messages
  - Build: [{ role: 'system', content: summary || 'No prior context' }] + last 15
- Include AI messages: type AI → role: "assistant". Human → role: "user"
- Prefix every human message with speaker name: "Alice: {content}"
- Fetch room.name and all member names for system prompt
- Build system prompt: "You are a helpful AI assistant in a professional team workspace. Room: {name}. Participants: {names}. Be concise and direct."
- Append @ai question as final user turn (with @ai stripped)
- Verify token estimate < 100,000 (rough: 1 token ≈ 4 chars). Trim oldest if over.

Rules for triggerSummaryUpdate(roomId: string) [async, never awaited in request path]:
- Fetch all messages except last 15
- Call AiModelRepository.summarize()
- Update room.contextSummary in DB

JSDoc on both methods.

Tests (mock Prisma + AiModelRepository):
- buildContext: should return all messages verbatim when count <= 50
- buildContext: should return summary + last 15 when count > 50
- buildContext: should include AI messages as role: "assistant"
- buildContext: should prefix human messages with speaker name
- buildContext: should trigger summary update when count > 50 (fire and forget — do not await)

Verify: pnpm test passes.
```

---

### PROMPT 10 — AI Model Repository + Streaming

```
Create the AiModelRepository and OpenAI implementation.

Create ONLY:
Use your discretion and how enteroprise business use repository, the idea is in the future users can switch models in the FE chat
this should allow the server to use the right model, models can be from openai or arthropic or gemini, so this should guide you on what to do
take whatever is proivided after this as my thoughtsand adjust and fine tune to meet what we need. Remmeber this must be self managing?? we wont have to be wswitching from openai class to arthropic class manully because the user switched model in fe
1. src/ai/repositories/ai-model.repository.ts — abstract class (exact from guide)
2. src/ai/repositories/openai-model.repository.ts — implements AiModelRepository

Rules for stream():
- Use openai.chat.completions.create({ model: 'gpt-4o', messages, stream: true })
- Return the raw async iterable — do NOT consume it here
- Do NOT catch errors here — let the processor handle them

Rules for transcribe(audio: Buffer, mimeType: string):
- Use openai.audio.transcriptions.create with the buffer
- Return the text string

Rules for synthesize(text: string):
- Use openai.audio.speech.create({ model: 'tts-1', voice: 'alloy', input: text })
- Return arrayBuffer converted to Buffer

Rules for summarize(messages):
- Use openai.chat.completions.create with gpt-4o-mini (cheap)
- System prompt: "Summarize this conversation preserving names, decisions, and key facts."
- Return the summary text

Register in ai.module.ts:
{ provide: AiModelRepository, useClass: OpenAiModelRepository }

Tests (mock OpenAI):
- stream: should call openai with gpt-4o and stream: true
- transcribe: should pass buffer to openai whisper
- synthesize: should return Buffer

Verify: pnpm test passes.
```

---

### PROMPT 11 — AI Processor: Stream + Save

```
Create the BullMQ processor that handles AI jobs.

Create ONLY:
1. src/ai/ai.processor.ts

Rules for process(job: Job):
- Extract { roomId, messageId, userId, question } from job.data
- Call contextService.buildContext(roomId)
- Call aiModelRepository.stream(context)
- Generate a tempMessageId (cuid or uuid)
- For each token in stream: broadcast ai_token to room { token, tempMessageId }
- Accumulate full response string
- On stream complete:
  - Save to DB: message { type: AI, userId: null, content: fullResponse, roomId, metadata: { invokedBy: userId, contextSize } }
  - Broadcast ai_response_complete to room { messageId: saved.id, tempMessageId }
  - Trigger TTS in background (do not await): voiceService.generateAiAudio(saved.id, fullResponse)
  - Trigger summary update in background: contextService.triggerSummaryUpdate(roomId)

Rules for onFailed(job, error):
- Log error with Logger (not console.log)
- Broadcast ai_error ephemeral to room: "AI Assistant is temporarily unavailable. Please try again."
- Do NOT expose error details to room

Error handling in process():
- Wrap in try/catch
- OpenAI timeout (>30s): set AbortController timeout, catch AbortError
- OpenAI 429: BullMQ backoff handles retry
- Any error: throw — BullMQ retries based on job.opts.attempts

Tests (mock everything):
- process: should broadcast ai_token for each streamed token
- process: should save complete response to DB after stream ends
- process: should trigger TTS without awaiting
- onFailed: should broadcast friendly error to room, not raw error message

Verify: full @ai flow works end to end in browser.
```

---

### PROMPT 12 — Voice: Whisper STT + Cloudinary

```
Create the voice upload endpoint with non-blocking transcription.

Create ONLY:
1. src/voice/voice.service.ts — uploadVoice() and generateAiAudio()
2. src/voice/voice.controller.ts — POST /voice/upload

Rules for uploadVoice(file: Express.Multer.File, roomId: string, userId: string):
- Validate file type (webm, mp3, wav, mp4 only)
- Validate file size (max 10MB)
- Stream buffer to Cloudinary:
  cloudinary.uploader.upload_stream({ resource_type: 'video', folder: 'kochanet/voice' }, callback)
  Pipe the buffer into the upload stream
- Create message in DB: { type: VOICE, content: 'Voice message (transcribing...)', audioUrl: cloudinaryUrl, roomId, userId }
- Broadcast new_message to room immediately (placeholder)
- Queue transcription job in BullMQ (fire and forget)
- Return { messageId, status: 'transcribing' }

Rules for transcription job processor:
- Call aiModelRepository.transcribe(buffer, mimeType)
- Update message.content with transcript
- Update message.metadata.transcript
- Broadcast voice_transcribed to room { messageId, transcript, audioUrl }

Rules for generateAiAudio(messageId: string, text: string):
- Call aiModelRepository.synthesize(text)
- Stream buffer to Cloudinary
- Update message.audioUrl
- Broadcast ai_audio_ready to room { messageId, audioUrl }

Rules:
- NEVER write to disk. Buffer in memory only.
- NEVER expose Cloudinary errors to client. Log and return generic error.
- Cloudinary credentials from .env only.

Tests:
- uploadVoice: should reject non-audio file types
- uploadVoice: should reject files > 10MB
- uploadVoice: should persist message before broadcasting
- uploadVoice: should NOT await transcription (fire and forget)

Verify: voice message shows placeholder then transcript in both tabs.
```

---

### PROMPT 13 — Read Receipts

```
Add read receipts to the existing gateway.

Add to chat.gateway.ts ONLY:
- message_delivered event handler
- messages_read event handler

Rules for message_delivered({ messageId }):
- Upsert MessageReceipt: { messageId, userId, deliveredAt: now }
- Get room.memberCount from DB
- If memberCount < 10: find sender socketId via GET socket:{senderId}, emit receipt_update to sender only
- If memberCount >= 10: increment Redis counter read-count:{messageId}, schedule debounced notification (3s)
- If memberCount >= 100: do nothing (no receipts)

Rules for messages_read({ roomId, upToMessageId }):
- Same tier logic as message_delivered
- Bulk upsert receipts for all messages up to upToMessageId that are not already read
- Notify each unique sender with their messages' read status

Rules:
- receipt_update goes to SENDER ONLY via their socketId in Redis
- Batch DB writes in a transaction
- Debounce via setTimeout + Redis flag: SET receipt-debounce:{senderId}:{messageId} 1 EX 3

Tests:
- message_delivered: should not emit receipt for rooms >= 100 members
- messages_read: should bulk upsert receipts in one transaction
- messages_read: should only notify affected senders, not everyone

Verify: tick indicators update in HTML test page.
```

---

### PROMPT 14 — Direct Messages

```
Add direct messaging support.

Add to rooms.service.ts:
- createOrGetDm(initiatorId: string, targetId: string): Promise<Room>

Add to rooms.controller.ts:
- POST /dm

Add to RoomRepository + PrismaRoomRepository:
- findExistingDm(userIdA: string, userIdB: string): Promise<Room | null>

Rules:
- Cannot DM yourself (throw BadRequestException)
- Check if DM room already exists between these two users before creating
- DM rooms: type = DM, isPrivate = true, name = null
- Both users added as MEMBER (no OWNER for DM rooms)
- Return existing room if found (idempotent)
- GET /rooms must return DM rooms alongside channels in the inbox

Tests:
- createOrGetDm: should return existing room without creating a duplicate
- createOrGetDm: should throw BadRequestException when userId === targetId
- createOrGetDm: should create room with both users as MEMBER

Verify: two users can initiate a DM and chat privately.
```

---

### PROMPT 15 — Users Search + Health

```
Add the users search endpoint and health check.

Create:
1. src/users/users.controller.ts — GET /users/search
2. src/health/health.controller.ts — GET /health (NOT prefixed with /api)

Rules for users/search:
- Query param: q (min 3 chars, required)
- Search by email prefix OR name prefix (case-insensitive ILIKE)
- Return max 10 results: [{ id, name, email, avatar }]
- Never return hashedPassword or googleId

Rules for health:
- Check PostgreSQL: prisma.$queryRaw`SELECT 1`
- Check Redis: redis.ping()
- Return { status: 'ok' | 'degraded', postgres: bool, redis: bool }
- 200 if all ok, 503 if any check fails
- Mark as @Public() — no auth required
- Render uses this endpoint for automatic restart

Tests:
- searchUsers: should return max 10 results
- searchUsers: should throw BadRequestException if q < 3 chars
- health: should return degraded status if Redis ping fails

Verify: GET /health returns 200. GET /users/search?q=ali returns matching users.
```

---

### PROMPT 16 — Swagger + Final Cleanup

```
Complete the Swagger documentation and final cleanup.

Tasks:
1. Add @ApiTags, @ApiOperation, @ApiResponse, @ApiBearerAuth decorators to ALL controllers
2. Add @ApiProperty to ALL DTOs
3. Add Swagger response examples to key endpoints
4. Verify all endpoints appear correctly at /api/docs
5. Add @description to all JSDoc blocks that are missing it
6. Run full test suite: pnpm test
7. Fix any failing tests
8. Remove any remaining console.log statements (search entire codebase)
9. Verify no API keys in any source file (grep for sk-, AKIA, cloudinary key patterns)
10. Run pnpm build — fix any TypeScript errors
11. Add Github action simple for running test on push to main
12. Update Readme especially endpoints and trade-offs
13. ensure all types, interfaces and enums hgo to @types folder, no types inside services,controllers and business logic, modules,repository and all.
14. no imports start wioth src in files inclusing tests, jest struggles with those kind of imports

Final checks:
- Every WebSocket event has a guard
- Every controller method has a JSDoc with @description, @param, @returns, @throws
- Every service method has complete JSDoc
- No console.log anywhere in src/
- No hardcoded secrets anywhere in src/
- pnpm test passes
- pnpm build passes

Do NOT add new features in this prompt. Clean up only.
```

---

### PROMPT 17 — HTML Test Page

```
~~Create a single self-contained HTML file: test-client/index.html~~

~~Requirements:~~
~~- Zero dependencies (no React, no Vue, no build step)~~
~~- Vanilla JavaScript only~~
~~- Connects to API_URL defined at the top of the file (easy to update before submission)~~
~~- Uses Socket.io client from CDN~~

Layout:
~~Left panel: Login form, Google OAuth button~~, Rooms list, Create Room button
Right panel: Active room header, Message list, Typing indicator, Message input, Voice button

Features to implement in order:
~~1. Login / register form → store token in memory (NOT localStorage)~~
2. Load rooms list with unread counts
3. Open a room → connect WebSocket, join room, receive snapshot
4. Send text message → appears instantly in both tabs
5. Typing indicator → show when other user types
6. Presence indicator → green dot for online users
7. @ai message → show "AI is thinking...", tokens stream in live, audio play button appears
8. Voice message → file input, shows "transcribing...", then transcript
9. Read receipt ticks under messages (single tick = sent, double = delivered, blue = read)
10. Reconnection → auto-reconnect, load missed messages
11. when inviting user, turn input to search so they can search by email or name, do the same for dm.
12. remove input used for removing user, add cross icon on member avatra to remove them and also add confirmation, owner cant remove themselves, they must leave
13: Add voice audio recorder and enabkle speaker to support audio
14. FE must match all Be implementations
15: no bugs

Rules:
~~- Token stored in Localstorage for persistence on refresh
-- Loading spinner when authing on rfersh to prevent showing login and sign up form
~~- WebSocket auth token sent in handshake.auth.token~~
~~- All API calls use fetch (no axios)~~
- On server error responses: show user-friendly message, never raw error
- File must work when opened directly in browser pointing at Render URL
```

---

## TROUBLESHOOTING

### Prisma errors

```
Error: Can't reach database server
→ Check DATABASE_URL in .env
→ Verify PostgreSQL is running: pg_isready

Error: Prisma Client is not generated
→ Run: pnpm prisma generate

Error: Migration pending
→ Run: pnpm prisma migrate dev (local) or pnpm prisma migrate deploy (production)
```

### Redis errors

```
Error: connect ECONNREFUSED 127.0.0.1:6379
→ Redis not running. Start with: redis-server

Error: WRONGTYPE Operation against a key holding the wrong kind of value
→ Redis key type mismatch. Flush test Redis: redis-cli FLUSHDB (test only, never production)
```

### WebSocket errors

```
Error: WebSocket is closed before the connection is established
→ Check that CORS origin allows the client origin
→ Verify WsJwtGuard is not rejecting the token

Error: TypeError: client.data.user is undefined
→ WsJwtGuard is not attached to this event
→ Verify @UseGuards(WsJwtGuard) is on the event handler
```

### OpenAI errors

```
Error: 401 Unauthorized
→ OPENAI_API_KEY is wrong or not set in .env

Error: 429 Too Many Requests
→ BullMQ will retry automatically with exponential backoff
→ Check your OpenAI plan limits

Error: Context length exceeded
→ ContextService token check is not catching this
→ Reduce WINDOW_SIZE in context.service.ts
```

### Cloudinary errors

```
Error: Must supply cloud_name
→ CLOUDINARY_CLOUD_NAME not set in .env

Error: Invalid Signature
→ CLOUDINARY_API_KEY or CLOUDINARY_API_SECRET wrong
```

### Build errors

```
Error: Cannot find module '@nestjs/...'
→ Run: pnpm install

Error: Type 'X' is not assignable to type 'Y'
→ Fix TypeScript types — never use 'as any' to silence
```

---

Bugs

1. on refresh, unread count is wrong? is the read recceipt not working?
2. This eeror might be able the last message id, the issue is if a user have not entered a group, on tab refresh, he sees wrong lkabel for unread messages count, when a message comes in before he neters,m once he enters, only the last message that came in is fetched, the previous group messages are lost
