import { randomUUID } from "node:crypto";
import { isPgVectorAvailable, operationsDb } from "./schema";
import { computeCustomer360, extractOrderOrPhoneHints, type Customer360Summary } from "./sla";
import {
  cosineSimilarity,
  DEFAULT_GEMINI_EMBED_MODELS,
  deterministicLocalEmbedding,
  embedText,
  estimateTokenCount,
  getConfiguredAiProviderInfo,
  type AiTokenUsage,
} from "./ai-provider";

export type KnowledgeCategory = "policy" | "product" | "faq" | "admin_memory" | "template";

export type KnowledgeChunkDraft = {
  chunkIndex: number;
  heading: string;
  content: string;
  tokenEstimate: number;
};

export type RetrievedRagChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  category: KnowledgeCategory;
  heading: string;
  content: string;
  sourceRef: string;
  vectorSimilarity: number;
  lexicalScore: number;
  rrfScore: number;
};

export type LiveOrderContextItem = {
  id: number;
  channelOrderId: string;
  status: string;
  awb: string;
  courier: string;
  total: number;
  isVipHighValue: boolean;
  paymentMethod: string;
  orderDate: string;
  ndrReason: string;
  ndrAttempts: number;
  confirmationStatus: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerCity: string;
  customerState: string;
  itemsSummary: string;
};

