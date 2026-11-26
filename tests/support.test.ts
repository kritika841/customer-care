import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";

process.env.SUPPORT_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.SESSION_SECRET = "test-session-secret-satmi-support-2026";

const {
  encrypt,
  decrypt,
  replyMime,
  emailAddress,
  messageText,
  isAutomatedSupportNoise,
  extractReplyToEmail,
  isInboundEmailAuthVerified,
} = await import("../lib/operations/gmail");
const { visibleEmailBody } = await import("../lib/email-body");
const { readJson, errorResponse, getTrustedAppOrigin } = await import("../lib/http");
const { createSessionToken, verifySessionToken, verifySessionTokenPayload } = await import(
  "../lib/auth/session"
);
const { rolesOf, hasRole, isAdmin, isSupportManager, isSupportRole } = await import(
  "../lib/auth/access"
);
const { validateRemoteAttachmentUrl } = await import("../lib/operations/attachment-url");
const { verifyMetaSignature } = await import("../lib/operations/meta");
const { estimateAiCostUsd } = await import("../lib/operations/ai-provider");
const { formatTokensCompact, formatCostUsd, formatCostInr } = await import("../lib/support-ui");
const {
  slaMinutesForPriority,
  computeSlaDueAt,
  extractOrderOrPhoneHints,
  computeCustomer360,
  evaluateSlaState,
} = await import("../lib/operations/sla");
const {
  EMBEDDING_DIM,
  estimateTokenCount,
  deterministicLocalEmbedding,
  cosineSimilarity,
} = await import("../lib/operations/ai-provider");
const { chunkKnowledgeDocument, scrubCustomerPii, buildCourierTrackingUrl } = await import(
  "../lib/operations/rag"
);
const {
  extractPinnedFactsFromMessages,
  buildCompactedThreadContext,
  detectMandatoryHumanEscalation,
  validateAiDraftSafety,
  evaluateQueryWithStoreRag,
  rephraseAdminClarification,
  sanitizeNomenclatureLabel,
  isOrderSpecificQueryOrCorrection,
} = await import("../lib/operations/ai-agent");

test("AES-256-GCM token encryption and MIME header sanitization", async () => {
  assert.equal(decrypt(encrypt("secret-refresh-token")), "secret-refresh-token");

  const mime = replyMime(
    "kritika@satmi.in",
    "customer@example.test",
    "Hello\r\nBcc: bad@example.test",
    "Thanks for reaching out!",
    "<id@satmi.in>",
    "<ref@example.test>"
  );
  assert.doesNotMatch(mime, /\r\nBcc:/);
  assert.match(mime, /In-Reply-To: <ref@example\.test>/);
  assert.match(mime, /References: <ref@example\.test>/);

  const sampleAttachment = Buffer.from("invoice-pdf-bytes").toString("base64");
  const mimeWithAttachment = replyMime(
    "kritika@satmi.in",
    "customer@example.test",
    "Order Invoice",
    "Please find the invoice attached.",
    "<id2@satmi.in>",
    "<ref@example.test>",
    [
      {
        name: "invoice\"\r\n.pdf",
        mimeType: "application/pdf",
        dataBase64: sampleAttachment,
      },
    ]
  );
  assert.match(mimeWithAttachment, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(mimeWithAttachment, /Content-Disposition: attachment; filename="invoice' {2}\.pdf"/);
  assert.doesNotMatch(mimeWithAttachment, /filename="invoice"/);
  assert.match(mimeWithAttachment, new RegExp(sampleAttachment));
});

test("Email address parsing and quoted thread stripping", () => {
  assert.equal(
    emailAddress("Customer Name <Customer@Example.com>"),
    "customer@example.com"
  );
  assert.equal(emailAddress("plain@example.com"), "plain@example.com");

  const rawBody = [
    "Hi team, please update me on my order.",
    "",
    "On Thu, Nov 12, 2026 at 10:00 AM Satmi Support <kritika@satmi.in> wrote:",
    "> Previous quoted message",
  ].join("\n");
  assert.equal(visibleEmailBody(rawBody), "Hi team, please update me on my order.");

  const htmlPart = {
    mimeType: "text/html",
    body: {
      data: Buffer.from("<p>Hello <b>Satmi</b> &amp; team</p>").toString(
        "base64url"
      ),
    },
  };
  assert.match(messageText(htmlPart), /Hello\s+Satmi\s+&\s+team/);
});

test("Self-hosted HMAC session token creation and verification", async () => {
  const user = {
    id: randomUUID(),
    email: "kritika@satmi.in",
    name: "Kritika Singh",
    role: "admin",
  };
  const token = await createSessionToken(user);
  const verified = await verifySessionToken(token);
  assert.deepEqual(verified, user);
  assert.equal(await verifySessionToken(token + "tampered"), null);
});

test("HTTP error handling and quota responses", async () => {
  await assert.rejects(
    readJson(new Response("", { status: 502 })),
    /did not return a usable response/
  );
  const r = errorResponse(
    new Error("Your project has exceeded the data transfer quota")
  );
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, "DATABASE_QUOTA");
});

