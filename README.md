# Satmi Customer Support System

Autonomous, AI-first omnichannel Customer Support hub built with Next.js 16, React 19, PostgreSQL (`pg`), Gemini AI, Gmail REST API, and Meta Graph API (Instagram DM + Facebook Messenger).

## Features

- **Unified Omnichannel Inbox (Gmail, Instagram DM, Facebook Messenger)**:
  - Gmail OAuth 2.0 + PKCE connection with AES-256-GCM encrypted token storage (`SUPPORT_TOKEN_KEY`), incremental `history.list` sync, and Google Cloud Pub/Sub webhook (`/api/support/gmail/push`) with OIDC verification.
  - Instagram & Facebook Messenger sync (`/api/support/meta/webhook` with fail-closed HMAC-SHA256 verification and `META_WEBHOOK_VERIFY_TOKEN` handshake).
  - Transactional outboxes with advisory locks, leased sending (`sending` / `uncertain` recovery), and duplicate-send protection.
- **AI-First Triage, RAG & Safe Escalation**:
  - Rolling conversation compaction, Store RAG retrieval (`support_ai_documents`), PII-scrubbed escalation memory, configurable debounce (`debounceSeconds`), and mandatory human-action policies.
  - Verification-gated order lookups, draft-safety validation, and fail-closed live-outbound gating (`AI_LIVE_OUTBOUND_ENABLED` + DB mode + channel allowlist).
- **Ticket Queues & Least-Loaded Auto-Assignment**:
  - Views for **My Open**, **Unassigned**, **Escalated**, **All Open**, **Waiting**, and **Closed** tickets with configurable ticket nomenclature.
  - Least-loaded auto-assignment (`assignWaitingTickets`) and optimistic concurrency checks (`version`).
- **Agent Workspace (`SupportPanel.tsx`)**:
  - Omnichannel workspace with clean plain-text message rendering, SSRF-hardened attachment proxy, customer order context sidebar, internal notes, quick-reply templates, and activity audit logs.
- **Self-Hosted PostgreSQL Authentication**:
  - Authenticates against `auth_users` in PostgreSQL using `pgcrypto` (`crypt()`) and DB-validated HMAC-SHA256 `satmi_session` cookies (`lib/auth/session.ts` + `dashboard_sessions`) with login rate limiting and `proxy.ts` route protection.

---

## Quick Start

### 1. Configure Environment Variables

Copy `.env.example` to `.env.local` and fill in your credentials:

```bash
cp .env.example .env.local
```

Required variables:
- `SUPABASE_DB_URL` (or `DATABASE_URL`): PostgreSQL connection string for your shared database.
- `SESSION_SECRET`: Required 32+ character secret used to sign `satmi_session` cookies.
- `NEXT_PUBLIC_APP_URL`: Canonical origin used for OAuth callbacks and CSAT links (e.g. `http://localhost:5010` in dev, `https://support.yourdomain.com` in prod).
- `SUPPORT_MAILBOX`: Shared support email address (default: `contact@satmi.in`).
- `SUPPORT_TOKEN_KEY`: 32-byte key (base64 or 64-char hex) for AES-256-GCM OAuth token encryption. Generate with:
  ```bash
  openssl rand -base64 32
  ```
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`: Google Cloud OAuth 2.0 credentials for Gmail API access.
- `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`: Meta App secret and private webhook verify token for Messenger / Instagram webhook verification.
- `GEMINI_API_KEY`: Google Gemini API key for embeddings and draft generation.
- `CRON_SECRET`: Secret token for `/api/cron/support` and `scripts/scheduler.mjs`.

### 2. Start Local Dev Database (Optional) & Apply Support Schema

```bash
npm run local:db
npm run check:support
npm run apply:support
```

### 3. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:5010](http://localhost:5010).

### 4. Run the Background Support Sync Scheduler (Optional)

To poll `/api/cron/support` every 5 minutes locally or on a VPS:

```bash
npm run scheduler
```

---

## Scripts

- `npm run dev` — Start Next.js development server on port `5010`
- `npm run build` — Build production bundle
- `npm run start` — Start production server on port `5010`
- `npm run test:support` — Run unit tests (`tests/support.test.ts`)
- `npm run check:support` — Validate required environment variables
- `npm run apply:support` — Apply PostgreSQL support tables, migrations, & indexes
- `npm run local:db` — Start local PGlite database server on `localhost:54321`
- `npm run scheduler` — Run 5-minute background Gmail/Meta sync, AI auto-draft, & outbox flush loop