export type StoreContextBundle = {
  query: string;
  extractedHints: { orderCodes: string[]; phones: string[] };
  requestedOrderCodes: string[];
  orders: LiveOrderContextItem[];
  customerVerified?: boolean;
  verificationReason?: string;
  associatedCustomerPhone: string;
  phoneMismatchDetected: boolean;
  phoneMismatchReason: string;
  newlyVerifiedPhoneToAssociate: string;
  customer360: Customer360Summary;
  hasVipOrder: boolean;
  highestOrderTotal: number;
  ragChunks: RetrievedRagChunk[];
  topRrfScore: number;
  topVectorSimilarity: number;
  topLexicalScore: number;
  hasStrongKnowledgeMatch: boolean;
  embeddingModel: string;
  embeddingUsage: AiTokenUsage;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strips customer-specific PII (emails, phone numbers, order codes, AWBs, pincodes, handles, names)
 * before storing learned Admin Memory into the global RAG knowledge base.
 */
export function scrubCustomerPii(raw: string, customerName?: string): string {
  let out = String(raw || "")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[CUSTOMER_EMAIL]")
    .replace(/(?:\+?91[\s.-]?)?[6-9]\d{4}[\s.-]?\d{5}\b/g, "[CUSTOMER_PHONE]")
    .replace(/\b0\d{2,4}[\s.-]?\d{6,8}\b/g, "[CUSTOMER_PHONE]")
    .replace(/(?:#|\b)(?:S|SI|ORD|SATMI)[-_]?\d{4,12}\b/gi, "[ORDER_ID]")
    .replace(/#[0-9]{4,12}\b/g, "[ORDER_ID]")
    .replace(/\bAWB[\s:#-]*[A-Z0-9]{6,20}\b/gi, "AWB [TRACKING_NUMBER]")
    .replace(/\b(?:pin\s*code|pincode|pin|postal\s*code)[\s:#-]*[1-8]\d{5}\b/gi, "pincode [PINCODE]")
    .replace(/(?:^|\s)@[a-zA-Z0-9._]{3,30}\b/g, " [CUSTOMER_HANDLE]");

  if (customerName) {
    const cleanName = customerName.replace(/^@/, "").trim();
    const parts = [cleanName, ...cleanName.split(/\s+/)].filter((p) => p.length >= 3);
    for (const part of parts) {
      if (/^(the|customer|satmi|support|order|team)$/i.test(part)) continue;
      out = out.replace(new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"), "[CUSTOMER_NAME]");
    }
  }

  return out.replace(/\s+/g, " ").trim();
}

/**
 * Splits a store knowledge document into semantic / markdown-aware chunks (~300 tokens)
 * with overlap while preserving heading breadcrumbs.
 */
export function chunkKnowledgeDocument(
  title: string,
  content: string,
  maxTokens = 300,
  overlapTokens = 45
): KnowledgeChunkDraft[] {
  const cleanTitle = String(title || "Store Knowledge").trim();
  const rawContent = String(content || "").replace(/\r\n/g, "\n").trim();
  if (!rawContent) return [];

  const lines = rawContent.split("\n");
  const sections: Array<{ heading: string; paragraphs: string[] }> = [];
  let currentHeading = cleanTitle;
  let currentBuffer: string[] = [];

  const flushParagraphBuffer = (targetParagraphs: string[]) => {
    const joined = currentBuffer.join("\n").trim();
    if (joined) targetParagraphs.push(joined);
    currentBuffer = [];
  };

  let currentParagraphs: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraphBuffer(currentParagraphs);
      if (currentParagraphs.length > 0) {
        sections.push({ heading: currentHeading, paragraphs: currentParagraphs });
        currentParagraphs = [];
      }
      const subHeading = headingMatch[2].trim();
      currentHeading =
        subHeading.toLowerCase() === cleanTitle.toLowerCase()
          ? cleanTitle
          : `${cleanTitle} › ${subHeading}`;
    } else if (line.trim() === "") {
      flushParagraphBuffer(currentParagraphs);
    } else {
      currentBuffer.push(line);
    }
  }
  flushParagraphBuffer(currentParagraphs);
  if (currentParagraphs.length > 0) {
    sections.push({ heading: currentHeading, paragraphs: currentParagraphs });
  }

  const chunks: KnowledgeChunkDraft[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    let acc: string[] = [];
    let accTokens = 0;

    for (const para of section.paragraphs) {
      const paraTokens = estimateTokenCount(para);
      if (accTokens + paraTokens > maxTokens && acc.length > 0) {
        const chunkText = acc.join("\n\n").trim();
        chunks.push({
          chunkIndex: chunkIndex++,
          heading: section.heading,
          content: chunkText,
          tokenEstimate: estimateTokenCount(`${section.heading}\n${chunkText}`),
        });

        // Retain trailing overlap
        const tail: string[] = [];
        let tailTokens = 0;
        for (let i = acc.length - 1; i >= 0; i--) {
          const t = estimateTokenCount(acc[i]);
          if (tailTokens + t > overlapTokens && tail.length > 0) break;
          tail.unshift(acc[i]);
          tailTokens += t;
        }
        acc = tail;
        accTokens = tailTokens;
      }

      if (paraTokens > maxTokens * 1.4) {
        // Split very long paragraphs by sentence boundaries
        const sentences = para.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          const sTokens = estimateTokenCount(sentence);
          if (accTokens + sTokens > maxTokens && acc.length > 0) {
            const chunkText = acc.join(" ").trim();
            chunks.push({
              chunkIndex: chunkIndex++,
              heading: section.heading,
              content: chunkText,
              tokenEstimate: estimateTokenCount(`${section.heading}\n${chunkText}`),
            });
            acc = [];
            accTokens = 0;
          }
          acc.push(sentence);
          accTokens += sTokens;
        }
      } else {
        acc.push(para);
        accTokens += paraTokens;
      }
    }

    if (acc.length > 0) {
      const chunkText = acc.join("\n\n").trim();
      chunks.push({
        chunkIndex: chunkIndex++,
        heading: section.heading,
        content: chunkText,
        tokenEstimate: estimateTokenCount(`${section.heading}\n${chunkText}`),
      });
    }
  }

  return chunks;
}

/**
 * Inserts or updates a Store Knowledge Document and indexes its chunks + 768-dim embeddings.
 */
export async function upsertKnowledgeDocument(params: {
  id?: string;
  title: string;
  category: KnowledgeCategory;
  content: string;
  sourceRef?: string;
  sourceTicketId?: string | null;
  metadata?: Record<string, unknown>;
  isActive?: boolean;
  expiresAt?: string | null;
  actorId?: string;
}): Promise<{ id: string; chunksIndexed: number; embeddingModel: string }> {
  const db = await operationsDb();
  const title = String(params.title || "").trim().slice(0, 200);
  const content = String(params.content || "").trim();
  if (!title || !content) {
    throw new Error("Knowledge document title and content are required");
  }

  const allowedCategories = new Set<KnowledgeCategory>([
    "policy",
    "product",
    "faq",
    "admin_memory",
    "template",
  ]);
  const category: KnowledgeCategory = allowedCategories.has(params.category)
    ? params.category
    : "faq";
  const sourceRef = String(params.sourceRef || "").trim();
  const actorId = String(params.actorId || "system");
  const isActive = params.isActive !== false;

  // Resolve existing document ID by explicit id, source_ref, or exact admin_memory title (dedup)
  let docId = params.id ? String(params.id).trim() : "";
  if (!docId && sourceRef) {
    const existingByRef = await db
      .prepare("SELECT id FROM support_knowledge_documents WHERE source_ref = ? LIMIT 1")
      .bind(sourceRef)
      .first<{ id: string }>();
    if (existingByRef?.id) docId = existingByRef.id;
  }
  if (!docId && category === "admin_memory") {
    const existingMem = await db
      .prepare(
        "SELECT id FROM support_knowledge_documents WHERE category = 'admin_memory' AND LOWER(TRIM(title)) = LOWER(TRIM(?)) LIMIT 1",
      )
      .bind(title)
      .first<{ id: string }>();
    if (existingMem?.id) docId = existingMem.id;
  }
  if (!docId) docId = `kb_${randomUUID()}`;

  const chunkDrafts = chunkKnowledgeDocument(title, content);
  let lastModel = getConfiguredAiProviderInfo().embeddingModel;

  const embeddedChunks: Array<
    KnowledgeChunkDraft & { id: string; embedding: number[]; embeddingModel: string }
  > = [];

  const embedPaceMs = Math.max(0, Number(process.env.RAG_EMBED_PACE_MS ?? 60));
  for (let idx = 0; idx < chunkDrafts.length; idx++) {
    const draft = chunkDrafts[idx];
    if (idx > 0 && embedPaceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, embedPaceMs));
    }
    const textToEmbed = `${draft.heading}\n${draft.content}`;
    const { embedding, model } = await embedText(textToEmbed, "RETRIEVAL_DOCUMENT");
    lastModel = model;
    embeddedChunks.push({
      ...draft,
      id: `${docId}_c${draft.chunkIndex}`,
      embedding,
      embeddingModel: model,
    });
  }

  const hasPgVector = await isPgVectorAvailable();

  await db.transaction(async (sql) => {
    await sql`
      INSERT INTO support_knowledge_documents (
        id, title, category, source_ref, source_ticket_id, content, metadata,
        is_active, expires_at, created_by, updated_by, updated_at
      ) VALUES (
        ${docId},
        ${title},
        ${category},
        ${sourceRef},
        ${params.sourceTicketId || null},
        ${content},
        ${sql.json((params.metadata || {}) as never)},
        ${isActive},
        ${params.expiresAt ? new Date(params.expiresAt).toISOString() : null}::timestamptz,
        ${actorId},
        ${actorId},
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        source_ref = CASE WHEN EXCLUDED.source_ref <> '' THEN EXCLUDED.source_ref ELSE support_knowledge_documents.source_ref END,
        content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        is_active = EXCLUDED.is_active,
        expires_at = EXCLUDED.expires_at,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `;

    await sql`DELETE FROM support_knowledge_chunks WHERE document_id = ${docId}`;

    for (const chunk of embeddedChunks) {
      if (hasPgVector) {
        const vectorLiteral = `[${chunk.embedding.join(",")}]`;
        await sql`
          INSERT INTO support_knowledge_chunks (
            id, document_id, chunk_index, heading, content, token_estimate, embedding_json, embedding_model, embedding
          ) VALUES (
            ${chunk.id},
            ${docId},
            ${chunk.chunkIndex},
            ${chunk.heading},
            ${chunk.content},
            ${chunk.tokenEstimate},
            ${sql.json(chunk.embedding)},
            ${chunk.embeddingModel},
            ${vectorLiteral}::vector
          )
        `;
      } else {
        await sql`
          INSERT INTO support_knowledge_chunks (
            id, document_id, chunk_index, heading, content, token_estimate, embedding_json, embedding_model
          ) VALUES (
            ${chunk.id},
            ${docId},
            ${chunk.chunkIndex},
            ${chunk.heading},
            ${chunk.content},
            ${chunk.tokenEstimate},
            ${sql.json(chunk.embedding)},
            ${chunk.embeddingModel}
          )
        `;
      }
    }
  });

  return {
    id: docId,
    chunksIndexed: embeddedChunks.length,
    embeddingModel: lastModel,
  };
}

export async function deleteKnowledgeDocument(documentId: string) {
  const db = await operationsDb();
  await db
    .prepare("DELETE FROM support_knowledge_documents WHERE id = ?")
    .bind(documentId)
    .run();
  return { ok: true };
}

const DEFAULT_SATMI_STORE_POLICIES: Array<{
  sourceRef: string;
  title: string;
  category: KnowledgeCategory;
  content: string;
}> = [
  {
    sourceRef: "policy:satmi_shipping_delivery",
    title: "Satmi Shipping, Dispatch & Delivery Timelines Policy",
    category: "policy",
    content: `# Shipping & Delivery Timelines
- All ready-to-ship Satmi orders are dispatched from our warehouse within 24 to 48 working hours of order confirmation.
- Standard delivery across India takes 4 to 7 working days from dispatch (metro cities typically 3 to 5 working days).
- Once dispatched, customers receive an AWB tracking number and courier partner link via SMS, WhatsApp, and Email.

# NDR (Non-Delivery Report) & Re-attempts
- If a delivery attempt fails (NDR raised due to customer unreachable, incomplete address, or door locked), the courier makes up to 3 delivery attempts.
- Customers can share an alternate 10-digit phone number or landmark with Satmi Support to trigger a high-priority phone-verified courier re-attempt on the next working day.`,
  },
  {
    sourceRef: "policy:satmi_exchange_returns",
    title: "Satmi Size Exchange, Return & Store Credit Policy",
    category: "policy",
    content: `# Size Exchange Policy
- Satmi offers a hassle-free 7-day size exchange window from the date of delivery.
- To initiate a size exchange, the product must be unused, unwashed, and have the original Satmi product tag intact.
- Customers should share their Order ID, preferred replacement size, and a photo showing the intact product tag. Reverse pickup is arranged within 24 to 48 hours.

# Damaged or Wrong Item Received
- If a customer receives a damaged, defective, or incorrect product, they must notify Satmi Support within 48 hours of delivery with an unboxing/product photo.
- Note for AI Agent: Any damaged item claim, wrong item received, or manual bank/UPI refund request requires human agent verification and must be escalated to a human support specialist.`,
  },
  {
    sourceRef: "policy:satmi_payment_cod_escalation",
    title: "Satmi COD, Order Confirmation & Human Escalation Rules",
    category: "policy",
    content: `# Payment Methods (Prepaid & COD)
- Satmi accepts Prepaid orders (UPI, Debit/Credit Cards, NetBanking) and Cash on Delivery (COD).
- High-risk or COD orders may undergo phone/WhatsApp confirmation before dispatch.

# Mandatory Human Escalation Triggers
- Callback Requests: Whenever a customer asks for a phone call or callback, the AI must escalate the ticket to a human agent to arrange the callback.
- High-Value / VIP Orders: Orders above Rs. 3,000 with delivery issues, cancellation requests, or exceptions require human agent attention.
- Manual Refunds / Bank Transfers & Damaged Item Claims: Must always be routed to a human support specialist.`,
  },
];

function stripHtmlTags(html: string): string {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Removes storefront UI buttons, quantity controls, form labels, carousel arrows,
 * URL boilerplate, and un-interpolated template variables from scraped or synced KB text.
 */
export function cleanScrapedStoreText(raw: string): string {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^Source:\s*https?:\/\/\S+\s*$/gim, "")
    .replace(/\{\{\s*(?:customer_name|first_name|name)\s*\}\}/gi, "Customer")
    .replace(/\{\{\s*(?:order_id|order_number|order_code)\s*\}\}/gi, "your order")
    .replace(/\{\{[^{}\n]*\}\}/g, "")
    .replace(/\b(?:ADD TO BOX|BUY IT NOW|Add to Cart|Buy Now)\b/gi, "")
    .replace(/[✕❮❯]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line) => {
      if (!line) return true;
      if (/^(?:ADD TO BOX|Add to Box|BUY IT NOW|Buy It Now|TRACK ORDER|Send Message|1 added|AS SEEN IN|As Seen On|−|\+|-|×|✕|❮|❯)$/i.test(line)) {
        return false;
      }
      if (/^(?:First Name|Last Name|Email|Phone Number|Message|Submit|Subscribe)$/i.test(line)) {
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type ShopifyProductApiItem = {
  id: number | string;
  title?: string;
  body_html?: string;
  vendor?: string;
  product_type?: string;
  tags?: string | string[];
  status?: string;
  handle?: string;
  variants?: Array<{
    id?: number | string;
    title?: string;
    price?: string;
    compare_at_price?: string | null;
    sku?: string;
    inventory_quantity?: number;
  }>;
};

/**
 * Fetches live product catalog from Shopify Admin API when SHOPIFY_SHOP_DOMAIN
 * and SHOPIFY_ADMIN_ACCESS_TOKEN are configured in the environment.
 * Read-only GET request — never modifies Shopify data.
 */
async function fetchShopifyCatalogProducts(): Promise<{
  synced: number;
  configured: boolean;
  error?: string;
}> {
  const rawDomain = (
    process.env.SHOPIFY_SHOP_DOMAIN ||
    process.env.SHOPIFY_STORE_DOMAIN ||
    "satmi.in"
  ).trim();
  const accessToken = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
  const apiVersion = (process.env.SHOPIFY_API_VERSION || "2024-10").trim();

  const host = rawDomain
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim();

  let products: ShopifyProductApiItem[] = [];
  const hasAdminCreds = Boolean(rawDomain && accessToken);
  let configured = hasAdminCreds;

  try {
    if (host && accessToken) {
      const url = `https://${host}/admin/api/${encodeURIComponent(
        apiVersion
      )}/products.json?limit=250&status=active`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) {
        const payload = (await res.json()) as { products?: ShopifyProductApiItem[] };
        products = payload.products || [];
      }
    }

    // Fallback or supplement with public satmi.in/products.json if Admin API returned 0
    if (products.length === 0) {
      const pubRes = await fetch("https://satmi.in/products.json?limit=250", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(25000),
      }).catch(() => null);
      if (pubRes?.ok) {
        const payload = (await pubRes.json()) as { products?: ShopifyProductApiItem[] };
        products = payload.products || [];
        configured = true;
      }
    }

    let synced = 0;

    for (const p of products.slice(0, 250)) {
      if (!p.id || !p.title) continue;
      const description = cleanScrapedStoreText(stripHtmlTags(p.body_html || ""));
      const tags = Array.isArray(p.tags)
        ? p.tags.join(", ")
        : String(p.tags || "").trim();
      const variants = (p.variants || []).filter((v) => {
        const numericPrice = Number(v.price ?? 0);
        return !Number.isFinite(numericPrice) || numericPrice > 0 || (p.variants || []).length === 1;
      });
      const variantLines = variants
        .filter((v) => v.price === undefined || Number(v.price) > 0)
        .map((v) => {
          const sizeOrVariant = v.title && v.title !== "Default Title" ? v.title : "Standard";
          const price = v.price && Number(v.price) > 0 ? `₹${v.price}` : "";
          const compare =
            v.compare_at_price && Number(v.compare_at_price) > Number(v.price || 0)
              ? ` (MRP ₹${v.compare_at_price})`
              : "";
          const sku = v.sku ? ` | SKU: ${v.sku}` : "";
          const stock =
            typeof v.inventory_quantity === "number"
              ? v.inventory_quantity > 0
                ? ` | In Stock (${v.inventory_quantity})`
                : " | Out of Stock"
              : "";
          return `- Variant/Size: ${sizeOrVariant}${price ? ` | Price: ${price}` : ""}${compare}${sku}${stock}`;
        });

      const docContent = [
        `# Product: ${p.title}`,
        p.product_type ? `Category / Type: ${p.product_type}` : "",
        p.vendor ? `Brand / Vendor: ${p.vendor}` : "",
        tags ? `Tags: ${tags}` : "",
        description ? `\n## Description & Details\n${description}` : "",
        variantLines.length
          ? `\n## Available Sizes, Variants, Pricing & Stock\n${variantLines.join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      await upsertKnowledgeDocument({
        title: `Product: ${p.title}`,
        category: "product",
        sourceRef: `shopify:product:${p.id}`,
        content: docContent,
        metadata: {
          shopifyProductId: p.id,
          handle: p.handle || "",
          productType: p.product_type || "",
          variantCount: variants.length,
        },
        actorId: "shopify_sync",
      });
      synced++;
    }

    return { synced, configured };
  } catch (err) {
    return {
      synced: 0,
      configured: true,
      error: err instanceof Error ? err.message : "Shopify sync failed",
    };
  }
}

const SATMI_WEBSITE_PAGES: Array<{
  url: string;
  sourceRef: string;
  title: string;
  category: KnowledgeCategory;
}> = [
  {
    url: "https://satmi.in/policies/refund-policy",
    sourceRef: "web:satmi.in:refund-policy",
    title: "Satmi.in Official Refund & Return Policy",
    category: "policy",
  },
  {
    url: "https://satmi.in/policies/shipping-policy",
    sourceRef: "web:satmi.in:shipping-policy",
    title: "Satmi.in Official Shipping Policy",
    category: "policy",
  },
  {
    url: "https://satmi.in/policies/terms-of-service",
    sourceRef: "web:satmi.in:terms-of-service",
    title: "Satmi.in Official Terms of Service",
    category: "policy",
  },
  {
    url: "https://satmi.in/policies/privacy-policy",
    sourceRef: "web:satmi.in:privacy-policy",
    title: "Satmi.in Official Privacy Policy",
    category: "policy",
  },
  {
    url: "https://satmi.in/pages/about-us",
    sourceRef: "web:satmi.in:about-us",
    title: "Satmi.in About Us & Brand Story",
    category: "faq",
  },
  {
    url: "https://satmi.in/pages/contact",
    sourceRef: "web:satmi.in:contact",
    title: "Satmi.in Official Contact Information",
    category: "faq",
  },
  {
    url: "https://satmi.in/pages/certification",
    sourceRef: "web:satmi.in:certification",
    title: "Satmi.in Product Authenticity & Certification",
    category: "faq",
  },
  {
    url: "https://satmi.in/pages/track-your-order",
    sourceRef: "web:satmi.in:track-your-order",
    title: "Satmi.in Order Tracking Guide",
    category: "faq",
  },
  {
    url: "https://satmi.in/pages/return-your-order",
    sourceRef: "web:satmi.in:return-your-order",
    title: "Satmi.in Order Return Portal & Instructions",
    category: "policy",
  },
  {
    url: "https://satmi.in/pages/bundle-offer",
    sourceRef: "web:satmi.in:bundle-offer",
    title: "Satmi.in Bundle Offers & Deals",
    category: "product",
  },
  {
    url: "https://satmi.in/pages/buy-2-karungali-at-999",
    sourceRef: "web:satmi.in:buy-2-karungali-at-999",
    title: "Satmi.in Buy 2 Karungali at ₹999 Offer",
    category: "product",
  },
  {
    url: "https://satmi.in/pages/buy-2-incense",
    sourceRef: "web:satmi.in:buy-2-incense",
    title: "Satmi.in Buy 2 Incense Offer",
    category: "product",
  },
  {
    url: "https://satmi.in/pages/why-has-karungali-mala-become-so-famous-these-days",
    sourceRef: "web:satmi.in:karungali-mala-guide",
    title: "Satmi.in Karungali Mala Benefits & Product Guide",
    category: "product",
  },
  {
    url: "https://satmi.in/pages/before-you-buy-your-next-agarbatti",
    sourceRef: "web:satmi.in:agarbatti-guide",
    title: "Satmi.in Agarbatti & Dhoop Quality Guide",
    category: "product",
  },
];

export function extractReadableMainHtml(html: string): string {
  const withoutHead = String(html || "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<dialog[\s\S]*?<\/dialog>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<button[\s\S]*?<\/button>/gi, " ")
    .replace(/<select[\s\S]*?<\/select>/gi, " ")
    .replace(/<textarea[\s\S]*?<\/textarea>/gi, " ")
    .replace(/<input[^>]*>/gi, " ");

  const mainMatch =
    withoutHead.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    withoutHead.match(/class="[^"]*shopify-policy__body[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    withoutHead.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

  const segment = mainMatch?.[1] || withoutHead;
  return cleanScrapedStoreText(stripHtmlTags(segment)).slice(0, 18000);
}

async function scrapeSatmiWebsiteToRag(actorId = "web_scraper"): Promise<number> {
  let scraped = 0;
  for (const page of SATMI_WEBSITE_PAGES) {
    try {
      const res = await fetch(page.url, {
        method: "GET",
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const readable = extractReadableMainHtml(html);
      if (readable.length < 80) continue;

      await upsertKnowledgeDocument({
        title: page.title,
        category: page.category,
        sourceRef: page.sourceRef,
        content: `# ${page.title}\n\n${readable}`,
        metadata: { url: page.url, source: "satmi.in" },
        actorId,
      });
      scraped++;
    } catch {
      // Non-fatal if an individual page times out
    }
  }
  return scraped;
}

/**
 * Synchronizes all available store context into the Hybrid RAG Knowledge Base:
 * 1. Foundational Satmi Store Policies
 * 2. Live satmi.in Website Policies, FAQs & Landing Pages
 * 3. Live Shopify Admin API + satmi.in/products.json Product Catalog
 * 4. Local PostgreSQL inventory_products and distinct order catalog items
 * 5. Shared Support Reply Templates (support_reply_templates)
 */
export async function syncStoreKnowledgeToRag(actorId = "system"): Promise<{
  policiesSynced: number;
  websitePagesScraped: number;
  shopifyProductsSynced: number;
  shopifyConfigured: boolean;
  shopifyError?: string;
  localProductsSynced: number;
  templatesSynced: number;
  totalDocuments: number;
  totalChunks: number;
}> {
  const db = await operationsDb();
  let policiesSynced = 0;
  let localProductsSynced = 0;
  let templatesSynced = 0;

  // 1. Seed Foundational Policies (only if not already present by source_ref)
  for (const policy of DEFAULT_SATMI_STORE_POLICIES) {
    const existing = await db
      .prepare("SELECT id FROM support_knowledge_documents WHERE source_ref = ?")
      .bind(policy.sourceRef)
      .first<{ id: string }>();
    if (!existing) {
      await upsertKnowledgeDocument({
        title: policy.title,
        category: policy.category,
        sourceRef: policy.sourceRef,
        content: policy.content,
        actorId,
      });
      policiesSynced++;
    }
  }

  // 2. Scrape satmi.in website policies, FAQs & offer pages
  const websitePagesScraped = await scrapeSatmiWebsiteToRag(actorId);

  // 3. Sync Live Shopify Admin API + satmi.in/products.json Products
  const shopifyResult = await fetchShopifyCatalogProducts();

  // 3. Sync Local PostgreSQL inventory_products (if table exists)
  const invTable = await db
    .prepare("SELECT to_regclass('public.inventory_products') AS name")
    .first<{ name: string | null }>()
    .catch(() => null);

  if (invTable?.name) {
    const invProducts = await db
      .prepare("SELECT * FROM inventory_products LIMIT 200")
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] }));

    for (const prod of invProducts.results) {
      const prodId = String(prod.id || "");
      const prodName = String(prod.name || prod.title || prod.sku || "");
      if (!prodId || !prodName) continue;
      const sku = String(prod.sku || "");
      const numPrice = Number(prod.price ?? 0);
      const price = prod.price != null && (!Number.isFinite(numPrice) || numPrice > 0) ? `₹${prod.price}` : "";
      const desc = cleanScrapedStoreText(String(prod.description || prod.notes || ""));
      const content = [
        `# Inventory Product: ${prodName}`,
        sku ? `SKU: ${sku}` : "",
        price ? `Price: ${price}` : "",
        desc ? `Details: ${desc}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      await upsertKnowledgeDocument({
        title: `Product: ${prodName}`,
        category: "product",
        sourceRef: `db:inventory_product:${prodId}`,
        content,
        metadata: { sku, source: "inventory_products" },
        actorId,
      });
      localProductsSynced++;
    }
  }

  // 4. Discover distinct store products from orders.products_json so the AI knows actual store items
  const recentOrdersWithProducts = await db
    .prepare(
      `SELECT products_json FROM orders
       WHERE products_json <> '[]' AND products_json <> ''
       ORDER BY created_at DESC
       LIMIT 250`
    )
    .all<{ products_json?: string; productsJson?: string }>()
    .catch(() => ({ results: [] as Array<{ products_json?: string; productsJson?: string }> }));

  const discoveredCatalog = new Map<
    string,
    { name: string; skus: Set<string>; prices: Set<string>; count: number }
  >();

  for (const row of recentOrdersWithProducts.results) {
    const raw = row.products_json || row.productsJson || "[]";
    try {
      const parsed = JSON.parse(String(raw));
      const items = Array.isArray(parsed) ? parsed : [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const itemObj = item as Record<string, unknown>;
        const name = String(
          itemObj.name || itemObj.title || itemObj.product_name || ""
        ).trim();
        if (!name) continue;
        const price = itemObj.price ?? itemObj.selling_price ?? itemObj.total;
        const numericPrice = price != null && String(price).trim() !== "" ? Number(price) : NaN;
        // Skip ₹0.00 freebie/gift line-items so they do not pollute catalog pricing
        if (Number.isFinite(numericPrice) && numericPrice <= 0 && /\b(?:free|gift)\b/i.test(name)) {
          continue;
        }
        const key = name.toLowerCase();
        const entry = discoveredCatalog.get(key) || {
          name,
          skus: new Set<string>(),
          prices: new Set<string>(),
          count: 0,
        };
        const sku = String(itemObj.sku || itemObj.channel_sku || "").trim();
        if (sku) entry.skus.add(sku);
        if (Number.isFinite(numericPrice) && numericPrice > 0) {
          entry.prices.add(`₹${price}`);
        }
        entry.count++;
        discoveredCatalog.set(key, entry);
      }
    } catch {
      // ignore malformed JSON
    }
  }

  if (discoveredCatalog.size > 0) {
    const topItems = [...discoveredCatalog.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 120);
    const catalogLines = topItems.map((item) => {
      const skuPart = item.skus.size ? ` | SKUs: ${[...item.skus].slice(0, 5).join(", ")}` : "";
      const pricePart = item.prices.size
        ? ` | Typical Price: ${[...item.prices].slice(0, 3).join(", ")}`
        : "";
      return `- ${item.name}${skuPart}${pricePart}`;
    });

    await upsertKnowledgeDocument({
      title: "Satmi Active Store Product Catalog (Orders & SKU Directory)",
      category: "product",
      sourceRef: "db:order_catalog_summary",
      content: `# Satmi Active Store Products & SKUs\nThe following products and SKUs are actively sold in the Satmi store:\n\n${catalogLines.join(
        "\n"
      )}`,
      metadata: { productCount: topItems.length },
      actorId,
    });
    localProductsSynced++;
  }

  // 5. Sync Support Reply Templates (cleaned of {{customer_name}} / {{order_id}} raw placeholders)
  const templates = await db
    .prepare("SELECT id, name, body, macro_tags, shortcut FROM support_reply_templates")
    .all<Record<string, unknown>>()
    .catch(() => ({ results: [] as Record<string, unknown>[] }));

  for (const tpl of templates.results) {
    const tplId = String(tpl.id || "");
    const tplName = String(tpl.name || "");
    const tplBody = cleanScrapedStoreText(String(tpl.body || ""));
    if (!tplId || !tplName || !tplBody) continue;
    await upsertKnowledgeDocument({
      title: `Approved Reply Template: ${tplName}`,
      category: "template",
      sourceRef: `db:template:${tplId}`,
      content: `# Approved Support Response Template: ${tplName}\n${tplBody}`,
      metadata: { templateId: tplId, shortcut: tpl.shortcut || "" },
      actorId,
    });
    templatesSynced++;
  }

  // 6. Repair any non-primary or legacy embeddings across the Knowledge Base
  await repairKnowledgeChunkEmbeddings({ actorId }).catch(() => null);

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*)::int FROM support_knowledge_documents WHERE is_active = TRUE) AS docs,
         (SELECT COUNT(*)::int FROM support_knowledge_chunks) AS chunks`
    )
    .first<{ docs: number; chunks: number }>();

  return {
    policiesSynced,
    websitePagesScraped,
    shopifyProductsSynced: shopifyResult.synced,
    shopifyConfigured: shopifyResult.configured,
    ...(shopifyResult.error ? { shopifyError: shopifyResult.error } : {}),
    localProductsSynced,
    templatesSynced,
    totalDocuments: Number(counts?.docs || 0),
    totalChunks: Number(counts?.chunks || 0),
  };
}

function summarizeOrderProductsJson(rawJson: unknown): string {
  try {
    const arr = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    if (!Array.isArray(arr) || arr.length === 0) return "";
    return arr
      .slice(0, 6)
      .map((item: Record<string, unknown>) => {
        const name = String(item.name || item.title || item.product_name || "Item");
        const qty = Number(item.quantity || item.units || 1);
        const sku = item.sku ? ` (SKU: ${item.sku})` : "";
        const price = item.price ?? item.selling_price;
        const numPrice = price != null ? Number(price) : NaN;
        const priceStr = Number.isFinite(numPrice) && numPrice > 0 ? ` @ ₹${price}` : "";
        return `${qty}x ${name}${sku}${priceStr}`;
      })
      .join("; ");
  } catch {
    return "";
  }
}

/**
 * Detects whether a 768-dim vector was produced by the sparse deterministic local hashed-ngram
 * fallback (which leaves >450 zero dimensions) rather than a dense neural embedding model.
 */
export function isSparseHashedVector(vec: unknown): boolean {
  let arr: unknown[] | null = null;
  if (Array.isArray(vec)) {
    arr = vec;
  } else if (typeof vec === "string") {
    try {
      const parsed = JSON.parse(vec);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      return true;
    }
  }
  if (!arr || arr.length === 0) return true;
  let zeroCount = 0;
  for (let i = 0; i < arr.length; i++) {
    if ((Number(arr[i]) || 0) === 0) zeroCount++;
  }
  return zeroCount > arr.length * 0.15;
}

/**
 * Targeted Repair & Re-Embed Routine:
 * 1. Cleans any scraped storefront UI noise ({{customer_name}}, ADD TO BOX, Source URLs, ₹0.00 freebies)
 *    from existing support_knowledge_documents and support_knowledge_chunks.
 * 2. Re-embeds all chunks whose embedding_model does not match the primary configured model
 *    (e.g. 'gemini-embedding-001') or whose vector is sparse/missing, with paced retry/backoff.
 * 3. Backfills pgvector `embedding` column when the PostgreSQL `vector` extension is available.
 */
export async function repairKnowledgeChunkEmbeddings(params?: {
  targetModel?: string;
  forceAll?: boolean;
  paceMs?: number;
  actorId?: string;
}): Promise<{
  inspected: number;
  cleanedDocs: number;
  reEmbedded: number;
  alreadyHealthy: number;
  stillFallback: number;
  targetModel: string;
  pgVectorEnabled: boolean;
}> {
  const db = await operationsDb();
  const providerInfo = getConfiguredAiProviderInfo();
  const targetModel =
    params?.targetModel ||
    (providerInfo.provider === "gemini"
      ? DEFAULT_GEMINI_EMBED_MODELS[0]
      : providerInfo.embeddingModel);
  const paceMs = Math.max(0, Number(params?.paceMs ?? process.env.RAG_EMBED_PACE_MS ?? 75));
  const hasPgVector = await isPgVectorAvailable();

  // Step 1: Clean polluted document content (UI chrome, {{customer_name}}, Source: https://...)
  const allDocs = await db
    .prepare("SELECT id, title, category, content FROM support_knowledge_documents")
    .all<{ id: string; title: string; category: string; content: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; title: string; category: string; content: string }> }));

  let cleanedDocs = 0;
  for (const doc of allDocs.results) {
    const cleaned = cleanScrapedStoreText(doc.content)
      .replace(/\|\s*Typical Price:\s*₹0(?:\.00)?\b/gi, "")
      .replace(/\|\s*Price:\s*₹0(?:\.00)?\b/gi, "");
    if (cleaned && cleaned !== doc.content.trim()) {
      await upsertKnowledgeDocument({
        id: doc.id,
        title: doc.title,
        category: doc.category as KnowledgeCategory,
        content: cleaned,
        actorId: params?.actorId || "rag_repair",
      });
      cleanedDocs++;
    }
  }

  // Step 2: Inspect all chunks and re-embed any non-targetModel or sparse hashed chunks
  const chunkRows = await db
    .prepare(
      `SELECT id, document_id, heading, content, embedding_json, COALESCE(embedding_model, '') AS embedding_model
       FROM support_knowledge_chunks
       ORDER BY document_id, chunk_index ASC`,
    )
    .all<{
      id: string;
      document_id: string;
      heading: string;
      content: string;
      embedding_json: unknown;
      embedding_model: string;
    }>();

  let reEmbedded = 0;
  let alreadyHealthy = 0;
  let stillFallback = 0;

  for (let i = 0; i < chunkRows.results.length; i++) {
    const row = chunkRows.results[i];
    const currentModel = String(row.embedding_model || "").trim();
    const isSparse = isSparseHashedVector(row.embedding_json);
    const cleanedChunkContent = cleanScrapedStoreText(row.content);
    const contentChanged = cleanedChunkContent !== row.content.trim();

    const needsReEmbed =
      params?.forceAll === true ||
      contentChanged ||
      isSparse ||
      currentModel !== targetModel;

    if (!needsReEmbed) {
      alreadyHealthy++;
      continue;
    }

    // If vector is already dense (non-sparse) and only embedding_model label was blank from pre-0024 schema,
    // and we didn't change content or forceAll, stamp the model name without wasting an API call
    // unless GEMINI_API_KEY is configured and we want verified embeddings.
    if (
      !params?.forceAll &&
      !contentChanged &&
      !isSparse &&
      currentModel === "" &&
      targetModel === "gemini-embedding-001"
    ) {
      let existingVec: number[] | null = null;
      if (Array.isArray(row.embedding_json)) {
        existingVec = row.embedding_json as number[];
      } else if (typeof row.embedding_json === "string") {
        try {
          existingVec = JSON.parse(row.embedding_json) as number[];
        } catch {
          existingVec = null;
        }
      }
      if (existingVec && existingVec.length === 768) {
        if (hasPgVector) {
          const vectorLiteral = `[${existingVec.join(",")}]`;
          await db
            .prepare(
              "UPDATE support_knowledge_chunks SET embedding_model = ?, embedding = ?::vector WHERE id = ?",
            )
            .bind(targetModel, vectorLiteral, row.id)
            .run();
        } else {
          await db
            .prepare("UPDATE support_knowledge_chunks SET embedding_model = ? WHERE id = ?")
            .bind(targetModel, row.id)
            .run();
        }
        reEmbedded++;
        continue;
      }
    }

    if (reEmbedded > 0 && paceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, paceMs));
    }

    const safeContent = cleanedChunkContent || row.content;
    const { embedding, model } = await embedText(
      `${row.heading}\n${safeContent}`,
      "RETRIEVAL_DOCUMENT",
    );

    if (model === "satmi-hashed-ngram-768" && targetModel !== "satmi-hashed-ngram-768") {
      stillFallback++;
    } else {
      reEmbedded++;
    }

    if (hasPgVector) {
      const vectorLiteral = `[${embedding.join(",")}]`;
      await db
        .prepare(
          `UPDATE support_knowledge_chunks
           SET content = ?, embedding_json = ?::jsonb, embedding_model = ?, embedding = ?::vector
           WHERE id = ?`,
        )
        .bind(safeContent, JSON.stringify(embedding), model, vectorLiteral, row.id)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE support_knowledge_chunks
           SET content = ?, embedding_json = ?::jsonb, embedding_model = ?
           WHERE id = ?`,
        )
        .bind(safeContent, JSON.stringify(embedding), model, row.id)
        .run();
    }
  }

  return {
    inspected: chunkRows.results.length,
    cleanedDocs,
    reEmbedded,
    alreadyHealthy,
    stillFallback,
    targetModel,
    pgVectorEnabled: hasPgVector,
  };
}