test("Automated newsletter and system alert filtering preserves real customer queries", () => {
  assert.equal(
    isAutomatedSupportNoise(
      new Map([["list-unsubscribe", "<https://example.com/unsub>"]]),
      "founder@brand.com",
      "Weekly Digest"
    ),
    true
  );
  assert.equal(
    isAutomatedSupportNoise(
      new Map([["auto-submitted", "auto-generated"]]),
      "alert@service.io",
      "Deployment failed"
    ),
    true
  );
  assert.equal(
    isAutomatedSupportNoise(new Map(), "notifications@vercel.com", "Build alert"),
    true
  );
  assert.equal(
    isAutomatedSupportNoise(new Map(), "support@satmi.in", "Reminder Scheduled: test"),
    true
  );
  assert.equal(
    isAutomatedSupportNoise(
      new Map(),
      "ananya.sharma@gmail.com",
      "Order #S10729974 delivery delayed",
      ["INBOX"]
    ),
    false
  );
});

test("Stage 2 SLA targets, Customer 360 aggregation, and DM order/phone hint extraction", () => {
  assert.equal(slaMinutesForPriority("urgent"), 60);
  assert.equal(slaMinutesForPriority("high"), 240);
  assert.equal(slaMinutesForPriority("normal"), 720);
  assert.equal(slaMinutesForPriority("low"), 1440);

  const due = computeSlaDueAt("2026-11-23T06:00:00.000Z", "urgent");
  assert.equal(due, "2026-11-23T07:00:00.000Z");

  const breached = evaluateSlaState(
    {
      status: "open",
      priority: "urgent",
      created_at: "2026-11-23T06:00:00.000Z",
      sla_due_at: due,
      last_direction: "inbound",
    },
    new Date("2026-11-23T07:30:00.000Z").getTime()
  );
  assert.equal(breached.state, "breached");
  assert.equal(breached.label, "SLA +30m");

  const hints = extractOrderOrPhoneHints(
    "Hi where is my order #S10729974? My phone is +91 9876543210."
  );
  assert.deepEqual(hints.orderCodes, ["S10729974"]);
  assert.deepEqual(hints.phones, ["9876543210"]);

  const c360 = computeCustomer360(
    [
      { status: "DELIVERED", payment_method: "COD", total: "1299" },
      { status: "RTO DELIVERED", payment_method: "Prepaid", total: "999" },
      { status: "CANCELED", payment_method: "COD", total: "500" },
    ],
    2
  );
  assert.equal(c360.totalOrders, 3);
  assert.equal(c360.totalSpend, 2298);
  assert.equal(c360.codOrders, 2);
  assert.equal(c360.prepaidOrders, 1);
  assert.equal(c360.rtoOrders, 1);
  assert.equal(c360.deliveredOrders, 1);
  assert.equal(c360.pastTicketsCount, 2);
});

