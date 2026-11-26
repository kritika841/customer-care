import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { ensureAuthSchema, withRequestDatabase } from "../lib/database";
import { operationsDb } from "../lib/operations/schema";
import {
  issuePersistedSession,
  SESSION_COOKIE_NAME,
  type DashboardUser,
} from "../lib/auth/session";
import { GET as supportGET, POST as supportPOST } from "../app/api/support/route";
import { GET as streamGET } from "../app/api/support/stream/route";
import { GET as logsGET } from "../app/api/logs/route";
import { GET as healthSyncGET } from "../app/api/health/sync/route";
import {
  GET as metaWebhookGET,
  POST as metaWebhookPOST,
} from "../app/api/support/meta/webhook/route";
import { POST as gmailPushPOST } from "../app/api/support/gmail/push/route";

// Safety hard-lock: never allow live outbound during integration testing
process.env.AI_LIVE_OUTBOUND_ENABLED = "false";
process.env.SESSION_SECRET ||= "test-session-secret-satmi-support-2026-layer3-integration";
process.env.SUPPORT_TOKEN_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.META_APP_SECRET ||= "layer3-test-meta-secret";
process.env.META_WEBHOOK_VERIFY_TOKEN ||= "layer3-test-verify-token";
process.env.GMAIL_PUSH_SERVICE_ACCOUNT ||= "push@satmi-test.iam.gserviceaccount.com";
process.env.GMAIL_PUSH_AUDIENCE ||= "https://support.satmi.in/api/support/gmail/push";

const ORIGIN = "http://127.0.0.1:5010";