const HINDI_HINGLISH_SYNONYM_RULES: Array<{
  pattern: RegExp;
  synonyms: string[];
}> = [
  {
    pattern:
      /(?:ऑर्डर|आर्डर|पार्सल|डिलीवरी|डिस्पैच|ट्रैक|कब\s*तक|कब\s*आएगा|कब\s*मिलेगा|नहीं\s*(?:मिला|आया)|मंगाया|\b(?:order|odar|ordr|parcel|magya|mangaya|mangwaya|aaya|aya|mila|nhi|nahi|nathi|aviyo|ekhono|kab\s+tak|kab\s+aayega|kab\s+milega|kaha\s+hai|kahan\s+hai|kitne\s+din|dispatch|delivery|track|tracking|awb)\b)/i,
    synonyms: [
      "order",
      "shipping",
      "delivery",
      "dispatch",
      "timeline",
      "tracking",
      "awb",
      "courier",
      "working",
      "days",
    ],
  },
  {
    pattern:
      /(?:रिटर्न|वापस|रिप्लेस|रिप्लेसमेंट|एक्सचेंज|रिफंड|कैंसिल|साइज|बदलना|\b(?:return|wapas|vapas|replace|replacement|exchange|refund|paise|paisa|cancel|badalna|size|unboxing)\b)/i,
    synonyms: [
      "refund",
      "return",
      "replacement",
      "exchange",
      "policy",
      "unboxing",
      "video",
      "days",
      "delivery",
    ],
  },
  {
    pattern:
      /(?:टूटा|फटा|खराब|गलत|डैमेज|\b(?:toota|tuta|phata|fata|kharab|kharaab|galat|damaged|defective|broken|wrong|missing)\b)/i,
    synonyms: [
      "damaged",
      "defective",
      "wrong",
      "product",
      "replacement",
      "unboxing",
      "escalation",
    ],
  },
  {
    pattern:
      /(?:कैश|पेमेंट|सीओडी|\b(?:cod|cash\s+on\s+delivery|prepaid|upi|payment|pay|coad)\b)/i,
    synonyms: ["cod", "cash", "delivery", "prepaid", "payment", "confirmation"],
  },
  {
    pattern:
      /(?:करुंगाली|माला|ब्रेसलेट|रुद्राक्ष|त्रिशूल|मुरुगन|हनुमान|\b(?:karungali|malai|mala|ebony|rudraksha|trishul|trishool|murugan|hanuman|gada|khatu|shyam|shiva|nandi|bead|beads)\b)/i,
    synonyms: [
      "karungali",
      "malai",
      "mala",
      "ebony",
      "wood",
      "bracelet",
      "rudraksha",
      "pendant",
      "certified",
      "108",
      "beads",
      "999",
    ],
  },
  {
    pattern:
      /(?:पाइराइट|क्रिस्टल|चक्र|स्टोन|\b(?:pyrite|wealth|magnet|chakra|tiger\s*eye|obsidian|hematite|quartz|amethyst|band|stone|rainbow)\b)/i,
    synonyms: [
      "pyrite",
      "wealth",
      "band",
      "money",
      "magnet",
      "bracelet",
      "chakra",
      "combo",
      "stone",
    ],
  },
  {
    pattern:
      /(?:अगरबत्ती|धूप|हवन|कप|स्टिक|खुशबू|चंदन|गुलाब|\b(?:agarbatti|incense|dhoop|dhup|havan|hawan|cup|cups|stick|sticks|kitni|trial|refill|kesar|chandan|gulab|nagchampa|fragrance|ceramic|stand|699|449)\b)/i,
    synonyms: [
      "incense",
      "sticks",
      "agarbatti",
      "dhoop",
      "havan",
      "cups",
      "trial",
      "pack",
      "refill",
      "100",
      "fragrances",
      "ceramic",
      "stands",
      "699",
      "449",
    ],
  },
  {
    pattern:
      /(?:असली|नकली|सर्टिफिकेट|सर्टिफाइड|लैब|\b(?:asli|nakli|original|real|fake|certified|certificate|certification|authenticity|lab|govt|quality)\b)/i,
    synonyms: [
      "authenticity",
      "certification",
      "certified",
      "govt",
      "lab",
      "original",
      "ebony",
    ],
  },
  {
    pattern:
      /(?:कीमत|प्राइस|दाम|कितने\s*का|ऑफर|कॉम्बो|\b(?:price|cost|rate|daam|dam|kitne\s+ka|kitna|offer|combo|bundle|bogo|buy\s*2)\b)/i,
    synonyms: ["price", "variant", "mrp", "combo", "bundle", "offer", "stock"],
  },
  {
    pattern:
      /(?:ऑर्डर\s*कैसे|कैसे\s*खरीदें|संपर्क|नंबर|\b(?:order\s+kais[ae]|kais[ae]\s+kar[eo]|how\s+to\s+order|how\s+to\s+buy|contact|helpline|support\s+number|address)\b)/i,
    synonyms: ["contact", "support", "website", "order", "shipping", "cod", "phone", "email"],
  },
];