test("Hybrid Store RAG chunker, 768-dim embeddings, and PII scrubbing for Admin Memory", () => {
  const samplePolicy = [
    "# Satmi Size Exchange Policy",
    "Customers can request a size exchange within 7 days of delivery if tags are intact.",
    "",
    "## Reverse Pickup Timeline",
    "Once approved, reverse pickup is scheduled within 24 to 48 working hours across India.",
  ].join("\n");

  const chunks = chunkKnowledgeDocument("Satmi Exchange Guide", samplePolicy, 40, 10);
  assert.ok(chunks.length >= 2);
  assert.match(chunks[0].heading, /Satmi Exchange Guide/);
  assert.ok(chunks[0].tokenEstimate > 0);

  const vecQuery = deterministicLocalEmbedding("7 days size exchange reverse pickup");
  const vecMatch = deterministicLocalEmbedding(chunks[0].content);
  const vecUnrelated = deterministicLocalEmbedding("quarterly warehouse supplier GST invoice");
  assert.equal(vecQuery.length, EMBEDDING_DIM);
  assert.ok(cosineSimilarity(vecQuery, vecMatch) > cosineSimilarity(vecQuery, vecUnrelated));

  const rawAdminMemory =
    "Tell priya.sharma@gmail.com (+91 9876543210) that her order #S10729974 with AWB BD9988776655 is eligible for a 7-day size exchange.";
  const scrubbed = scrubCustomerPii(rawAdminMemory);
  assert.doesNotMatch(scrubbed, /priya\.sharma@gmail\.com/);
  assert.doesNotMatch(scrubbed, /9876543210/);
  assert.doesNotMatch(scrubbed, /S10729974/);
  assert.doesNotMatch(scrubbed, /BD9988776655/);
  assert.match(scrubbed, /\[CUSTOMER_EMAIL\]/);
  assert.match(scrubbed, /\[CUSTOMER_PHONE\]/);
  assert.match(scrubbed, /\[ORDER_ID\]/);
});

test("10,000-token rolling conversation compactor preserves verbatim tail and pinned order/phone/AWB entities", async () => {
  const longParagraph =
    "Customer and support discussed fabric care, festive delivery schedules, and address landmarks in detail. ".repeat(
      14
    );

  const messages = [
    {
      id: "m_1",
      direction: "inbound",
      sender: "Ananya",
      body: `Hi, I need help with my order #S10729974. My phone number is +91 9876543210 and I ordered size XL. ${longParagraph}`,
      createdAt: "2026-11-20T10:00:00.000Z",
    },
    {
      id: "m_2",
      direction: "outbound",
      sender: "Satmi Support",
      body: `Hi Ananya, your shipment was dispatched with AWB DL7766554433. ${longParagraph}`,
      createdAt: "2026-11-20T10:05:00.000Z",
    },
  ];

  // Add 35 more messages so total tokens exceed the 10,000-token threshold
  for (let i = 3; i <= 37; i++) {
    messages.push({
      id: `m_${i}`,
      direction: i % 2 === 1 ? "inbound" : "outbound",
      sender: i % 2 === 1 ? "Ananya" : "Satmi Support",
      body: `Turn ${i}: ${longParagraph}`,
      createdAt: new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString(),
    });
  }

  const totalEstimated = messages.reduce(
    (s, m) => s + estimateTokenCount(`${m.sender}: ${m.body}`) + 8,
    0
  );
  assert.ok(totalEstimated >= 10000, `Expected >= 10000 tokens, got ${totalEstimated}`);

  const pinned = extractPinnedFactsFromMessages(messages);
  assert.deepEqual(pinned.orderCodes, ["S10729974"]);
  assert.deepEqual(pinned.phones, ["9876543210"]);
  assert.deepEqual(pinned.awbNumbers, ["DL7766554433"]);
  assert.ok(pinned.mentionedSizes.includes("XL"));

  const compacted = await buildCompactedThreadContext({
    messages,
    compactionThreshold: 10000,
  });

  assert.equal(compacted.wasCompacted, true);
  assert.equal(compacted.compactedNow, true);
  assert.equal(compacted.recentVerbatimMessages.length, 6);
  assert.equal(compacted.recentVerbatimMessages[5].id, "m_37");
  assert.match(compacted.promptReadyTranscript, /S10729974/);
  assert.match(compacted.promptReadyTranscript, /9876543210/);
  assert.match(compacted.promptReadyTranscript, /DL7766554433/);
  assert.match(compacted.promptReadyTranscript, /COMPACTED ROLLING SUMMARY/);
  assert.ok(
    estimateTokenCount(compacted.promptReadyTranscript) < compacted.totalRawTokens * 0.45,
    "Compacted transcript must consume significantly fewer tokens than raw 10k+ chat"
  );
});

