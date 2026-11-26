import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureAuthSchema, withRequestDatabase } from "../lib/database";
import { operationsDb } from "../lib/operations/schema";

// Load .env.local if SUPABASE_DB_URL is not already in process.env
if (!process.env.SUPABASE_DB_URL) {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

process.env.AI_LIVE_OUTBOUND_ENABLED = "false";
process.env.SUPPORT_TEST_DRY_RUN = "true";

const TEST_PASSWORD = "E2eSupport!2026";
const E2E_SUFFIX = randomUUID().slice(0, 8);

const ADMIN_USER = {
  id: `usr_e2e_admin_${E2E_SUFFIX}`,
  email: `e2e.admin.${E2E_SUFFIX}@satmi.in`,
  name: "E2E Admin",
  role: "admin",
};
const MANAGER_USER = {
  id: `usr_e2e_mgr_${E2E_SUFFIX}`,
  email: `e2e.manager.${E2E_SUFFIX}@satmi.in`,
  name: "E2E Manager",
  role: "support_manager",
};
const AGENT_USER = {
  id: `usr_e2e_agent_${E2E_SUFFIX}`,
  email: `e2e.agent.${E2E_SUFFIX}@satmi.in`,
  name: "E2E Agent",
  role: "support_agent",
};

const TEST_ORDER_ID = 990001;
const ORDER_TICKET_ID = `t_e2e_order_${E2E_SUFFIX}`;
const POLICY_TICKET_ID = `t_e2e_policy_${E2E_SUFFIX}`;
const QUEUE_TICKET_1_ID = `t_e2e_queue1_${E2E_SUFFIX}`;
const QUEUE_TICKET_2_ID = `t_e2e_queue2_${E2E_SUFFIX}`;
const ORDER_DRAFT_MSG_ID = `m_e2e_draft_ord_${E2E_SUFFIX}`;
const POLICY_DRAFT_MSG_ID = `m_e2e_draft_pol_${E2E_SUFFIX}`;

const createdMemoryTitles: string[] = [];
let priorApprovalMode = true;

function attachStrictPageGuards(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const server5xxResponses: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("response", (res) => {
    if (res.status() >= 500) {
      server5xxResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  return {
    assertZeroErrors() {
      expect(consoleErrors, `Unexpected console.error: ${consoleErrors.join(" | ")}`).toEqual([]);
      expect(pageErrors, `Unexpected uncaught pageerror: ${pageErrors.join(" | ")}`).toEqual([]);
      expect(
        server5xxResponses,
        `Unexpected 5xx network responses: ${server5xxResponses.join(" | ")}`,
      ).toEqual([]);
    },
  };
}

async function signInThroughUi(page: Page, email: string, password = TEST_PASSWORD) {
  await page.goto("/auth/sign-in");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    page.click('button[type="submit"]'),
  ]);
}

test.beforeAll(async () => {
  await withRequestDatabase(async () => {
    const db = await operationsDb();
    await ensureAuthSchema(db);

    const settingsRow = await db
      .prepare("SELECT approval_mode_enabled FROM support_ai_settings WHERE id = 'default'")
      .first<{ approval_mode_enabled?: boolean }>();
    priorApprovalMode = settingsRow?.approval_mode_enabled !== false;

    await db
      .prepare(
        "UPDATE support_ai_settings SET approval_mode_enabled = TRUE, operating_mode = 'draft_only', live_outbound_enabled = FALSE WHERE id = 'default'",
      )
      .run();

    for (const u of [ADMIN_USER, MANAGER_USER, AGENT_USER]) {
      await db
        .prepare(
          `INSERT INTO auth_users (id, email, encrypted_password, name, role, session_version)
           VALUES (?, ?, crypt(?, gen_salt('bf')), ?, ?, 1)
           ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role`,
        )
        .bind(u.id, u.email, TEST_PASSWORD, u.name, u.role)
        .run();

      await db
        .prepare(
          `INSERT INTO support_agents (user_id, email, name, role, available)
           VALUES (?, ?, ?, ?, TRUE)
           ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, available = TRUE`,
        )
        .bind(u.id, u.email, u.name, u.role)
        .run();
    }

    await db
      .prepare(
        `INSERT INTO support_mailboxes (email, connected_by)
         VALUES ('kritika@satmi.in', ?)
         ON CONFLICT (email) DO NOTHING`,
      )
      .bind(ADMIN_USER.id)
      .run();

    // Seed isolated test order for 1-Click Order Tracking & Customer 360
    const nowIso = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO orders (
           id, channel_order_id, channel_id, channel_name, customer_name,
           customer_email, customer_phone, customer_city, customer_state,
           order_date, created_at, updated_at, status, payment_method,
           payment_status, total, awb, courier, products_json, raw_json, synced_at
         ) VALUES (
           ?, '#S10729974', 1, 'Shopify', 'E2E Test Customer',
           'e2e.customer@example.test', '9876543210', 'Jaipur', 'Rajasthan',
           ?, ?, ?, 'IN TRANSIT', 'Prepaid',
           'paid', 1499.00, 'DL7766554433', 'Delhivery',
           '[{"name":"Original Karungali Malai 108-Beads","quantity":2,"price":"699.00"}]',
           '{"tags":"VIP_TEST"}', ?
         ) ON CONFLICT (id) DO UPDATE SET
           channel_order_id = EXCLUDED.channel_order_id,
           awb = EXCLUDED.awb,
           courier = EXCLUDED.courier,
           status = EXCLUDED.status,
           total = EXCLUDED.total`,
      )
      .bind(TEST_ORDER_ID, nowIso, nowIso, nowIso, nowIso)
      .run();

    // 1. Order-specific ticket with AI draft + token usage + linked order
    await db
      .prepare(
        `INSERT INTO support_tickets (
           id, mailbox, gmail_thread_id, subject, customer_email, customer_name,
           assignee_id, status, priority, order_id, channel, external_user_id, external_username,
           associated_phone, ai_status, ai_approval_status, ai_confidence, version, created_at, updated_at, last_inbound_at
         ) VALUES (
           ?, 'kritika@satmi.in', ?, 'E2E Order Status #S10729974', '@e2e_order_user', 'E2E Test Customer',
           ?, 'open', 'normal', ?, 'instagram', 'e2e_ig_order_user', '@e2e_order_user',
           '9876543210', 'draft_ready', 'pending_review', 0.940, 1, now(), now(), now()
         )`,
      )
      .bind(ORDER_TICKET_ID, `e2e:order:${E2E_SUFFIX}`, AGENT_USER.id, TEST_ORDER_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO support_messages (
           id, ticket_id, message_id, direction, sender, recipients, body, delivery_status
         ) VALUES (?, ?, ?, 'inbound', 'E2E Test Customer', 'instagram', 'Where is my order #S10729974? My phone is 9876543210.', 'received')`,
      )
      .bind(`m_in_${ORDER_TICKET_ID}`, ORDER_TICKET_ID, `<in-${ORDER_TICKET_ID}@satmi.in>`)
      .run();

    await db
      .prepare(
        `INSERT INTO support_messages (
           id, ticket_id, message_id, direction, sender, recipients, body, delivery_status, created_by
         ) VALUES (?, ?, ?, 'outbound', 'Satmi AI Agent', '@e2e_order_user', 'Hi E2E Test Customer, your order #S10729974 is IN TRANSIT via Delhivery (AWB: DL7766554433).', 'ai_draft', 'ai_agent')`,
      )
      .bind(ORDER_DRAFT_MSG_ID, ORDER_TICKET_ID, `<draft-${ORDER_TICKET_ID}@satmi.in>`)
      .run();

    await db
      .prepare(
        `INSERT INTO support_ai_token_usage (
           id, ticket_id, message_id, operation_type, provider, model,
           input_tokens, output_tokens, total_tokens, estimated_cost_usd, actor_id
         ) VALUES (?, ?, ?, 'triage', 'gemini', 'gemini-2.5-flash', 1420, 180, 1600, 0.000321, 'ai_agent')`,
      )
      .bind(`tok_e2e_1_${E2E_SUFFIX}`, ORDER_TICKET_ID, ORDER_DRAFT_MSG_ID)
      .run();

    // 2. General policy ticket with AI draft (for testing Decline & Learn to AI Memory)
    await db
      .prepare(
        `INSERT INTO support_tickets (
           id, mailbox, gmail_thread_id, subject, customer_email, customer_name,
           assignee_id, status, priority, channel, external_user_id, external_username,
           ai_status, ai_approval_status, ai_confidence, version, created_at, updated_at, last_inbound_at
         ) VALUES (
           ?, 'kritika@satmi.in', ?, 'E2E Festive Gift Box Policy Question', '@e2e_policy_user', 'E2E Policy Shopper',
           ?, 'open', 'normal', 'instagram', 'e2e_ig_policy_user', '@e2e_policy_user',
           'draft_ready', 'pending_review', 0.880, 1, now(), now(), now()
         )`,
      )
      .bind(POLICY_TICKET_ID, `e2e:policy:${E2E_SUFFIX}`, AGENT_USER.id)
      .run();

    await db
      .prepare(
        `INSERT INTO support_messages (
           id, ticket_id, message_id, direction, sender, recipients, body, delivery_status
         ) VALUES (?, ?, ?, 'inbound', 'E2E Policy Shopper', 'instagram', 'Do you provide complimentary gift wrapping on festive combo boxes?', 'received')`,
      )
      .bind(`m_in_${POLICY_TICKET_ID}`, POLICY_TICKET_ID, `<in-${POLICY_TICKET_ID}@satmi.in>`)
      .run();

    await db
      .prepare(
        `INSERT INTO support_messages (
           id, ticket_id, message_id, direction, sender, recipients, body, delivery_status, created_by
         ) VALUES (?, ?, ?, 'outbound', 'Satmi AI Agent', '@e2e_policy_user', 'Hi there, gift wrapping costs Rs. 50 extra.', 'ai_draft', 'ai_agent')`,
      )
      .bind(POLICY_DRAFT_MSG_ID, POLICY_TICKET_ID, `<draft-${POLICY_TICKET_ID}@satmi.in>`)
      .run();

    // 3. Two Agent Queue tickets (needs_human_action & needs_admin_input) with distinct messages & escalation banners
    for (const [idx, qId, qName, qSubj, qMsg, qEsc] of [
      [
        1,
        QUEUE_TICKET_1_ID,
        "E2E Queue Customer Alpha",
        "E2E Alpha Callback Request",
        "Unique Alpha inbound message: Please arrange a phone callback for my Karungali order.",
        "Alpha Escalation Banner: Customer explicitly requested a phone callback.",
      ],
      [
        2,
        QUEUE_TICKET_2_ID,
        "E2E Queue Customer Beta",
        "E2E Beta Damaged Parcel Claim",
        "Unique Beta inbound message: My incense holder arrived cracked in the box.",
        "Beta Escalation Banner: Customer reported a damaged item requiring human inspection.",
      ],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO support_tickets (
             id, mailbox, gmail_thread_id, subject, customer_email, customer_name,
             assignee_id, status, priority, channel, external_user_id, external_username,
             ai_status, ai_approval_status, ai_confidence, version, created_at, updated_at, last_inbound_at
           ) VALUES (
             ?, 'kritika@satmi.in', ?, ?, ?, ?,
             ?, 'open', 'high', 'instagram', ?, ?,
             'needs_human_action', 'pending_review', 0.950, 1, now(), now(), now()
           )`,
        )
        .bind(
          qId,
          `e2e:queue${idx}:${E2E_SUFFIX}`,
          qSubj,
          `@e2e_queue_${idx}`,
          qName,
          AGENT_USER.id,
          `e2e_ig_queue_${idx}`,
          `@e2e_queue_${idx}`,
        )
        .run();

      await db
        .prepare(
          `INSERT INTO support_messages (
             id, ticket_id, message_id, direction, sender, recipients, body, delivery_status
           ) VALUES (?, ?, ?, 'inbound', ?, 'instagram', ?, 'received')`,
        )
        .bind(`m_in_${qId}`, qId, `<in-${qId}@satmi.in>`, qName, qMsg)
        .run();

      await db
        .prepare(
          `INSERT INTO support_ai_escalations (
             id, ticket_id, trigger_message_id, escalation_type, action_category,
             ai_question_for_admin, customer_query_excerpt, status
           ) VALUES (?, ?, ?, 'human_action_required', ?, ?, ?, 'pending')`,
        )
        .bind(
          `esc_${qId}`,
          qId,
          `m_in_${qId}`,
          idx === 1 ? "arrange_callback" : "damaged_or_wrong_item",
          qEsc,
          qMsg,
        )
        .run();
    }
  });
});

test.afterAll(async () => {
  await withRequestDatabase(async () => {
    const db = await operationsDb();
    await db
      .prepare("UPDATE support_ai_settings SET approval_mode_enabled = ? WHERE id = 'default'")
      .bind(priorApprovalMode)
      .run();

    for (const titlePattern of createdMemoryTitles) {
      await db
        .prepare(
          "DELETE FROM support_knowledge_documents WHERE category = 'admin_memory' AND (title ILIKE ? OR content ILIKE ?)",
        )
        .bind(`%${titlePattern}%`, `%${titlePattern}%`)
        .run();
    }

    for (const tid of [
      ORDER_TICKET_ID,
      POLICY_TICKET_ID,
      QUEUE_TICKET_1_ID,
      QUEUE_TICKET_2_ID,
    ]) {
      await db
        .prepare("DELETE FROM support_knowledge_documents WHERE source_ticket_id = ?")
        .bind(tid)
        .run();
      await db.prepare("DELETE FROM support_ai_token_usage WHERE ticket_id = ?").bind(tid).run();
      await db.prepare("DELETE FROM support_ai_escalations WHERE ticket_id = ?").bind(tid).run();
      await db.prepare("DELETE FROM support_events WHERE ticket_id = ?").bind(tid).run();
      await db.prepare("DELETE FROM support_messages WHERE ticket_id = ?").bind(tid).run();
      await db.prepare("DELETE FROM support_tickets WHERE id = ?").bind(tid).run();
    }

    await db.prepare("DELETE FROM orders WHERE id = ?").bind(TEST_ORDER_ID).run();

    for (const u of [ADMIN_USER, MANAGER_USER, AGENT_USER]) {
      await db.prepare("DELETE FROM dashboard_sessions WHERE user_id = ?").bind(u.id).run();
      await db.prepare("DELETE FROM support_agents WHERE user_id = ?").bind(u.id).run();
      await db.prepare("DELETE FROM auth_users WHERE id = ?").bind(u.id).run();
    }
    await db.close();
  });
});

test("1. Auth sign-in/sign-out flow & role gating (admin vs support_manager vs support_agent)", async ({
  page,
}) => {
  const guards = attachStrictPageGuards(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 1a. Admin sign-in sees Users nav, AI & Memory, Approval Mode toggle, and Floating Memory Dock
  await signInThroughUi(page, ADMIN_USER.email);
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(mainNav.getByText("AI & Memory")).toBeVisible();
  await expect(mainNav.getByText("Insights")).toBeVisible();
  await expect(mainNav.getByText("Users")).toBeVisible();
  await expect(page.getByRole("switch")).toBeVisible();
  await expect(page.getByTestId("floating-ai-memory-toggle")).toBeVisible();

  // Sign out via AccountMenu
  await page.getByRole("button", { name: "Open account menu" }).click();
  await Promise.all([
    page.waitForURL((url) => url.pathname.includes("/auth/sign-in")),
    page.getByRole("button", { name: "Sign out" }).click(),
  ]);

  // 1b. Support Manager sign-in sees AI & Memory, Insights, Settings, Activity, but NOT Users
  await signInThroughUi(page, MANAGER_USER.email);
  await expect(mainNav.getByText("AI & Memory")).toBeVisible();
  await expect(mainNav.getByText("Insights")).toBeVisible();
  await expect(mainNav.getByText("Users")).toHaveCount(0);

  await page.getByRole("button", { name: "Open account menu" }).click();
  await Promise.all([
    page.waitForURL((url) => url.pathname.includes("/auth/sign-in")),
    page.getByRole("button", { name: "Sign out" }).click(),
  ]);

  // 1c. Support Agent sign-in sees only Tickets and Agent Queue (no AI & Memory, no Approval toggle, no FloatingMemoryDock)
  await signInThroughUi(page, AGENT_USER.email);
  await expect(mainNav.getByText("Agent Queue")).toBeVisible();
  await expect(mainNav.getByText("AI & Memory")).toHaveCount(0);
  await expect(mainNav.getByText("Insights")).toHaveCount(0);
  await expect(mainNav.getByText("Users")).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByTestId("floating-ai-memory-toggle")).toHaveCount(0);

  guards.assertZeroErrors();
});

test("2. Ticket sorting (8 modes), search, channel filters, Approval Mode toggle, Excel resize, and selective Decline Learning", async ({
  page,
}) => {
  const guards = attachStrictPageGuards(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInThroughUi(page, ADMIN_USER.email);

  // Wait for initial tickets table to render
  await expect(page.getByLabel("Sort queries")).toBeVisible();

  // Exercise all 8 sorting modes
  for (const sortMode of [
    "newest",
    "needs_reply",
    "oldest",
    "updated",
    "fifo",
    "sla",
    "ticket_desc",
    "ticket_asc",
  ]) {
    const sortResPromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/support?") &&
        res.url().includes(`sort=${sortMode}`) &&
        res.status() === 200,
    );
    await page.getByLabel("Sort queries").selectOption(sortMode);
    await sortResPromise;
  }

  // Exercise channel filter dropdown
  const chFilter = page.getByLabel("Filter by channel");
  await chFilter.selectOption("instagram");
  await chFilter.selectOption("all");

  // Toggle Approval Mode OFF and back ON
  const approvalSwitch = page.getByRole("switch");
  const initialChecked = await approvalSwitch.getAttribute("aria-checked");
  await approvalSwitch.click();
  await expect(approvalSwitch).toHaveAttribute(
    "aria-checked",
    initialChecked === "true" ? "false" : "true",
  );
  if (initialChecked === "true") {
    await approvalSwitch.click();
    await expect(approvalSwitch).toHaveAttribute("aria-checked", "true");
  }

  // Filter via search bar to our isolated E2E tickets
  const searchInput = page.locator('header input[type="text"]');
  await searchInput.fill("E2E");
  await expect(page.getByText("E2E Order Status #S10729974")).toBeVisible();
  await expect(page.getByText("E2E Festive Gift Box Policy Question")).toBeVisible();

  // Verify Excel review table density controls + column resize + row resize
  await page.getByRole("button", { name: "Compact" }).click();
  await page.getByRole("button", { name: "Tall" }).click();
  await page.getByRole("button", { name: "Auto-fit" }).click();

  const colResizeHandle = page.getByLabel("Resize Customer column");
  const colBox = await colResizeHandle.boundingBox();
  expect(colBox).not.toBeNull();
  if (colBox) {
    await page.mouse.move(colBox.x + colBox.width / 2, colBox.y + colBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(colBox.x + 45, colBox.y + colBox.height / 2);
    await page.mouse.up();
  }

  const rowResizeHandle = page.getByLabel("Resize row 1");
  const rowBox = await rowResizeHandle.boundingBox();
  expect(rowBox).not.toBeNull();
  if (rowBox) {
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + 30);
    await page.mouse.up();
  }

  // 2a. Decline order-specific ticket -> verify skipped from global AI memory
  const orderRow = page.locator("tr", { hasText: "E2E Order Status #S10729974" });
  await orderRow.getByRole("button", { name: "Decline" }).click();

  const declineDialog = page.getByRole("dialog");
  await expect(declineDialog).toBeVisible();
  await declineDialog
    .locator('input[type="text"]')
    .fill("Order #S10729974 is out for delivery today with AWB DL7766554433");
  await declineDialog
    .locator("textarea")
    .fill(
      "Hi E2E Test Customer, your order #S10729974 with AWB DL7766554433 is out for delivery today.",
    );
  await declineDialog.getByRole("button", { name: /Send Correction/i }).click();

  await expect(page.getByRole("status")).toContainText(/Skipped global AI learning/i);

  // Verify in DB that no admin_memory doc was created for ORDER_TICKET_ID
  await withRequestDatabase(async () => {
    const db = await operationsDb();
    const memRow = await db
      .prepare(
        "SELECT id FROM support_knowledge_documents WHERE source_ticket_id = ? AND category = 'admin_memory'",
      )
      .bind(ORDER_TICKET_ID)
      .first();
    expect(memRow).toBeNull();
  });

  // 2b. Decline general policy ticket -> verify learned into global AI memory
  const uniquePolicyPhrase = `E2E_GIFT_WRAP_${E2E_SUFFIX}`;
  createdMemoryTitles.push(uniquePolicyPhrase);
  const policyRow = page.locator("tr", { hasText: "E2E Festive Gift Box Policy Question" });
  await policyRow.getByRole("button", { name: "Decline" }).click();

  await expect(declineDialog).toBeVisible();
  await declineDialog
    .locator('input[type="text"]')
    .fill("Complimentary festive gift wrapping is free on all combo boxes");
  await declineDialog
    .locator("textarea")
    .fill(
      `Hi there, Satmi provides complimentary festive gift wrapping (${uniquePolicyPhrase}) on all combo boxes at no extra cost.`,
    );
  await declineDialog.getByRole("button", { name: /Send Correction/i }).click();

  await expect(page.getByRole("status")).toContainText(/AI learned a new rule/i);

  // Verify in DB that an admin_memory doc WAS created for POLICY_TICKET_ID
  await withRequestDatabase(async () => {
    const db = await operationsDb();
    const memRow = await db
      .prepare(
        "SELECT id, title FROM support_knowledge_documents WHERE source_ticket_id = ? AND category = 'admin_memory'",
      )
      .bind(POLICY_TICKET_ID)
      .first<{ id: string; title: string }>();
    expect(memRow).not.toBeNull();
  });

  guards.assertZeroErrors();
});

test("3. Agent Queue (?view=queue) Prev/Skip navigation keeps header, escalation banner, and chat messages synchronized", async ({
  page,
}) => {
  const guards = attachStrictPageGuards(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInThroughUi(page, AGENT_USER.email);

  // Switch to Agent Queue view
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: /Agent Queue/i })
    .click();

  await expect(page.getByText(/Queue 1 \//)).toBeVisible();

  // Read active customer name on Queue item 1 and verify matching escalation banner & chat message
  const firstIsAlpha = await page
    .getByText("E2E Queue Customer Alpha")
    .first()
    .isVisible()
    .catch(() => false);

  if (firstIsAlpha) {
    await expect(page.getByText(/Alpha Escalation Banner:/)).toBeVisible();
    await expect(page.getByText(/Unique Alpha inbound message:/)).toBeVisible();
    await expect(page.getByText(/Unique Beta inbound message:/)).toHaveCount(0);
  } else {
    await expect(page.getByText(/Beta Escalation Banner:/)).toBeVisible();
    await expect(page.getByText(/Unique Beta inbound message:/)).toBeVisible();
    await expect(page.getByText(/Unique Alpha inbound message:/)).toHaveCount(0);
  }

  // Click Skip -> verify header, escalation banner, and chat messages switch atomically to the other ticket
  await page.getByRole("button", { name: /Skip/i }).click();
  await expect(page.getByText(/Queue 2 \//)).toBeVisible();

  if (firstIsAlpha) {
    await expect(page.getByText("E2E Queue Customer Beta").first()).toBeVisible();
    await expect(page.getByText(/Beta Escalation Banner:/)).toBeVisible();
    await expect(page.getByText(/Unique Beta inbound message:/)).toBeVisible();
    await expect(page.getByText(/Unique Alpha inbound message:/)).toHaveCount(0);
  } else {
    await expect(page.getByText("E2E Queue Customer Alpha").first()).toBeVisible();
    await expect(page.getByText(/Alpha Escalation Banner:/)).toBeVisible();
    await expect(page.getByText(/Unique Alpha inbound message:/)).toBeVisible();
    await expect(page.getByText(/Unique Beta inbound message:/)).toHaveCount(0);
  }

  // Click Prev -> returns to Queue 1
  await page.getByRole("button", { name: /Prev/i }).click();
  await expect(page.getByText(/Queue 1 \//)).toBeVisible();

  guards.assertZeroErrors();
});

test("4. Hovering Update AI Memory dock (Dark & Light Mode theme matching, create/update/list/delete commands, collapse) & Mobile viewport overlap check", async ({
  page,
}) => {
  const guards = attachStrictPageGuards(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInThroughUi(page, ADMIN_USER.email);

  // Verify minimized by default
  const toggleBtn = page.getByTestId("floating-ai-memory-toggle");
  await expect(toggleBtn).toBeVisible();
  await expect(page.getByTestId("floating-ai-memory-dock")).toHaveCount(0);

  // Open dock
  await toggleBtn.click();
  const dock = page.getByTestId("floating-ai-memory-dock");
  await expect(dock).toBeVisible();

  // Check computed background color in Light vs Dark mode (poll past 150ms CSS transition)
  const themeBtn = page.locator('header button[aria-label*="theme"]');
  const isInitiallyDark = await page.evaluate(() =>
    document.documentElement.classList.contains("dark"),
  );
  if (isInitiallyDark) {
    await themeBtn.click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(false);
  }
  const getDockCardBg = () =>
    dock.locator("textarea").evaluate((el) => {
      const card = el.closest("div");
      return card ? window.getComputedStyle(card).backgroundColor : "";
    });
  const lightBg = await getDockCardBg();

  // Switch to Dark mode and verify theme class + CSS variable + computed dock background color transition
  await themeBtn.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(true);
  await expect.poll(getDockCardBg).not.toEqual(lightBg);

  // Switch back to Light mode
  await themeBtn.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(false);
  await expect.poll(getDockCardBg).toEqual(lightBg);

  // Run Create -> Update -> List -> Delete memory commands via dock UI
  createdMemoryTitles.push("pitambari");
  createdMemoryTitles.push("Brass Diya");
  const dockInput = dock.getByLabel("Instruct AI agent to update memory");
  const updateBtn = dock.getByRole("button", { name: "Send memory command to AI" });

  // 4a. Create memory
  const createCmd =
    "Remember Brass Diya Care Rule: Clean Satmi brass diyas gently with lemon and pitambari powder.";
  await dockInput.fill(createCmd);
  await updateBtn.click();
  await expect(dock).toContainText(createCmd, { timeout: 30000 });
  await expect(updateBtn).toContainText("Update", { timeout: 30000 });

  // 4b. Update memory
  const updateCmd =
    "Update Brass Diya Care Rule: Clean Satmi brass diyas gently with lemon and pitambari powder, then dry with a soft cotton cloth.";
  await dockInput.fill(updateCmd);
  await updateBtn.click();
  await expect(dock).toContainText(updateCmd, { timeout: 30000 });
  await expect(updateBtn).toContainText("Update", { timeout: 30000 });

  // 4c. List memories & verify persistence in DB
  const listCmd = "List everything currently stored in AI Memory.";
  await dockInput.fill(listCmd);
  await updateBtn.click();
  await expect(dock).toContainText(listCmd, { timeout: 30000 });
  await expect(updateBtn).toContainText("Update", { timeout: 30000 });

  await withRequestDatabase(async () => {
    const db = await operationsDb();
    const persistedBeforeDelete = await db
      .prepare(
        "SELECT id, title FROM support_knowledge_documents WHERE category = 'admin_memory' AND (title ILIKE ? OR content ILIKE ?)",
      )
      .bind("%pitambari%", "%pitambari%")
      .first<{ id: string; title: string }>();
    expect(persistedBeforeDelete).not.toBeNull();
  });

  // 4d. Delete memory
  const deleteCmd = "Delete the Brass Diya Care Rule about pitambari powder from AI Memory.";
  await dockInput.fill(deleteCmd);
  await updateBtn.click();
  await expect(dock).toContainText(deleteCmd, { timeout: 30000 });
  await expect(updateBtn).toContainText("Update", { timeout: 30000 });

  // 4e. Collapse dock cleanly
  await dock.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByTestId("floating-ai-memory-dock")).toHaveCount(0);
  await expect(toggleBtn).toBeVisible();

  // 4f. Mobile viewport (390x844) layout & overlap check
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMenuBtn = page.getByLabel("Open navigation menu");
  await expect(mobileMenuBtn).toBeVisible();
  const headerBox = await mobileMenuBtn.boundingBox();
  const toggleBox = await toggleBtn.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  if (headerBox && toggleBox) {
    // Top bar and bottom floating toggle must never overlap vertically
    expect(toggleBox.y).toBeGreaterThan(headerBox.y + headerBox.height);
  }

  // Open and close mobile sidebar drawer
  await mobileMenuBtn.click();
  await expect(page.getByLabel("Close navigation").last()).toBeVisible();
  await page.getByLabel("Close navigation").last().click();

  guards.assertZeroErrors();
});

test("5. Token Spend observability, 1-click Order Tracking modal, and Customer 360 profile sidebar", async ({
  page,
}) => {
  const guards = attachStrictPageGuards(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInThroughUi(page, ADMIN_USER.email);

  // Search for our E2E order ticket
  const searchInput = page.locator('header input[type="text"]');
  await searchInput.fill("E2E Order Status #S10729974");
  const orderRow = page.locator("tr", { hasText: "E2E Order Status #S10729974" });
  await expect(orderRow).toBeVisible();

  // Verify token badge in Excel review table row
  await expect(orderRow).toContainText(/1,600 tok/i);

  // Click 1-click Order Tracking button (DL7766554433) in table
  await orderRow.getByRole("button", { name: /DL7766554433/ }).click();
  const trackingDialog = page.getByRole("dialog");
  await expect(trackingDialog).toBeVisible();
  await expect(trackingDialog).toContainText("Order Tracking #S10729974");
  await expect(trackingDialog).toContainText("DL7766554433");
  await expect(trackingDialog).toContainText("IN TRANSIT");
  await expect(
    trackingDialog.getByRole("link", { name: /Open Courier Tracking/i }),
  ).toHaveAttribute("href", /delhivery\.com/);
  await trackingDialog.getByRole("button", { name: "Close tracking modal" }).first().click();
  await expect(trackingDialog).toHaveCount(0);

  // Click row to open Ticket Workspace & inspect Customer 360 sidebar + TicketAiAssistantCard token breakdown
  await orderRow.click();
  await expect(page.getByText("Customer Information")).toBeVisible();
  await expect(page.getByText("Lifetime Spend")).toBeVisible();
  await expect(page.getByText("₹1,499")).toBeVisible();
  await expect(page.getByText("9876543210", { exact: true })).toBeVisible();

  // Click Track button inside Customer 360 sidebar
  await page.locator("aside").getByRole("button", { name: "Track" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close tracking modal" })
    .first()
    .click();

  // Expand per-chat & per-request token breakdown in TicketAiAssistantCard
  const chatTokenBtn = page.getByRole("button", { name: /Chat AI:.*1,600 tok/i });
  await expect(chatTokenBtn).toBeVisible();
  await chatTokenBtn.click();
  await expect(page.getByText("Per-Chat & Per-Request AI Token Breakdown")).toBeVisible();
  await expect(page.getByText("gemini-2.5-flash").first()).toBeVisible();

  // Navigate to global AI & Memory -> Token Spend view
  const mainNav = page.getByRole("navigation", { name: "Main navigation" });
  await mainNav.getByRole("button", { name: /AI & Memory/i }).click();
  await page.getByRole("button", { name: /Token Spend/i }).click();
  await expect(page.getByText(/Total Tokens/i).first()).toBeVisible();

  // Navigate to Insights view and verify Token Spend summary renders
  await mainNav.getByRole("button", { name: /Insights/i }).click();
  await expect(page.getByText(/AI Token/i).first()).toBeVisible();

  guards.assertZeroErrors();
});