/**
 * Expands Hindi (Devanagari) and Roman Hinglish queries with canonical English store keywords
 * so PostgreSQL English FTS, keyword lexical scoring, and vector retrieval work seamlessly.
 */
export function expandHindiAndHinglishQuery(query: string): {
  expandedQuery: string;
  expansionTerms: string[];
  hasHindiOrHinglish: boolean;
} {
  const clean = String(query || "").trim();
  if (!clean) {
    return { expandedQuery: "", expansionTerms: [], hasHindiOrHinglish: false };
  }

  const hasDevanagari = /[\u0900-\u097F]/.test(clean);
  const hasHinglishTokens =
    /\b(?:mera|meri|mere|magya|mangaya|mangwaya|aaya|aya|nhi|nahi|nathi|aviyo|kab|kaha|kahan|kitni|kitna|kitne|kais[ae]|kar[eo]|krdo|chahiye|wapas|vapas|pais[ae]|toot[ai]?|tut[ai]?|kharab|galat|asli|nakli|agarbatti|dhoop|dhup|hawan|malai|odar)\b/i.test(
      clean,
    );

  const matchedSynonyms = new Set<string>();
  for (const rule of HINDI_HINGLISH_SYNONYM_RULES) {
    if (rule.pattern.test(clean)) {
      for (const term of rule.synonyms) {
        matchedSynonyms.add(term);
      }
    }
  }

  const expansionTerms = [...matchedSynonyms];
  const expandedQuery =
    expansionTerms.length > 0 ? `${clean} ${expansionTerms.join(" ")}` : clean;

  return {
    expandedQuery,
    expansionTerms,
    hasHindiOrHinglish: hasDevanagari || hasHinglishTokens,
  };
}