test("Mandatory human escalation triggers: callbacks, damaged/wrong items, manual refunds, VIP > 3000, and angry sentiment", async () => {
  const baseStoreContext = {
    query: "",
    extractedHints: { orderCodes: [], phones: [] },
    requestedOrderCodes: [],
    orders: [],
    associatedCustomerPhone: "",
    phoneMismatchDetected: false,
    phoneMismatchReason: "",
    newlyVerifiedPhoneToAssociate: "",
    customer360: computeCustomer360([], 0),
    hasVipOrder: false,
    highestOrderTotal: 1499,
    ragChunks: [],
    topRrfScore: 0,
    topVectorSimilarity: 0,
    topLexicalScore: 0,
    hasStrongKnowledgeMatch: false,
    embeddingModel: "test",
    embeddingUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      isEstimated: false,
    },
  };

  // 1. Callback Request
  const cb = detectMandatoryHumanEscalation({
    latestCustomerText: "Please arrange a callback on my number so I can talk to an agent.",
    storeContext: baseStoreContext,
    vipThreshold: 3000,
  });
  assert.equal(cb.required, true);
  assert.equal(cb.category, "arrange_callback");

  // 2. Damaged / Wrong Item
  const dmg = detectMandatoryHumanEscalation({
    latestCustomerText: "I received a damaged kurti with a torn sleeve and wrong color.",
    storeContext: baseStoreContext,
    vipThreshold: 3000,
  });
  assert.equal(dmg.required, true);
  assert.equal(dmg.category, "damaged_or_wrong_item");

  // 3. Manual Refund / Bank Transfer
  const ref = detectMandatoryHumanEscalation({
    latestCustomerText: "I want a full refund via bank transfer or UPI refund immediately.",
    storeContext: baseStoreContext,
    vipThreshold: 3000,
  });
  assert.equal(ref.required, true);
  assert.equal(ref.category, "manual_refund_or_bank_transfer");

  // 4. VIP / High-value order > ₹3,000 with delivery issue
  const vip = detectMandatoryHumanEscalation({
    latestCustomerText: "My wedding order is delayed and stuck in transit, please help urgently!",
    storeContext: {
      ...baseStoreContext,
      hasVipOrder: true,
      highestOrderTotal: 4599,
    },
    vipThreshold: 3000,
  });
  assert.equal(vip.required, true);
  assert.equal(vip.category, "vip_high_value_order");

  // 5. Angry / Abusive Sentiment
  const angry = detectMandatoryHumanEscalation({
    latestCustomerText: "This is a total scam, worst service ever, I am going to consumer court!",
    storeContext: baseStoreContext,
    vipThreshold: 3000,
  });
  assert.equal(angry.required, true);
  assert.equal(angry.category, "angry_or_abusive_sentiment");

  // 6. Admin Clarification -> AI Rephrase + PII-scrubbed canonical memory
  const rephrased = await rephraseAdminClarification({
    customerName: "Riya Kapoor",
    channel: "instagram",
    customerQuery:
      "Can you customize the sleeve length on order #S10729974? My phone is 9876543210.",
    aiQuestionForAdmin: "Do we offer custom sleeve length on ready-to-ship kurtas?",
    adminRawAnswer:
      "tell them we don't offer sleeve customization on ready-to-ship items, only standard XS to XXL sizes",
  });
  assert.match(rephrased.customerReply, /Riya/);
  assert.match(rephrased.customerReply, /XS to XXL/i);
  assert.doesNotMatch(rephrased.canonicalQuestion, /S10729974/);
  assert.doesNotMatch(rephrased.canonicalQuestion, /9876543210/);
});