function makeAuthedRequest(
  path: string,
  options: {
    method?: "GET" | "POST";
    cookie?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const method = options.method || "GET";
  const headers: Record<string, string> = {
    host: "127.0.0.1:5010",
    origin: ORIGIN,
    ...(options.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${options.cookie}` } : {}),
    ...(options.body !== undefined || options.rawBody !== undefined
      ? { "Content-Type": "application/json" }
      : {}),
    ...(options.headers || {}),
  };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body:
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
  });
}

test("Layer 3: API, Concurrency, Security & Failure-Injection Integration Suite", async (t) => {
  const suffix = randomUUID().slice(0, 8);
  const adminUser: DashboardUser = {
    id: `usr_l3_admin_${suffix}`,
    email: `l3.admin.${suffix}@satmi.in`,
    name: "Layer3 Admin",
    role: "admin",
  };
  const managerUser: DashboardUser = {
    id: `usr_l3_mgr_${suffix}`,
    email: `l3.mgr.${suffix}@satmi.in`,
    name: "Layer3 Manager",
    role: "support_manager",
  };
  const agentUser: DashboardUser = {
    id: `usr_l3_agent_${suffix}`,
    email: `l3.agent.${suffix}@satmi.in`,
    name: "Layer3 Agent",
    role: "support_agent",
  };
  const viewerUser: DashboardUser = {
    id: `usr_l3_viewer_${suffix}`,
    email: `l3.viewer.${suffix}@satmi.in`,
    name: "Layer3 Viewer",
    role: "viewer",
  };

  const ticketIds = [
    `t_l3_1_${suffix}`,
    `t_l3_2_${suffix}`,
    `t_l3_3_${suffix}`,
  ];
  let badLogId: number | null = null;

  let adminCookie = "";
  let managerCookie = "";
  let agentCookie = "";
  let viewerCookie = "";

  await withRequestDatabase(async () => {
    const db = await operationsDb();
    await ensureAuthSchema(db);

    for (const u of [adminUser, managerUser, agentUser, viewerUser]) {
      await db
        .prepare(
          `INSERT INTO auth_users (id, email, encrypted_password, name, role, session_version)
           VALUES (?, ?, crypt('TestPass123!', gen_salt('bf')), ?, ?, 1)
           ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
        )
        .bind(u.id, u.email, u.name, u.role)
        .run();

      if (u.role !== "viewer") {
        await db
          .prepare(
            `INSERT INTO support_agents (user_id, email, name, role, available)
             VALUES (?, ?, ?, ?, TRUE)
             ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, available = TRUE`,
          )
          .bind(u.id, u.email, u.name, u.role)
          .run();
      }
    }

    adminCookie = await issuePersistedSession(adminUser);
    managerCookie = await issuePersistedSession(managerUser);
    agentCookie = await issuePersistedSession(agentUser);
    viewerCookie = await issuePersistedSession(viewerUser);

    await db
      .prepare(
        `INSERT INTO support_mailboxes (email, connected_by)
         VALUES ('kritika@satmi.in', ?)
         ON CONFLICT (email) DO NOTHING`,
      )
      .bind(adminUser.id)
      .run();

    for (let i = 0; i < ticketIds.length; i++) {
      const tid = ticketIds[i];
      await db
        .prepare(
          `INSERT INTO support_tickets (
             id, mailbox, gmail_thread_id, subject, customer_email, customer_name,
             assignee_id, status, priority, channel, version
           ) VALUES (?, 'kritika@satmi.in', ?, ?, ?, ?, ?, 'open', 'normal', 'instagram', 1)`,
        )
        .bind(
          tid,
          `l3_thread_${tid}`,
          `Layer 3 Test Subject ${i + 1}`,
          `@l3_customer_${i + 1}`,
          `Layer3 Customer ${i + 1}`,
          agentUser.id,
        )
        .run();

      await db
        .prepare(
          `INSERT INTO support_messages (
             id, ticket_id, message_id, direction, sender, recipients, body, delivery_status
           ) VALUES (?, ?, ?, 'inbound', ?, 'instagram', ?, 'received')`,
        )
        .bind(
          `msg_in_${tid}`,
          tid,
          `<in-${tid}@satmi.in>`,
          `Layer3 Customer ${i + 1}`,
          `Unique inbound query for ticket ${tid}: What is the price of Original Karungali Malai?`,
        )
        .run();
    }
  });

  try {
    await t.test("1. Security: role gating (401/403), malformed JSON handling (400), and health/logs/stream endpoints", async () => {
      // Unauthenticated -> 401
      const unauthSupport = await supportGET(makeAuthedRequest("/api/support"));
      assert.equal(unauthSupport.status, 401);

      const unauthLogs = await logsGET(makeAuthedRequest("/api/logs"));
      assert.equal(unauthLogs.status, 401);

      const unauthHealth = await healthSyncGET(makeAuthedRequest("/api/health/sync"));
      assert.equal(unauthHealth.status, 401);

      const unauthStream = await streamGET(makeAuthedRequest("/api/support/stream"));
      assert.equal(unauthStream.status, 401);

      // Viewer role without support access -> 403
      const viewerRes = await supportGET(
        makeAuthedRequest("/api/support", { cookie: viewerCookie }),
      );
      assert.equal(viewerRes.status, 403);

      // Support Agent trying to access manager-only endpoints -> 403
      const agentInsights = await supportGET(
        makeAuthedRequest("/api/support?mode=insights", { cookie: agentCookie }),
      );
      assert.equal(agentInsights.status, 403);

      const agentTokens = await supportGET(
        makeAuthedRequest("/api/support?mode=token_usage", { cookie: agentCookie }),
      );
      assert.equal(agentTokens.status, 403);

      const agentLogs = await logsGET(
        makeAuthedRequest("/api/logs", { cookie: agentCookie }),
      );
      assert.equal(agentLogs.status, 403);

      const agentMemoryCmd = await supportPOST(
        makeAuthedRequest("/api/support", {
          method: "POST",
          cookie: agentCookie,
          body: { action: "ai_memory_command", instruction: "List memories" },
        }),
      );
      assert.equal(agentMemoryCmd.status, 403);

      // Support Manager trying to access admin-only nomenclature_update -> 403
      const mgrNomenclature = await supportPOST(
        makeAuthedRequest("/api/support", {
          method: "POST",
          cookie: managerCookie,
          body: {
            action: "nomenclature_update",
            ticketLabelSingular: "Case",
            ticketLabelPlural: "Cases",
          },
        }),
      );
      assert.equal(mgrNomenclature.status, 403);

      // Malformed JSON body -> 400 (never 500)
      const malformedRes = await supportPOST(
        makeAuthedRequest("/api/support", {
          method: "POST",
          cookie: adminCookie,
          rawBody: "{corrupted_json: true",
        }),
      );
      assert.equal(malformedRes.status, 400);

      // Malformed details_json row in activity_logs -> /api/logs returns 200 cleanly
      await withRequestDatabase(async () => {
        const db = await operationsDb();
        const inserted = await db
          .prepare(
            `INSERT INTO activity_logs (source, event_type, level, message, details_json, created_at)
             VALUES ('layer3_test', 'malformed_json_test', 'warn', 'Test malformed details_json', '{bad_json', ?)
             RETURNING id`,
          )
          .bind(new Date().toISOString())
          .first<{ id: number }>();
        badLogId = inserted?.id ?? null;
      });

      const logsRes = await logsGET(
        makeAuthedRequest("/api/logs", { cookie: managerCookie }),
      );
      assert.equal(logsRes.status, 200);
      const logsJson = (await logsRes.json()) as { logs: Array<{ id: number; details: Record<string, unknown> }> };
      assert.ok(Array.isArray(logsJson.logs));

      // /api/health/sync -> 200
      const healthRes = await healthSyncGET(
        makeAuthedRequest("/api/health/sync", { cookie: agentCookie }),
      );
      assert.equal(healthRes.status, 200);
      const healthJson = (await healthRes.json()) as { state: string };
      assert.ok(["syncing", "healthy", "stale"].includes(healthJson.state));

      // /api/support/stream -> 200 SSE sync frame
      const abortCtrl = new AbortController();
      const streamReq = new Request(
        `${ORIGIN}/api/support/stream?ticket=${encodeURIComponent(ticketIds[0])}`,
        {
          method: "GET",
          headers: {
            host: "127.0.0.1:5010",
            cookie: `${SESSION_COOKIE_NAME}=${agentCookie}`,
          },
          signal: abortCtrl.signal,
        },
      );
      const streamRes = await streamGET(streamReq);
      assert.equal(streamRes.status, 200);
      assert.match(streamRes.headers.get("content-type") || "", /text\/event-stream/);
      const reader = streamRes.body?.getReader();
      assert.ok(reader);
      const firstChunk = await reader.read();
      abortCtrl.abort();
      const frameText = new TextDecoder().decode(firstChunk.value);
      assert.match(frameText, /event: sync/);
      assert.match(frameText, /"selectedVersion":1/);
    });

    await t.test("2. Meta Webhook HMAC verification & Gmail Push JWT verification", async () => {
      // Meta GET challenge verification
      const badChallenge = await metaWebhookGET(
        new Request(
          `${ORIGIN}/api/support/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=12345`,
        ),
      );
      assert.equal(badChallenge.status, 403);

      const goodChallenge = await metaWebhookGET(
        new Request(
          `${ORIGIN}/api/support/meta/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
            process.env.META_WEBHOOK_VERIFY_TOKEN!,
          )}&hub.challenge=satmi_challenge_ok`,
        ),
      );
      assert.equal(goodChallenge.status, 200);
      assert.equal(await goodChallenge.text(), "satmi_challenge_ok");

      // Meta POST invalid HMAC -> 401
      const payloadStr = JSON.stringify({ object: "page", entry: [] });
      const badHmacRes = await metaWebhookPOST(
        new Request(`${ORIGIN}/api/support/meta/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-hub-signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
          },
          body: payloadStr,
        }),
      );
      assert.equal(badHmacRes.status, 401);

      // Meta POST valid HMAC -> 200
      const validSig =
        "sha256=" +
        createHmac("sha256", process.env.META_APP_SECRET!)
          .update(payloadStr)
          .digest("hex");
      const goodHmacRes = await metaWebhookPOST(
        new Request(`${ORIGIN}/api/support/meta/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-hub-signature-256": validSig,
          },
          body: payloadStr,
        }),
      );
      assert.equal(goodHmacRes.status, 200);

      // Gmail push without valid Bearer JWT -> 401
      const badPushRes = await gmailPushPOST(
        new Request(`${ORIGIN}/api/support/gmail/push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: { data: "" } }),
        }),
      );
      assert.equal(badPushRes.status, 401);
    });

    await t.test("3. Rapid ticket switching: concurrent GET /api/support?ticket=... + POST viewing with zero SQL 26000 errors and zero mismatched messages", async () => {
      const switchTasks: Array<Promise<void>> = [];

      for (let round = 0; round < 4; round++) {
        for (const tid of ticketIds) {
          switchTasks.push(
            (async () => {
              const [getRes, viewRes] = await Promise.all([
                supportGET(
                  makeAuthedRequest(`/api/support?ticket=${encodeURIComponent(tid)}`, {
                    cookie: agentCookie,
                  }),
                ),
                supportPOST(
                  makeAuthedRequest("/api/support", {
                    method: "POST",
                    cookie: agentCookie,
                    body: { action: "viewing", ticketId: tid },
                  }),
                ),
              ]);

              assert.equal(getRes.status, 200, `GET /api/support?ticket=${tid} failed with ${getRes.status}`);
              assert.equal(viewRes.status, 200, `POST viewing for ${tid} failed with ${viewRes.status}`);

              const snapshot = (await getRes.json()) as {
                selectedTicket: { id: string } | null;
                messages: Array<{ id: string; ticket_id: string; body: string }>;
              };
              assert.ok(snapshot.selectedTicket, "Expected selectedTicket to be present");
              assert.equal(
                snapshot.selectedTicket.id,
                tid,
                `Mismatched selectedTicket.id: expected ${tid}, got ${snapshot.selectedTicket.id}`,
              );
              assert.ok(snapshot.messages.length >= 1, `Expected messages for ticket ${tid}`);
              for (const msg of snapshot.messages) {
                assert.equal(
                  msg.ticket_id,
                  tid,
                  `Cross-ticket message leak detected! Message ${msg.id} belongs to ${msg.ticket_id} during fetch for ${tid}`,
                );
                assert.match(msg.body, new RegExp(tid));
              }
            })(),
          );
        }
      }

      await Promise.all(switchTasks);
    });

    await t.test("4. Idempotency (requestKey deduplication), optimistic locking (version 409), and AI per-ticket lease lock (409)", async () => {
      const targetTicketId = ticketIds[0];
      const idemKey = `req_idem_${suffix}`;

      const [noteRes1, noteRes2] = await Promise.all([
        supportPOST(
          makeAuthedRequest("/api/support", {
            method: "POST",
            cookie: agentCookie,
            body: {
              action: "note",
              ticketId: targetTicketId,
              version: 1,
              body: "Idempotent internal note test",
              requestKey: idemKey,
            },
          }),
        ),
        supportPOST(
          makeAuthedRequest("/api/support", {
            method: "POST",
            cookie: agentCookie,
            body: {
              action: "note",
              ticketId: targetTicketId,
              version: 1,
              body: "Idempotent internal note test",
              requestKey: idemKey,
            },
          }),
        ),
      ]);

      assert.equal(noteRes1.status, 200);
      assert.equal(noteRes2.status, 200);

      // Verify exactly 1 row in support_messages for request_key = idemKey
      await withRequestDatabase(async () => {
        const db = await operationsDb();
        const countRow = await db
          .prepare("SELECT COUNT(*)::int AS cnt FROM support_messages WHERE request_key = ?")
          .bind(idemKey)
          .first<{ cnt: number }>();
        assert.equal(countRow?.cnt, 1, "Idempotent requestKey must never create duplicate message rows");
      });

      // Stale version -> 409 Conflict
      const staleRes = await supportPOST(
        makeAuthedRequest("/api/support", {
          method: "POST",
          cookie: agentCookie,
          body: {
            action: "status",
            ticketId: targetTicketId,
            version: 1, // ticket is now version 2 after the note
            status: "in_progress",
          },
        }),
      );
      assert.equal(staleRes.status, 409);
      const staleJson = (await staleRes.json()) as { error: string };
      assert.match(staleJson.error, /updated by another teammate/i);

      // AI per-ticket lease lock -> 409 Conflict on concurrent ai_run_ticket
      const lockedTicketId = ticketIds[1];
      await withRequestDatabase(async () => {
        const db = await operationsDb();
        await db
          .prepare(
            "UPDATE support_tickets SET ai_lock_until = now() + interval '60 seconds' WHERE id = ?",
          )
          .bind(lockedTicketId)
          .run();
      });

      const lockedAiRes = await supportPOST(
        makeAuthedRequest("/api/support", {
          method: "POST",
          cookie: agentCookie,
          body: { action: "ai_run_ticket", ticketId: lockedTicketId },
        }),
      );
      assert.equal(lockedAiRes.status, 409);
      const lockedAiJson = (await lockedAiRes.json()) as { error: string };
      assert.match(lockedAiJson.error, /already running/i);

      // Release lock for next test
      await withRequestDatabase(async () => {
        const db = await operationsDb();
        await db
          .prepare("UPDATE support_tickets SET ai_lock_until = NULL WHERE id = ?")
          .bind(lockedTicketId)
          .run();
      });
    });

    await t.test("5. Failure injection: simulated Gemini 429 & 500 bursts during ai_run_ticket recover cleanly with zero live outbound sends", async () => {
      const targetTicketId = ticketIds[1];
      const origFetch = globalThis.fetch;
      const prevRetryBase = process.env.AI_PROVIDER_RETRY_BASE_MS;
      process.env.AI_PROVIDER_RETRY_BASE_MS = "10";

      let chatAttempts = 0;
      try {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (url.includes(":generateContent")) {
            chatAttempts++;
            if (chatAttempts === 1) {
              return new Response('{"error":{"code":429,"message":"Simulated 429 burst"}}', {
                status: 429,
              });
            }
            if (chatAttempts === 2) {
              return new Response('{"error":{"code":500,"message":"Simulated 500 error"}}', {
                status: 500,
              });
            }
            return new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            decision: "auto_reply",
                            confidence: 0.94,
                            reasoning: "Grounded in Original Karungali Malai product catalog chunk.",
                            customerReplyDraft:
                              "Hi there,\n\nThe Original Karungali Malai 108-Beads Ebony Wood is available at ₹699 (MRP ₹1,487) and comes with Government Lab Certification.\n\n— Team Satmi",
                            shouldResolveTicket: true,
                            suggestedPriority: "normal",
                            suggestedTags: ["AI Answered", "product"],
                            questionForAdmin: "",
                            missingKnowledgeTopic: "",
                            humanActionCategory: "",
                            humanActionSummary: "",
                            citedDocumentIds: [],
                          }),
                        },
                      ],
                    },
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 420,
                  candidatesTokenCount: 85,
                  totalTokenCount: 505,
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes(":embedContent")) {
            const vec = Array.from({ length: 768 }, (_, idx) => Math.cos(idx + 1) * 0.04);
            return new Response(
              JSON.stringify({ embedding: { values: vec } }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return origFetch(input, init);
        }) as typeof fetch;

        const aiRes = await supportPOST(
          makeAuthedRequest("/api/support", {
            method: "POST",
            cookie: agentCookie,
            body: { action: "ai_run_ticket", ticketId: targetTicketId },
          }),
        );
        assert.equal(aiRes.status, 200);
        const aiJson = (await aiRes.json()) as {
          ok: boolean;
          provider: string;
          safeModeActive: boolean;
          aiStatus: string;
          decision: { decision: string; customerReplyDraft: string };
        };
        assert.equal(aiJson.ok, true);
        assert.equal(aiJson.provider, "gemini");
        assert.equal(aiJson.safeModeActive, true);
        assert.equal(aiJson.aiStatus, "draft_ready");
        assert.equal(aiJson.decision.decision, "auto_reply");
        assert.equal(chatAttempts, 3);

        // Verify draft is saved strictly as 'ai_draft' and ZERO live outbound rows exist for this ticket
        await withRequestDatabase(async () => {
          const db = await operationsDb();
          const outboundRows = await db
            .prepare(
              "SELECT delivery_status FROM support_messages WHERE ticket_id = ? AND direction = 'outbound'",
            )
            .bind(targetTicketId)
            .all<{ delivery_status: string }>();
          assert.equal(outboundRows.results.length, 1);
          assert.equal(outboundRows.results[0].delivery_status, "ai_draft");
        });
      } finally {
        globalThis.fetch = origFetch;
        if (prevRetryBase === undefined) delete process.env.AI_PROVIDER_RETRY_BASE_MS;
        else process.env.AI_PROVIDER_RETRY_BASE_MS = prevRetryBase;
      }
    });
  } finally {
    // Clean up all Layer 3 test fixtures
    await withRequestDatabase(async () => {
      const db = await operationsDb();
      if (badLogId !== null) {
        await db.prepare("DELETE FROM activity_logs WHERE id = ?").bind(badLogId).run();
      }
      for (const tid of ticketIds) {
        await db.prepare("DELETE FROM support_ai_token_usage WHERE ticket_id = ?").bind(tid).run();
        await db.prepare("DELETE FROM support_ai_escalations WHERE ticket_id = ?").bind(tid).run();
        await db.prepare("DELETE FROM support_events WHERE ticket_id = ?").bind(tid).run();
        await db.prepare("DELETE FROM support_messages WHERE ticket_id = ?").bind(tid).run();
        await db.prepare("DELETE FROM support_tickets WHERE id = ?").bind(tid).run();
      }
      for (const u of [adminUser, managerUser, agentUser, viewerUser]) {
        await db.prepare("DELETE FROM dashboard_sessions WHERE user_id = ?").bind(u.id).run();
        await db.prepare("DELETE FROM support_agents WHERE user_id = ?").bind(u.id).run();
        await db.prepare("DELETE FROM auth_users WHERE id = ?").bind(u.id).run();
      }
      await db.close();
    });
  }
});