const FTS_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "have",
  "what",
  "when",
  "where",
  "how",
  "can",
  "you",
  "your",
  "are",
  "was",
  "will",
  "please",
  "help",
  "satmi",
  "mera",
  "meri",
  "mere",
  "hai",
  "tha",
  "thi",
  "aur",
  "kya",
  "maine",
  "mujhe",
]);

/**
 * Builds a safe PostgreSQL `to_tsquery('english', ...)` OR-expression from an expanded query
 * so multi-word or Hindi/Hinglish queries retrieve any chunk matching any core keyword.
 */
export function buildFtsOrQuery(query: string): string {
  const { expandedQuery } = expandHindiAndHinglishQuery(query);
  const terms = [
    ...new Set(
      expandedQuery
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !FTS_STOP_WORDS.has(t) && !/^\d{5,}$/.test(t)),
    ),
  ].slice(0, 18);
  return terms.join(" | ");
}

export function computeKeywordLexicalScore(
  query: string,
  heading: string,
  content: string,
): number {
  const { expandedQuery, expansionTerms, hasHindiOrHinglish } =
    expandHindiAndHinglishQuery(query);
  const rawTerms = [
    ...new Set(
      String(query || "")
        .toLowerCase()
        .replace(/[^a-z0-9₹#]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !FTS_STOP_WORDS.has(t)),
    ),
  ];

  // For Hindi/Hinglish queries (where raw English terms are scarce), score primarily against expanded canonical terms
  const queryTerms =
    hasHindiOrHinglish && expansionTerms.length > 0
      ? [...new Set([...rawTerms, ...expansionTerms])]
      : rawTerms.length > 0
        ? [...new Set([...rawTerms, ...expansionTerms.slice(0, 5)])]
        : [
            ...new Set(
              expandedQuery
                .toLowerCase()
                .replace(/[^a-z0-9₹#]/g, " ")
                .split(/\s+/)
                .filter((t) => t.length >= 3 && !FTS_STOP_WORDS.has(t)),
            ),
          ];

  if (queryTerms.length === 0) return 0;

  const hayHeading = String(heading || "").toLowerCase();
  const hayContent = String(content || "").toLowerCase();
  let matchedWeight = 0;
  let totalWeight = 0;
  let matchedCount = 0;

  for (const term of queryTerms) {
    const termWeight = term.length >= 6 ? 1.5 : 1.0;
    totalWeight += termWeight;
    if (hayHeading.includes(term)) {
      matchedWeight += termWeight * 1.4;
      matchedCount++;
    } else if (hayContent.includes(term)) {
      matchedWeight += termWeight;
      matchedCount++;
    }
  }

  if (totalWeight <= 0) return 0;
  // When synonym expansion adds a broad set of related keywords, normalize by a capped denominator
  // so matching 3-5 core synonyms achieves a strong lexical score (>= 0.45).
  const effectiveDenominator = hasHindiOrHinglish
    ? Math.min(totalWeight, Math.max(4.5, matchedCount * 1.35))
    : Math.min(totalWeight, Math.max(3.5, rawTerms.length * 1.35));
  return Math.min(1, matchedWeight / effectiveDenominator);
}

let cachedShiprocketToken: { token: string; expiresAt: number } | null = null;

async function getShiprocketToken(): Promise<string> {
  const email = (process.env.SHIPROCKET_EMAIL || "").trim();
  const password = (process.env.SHIPROCKET_PASSWORD || "").trim();
  if (!email || !password) return "";

  if (cachedShiprocketToken && Date.now() < cachedShiprocketToken.expiresAt) {
    return cachedShiprocketToken.token;
  }

  try {
    const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { token?: string };
    if (data.token) {
      cachedShiprocketToken = {
        token: data.token,
        expiresAt: Date.now() + 8 * 3600_000,
      };
      return data.token;
    }
  } catch {
    // Non-fatal
  }
  return "";
}

/**
 * Read-only on-demand lookup against Shopify Admin API and Shiprocket API when an order code
 * or phone number is mentioned by a customer and not yet present in the local `orders` table.
 */
async function lookupLiveOrdersFromIntegrations(params: {
  orderCodes: string[];
  phones: string[];
  email?: string;
  vipThreshold: number;
}): Promise<LiveOrderContextItem[]> {
  const results: LiveOrderContextItem[] = [];
  const seenOrderIds = new Set<string>();

  const rawDomain = (
    process.env.SHOPIFY_SHOP_DOMAIN ||
    process.env.SHOPIFY_STORE_DOMAIN ||
    ""
  ).trim();
  const shopifyToken = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
  const apiVersion = (process.env.SHOPIFY_API_VERSION || "2024-10").trim();
  const shopifyHost = rawDomain
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .trim();

  // 1. Shopify Admin API Order Lookup
  if (shopifyHost && shopifyToken) {
    for (const code of params.orderCodes.slice(0, 3)) {
      try {
        const res = await fetch(
          `https://${shopifyHost}/admin/api/${encodeURIComponent(
            apiVersion
          )}/orders.json?name=${encodeURIComponent(code)}&status=any&limit=5`,
          {
            headers: {
              "X-Shopify-Access-Token": shopifyToken,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!res.ok) continue;
        const payload = (await res.json()) as {
          orders?: Array<Record<string, unknown>>;
        };
        for (const o of payload.orders || []) {
          const name = String(o.name || o.order_number || "");
          if (!name || seenOrderIds.has(name)) continue;
          seenOrderIds.add(name);
          const total = Number(o.total_price || 0);
          const fulfillments = Array.isArray(o.fulfillments)
            ? (o.fulfillments as Array<Record<string, unknown>>)
            : [];
          const latestFul = fulfillments[fulfillments.length - 1];
          const customerObj = (o.customer || {}) as Record<string, unknown>;
          const shippingObj = (o.shipping_address || {}) as Record<string, unknown>;
          const lineItems = Array.isArray(o.line_items)
            ? (o.line_items as Array<Record<string, unknown>>)
            : [];

          results.push({
            id: Number(o.id || 0),
            channelOrderId: name,
            status: String(
              o.cancelled_at
                ? "CANCELLED"
                : latestFul?.shipment_status || o.fulfillment_status || "UNFULFILLED"
            ).toUpperCase(),
            awb: String(latestFul?.tracking_number || ""),
            courier: String(latestFul?.tracking_company || ""),
            total,
            isVipHighValue: total >= params.vipThreshold,
            paymentMethod: String(
              Array.isArray(o.payment_gateway_names)
                ? o.payment_gateway_names[0] || ""
                : ""
            ),
            orderDate: String(o.created_at || ""),
            ndrReason: "",
            ndrAttempts: 0,
            confirmationStatus: String(o.financial_status || ""),
            customerName:
              [customerObj.first_name, customerObj.last_name]
                .filter(Boolean)
                .join(" ")
                .trim() || String(shippingObj.name || ""),
            customerEmail: String(o.email || customerObj.email || ""),
            customerPhone: String(
              o.phone || shippingObj.phone || customerObj.phone || ""
            ),
            customerCity: String(shippingObj.city || ""),
            customerState: String(shippingObj.province || ""),
            itemsSummary: lineItems
              .slice(0, 6)
              .map((li) => `${li.quantity || 1}x ${li.title || "Item"} @ ₹${li.price || ""}`)
              .join("; "),
          });
        }
      } catch {
        // Non-fatal
      }
    }
  }

  // 2. Shiprocket Live Order & Tracking Lookup
  const srToken = await getShiprocketToken();
  if (srToken) {
    const searchTerms = [
      ...params.orderCodes.slice(0, 2),
      ...params.phones.slice(0, 1),
    ];
    for (const term of searchTerms) {
      try {
        const res = await fetch(
          `https://apiv2.shiprocket.in/v1/external/orders?search=${encodeURIComponent(
            term
          )}&per_page=5`,
          {
            headers: {
              Authorization: `Bearer ${srToken}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(10000),
          }
        );
        if (!res.ok) continue;
        const payload = (await res.json()) as {
          data?: Array<Record<string, unknown>>;
        };
        for (const o of payload.data || []) {
          const channelOrderId = String(o.channel_order_id || o.id || "");
          const shipments = Array.isArray(o.shipments)
            ? (o.shipments as Array<Record<string, unknown>>)
            : [];
          const ship = shipments[0] || {};
          const awb = String(ship.awb || "");
          const courier = String(ship.courier || "");
          const srStatus = String(o.status || ship.status || "PROCESSING");

          const existing = results.find(
            (r) =>
              r.channelOrderId.replace(/^#/, "").toUpperCase() ===
              channelOrderId.replace(/^#/, "").toUpperCase()
          );
          if (existing) {
            if (!existing.awb && awb) existing.awb = awb;
            if (!existing.courier && courier) existing.courier = courier;
            if (srStatus) existing.status = srStatus;
            continue;
          }

          if (seenOrderIds.has(channelOrderId)) continue;
          seenOrderIds.add(channelOrderId);
          const total = Number(o.total || 0);
          const products = Array.isArray(o.products)
            ? (o.products as Array<Record<string, unknown>>)
            : [];

          results.push({
            id: Number(o.id || 0),
            channelOrderId,
            status: srStatus,
            awb,
            courier,
            total,
            isVipHighValue: total >= params.vipThreshold,
            paymentMethod: String(o.payment_method || ""),
            orderDate: String(o.created_at || ""),
            ndrReason: "",
            ndrAttempts: 0,
            confirmationStatus: "",
            customerName: String(o.customer_name || ""),
            customerEmail: String(o.customer_email || ""),
            customerPhone: String(o.customer_phone || ""),
            customerCity: String(o.customer_city || ""),
            customerState: String(o.customer_state || ""),
            itemsSummary: products
              .slice(0, 6)
              .map((p) => `${p.quantity || 1}x ${p.name || "Item"} @ ₹${p.selling_price || ""}`)
              .join("; "),
          });
        }
      } catch {
        // Non-fatal
      }
    }
  }

  return results;
}

export function buildCourierTrackingUrl(courier: string, awb: string): string {
  const cleanAwb = String(awb || "").trim();
  if (!cleanAwb) return "";
  const lowerCourier = String(courier || "").toLowerCase();
  if (lowerCourier.includes("delhivery")) {
    return `https://www.delhivery.com/track-v2/package/${encodeURIComponent(cleanAwb)}`;
  }
  if (lowerCourier.includes("bluedart") || lowerCourier.includes("blue dart")) {
    return `https://www.bluedart.com/tracking?trackFor=0&trackNo=${encodeURIComponent(cleanAwb)}`;
  }
  if (lowerCourier.includes("xpressbees")) {
    return `https://www.xpressbees.com/shipment/tracking?awbNo=${encodeURIComponent(cleanAwb)}`;
  }
  if (lowerCourier.includes("ecom")) {
    return `https://ecomexpress.in/tracking/?awb_field=${encodeURIComponent(cleanAwb)}`;
  }
  if (lowerCourier.includes("dtdc")) {
    return `https://www.dtdc.in/tracking.asp?strCnno=${encodeURIComponent(cleanAwb)}`;
  }
  if (lowerCourier.includes("shadowfax")) {
    return `https://tracker.shadowfax.in/#/track/${encodeURIComponent(cleanAwb)}`;
  }
  return `https://shiprocket.co/tracking/${encodeURIComponent(cleanAwb)}`;
}

export type OrderTrackingDetails = {
  awb: string;
  courier: string;
  orderCode: string;
  status: string;
  trackingUrl: string;
  etd: string;
  currentLocation: string;
  ndrReason: string;
  activities: Array<{ date: string; status: string; activity: string; location: string }>;
  source: "shiprocket_live" | "local_db";
};

export async function fetchLiveOrderTrackingInfo(params: {
  awb?: string;
  orderId?: number | null;
  orderCode?: string;
}): Promise<OrderTrackingDetails | null> {
  const db = await operationsDb();
  let orderRow: Record<string, unknown> | null = null;
  if (params.orderId) {
    orderRow = await db
      .prepare(
        "SELECT id, channel_order_id, status, awb, courier, ndr_reason, order_date FROM orders WHERE id = ? LIMIT 1",
      )
      .bind(params.orderId)
      .first<Record<string, unknown>>()
      .catch(() => null);
  } else if (params.awb) {
    orderRow = await db
      .prepare(
        "SELECT id, channel_order_id, status, awb, courier, ndr_reason, order_date FROM orders WHERE awb = ? LIMIT 1",
      )
      .bind(params.awb.trim())
      .first<Record<string, unknown>>()
      .catch(() => null);
  } else if (params.orderCode) {
    const cleanCode = params.orderCode.replace(/^#/, "").trim().toUpperCase();
    orderRow = await db
      .prepare(
        "SELECT id, channel_order_id, status, awb, courier, ndr_reason, order_date FROM orders WHERE UPPER(REPLACE(channel_order_id, '#', '')) = ? LIMIT 1",
      )
      .bind(cleanCode)
      .first<Record<string, unknown>>()
      .catch(() => null);
  }

  const awb = String(params.awb || orderRow?.awb || "").trim();
  const courier = String(orderRow?.courier || "").trim();
  const orderCode = String(orderRow?.channel_order_id || params.orderCode || "");
  const fallbackStatus = String(orderRow?.status || "PROCESSING");
  const ndrReason = String(orderRow?.ndr_reason || "");
  const trackingUrl = buildCourierTrackingUrl(courier, awb);

  if (awb) {
    const srToken = await getShiprocketToken();
    if (srToken) {
      try {
        const res = await fetch(
          `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${encodeURIComponent(awb)}`,
          {
            headers: {
              Authorization: `Bearer ${srToken}`,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (res.ok) {
          const payload = (await res.json()) as {
            tracking_data?: {
              etd?: string;
              shipment_track?: Array<{
                current_status?: string;
                courier_name?: string;
                destination?: string;
                origin?: string;
                edd?: string;
              }>;
              shipment_track_activities?: Array<{
                date?: string;
                status?: string;
                activity?: string;
                location?: string;
              }>;
              track_url?: string;
            };
          };
          const td = payload?.tracking_data;
          const trackHead = td?.shipment_track?.[0];
          const activities = (td?.shipment_track_activities || []).slice(0, 15).map((a) => ({
            date: String(a.date || ""),
            status: String(a.status || ""),
            activity: String(a.activity || ""),
            location: String(a.location || ""),
          }));
          if (td && (trackHead || activities.length > 0)) {
            return {
              awb,
              courier: String(trackHead?.courier_name || courier),
              orderCode,
              status: String(trackHead?.current_status || fallbackStatus),
              trackingUrl: String(td.track_url || trackingUrl),
              etd: String(td.etd || trackHead?.edd || ""),
              currentLocation: String(activities[0]?.location || trackHead?.destination || ""),
              ndrReason,
              activities,
              source: "shiprocket_live",
            };
          }
        }
      } catch {
        // Fall back to local DB order snapshot
      }
    }
  }

  if (!awb && !orderRow) return null;

  return {
    awb,
    courier,
    orderCode,
    status: fallbackStatus,
    trackingUrl,
    etd: "",
    currentLocation: "",
    ndrReason,
    activities: [],
    source: "local_db",
  };
}

/**
 * Two-Tier Whole-Store Context Retrieval:
 * - Tier 1: Deterministic SQL lookup for customer's live orders, AWB, courier, NDR, VIP status (> ₹3,000), and Customer360.
 * - Tier 2: Hybrid Semantic (768-dim cosine similarity) + Lexical (PostgreSQL FTS ts_rank_cd + keyword overlap)
 *   fused via Reciprocal Rank Fusion (RRF).
 */
export async function retrieveStoreContext(params: {
  query: string;
  latestMessageText?: string;
  threadContextText?: string;
  ticketId?: string;
  customerEmail?: string;
  customerPhone?: string;
  associatedPhone?: string;
  channel?: string;
  externalUserId?: string;
  linkedOrderId?: number | null;
  inboundAuthVerified?: boolean;
  vipThreshold?: number;
  topK?: number;
  maxChunksPerDoc?: number;
}): Promise<StoreContextBundle> {
  const db = await operationsDb();
  const cleanQuery = String(params.query || "").trim();
  const latestText = String(params.latestMessageText || params.query || "").trim();
  const threadText = String(params.threadContextText || "").trim();
  const topK = Math.max(1, Math.min(15, params.topK || 6));
  const maxChunksPerDoc = Math.max(1, Math.min(topK, params.maxChunksPerDoc || 2));
  const vipThreshold = Number(params.vipThreshold || 3000);

  // Ensure default store policies exist if knowledge base is completely empty
  const kbCount = await db
    .prepare("SELECT COUNT(*)::int AS count FROM support_knowledge_documents")
    .first<{ count: number }>()
    .catch(() => ({ count: 0 }));
  if ((kbCount?.count || 0) === 0) {
    await syncStoreKnowledgeToRag("auto_seed").catch(() => null);
  }

  // --- TIER 1: DETERMINISTIC LIVE CUSTOMER & ORDER LOOKUP ---
  const combinedHintText = [cleanQuery, latestText, threadText].filter(Boolean).join("\n");
  const hints = extractOrderOrPhoneHints(combinedHintText);
  const latestHints = extractOrderOrPhoneHints(latestText);
  const channel = String(params.channel || "email");
  const externalUserId = String(params.externalUserId || "");
  const cleanEmailParam = String(params.customerEmail || "").trim();

  let savedLink: Record<string, unknown> | null = null;
  if (externalUserId) {
    savedLink = await db
      .prepare(
        "SELECT * FROM support_customer_links WHERE channel = ? AND external_user_id = ?"
      )
      .bind(channel, externalUserId)
      .first<Record<string, unknown>>()
      .catch(() => null);
  } else if (
    cleanEmailParam &&
    !cleanEmailParam.endsWith("@facebook.com") &&
    !cleanEmailParam.startsWith("@") &&
    cleanEmailParam.includes("@")
  ) {
    savedLink = await db
      .prepare(
        "SELECT * FROM support_customer_links WHERE channel = ? AND (LOWER(external_user_id) = LOWER(?) OR LOWER(customer_email) = LOWER(?)) ORDER BY updated_at DESC LIMIT 1"
      )
      .bind(channel, cleanEmailParam, cleanEmailParam)
      .first<Record<string, unknown>>()
      .catch(() => null);
  }

  let ticketAssociatedPhone = String(params.associatedPhone || "").trim();
  if (!ticketAssociatedPhone && params.ticketId) {
    const ticketRow = await db
      .prepare("SELECT associated_phone FROM support_tickets WHERE id = ? LIMIT 1")
      .bind(params.ticketId)
      .first<{ associated_phone?: string }>()
      .catch(() => null);
    ticketAssociatedPhone = String(ticketRow?.associated_phone || "").trim();
  }

  const linkedOrderId =
    Number(params.linkedOrderId || savedLink?.linked_order_id || 0) || null;
  const resolvedEmail = String(
    savedLink?.customer_email || params.customerEmail || ""
  ).trim();
  const associatedCustomerPhone = String(
    savedLink?.customer_phone || ticketAssociatedPhone || params.customerPhone || ""
  ).trim();
  const resolvedPhone = associatedCustomerPhone;

  const orderClauses: string[] = [];
  const orderParams: unknown[] = [];

  if (linkedOrderId) {
    orderClauses.push("id = ?");
    orderParams.push(linkedOrderId);
  }
  if (
    resolvedEmail &&
    !resolvedEmail.endsWith("@facebook.com") &&
    !resolvedEmail.startsWith("@") &&
    resolvedEmail.includes("@")
  ) {
    orderClauses.push("LOWER(customer_email) = LOWER(?)");
    orderParams.push(resolvedEmail);
  }
  if (resolvedPhone) {
    orderClauses.push(
      "RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 10) = RIGHT(?, 10)"
    );
    orderParams.push(resolvedPhone);
  }
  for (const code of hints.orderCodes) {
    orderClauses.push("UPPER(REPLACE(channel_order_id, '#', '')) = ?");
    orderParams.push(code);
  }
  for (const phone of hints.phones) {
    orderClauses.push(
      "RIGHT(REGEXP_REPLACE(customer_phone, '[^0-9]', '', 'g'), 10) = ?"
    );
    orderParams.push(phone);
  }

  let rawOrders: Array<Record<string, unknown>> = [];
  if (orderClauses.length > 0) {
    const orderRows = await db
      .prepare(
        `SELECT id, channel_order_id, status, awb, courier, total, payment_method, order_date,
                ndr_reason, ndr_attempts, confirmation_status,
                customer_name, customer_email, customer_phone, customer_city, customer_state,
                products_json, raw_json
         FROM orders
         WHERE ${orderClauses.join(" OR ")}
         ORDER BY created_at DESC
         LIMIT 15`
      )
      .bind(...orderParams)
      .all<Record<string, unknown>>()
      .catch(() => ({ results: [] as Record<string, unknown>[] }));
    rawOrders = orderRows.results;
  }

  let highestOrderTotal = 0;
  const orders: LiveOrderContextItem[] = rawOrders.map((o) => {
    const total = Number(o.total || 0);
    if (Number.isFinite(total) && total > highestOrderTotal) {
      highestOrderTotal = total;
    }
    return {
      id: Number(o.id || 0),
      channelOrderId: String(o.channel_order_id || o.channelOrderId || `#${o.id}`),
      status: String(o.status || "UNKNOWN"),
      awb: String(o.awb || ""),
      courier: String(o.courier || ""),
      total,
      isVipHighValue: total >= vipThreshold,
      paymentMethod: String(o.payment_method || o.paymentMethod || ""),
      orderDate: String(o.order_date || o.orderDate || ""),
      ndrReason: String(o.ndr_reason || ""),
      ndrAttempts: Number(o.ndr_attempts || 0),
      confirmationStatus: String(o.confirmation_status || o.confirmationStatus || ""),
      customerName: String(o.customer_name || o.customerName || ""),
      customerEmail: String(o.customer_email || o.customerEmail || ""),
      customerPhone: String(o.customer_phone || o.customerPhone || ""),
      customerCity: String(o.customer_city || o.customerCity || ""),
      customerState: String(o.customer_state || o.customerState || ""),
      itemsSummary: summarizeOrderProductsJson(o.products_json || o.productsJson),
    };
  });

  // Check if any requested order codes are missing from local DB, or no orders found yet -> check live Shopify & Shiprocket
  const existingCodeSet = new Set(
    orders.map((o) => o.channelOrderId.replace(/^#/, "").trim().toUpperCase()),
  );
  const missingOrderCodes = hints.orderCodes.filter((c) => !existingCodeSet.has(c));

  if (
    missingOrderCodes.length > 0 ||
    (orders.length === 0 && (hints.phones.length > 0 || resolvedPhone))
  ) {
    const liveOrders = await lookupLiveOrdersFromIntegrations({
      orderCodes: missingOrderCodes.length > 0 ? missingOrderCodes : hints.orderCodes,
      phones: resolvedPhone ? [resolvedPhone, ...hints.phones] : hints.phones,
      email: resolvedEmail,
      vipThreshold,
    }).catch(() => [] as LiveOrderContextItem[]);

    for (const lo of liveOrders) {
      const normalizedCode = lo.channelOrderId.replace(/^#/, "").trim().toUpperCase();
      if (existingCodeSet.has(normalizedCode)) continue;
      existingCodeSet.add(normalizedCode);
      if (lo.total > highestOrderTotal) highestOrderTotal = lo.total;
      orders.push(lo);
    }
  }

  const customer360 = computeCustomer360(rawOrders, 0);
  const hasVipOrder =
    orders.some((o) => o.isVipHighValue) || customer360.totalSpend >= vipThreshold * 2;

  // Determine whether the customer has verified ownership of the requested order(s)
  const normalizedPhoneDigits = (p: string) => p.replace(/\D/g, "").slice(-10);
  const associatedPhoneDigits = normalizedPhoneDigits(associatedCustomerPhone);
  const threadPhones = new Set(
    [associatedCustomerPhone, ...hints.phones]
      .map(normalizedPhoneDigits)
      .filter((p) => p.length === 10),
  );
  const threadEmail =
    resolvedEmail && !resolvedEmail.endsWith("@facebook.com") && !resolvedEmail.startsWith("@") && resolvedEmail.includes("@")
      ? resolvedEmail.toLowerCase()
      : "";

  const requestedOrderCodes = latestHints.orderCodes.length > 0 ? latestHints.orderCodes : hints.orderCodes;
  const requestedCodeSet = new Set(requestedOrderCodes.map((c) => c.replace(/^#/, "").toUpperCase()));
  const targetOrders =
    requestedCodeSet.size > 0
      ? orders.filter((o) => requestedCodeSet.has(o.channelOrderId.replace(/^#/, "").toUpperCase()))
      : orders;

  let customerVerified = false;
  let verificationReason = "No order matched";
  let phoneMismatchDetected = false;
  let phoneMismatchReason = "";
  let newlyVerifiedPhoneToAssociate = "";

  if (targetOrders.length > 0) {
    // 1. Cross-order phone verification when customer already has an associated phone number
    if (associatedPhoneDigits.length === 10) {
      const matchingByPhone = targetOrders.find(
        (o) => normalizedPhoneDigits(o.customerPhone) === associatedPhoneDigits,
      );
      const mismatchingOrder = targetOrders.find((o) => {
        const orderPhone = normalizedPhoneDigits(o.customerPhone);
        return orderPhone.length === 10 && orderPhone !== associatedPhoneDigits;
      });

      if (matchingByPhone) {
        customerVerified = true;
        verificationReason = "Matched customer's associated phone number";
      } else if (mismatchingOrder) {
        customerVerified = false;
        phoneMismatchDetected = true;
        const requestedLabel = mismatchingOrder.channelOrderId;
        const orderLast4 = normalizedPhoneDigits(mismatchingOrder.customerPhone).slice(-4);
        const custLast4 = associatedPhoneDigits.slice(-4);
        phoneMismatchReason = `Customer requested order ${requestedLabel}, whose registered phone (ending ${orderLast4}) does NOT match the phone number associated with this customer (ending ${custLast4}). Human verification required.`;
        verificationReason = phoneMismatchReason;
      } else if (savedLink || params.linkedOrderId) {
        customerVerified = true;
        verificationReason = "Linked customer profile";
      }
    }

    // 2. First-time verification if no associated phone resolved it yet
    if (!customerVerified && !phoneMismatchDetected) {
      if (savedLink || params.linkedOrderId) {
        customerVerified = true;
        verificationReason = "Linked customer profile";
      } else if (channel === "email") {
        const emailMatched = targetOrders.find(
          (o) => Boolean(threadEmail) && o.customerEmail.toLowerCase() === threadEmail,
        );
        if (emailMatched && params.inboundAuthVerified !== false) {
          customerVerified = true;
          verificationReason = "Verified email sender";
          const orderPhone = normalizedPhoneDigits(emailMatched.customerPhone);
          if (orderPhone.length === 10) newlyVerifiedPhoneToAssociate = orderPhone;
        } else {
          // Check if customer disclosed a phone number in email that conflicts with order phone
          const explicitPhones = hints.phones.map(normalizedPhoneDigits).filter((p) => p.length === 10);
          const phoneMatched = targetOrders.find((o) =>
            explicitPhones.includes(normalizedPhoneDigits(o.customerPhone)),
          );
          const phoneConflict = targetOrders.find((o) => {
            const op = normalizedPhoneDigits(o.customerPhone);
            return op.length === 10 && explicitPhones.length > 0 && !explicitPhones.includes(op);
          });
          if (phoneMatched && params.inboundAuthVerified !== false) {
            customerVerified = true;
            verificationReason = "Verified Order ID + phone number";
            newlyVerifiedPhoneToAssociate = normalizedPhoneDigits(phoneMatched.customerPhone);
          } else if (phoneConflict) {
            customerVerified = false;
            phoneMismatchDetected = true;
            phoneMismatchReason = `Customer provided a phone number that does not match the phone registered on order ${phoneConflict.channelOrderId}. Human verification required.`;
            verificationReason = phoneMismatchReason;
          } else {
            customerVerified = false;
            verificationReason =
              params.inboundAuthVerified === false
                ? "Inbound email authentication (SPF/DKIM) did not pass"
                : "Sender email does not match order email";
          }
        }
      } else {
        // On Instagram/Facebook, require Order ID + matching registered phone/email (2-factor check)
        const matchedOrder = targetOrders.find((o) => {
          const orderPhone = normalizedPhoneDigits(o.customerPhone);
          const orderEmail = o.customerEmail.toLowerCase();
          return (
            (orderPhone.length === 10 && threadPhones.has(orderPhone)) ||
            (Boolean(threadEmail) && orderEmail === threadEmail)
          );
        });
        const explicitPhones = hints.phones.map(normalizedPhoneDigits).filter((p) => p.length === 10);
        const phoneConflict = targetOrders.find((o) => {
          const op = normalizedPhoneDigits(o.customerPhone);
          return op.length === 10 && explicitPhones.length > 0 && !explicitPhones.includes(op);
        });

        if (hints.orderCodes.length > 0 && matchedOrder) {
          customerVerified = true;
          verificationReason = "Verified Order ID + registered phone/email";
          const op = normalizedPhoneDigits(matchedOrder.customerPhone);
          if (op.length === 10) newlyVerifiedPhoneToAssociate = op;
        } else if (phoneConflict) {
          customerVerified = false;
          phoneMismatchDetected = true;
          phoneMismatchReason = `Customer provided a phone number that does not match the phone registered on order ${phoneConflict.channelOrderId}. Human verification required.`;
          verificationReason = phoneMismatchReason;
        } else {
          customerVerified = false;
          verificationReason =
            "Social DM customer must confirm registered 10-digit phone or email alongside Order ID";
        }
      }
    }

    // Whenever verified, ensure we capture the order's phone number if we don't have one associated yet
    if (customerVerified && !associatedPhoneDigits && !newlyVerifiedPhoneToAssociate) {
      const firstWithPhone = targetOrders.find(
        (o) => normalizedPhoneDigits(o.customerPhone).length === 10,
      );
      if (firstWithPhone) {
        newlyVerifiedPhoneToAssociate = normalizedPhoneDigits(firstWithPhone.customerPhone);
      } else if (hints.phones[0]) {
        newlyVerifiedPhoneToAssociate = normalizedPhoneDigits(hints.phones[0]);
      }
    }
  }

  // --- TIER 2: HYBRID VECTOR + LEXICAL FULL-TEXT SEARCH WITH RRF & DIVERSITY CAP ---
  const focusedTextForSearch =
    latestText && cleanQuery.length > latestText.length * 2.5
      ? `${cleanQuery.split("\n")[0] || ""}\n${latestText}`.trim()
      : cleanQuery;
  const { expandedQuery, expansionTerms, hasHindiOrHinglish } =
    expandHindiAndHinglishQuery(focusedTextForSearch);
  const semanticSearchInput =
    hasHindiOrHinglish && expansionTerms.length > 0
      ? `${focusedTextForSearch}\nKeywords: ${expansionTerms.join(" ")}`
      : focusedTextForSearch;
  const ftsOrQuery = buildFtsOrQuery(focusedTextForSearch);

  const {
    embedding: queryEmbedding,
    model: embeddingModel,
    usage: embeddingUsage,
  } = await embedText(semanticSearchInput, "RETRIEVAL_QUERY");

  const hasPgVector = await isPgVectorAvailable();
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  const ftsCandidatesPromise = ftsOrQuery
    ? db
        .prepare(
          `SELECT
             c.id AS chunk_id,
             c.document_id,
             c.heading,
             c.content,
             c.embedding_json,
             COALESCE(c.embedding_model, '') AS embedding_model,
             d.title AS document_title,
             d.category,
             d.source_ref,
             ts_rank_cd(c.search_tsv, to_tsquery('english', ?)) AS fts_rank
           FROM support_knowledge_chunks c
           JOIN support_knowledge_documents d ON d.id = c.document_id
           WHERE d.is_active = TRUE
             AND (d.expires_at IS NULL OR d.expires_at > now())
             AND c.search_tsv @@ to_tsquery('english', ?)
           ORDER BY fts_rank DESC, d.updated_at DESC
           LIMIT 180`,
        )
        .bind(ftsOrQuery, ftsOrQuery)
        .all<Record<string, unknown>>()
        .catch(() => ({ results: [] as Record<string, unknown>[] }))
    : Promise.resolve({ results: [] as Record<string, unknown>[] });

  const vectorCandidatesPromise =
    hasPgVector && embeddingModel !== "satmi-hashed-ngram-768"
      ? db
          .prepare(
            `SELECT
               c.id AS chunk_id,
               c.document_id,
               c.heading,
               c.content,
               c.embedding_json,
               COALESCE(c.embedding_model, '') AS embedding_model,
               d.title AS document_title,
               d.category,
               d.source_ref,
               CASE
                 WHEN ? <> '' THEN ts_rank_cd(c.search_tsv, to_tsquery('english', ?))
                 ELSE 0
               END AS fts_rank,
               1 - (c.embedding <=> ?::vector) AS pg_vec_sim
             FROM support_knowledge_chunks c
             JOIN support_knowledge_documents d ON d.id = c.document_id
             WHERE d.is_active = TRUE
               AND (d.expires_at IS NULL OR d.expires_at > now())
               AND c.embedding IS NOT NULL
               AND (c.embedding_model = ? OR c.embedding_model = '')
             ORDER BY c.embedding <=> ?::vector ASC
             LIMIT 160`,
          )
          .bind(ftsOrQuery, ftsOrQuery, vectorLiteral, embeddingModel, vectorLiteral)
          .all<Record<string, unknown>>()
          .catch(() => ({ results: [] as Record<string, unknown>[] }))
      : db
          .prepare(
            `SELECT
               c.id AS chunk_id,
               c.document_id,
               c.heading,
               c.content,
               c.embedding_json,
               COALESCE(c.embedding_model, '') AS embedding_model,
               d.title AS document_title,
               d.category,
               d.source_ref,
               CASE
                 WHEN ? <> '' THEN ts_rank_cd(c.search_tsv, to_tsquery('english', ?))
                 ELSE 0
               END AS fts_rank
             FROM support_knowledge_chunks c
             JOIN support_knowledge_documents d ON d.id = c.document_id
             WHERE d.is_active = TRUE
               AND (d.expires_at IS NULL OR d.expires_at > now())
             ORDER BY
               CASE d.category
                 WHEN 'admin_memory' THEN 0
                 WHEN 'policy' THEN 1
                 WHEN 'faq' THEN 2
                 WHEN 'product' THEN 3
                 ELSE 4
               END ASC,
               d.updated_at DESC
             LIMIT 5000`,
          )
          .bind(ftsOrQuery, ftsOrQuery)
          .all<Record<string, unknown>>()
          .catch((err) => {
            console.warn("Knowledge chunk retrieval failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            return { results: [] as Record<string, unknown>[] };
          });

  const [ftsRows, vecOrRecentRows] = await Promise.all([
    ftsCandidatesPromise,
    vectorCandidatesPromise,
  ]);

  const dedupedRows = new Map<string, Record<string, unknown>>();
  for (const r of [...ftsRows.results, ...vecOrRecentRows.results]) {
    const cid = String(r.chunk_id || "");
    if (cid && !dedupedRows.has(cid)) dedupedRows.set(cid, r);
  }

  type ScoredCandidate = {
    chunkId: string;
    documentId: string;
    documentTitle: string;
    category: KnowledgeCategory;
    heading: string;
    content: string;
    sourceRef: string;
    vectorSimilarity: number;
    lexicalScore: number;
  };

  let lazyLocalQueryVec: number[] | null = null;
  const getLocalQueryVec = () => {
    if (!lazyLocalQueryVec) {
      lazyLocalQueryVec = deterministicLocalEmbedding(expandedQuery);
    }
    return lazyLocalQueryVec;
  };

  const candidates: ScoredCandidate[] = Array.from(dedupedRows.values()).map((r) => {
    const chunkModel = String(r.embedding_model || "");
    let emb: number[] | null = null;
    if (Array.isArray(r.embedding_json)) {
      emb = r.embedding_json as number[];
    } else if (typeof r.embedding_json === "string") {
      try {
        emb = JSON.parse(r.embedding_json) as number[];
      } catch {
        emb = null;
      }
    }

    const chunkIsSparseHashed =
      chunkModel === "satmi-hashed-ngram-768" ||
      (chunkModel === "" && isSparseHashedVector(emb));

    const compatibleNeuralSpace =
      !chunkIsSparseHashed &&
      (chunkModel === embeddingModel ||
        (chunkModel === "" && embeddingModel !== "satmi-hashed-ngram-768"));

    let vecSim = 0;
    if (typeof r.pg_vec_sim === "number" && compatibleNeuralSpace) {
      vecSim = Math.max(0, r.pg_vec_sim);
    } else if (compatibleNeuralSpace && emb) {
      vecSim = Math.max(0, cosineSimilarity(queryEmbedding, emb));
    } else if (chunkIsSparseHashed && emb) {
      // Fallback compatibility when a chunk is still stored as satmi-hashed-ngram-768
      const localQueryVec =
        embeddingModel === "satmi-hashed-ngram-768" ? queryEmbedding : getLocalQueryVec();
      vecSim = Math.max(0, cosineSimilarity(localQueryVec, emb) * (embeddingModel === "satmi-hashed-ngram-768" ? 1 : 0.85));
    }

    const ftsRank = Math.min(1, Number(r.fts_rank || 0) * 2.5);
    const kwScore = computeKeywordLexicalScore(
      focusedTextForSearch,
      String(r.heading || ""),
      String(r.content || "")
    );
    const lexicalScore = Number(Math.max(ftsRank, kwScore).toFixed(4));

    return {
      chunkId: String(r.chunk_id),
      documentId: String(r.document_id),
      documentTitle: String(r.document_title || ""),
      category: String(r.category || "faq") as KnowledgeCategory,
      heading: String(r.heading || ""),
      content: String(r.content || ""),
      sourceRef: String(r.source_ref || ""),
      vectorSimilarity: Number(vecSim.toFixed(4)),
      lexicalScore,
    };
  });

  // Sort independently for Reciprocal Rank Fusion (RRF, k = 60)
  const byVector = [...candidates].sort((a, b) => b.vectorSimilarity - a.vectorSimilarity);
  const byLexical = [...candidates].sort((a, b) => b.lexicalScore - a.lexicalScore);

  const vectorRankMap = new Map<string, number>();
  const lexicalRankMap = new Map<string, number>();

  byVector.forEach((c, idx) => vectorRankMap.set(c.chunkId, idx + 1));
  byLexical.forEach((c, idx) => lexicalRankMap.set(c.chunkId, idx + 1));

  const RRF_K = 60;
  const scoredAll: RetrievedRagChunk[] = candidates
    .map((c) => {
      const vRank = vectorRankMap.get(c.chunkId) || 999;
      const lRank = lexicalRankMap.get(c.chunkId) || 999;
      const baseRrf =
        (c.vectorSimilarity > 0.05 ? 1 / (RRF_K + vRank) : 0) +
        (c.lexicalScore > 0.08 ? 1 / (RRF_K + lRank) : 0);

      // Boost verified admin_memory and store policies when they match well; slightly deprioritize raw reply templates
      const categoryBoost =
        c.category === "admin_memory" && (c.lexicalScore >= 0.25 || c.vectorSimilarity >= 0.35)
          ? 0.006
          : c.category === "policy" && (c.lexicalScore >= 0.2 || c.vectorSimilarity >= 0.3)
            ? 0.004
            : c.category === "template"
              ? -0.003
              : 0;

      const rrfScore = Number(Math.max(0, baseRrf + categoryBoost).toFixed(6));
      return {
        ...c,
        rrfScore,
      };
    })
    .filter((c) => c.vectorSimilarity >= 0.12 || c.lexicalScore >= 0.15)
    .sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      return b.lexicalScore + b.vectorSimilarity - (a.lexicalScore + a.vectorSimilarity);
    });

  // Enforce Document Diversity Cap:
  // First pass selects up to 1 top chunk per distinct document (up to topK).
  // If fewer than topK chunks are filled, second pass allows up to maxChunksPerDoc per document.
  const fused: RetrievedRagChunk[] = [];
  const docChunkCounts = new Map<string, number>();
  const remainingChunks: RetrievedRagChunk[] = [];

  for (const chunk of scoredAll) {
    const count = docChunkCounts.get(chunk.documentId) || 0;
    if (count === 0 && fused.length < topK) {
      fused.push(chunk);
      docChunkCounts.set(chunk.documentId, 1);
    } else if (count < maxChunksPerDoc) {
      remainingChunks.push(chunk);
    }
  }

  for (const chunk of remainingChunks) {
    if (fused.length >= topK) break;
    const count = docChunkCounts.get(chunk.documentId) || 0;
    if (count < maxChunksPerDoc) {
      fused.push(chunk);
      docChunkCounts.set(chunk.documentId, count + 1);
    }
  }

  // Enrich selected chunks when a document (e.g. a Shopify product card) was split into
  // tiny section chunks (c0: "Brand / Vendor: Satmi", c1: Description, c2: "Price: ₹...")
  // so that 1 retrieved document slot carries complete description + variant pricing.
  const siblingsByDoc = new Map<string, ScoredCandidate[]>();
  for (const cand of candidates) {
    const list = siblingsByDoc.get(cand.documentId) || [];
    list.push(cand);
    siblingsByDoc.set(cand.documentId, list);
  }

  for (const item of fused) {
    if ((docChunkCounts.get(item.documentId) || 0) > 1) continue;
    const siblings = siblingsByDoc.get(item.documentId) || [];
    if (siblings.length <= 1 || siblings.length > 5) continue;
    const orderedSiblings = [...siblings].sort((a, b) =>
      a.chunkId.localeCompare(b.chunkId, undefined, { numeric: true }),
    );
    const mergedParts: string[] = [];
    let totalChars = 0;
    for (const sib of orderedSiblings) {
      const part = sib.content.trim();
      if (!part) continue;
      if (totalChars + part.length > 1600 && mergedParts.length > 0) continue;
      mergedParts.push(part);
      totalChars += part.length;
    }
    if (mergedParts.length > 1) {
      item.content = mergedParts.join("\n\n");
    }
  }

  const topRrfScore = fused[0]?.rrfScore || 0;
  const topVectorSimilarity = fused.reduce((m, c) => Math.max(m, c.vectorSimilarity), 0);
  const topLexicalScore = fused.reduce((m, c) => Math.max(m, c.lexicalScore), 0);
  const hasStrongKnowledgeMatch =
    orders.length > 0 || topLexicalScore >= 0.32 || topVectorSimilarity >= 0.42;

  return {
    query: cleanQuery,
    extractedHints: hints,
    requestedOrderCodes,
    orders,
    customerVerified,
    verificationReason,
    associatedCustomerPhone: associatedPhoneDigits || newlyVerifiedPhoneToAssociate || "",
    phoneMismatchDetected,
    phoneMismatchReason,
    newlyVerifiedPhoneToAssociate,
    customer360,
    hasVipOrder,
    highestOrderTotal,
    ragChunks: fused,
    topRrfScore,
    topVectorSimilarity,
    topLexicalScore,
    hasStrongKnowledgeMatch,
    embeddingModel,
    embeddingUsage,
  };
}

export async function listKnowledgeDocuments(filters?: {
  category?: string;
  search?: string;
}) {
  const db = await operationsDb();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters?.category && filters.category !== "all") {
    clauses.push("d.category = ?");
    params.push(filters.category);
  }
  if (filters?.search?.trim()) {
    const q = `%${filters.search.trim().slice(0, 120)}%`;
    clauses.push("(d.title ILIKE ? OR d.content ILIKE ? OR d.source_ref ILIKE ?)");
    params.push(q, q, q);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      `SELECT d.*,
              (SELECT COUNT(*)::int FROM support_knowledge_chunks c WHERE c.document_id = d.id) AS chunk_count
       FROM support_knowledge_documents d
       ${where}
       ORDER BY
         CASE d.category
           WHEN 'admin_memory' THEN 0
           WHEN 'policy' THEN 1
           WHEN 'product' THEN 2
           WHEN 'faq' THEN 3
           ELSE 4
         END ASC,
         d.updated_at DESC
       LIMIT 200`
    )
    .bind(...params)
    .all<Record<string, unknown>>();

  return rows.results;
}