test("Admin ticketing nomenclature label sanitization", () => {
  assert.equal(sanitizeNomenclatureLabel("  Case  ", "Ticket"), "Case");
  assert.equal(sanitizeNomenclatureLabel("   ", "Tickets"), "Tickets");
  assert.equal(
    sanitizeNomenclatureLabel("Very Long Custom Support Inquiry Label Name", "Ticket").length,
    32
  );
});

test("Comma-separated role helpers handle multi-role users uniformly", () => {
  assert.deepEqual(rolesOf({ role: "support_agent, support_manager" }), [
    "support_agent",
    "support_manager",
  ]);
  assert.equal(hasRole({ role: "support_agent, admin" }, "admin"), true);
  assert.equal(isAdmin({ role: "support_agent, admin" }), true);
  assert.equal(isSupportManager({ role: "support_agent, support_manager" }), true);
  assert.equal(isSupportRole({ role: "support_manager" }), true);
  assert.equal(isSupportRole({ role: "viewer" }), false);
});

test("Session payload exposes jti/sv and enforces SESSION_SECRET in production", async () => {
  const jti = randomUUID();
  const token = await createSessionToken(
    {
      id: randomUUID(),
      email: "ops@satmi.in",
      name: "Ops Lead",
      role: "admin",
    },
    { jti, sessionVersion: 2 }
  );
  const payload = await verifySessionTokenPayload(token);
  assert.ok(payload);
  assert.equal(payload.jti, jti);
  assert.equal(payload.sv, 2);

  const prevEnv = process.env.NODE_ENV;
  const prevSecret = process.env.SESSION_SECRET;
  try {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.SESSION_SECRET = "short";
    await assert.rejects(() =>
      createSessionToken({ id: "1", email: "a@b.com", name: "A", role: "admin" })
    );
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv;
    process.env.SESSION_SECRET = prevSecret;
  }
});

test("Meta webhook signature verification fails closed when secret is unset", () => {
  const prevSecret = process.env.META_APP_SECRET;
  try {
    delete process.env.META_APP_SECRET;
    assert.equal(verifyMetaSignature('{"entry":[]}', "sha256=abc"), false);

    process.env.META_APP_SECRET = "meta-secret-123";
    const body = '{"entry":[{"id":"1"}]}';
    const sig = "sha256=" + createHmac("sha256", "meta-secret-123").update(body).digest("hex");
    assert.equal(verifyMetaSignature(body, sig), true);
    assert.equal(verifyMetaSignature(body, "sha256=deadbeef"), false);
  } finally {
    if (prevSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = prevSecret;
  }
});

test("Remote attachment SSRF guard blocks metadata, local, non-HTTPS, and unapproved hosts", () => {
  assert.throws(() => validateRemoteAttachmentUrl("http://169.254.169.254/latest/meta-data"));
  assert.throws(() => validateRemoteAttachmentUrl("https://169.254.169.254/latest/meta-data"));
  assert.throws(() => validateRemoteAttachmentUrl("https://127.0.0.1/secret"));
  assert.throws(() => validateRemoteAttachmentUrl("https://localhost/secret"));
  assert.throws(() => validateRemoteAttachmentUrl("https://evil.example.com/payload.png"));

  const valid = validateRemoteAttachmentUrl("https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1");
  assert.equal(valid.hostname, "lookaside.fbsbx.com");
});

test("Email Reply-To extraction and SPF/DKIM verification check", () => {
  assert.equal(
    extractReplyToEmail(
      new Map([
        ["from", "Shopify Contact <mailer@shopify.com>"],
        ["reply-to", "Riya <riya@customer.in>"],
      ]),
      "mailer@shopify.com"
    ),
    "riya@customer.in"
  );
  assert.equal(
    isInboundEmailAuthVerified(
      new Map([["authentication-results", "mx.google.com; dkim=pass; spf=pass"]])
    ),
    true
  );
  assert.equal(
    isInboundEmailAuthVerified(
      new Map([["authentication-results", "mx.google.com; dkim=fail; spf=softfail"]])
    ),
    false
  );
});

test("Trusted app origin prefers NEXT_PUBLIC_APP_URL and ignores spoofed x-forwarded-host", () => {
  const prevUrl = process.env.NEXT_PUBLIC_APP_URL;
  const prevTrust = process.env.TRUST_PROXY_HOST;
  try {
    process.env.NEXT_PUBLIC_APP_URL = "https://support.satmi.in/custom-path";
    const hdrs = new Headers({
      host: "localhost:5010",
      "x-forwarded-host": "evil.attacker.test",
    });
    assert.equal(getTrustedAppOrigin(hdrs), "https://support.satmi.in");

    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.TRUST_PROXY_HOST;
    assert.equal(getTrustedAppOrigin(hdrs), "http://localhost:5010");
  } finally {
    if (prevUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = prevUrl;
    if (prevTrust === undefined) delete process.env.TRUST_PROXY_HOST;
    else process.env.TRUST_PROXY_HOST = prevTrust;
  }
});

test("AI draft safety validator, Hinglish/money-back triggers, PII scrubbing, and heuristic guardrails", async () => {
  const scrubbed = scrubCustomerPii(
    "Hi Riya Patel, call +91 98765 43210, pincode 110001, IG @riya_satmi, email riya@example.in, order #S10729974",
    "Riya Patel"
  );
  assert.doesNotMatch(scrubbed, /98765/);
  assert.doesNotMatch(scrubbed, /110001/);
  assert.doesNotMatch(scrubbed, /riya_satmi/i);
  assert.doesNotMatch(scrubbed, /riya@example\.in/i);
  assert.doesNotMatch(scrubbed, /S10729974/);

  const baseStore = {
    query: "order status",
    extractedHints: { orderCodes: ["S10729974"], phones: [] },
    orders: [
      {
        id: 1,
        channelOrderId: "S10729974",
        status: "In Transit",
        total: 1850,
        paymentMethod: "Prepaid",
        courier: "Delhivery",
        awb: "DL123456",
        ndrReason: "",
        ndrAttempts: 0,
        confirmationStatus: "confirmed",
        orderDate: "2026-04-01T10:00:00Z",
        customerName: "Ananya",
        customerEmail: "ananya@example.com",
        customerPhone: "9876543210",
        customerCity: "Delhi",
        customerState: "DL",
        itemsSummary: "Cotton Kurta",
        isVipHighValue: false,
      },
    ],
    ragChunks: [
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        documentTitle: "Dispatch SLA",
        category: "policy" as const,
        heading: "Shipping",
        content: "Standard orders ship from Jaipur within 24-48 hours via Delhivery.",
        sourceRef: "",
        vectorSimilarity: 0.9,
        lexicalScore: 0.8,
        rrfScore: 0.9,
      },
    ],
    customerVerified: true,
    verificationReason: "matched_order_and_phone",
    requestedOrderCodes: ["S10729974"],
    associatedCustomerPhone: "9876543210",
    phoneMismatchDetected: false,
    phoneMismatchReason: "",
    newlyVerifiedPhoneToAssociate: "",
    customer360: computeCustomer360([], 0),
    hasVipOrder: false,
    highestOrderTotal: 1850,
    topRrfScore: 0.9,
    topVectorSimilarity: 0.9,
    topLexicalScore: 0.8,
    hasStrongKnowledgeMatch: true,
    embeddingModel: "gemini-embedding-001",
    embeddingUsage: {
      inputTokens: 12,
      outputTokens: 0,
      totalTokens: 12,
      estimatedCostUsd: 0.000002,
      isEstimated: false,
    },
  };

  assert.equal(
    validateAiDraftSafety({
      draft: "Please check https://phishing.example.com for your refund",
      storeContext: baseStore,
      latestCustomerText: "Where is my order?",
    }).safe,
    false
  );
  assert.equal(
    validateAiDraftSafety({
      draft: "Here is 20% off on your next order!",
      storeContext: baseStore,
      latestCustomerText: "Hi",
    }).safe,
    false
  );
  assert.equal(
    validateAiDraftSafety({
      draft: "Your order #S99999999 has been cancelled.",
      storeContext: baseStore,
      latestCustomerText: "Order update?",
    }).safe,
    false
  );

  // Money back + Hinglish + policy toggle
  const moneyBack = detectMandatoryHumanEscalation({
    latestCustomerText: "Please give my money back",
    storeContext: baseStore,
    vipThreshold: 3000,
  });
  assert.equal(moneyBack.required, true);

  const hinglish = detectMandatoryHumanEscalation({
    latestCustomerText: "Mera parcel kharab aur phata hua aaya hai, paisa wapas chahiye",
    storeContext: baseStore,
    vipThreshold: 3000,
  });
  assert.equal(hinglish.required, true);

  const policyDisabled = detectMandatoryHumanEscalation({
    latestCustomerText: "Please give my money back",
    storeContext: baseStore,
    vipThreshold: 3000,
    enabledPolicies: [],
  });
  assert.equal(policyDisabled.required, false);

  // Live heuristic safety: when Gemini key is absent, live evaluation NEVER auto-replies blindly
  const prevGemini = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    const res = await evaluateQueryWithStoreRag({
      channel: "instagram",
      customerName: "Ananya",
      customerEmail: "@ananya",
      latestCustomerText: "Where is my order #S10729974?",
      compactedContext: {
        totalMessages: 1,
        totalRawTokens: 10,
        compactionThreshold: 10000,
        wasCompacted: false,
        compactedNow: false,
        summaryText: "",
        summaryTokens: 0,
        summaryUpToMessageId: "",
        pinnedFacts: {
          orderCodes: [],
          phones: [],
          awbNumbers: [],
          emails: [],
          mentionedSizes: [],
          customerCommitments: [],
        },
        recentVerbatimMessages: [],
        promptReadyTranscript: "Customer: Where is my order #S10729974?",
      },
      storeContext: { ...baseStore, customerVerified: false },
      settings: {
        id: "default",
        operatingMode: "live_auto",
        approvalModeEnabled: false,
        liveOutboundEnabled: true,
        envLiveOutboundEnabled: false,
        testRecipientAllowlist: [],
        compactionTokenThreshold: 10000,
        autoReplyConfidenceThreshold: 0.82,
        vipOrderValueThreshold: 3000,
        debounceSeconds: 30,
        humanActionPolicies: ["manual_refund_or_bank_transfer"],
        ticketLabelSingular: "Ticket",
        ticketLabelPlural: "Tickets",
        brandPersonaPrompt: "",
        providerInfo: {
          provider: "gemini",
          chatModel: "gemini-2.5-flash",
          embeddingModel: "gemini-embedding-001",
          apiKeyConfigured: false,
        },
        updatedAt: "",
      },
      isSimulation: false,
    });
    assert.notEqual(res.decision.decision, "auto_reply");
    assert.ok(res.decision.confidence < 0.82);
  } finally {
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGemini;
  }
});

test("Selective AI learning blocks order-specific queries and allows general store rules", () => {
  const orderQuery = isOrderSpecificQueryOrCorrection({
    customerQuery: "Where is my order #S10729974?",
    declineReason: "Wrong tracking info",
    correctedReply: "Your order #S10729974 is out for delivery today via Delhivery.",
  });
  assert.equal(orderQuery.isOrderSpecific, true);

  const awbQuery = isOrderSpecificQueryOrCorrection({
    customerQuery: "Please check AWB 1234567890",
    declineReason: "Update tracking",
    correctedReply: "It is in transit.",
  });
  assert.equal(awbQuery.isOrderSpecific, true);

  const generalQuery = isOrderSpecificQueryOrCorrection({
    customerQuery: "How many days do I have for a size exchange?",
    declineReason: "Exchange window is 14 days, not 7 days",
    correctedReply: "Hi there, Satmi offers a 14-day size exchange from the delivery date.",
  });
  assert.equal(generalQuery.isOrderSpecific, false);
});

test("Phone mismatch across orders triggers mandatory human intervention & tracking URL builder", () => {
  const mismatch = detectMandatoryHumanEscalation({
    latestCustomerText: "What is the status of order #S10800099?",
    storeContext: {
      query: "What is the status of order #S10800099?",
      extractedHints: { orderCodes: ["S10800099"], phones: [] },
      requestedOrderCodes: ["S10800099"],
      orders: [],
      customerVerified: false,
      verificationReason: "Phone mismatch",
      associatedCustomerPhone: "9876543210",
      phoneMismatchDetected: true,
      phoneMismatchReason: "Order phone does not match customer's associated phone",
      newlyVerifiedPhoneToAssociate: "",
      customer360: computeCustomer360([], 0),
      hasVipOrder: false,
      highestOrderTotal: 999,
      ragChunks: [],
      topRrfScore: 0,
      topVectorSimilarity: 0,
      topLexicalScore: 0,
      hasStrongKnowledgeMatch: false,
      embeddingModel: "test",
      embeddingUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        isEstimated: false,
      },
    },
    vipThreshold: 3000,
  });
  assert.equal(mismatch.required, true);
  assert.equal(mismatch.category, "phone_mismatch_verification");

  assert.match(buildCourierTrackingUrl("Delhivery", "AWB12345"), /delhivery\.com/);
  assert.match(buildCourierTrackingUrl("Shadowfax", "SF998877"), /shadowfax\.in/);
  assert.match(buildCourierTrackingUrl("", "SR112233"), /shiprocket\.co\/tracking\/SR112233/);
});

test("AI token cost estimator and spend formatting helpers", () => {
  // Local/hashed fallback models always cost $0
  assert.equal(estimateAiCostUsd("local_heuristic", 5000, 1000), 0);
  assert.equal(estimateAiCostUsd("satmi-hashed-ngram-768", 500, 0), 0);

  // Gemini 2.5 Flash: $0.15/1M in, $0.60/1M out
  const flashCost = estimateAiCostUsd("gemini-2.5-flash", 1_000_000, 1_000_000);
  assert.equal(flashCost, 0.75);

  // Small single message cost > 0
  const msgCost = estimateAiCostUsd("gemini-2.5-flash", 1200, 200);
  assert.ok(msgCost > 0 && msgCost < 0.001);

  assert.equal(formatTokensCompact(420), "420");
  assert.equal(formatTokensCompact(15400), "15.4k");
  assert.equal(formatTokensCompact(1_250_000), "1.25M");
  assert.equal(formatCostUsd(0), "$0.00");
  assert.equal(formatCostUsd(0.0025), "$0.0025");
  assert.equal(formatCostInr(0), "₹0.00");
  assert.equal(formatCostInr(0.01, 85), "₹0.85");
});

