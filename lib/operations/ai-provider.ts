import { createHash } from "node:crypto";

export type AiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  isEstimated: boolean;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export function estimateAiCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  options?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): number {
  const m = String(model || "").toLowerCase();
  if (!m || m.includes("local") || m.includes("hashed") || m === "empty" || m.includes("budget-guard")) {
    return 0;
  }
  const cacheReadTokens = Math.max(0, Number(options?.cacheReadTokens || 0));
  const cacheWriteTokens = Math.max(0, Number(options?.cacheWriteTokens || 0));

  let inputPer1M = 0.15;
  let outputPer1M = 0.6;
  let cacheReadPer1M = 0;
  let cacheWritePer1M = 0;

  if (m.includes("embedding")) {
    inputPer1M = m.includes("text-embedding-3-small") ? 0.02 : 0.15;
    outputPer1M = 0;
  } else if (m.includes("haiku-5-5")) {
    const over100k = inputTokens + cacheReadTokens + cacheWriteTokens > 100_000;
    inputPer1M = over100k ? 0.5 : 0.1;
    outputPer1M = over100k ? 2.5 : 0.5;
    cacheReadPer1M = over100k ? 0.05 : 0.01;
    cacheWritePer1M = over100k ? 0.625 : 0.125;
  } else if (m.includes("haiku-4-5") || m.includes("haiku-3-5") || m.includes("claude-haiku")) {
    inputPer1M = 1.0;
    outputPer1M = 5.0;
    cacheReadPer1M = 0.1;
    cacheWritePer1M = 1.25;
  } else if (m.includes("claude-sonnet")) {
    inputPer1M = 2.0;
    outputPer1M = 10.0;
    cacheReadPer1M = 0.1;
    cacheWritePer1M = 2.5;
  } else if (m.includes("claude-opus")) {
    inputPer1M = 4.0;
    outputPer1M = 20.0;
    cacheReadPer1M = 0.2;
    cacheWritePer1M = 5.0;
  } else if (m.includes("claude-fable")) {
    inputPer1M = 8.0;
    outputPer1M = 40.0;
    cacheReadPer1M = 0.2;
    cacheWritePer1M = 10.0;
  } else if (m.includes("2.5-pro") || m.includes("1.5-pro")) {
    inputPer1M = 1.25;
    outputPer1M = 10.0;
  } else if (m.includes("2.5-flash-lite") || m.includes("flash-lite")) {
    inputPer1M = 0.1;
    outputPer1M = 0.4;
  } else if (m.includes("gpt-4o-mini")) {
    inputPer1M = 0.15;
    outputPer1M = 0.6;
  } else if (m.includes("gpt-4o")) {
    inputPer1M = 2.5;
    outputPer1M = 10.0;
  }
  const usd =
    (inputTokens * inputPer1M +
      outputTokens * outputPer1M +
      cacheReadTokens * cacheReadPer1M +
      cacheWriteTokens * cacheWritePer1M) /
    1_000_000;
  return Number(usd.toFixed(8));
}

export const EMBEDDING_DIM = 768;
export const DEFAULT_ANTHROPIC_CHAT_MODEL = "claude-haiku-5-5";
export const LEGACY_ANTHROPIC_HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_GEMINI_CHAT_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";
export const FALLBACK_GEMINI_CHAT_MODELS = [
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
];
export const DEFAULT_GEMINI_EMBED_MODELS = [
  process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
];

const unavailableLiveGeminiModels = new Set<string>();
const rateLimitedLiveGeminiModels = new Map<string, number>();

function redactSecrets(raw: string): string {
  return String(raw || "")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_GEMINI_KEY]")
    .replace(/sk-ant-[0-9A-Za-z_-]{12,}/g, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/sk-[0-9A-Za-z_-]{16,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(key|token|secret|password)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 320);
}

export function logAiProviderWarning(
  operation: string,
  details: Record<string, unknown>,
): void {
  const safeDetails: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    safeDetails[k] = typeof v === "string" ? redactSecrets(v) : v;
  }
  console.warn(`[ai-provider:${operation}]`, JSON.stringify(safeDetails));
}

async function sleepWithJitter(attempt: number, defaultBaseMs = 800): Promise<void> {
  const envBase = Number(process.env.AI_PROVIDER_RETRY_BASE_MS);
  const baseMs = Number.isFinite(envBase) && envBase >= 0 ? envBase : defaultBaseMs;
  if (baseMs === 0) return;
  const exp = baseMs * Math.pow(2, Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * Math.min(250, Math.max(20, baseMs * 0.4)));
  const delayMs = Math.min(8000, exp + jitter);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529
  );
}

export function getAnthropicApiKey(): string {
  return (process.env.ANTHROPIC_API_KEY || "").trim();
}

export function getGeminiApiKey(): string {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    ""
  ).trim();
}

export function getOpenAiApiKey(): string {
  return (process.env.OPENAI_API_KEY || "").trim();
}

/**
 * Strictly enforces Claude Haiku model selection to protect paid API spend.
 * Any non-Haiku model (Sonnet, Opus, Fable, etc.) is rejected and pinned back
 * to `claude-haiku-5-5` unless `ANTHROPIC_STRICT_HAIKU=false` is explicitly set.
 */
export function resolveStrictAnthropicHaikuModel(requestedModel?: string): string {
  const candidate = String(
    requestedModel || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_CHAT_MODEL,
  ).trim();
  const strictHaiku = process.env.ANTHROPIC_STRICT_HAIKU !== "false";
  const allowLegacyHaiku = process.env.ANTHROPIC_ALLOW_LEGACY_HAIKU === "true";

  if (!candidate) return DEFAULT_ANTHROPIC_CHAT_MODEL;
  const lower = candidate.toLowerCase();

  if (strictHaiku) {
    if (!lower.includes("haiku")) {
      logAiProviderWarning("strict_haiku_guard", {
        blockedModel: candidate,
        enforcedModel: DEFAULT_ANTHROPIC_CHAT_MODEL,
        reason: "Non-Haiku Anthropic models (Sonnet/Opus/Fable) are blocked to prevent overspend",
      });
      return DEFAULT_ANTHROPIC_CHAT_MODEL;
    }
    if (!allowLegacyHaiku && lower !== DEFAULT_ANTHROPIC_CHAT_MODEL) {
      logAiProviderWarning("strict_haiku_guard", {
        blockedModel: candidate,
        enforcedModel: DEFAULT_ANTHROPIC_CHAT_MODEL,
        reason: "Legacy Haiku 4.5 ($1/$5 per 1M) blocked; locked to claude-haiku-5-5 ($0.10/$0.50 per 1M)",
      });
      return DEFAULT_ANTHROPIC_CHAT_MODEL;
    }
  }
  return candidate;
}

export function getActiveChatProviderPreference(): "anthropic" | "gemini" | "openai" | "local_heuristic" {
  const explicit = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (explicit === "anthropic" && getAnthropicApiKey()) return "anthropic";
  if (explicit === "gemini" && getGeminiApiKey()) return "gemini";
  if (explicit === "openai" && getOpenAiApiKey()) return "openai";
  if (getAnthropicApiKey()) return "anthropic";
  if (getGeminiApiKey()) return "gemini";
  if (getOpenAiApiKey()) return "openai";
  return "local_heuristic";
}

export function getConfiguredAiProviderInfo(): {
  provider: "anthropic" | "gemini" | "openai" | "local_heuristic";
  chatModel: string;
  embeddingModel: string;
  apiKeyConfigured: boolean;
} {
  const embeddingModel = getGeminiApiKey()
    ? DEFAULT_GEMINI_EMBED_MODELS[0]
    : getOpenAiApiKey()
      ? "text-embedding-3-small"
      : "satmi-hashed-ngram-768";

  const chatPref = getActiveChatProviderPreference();
  if (chatPref === "anthropic") {
    return {
      provider: "anthropic",
      chatModel: resolveStrictAnthropicHaikuModel(),
      embeddingModel,
      apiKeyConfigured: true,
    };
  }
  if (chatPref === "gemini") {
    return {
      provider: "gemini",
      chatModel: DEFAULT_GEMINI_CHAT_MODEL,
      embeddingModel,
      apiKeyConfigured: true,
    };
  }
  if (chatPref === "openai") {
    return {
      provider: "openai",
      chatModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
      embeddingModel,
      apiKeyConfigured: true,
    };
  }
  return {
    provider: "local_heuristic",
    chatModel: "satmi-local-grounded-v1 (configure ANTHROPIC_API_KEY or GEMINI_API_KEY)",
    embeddingModel: "satmi-hashed-ngram-768",
    apiKeyConfigured: false,
  };
}

// ---------------------------------------------------------------------------
// Paid API Spend Circuit Breakers (Daily USD, Monthly USD, Hourly RPM, Ticket 24h)
// ---------------------------------------------------------------------------
type InProcessSpendState = {
  dayKey: string;
  monthKey: string;
  daySpendUsd: number;
  monthSpendUsd: number;
  hourlyTimestamps: number[];
  ticketDayCounts: Map<string, number>;
  lastDbSyncAt: number;
  dbDaySpendUsd: number;
  dbMonthSpendUsd: number;
  dbHourlyCount: number;
};

const spendState: InProcessSpendState = {
  dayKey: "",
  monthKey: "",
  daySpendUsd: 0,
  monthSpendUsd: 0,
  hourlyTimestamps: [],
  ticketDayCounts: new Map(),
  lastDbSyncAt: 0,
  dbDaySpendUsd: 0,
  dbMonthSpendUsd: 0,
  dbHourlyCount: 0,
};

function rolloverSpendWindowsIfNeeded() {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const monthKey = now.toISOString().slice(0, 7);
  if (spendState.dayKey !== dayKey) {
    spendState.dayKey = dayKey;
    spendState.daySpendUsd = 0;
    spendState.dbDaySpendUsd = 0;
    spendState.ticketDayCounts.clear();
  }
  if (spendState.monthKey !== monthKey) {
    spendState.monthKey = monthKey;
    spendState.monthSpendUsd = 0;
    spendState.dbMonthSpendUsd = 0;
  }
  const oneHourAgo = Date.now() - 3600_000;
  if (spendState.hourlyTimestamps.length > 0) {
    spendState.hourlyTimestamps = spendState.hourlyTimestamps.filter((ts) => ts >= oneHourAgo);
  }
}

export function resetPaidBudgetTrackerForTests(): void {
  spendState.dayKey = "";
  spendState.monthKey = "";
  spendState.daySpendUsd = 0;
  spendState.monthSpendUsd = 0;
  spendState.hourlyTimestamps = [];
  spendState.ticketDayCounts.clear();
  spendState.lastDbSyncAt = 0;
  spendState.dbDaySpendUsd = 0;
  spendState.dbMonthSpendUsd = 0;
  spendState.dbHourlyCount = 0;
}

export function getPaidAiBudgetCaps() {
  const parsePositive = (raw: string | undefined, fallback: number, min = 0) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > min ? n : fallback;
  };
  return {
    enabled: process.env.AI_SPEND_GUARD_ENABLED !== "false",
    maxDailyUsd: parsePositive(process.env.AI_MAX_DAILY_USD, 1.0),
    maxMonthlyUsd: parsePositive(process.env.AI_MAX_MONTHLY_USD, 15.0),
    maxRequestsPerHour: Math.round(parsePositive(process.env.AI_MAX_REQUESTS_PER_HOUR, 120, 0)),
    maxCallsPerTicketDay: Math.round(parsePositive(process.env.AI_MAX_CALLS_PER_TICKET_24H, 6, 0)),
    maxOutputTokens: Math.min(
      1600,
      Math.max(128, Math.round(parsePositive(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS, 1200, 64))),
    ),
    maxInputTokens: Math.min(
      24000,
      Math.max(1500, Math.round(parsePositive(process.env.AI_MAX_INPUT_TOKENS, 14000, 500))),
    ),
  };
}

async function syncDbSpendBaselineIfConfigured(ticketId?: string): Promise<number | null> {
  if (!process.env.SUPABASE_DB_URL) return null;
  const nowMs = Date.now();
  try {
    const { operationsDb } = await import("./schema");
    const db = await operationsDb();
    let ticketCalls24h: number | null = null;

    if (nowMs - spendState.lastDbSyncAt >= 5000) {
      const row = await db
        .prepare(
          `SELECT
             COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::float8 AS day_usd,
             COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::float8 AS month_usd,
             COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour' AND provider IN ('anthropic', 'gemini', 'openai'))::int AS hour_reqs
           FROM support_ai_token_usage`,
        )
        .first<{ day_usd: number; month_usd: number; hour_reqs: number }>();
      if (row) {
        spendState.dbDaySpendUsd = Number(row.day_usd || 0);
        spendState.dbMonthSpendUsd = Number(row.month_usd || 0);
        spendState.dbHourlyCount = Number(row.hour_reqs || 0);
        spendState.lastDbSyncAt = nowMs;
      }
    }

    if (ticketId) {
      const tRow = await db
        .prepare(
          `SELECT COUNT(*)::int AS cnt
           FROM support_ai_token_usage
           WHERE ticket_id = ?
             AND created_at >= now() - interval '24 hours'
             AND provider IN ('anthropic', 'gemini', 'openai')`,
        )
        .bind(ticketId)
        .first<{ cnt: number }>();
      ticketCalls24h = Number(tRow?.cnt || 0);
    }

    return ticketCalls24h;
  } catch {
    return null;
  }
}

export async function checkPaidAiBudgetGuard(params?: {
  ticketId?: string;
}): Promise<{
  allowed: boolean;
  reason: string;
  daySpendUsd: number;
  monthSpendUsd: number;
  hourlyRequests: number;
}> {
  rolloverSpendWindowsIfNeeded();
  const caps = getPaidAiBudgetCaps();
  if (!caps.enabled) {
    return { allowed: true, reason: "", daySpendUsd: 0, monthSpendUsd: 0, hourlyRequests: 0 };
  }

  const dbTicketCalls = await syncDbSpendBaselineIfConfigured(params?.ticketId);
  const daySpendUsd = Math.max(spendState.dbDaySpendUsd, spendState.daySpendUsd);
  const monthSpendUsd = Math.max(spendState.dbMonthSpendUsd, spendState.monthSpendUsd);
  const hourlyRequests = Math.max(spendState.dbHourlyCount, spendState.hourlyTimestamps.length);

  if (daySpendUsd >= caps.maxDailyUsd) {
    return {
      allowed: false,
      reason: `daily_usd_cap_reached ($${daySpendUsd.toFixed(4)} >= $${caps.maxDailyUsd.toFixed(2)})`,
      daySpendUsd,
      monthSpendUsd,
      hourlyRequests,
    };
  }
  if (monthSpendUsd >= caps.maxMonthlyUsd) {
    return {
      allowed: false,
      reason: `monthly_usd_cap_reached ($${monthSpendUsd.toFixed(4)} >= $${caps.maxMonthlyUsd.toFixed(2)})`,
      daySpendUsd,
      monthSpendUsd,
      hourlyRequests,
    };
  }
  if (hourlyRequests >= caps.maxRequestsPerHour) {
    return {
      allowed: false,
      reason: `hourly_request_cap_reached (${hourlyRequests} >= ${caps.maxRequestsPerHour}/hr)`,
      daySpendUsd,
      monthSpendUsd,
      hourlyRequests,
    };
  }
  if (params?.ticketId) {
    const inMemCount = spendState.ticketDayCounts.get(params.ticketId) || 0;
    const ticketCalls = Math.max(inMemCount, dbTicketCalls ?? 0);
    if (ticketCalls >= caps.maxCallsPerTicketDay) {
      return {
        allowed: false,
        reason: `per_ticket_24h_cap_reached (${ticketCalls} >= ${caps.maxCallsPerTicketDay})`,
        daySpendUsd,
        monthSpendUsd,
        hourlyRequests,
      };
    }
  }

  return { allowed: true, reason: "", daySpendUsd, monthSpendUsd, hourlyRequests };
}

function recordPaidUsageInCircuitBreaker(costUsd: number, ticketId?: string): void {
  rolloverSpendWindowsIfNeeded();
  const safeCost = Math.max(0, Number(costUsd) || 0);
  spendState.daySpendUsd = Number((spendState.daySpendUsd + safeCost).toFixed(8));
  spendState.monthSpendUsd = Number((spendState.monthSpendUsd + safeCost).toFixed(8));
  spendState.dbDaySpendUsd = Number((spendState.dbDaySpendUsd + safeCost).toFixed(8));
  spendState.dbMonthSpendUsd = Number((spendState.dbMonthSpendUsd + safeCost).toFixed(8));
  spendState.hourlyTimestamps.push(Date.now());
  spendState.dbHourlyCount += 1;
  if (ticketId) {
    spendState.ticketDayCounts.set(
      ticketId,
      (spendState.ticketDayCounts.get(ticketId) || 0) + 1,
    );
  }
}

/**
 * Estimates LLM token count for English/Hinglish customer support threads.
 * Uses a conservative ~3.7 chars/token + word boundary estimator.
 */
export function estimateTokenCount(text: string): number {
  const clean = String(text || "");
  if (!clean) return 0;
  const charEstimate = Math.ceil(clean.length / 3.7);
  const words = clean.trim().split(/\s+/).filter(Boolean).length;
  const wordEstimate = Math.ceil(words * 1.35);
  return Math.max(charEstimate, wordEstimate);
}

/**
 * Normalizes a vector to unit L2 norm so dot-product equals cosine similarity.
 */
export function normalizeVector(vec: number[]): number[] {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]) || 0;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (norm < 1e-12) return vec.map(() => 0);
  return vec.map((v) => Number(((Number(v) || 0) / norm).toFixed(6)));
}

/**
 * Deterministic 768-dim feature-hashed n-gram embedding fallback.
 * Used when GEMINI_API_KEY is not present (e.g. unit tests / offline sandbox)
 * so vector search and cosine similarity remain 100% functional and deterministic.
 */
export function deterministicLocalEmbedding(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9₹#@\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return vec;

  const tokens = normalized.split(" ").filter(Boolean);
  const features: Array<{ term: string; weight: number }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    features.push({ term: `u:${t}`, weight: t.length >= 5 ? 1.5 : 1.0 });
    if (i + 1 < tokens.length) {
      features.push({ term: `b:${t}_${tokens[i + 1]}`, weight: 1.25 });
    }
    if (t.length >= 4) {
      for (let j = 0; j <= t.length - 3; j++) {
        features.push({ term: `c:${t.slice(j, j + 3)}`, weight: 0.45 });
      }
    }
  }

  for (const feat of features) {
    const digest = createHash("sha256").update(feat.term).digest();
    const idx = digest.readUInt16BE(0) % dim;
    const sign = (digest[2] & 1) === 0 ? 1 : -1;
    vec[idx] += sign * feat.weight;
  }

  return normalizeVector(vec);
}

/**
 * Computes cosine similarity in [-1, 1] between two equal-length vectors.
 */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA < 1e-12 || normB < 1e-12) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Computes a 768-dimensional embedding using Google Gemini (text-embedding-004 / gemini-embedding-001),
 * with fallback to OpenAI text-embedding-3-small or deterministic local 768-dim embedding.
 */
export async function embedText(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT"
): Promise<{ embedding: number[]; model: string; usage: AiTokenUsage }> {
  const clean = String(text || "").trim().slice(0, 8000);
  if (!clean) {
    return {
      embedding: new Array<number>(EMBEDDING_DIM).fill(0),
      model: "empty",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, isEstimated: true },
    };
  }

  const approxTokens = estimateTokenCount(clean);
  const geminiKey = getGeminiApiKey();
  const embedTimeoutMs = Math.max(5000, Number(process.env.GEMINI_EMBED_TIMEOUT_MS || 20000));
  if (geminiKey) {
    for (const modelName of DEFAULT_GEMINI_EMBED_MODELS) {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        modelName
      )}:embedContent`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": geminiKey,
            },
            body: JSON.stringify({
              model: `models/${modelName}`,
              content: { parts: [{ text: clean }] },
              taskType,
              outputDimensionality: EMBEDDING_DIM,
            }),
            signal: AbortSignal.timeout(embedTimeoutMs),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              embedding?: { values?: number[] };
            };
            const values = data?.embedding?.values;
            if (Array.isArray(values) && values.length > 0) {
              const resized =
                values.length >= EMBEDDING_DIM
                  ? values.slice(0, EMBEDDING_DIM)
                  : [...values, ...new Array(EMBEDDING_DIM - values.length).fill(0)];
              return {
                embedding: normalizeVector(resized),
                model: modelName,
                usage: {
                  inputTokens: approxTokens,
                  outputTokens: 0,
                  totalTokens: approxTokens,
                  estimatedCostUsd: estimateAiCostUsd(modelName, approxTokens, 0),
                  isEstimated: true,
                },
              };
            }
            logAiProviderWarning("embedText", {
              model: modelName,
              attempt: attempt + 1,
              reason: "empty_embedding_values",
            });
            break;
          }

          const errSnippet = await res.text().catch(() => "");
          logAiProviderWarning("embedText", {
            model: modelName,
            attempt: attempt + 1,
            status: res.status,
            error: errSnippet.slice(0, 220),
          });

          if (isRetryableHttpStatus(res.status) && attempt < 2) {
            await sleepWithJitter(attempt, 700);
            continue;
          }
          break;
        } catch (err) {
          const isTimeout =
            err instanceof Error &&
            (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|aborted/i.test(err.message));
          logAiProviderWarning("embedText", {
            model: modelName,
            attempt: attempt + 1,
            reason: isTimeout ? "timeout" : "network_error",
            error: err instanceof Error ? err.message : String(err),
          });
          if (attempt < 2) {
            await sleepWithJitter(attempt, 700);
            continue;
          }
        }
      }
    }
  }

  const openAiKey = getOpenAiApiKey();
  if (openAiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: clean,
          dimensions: EMBEDDING_DIM,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          data?: Array<{ embedding?: number[] }>;
          usage?: { prompt_tokens?: number; total_tokens?: number };
        };
        const values = data?.data?.[0]?.embedding;
        if (Array.isArray(values) && values.length === EMBEDDING_DIM) {
          const inTok = Number(data?.usage?.prompt_tokens ?? approxTokens);
          const totTok = Number(data?.usage?.total_tokens ?? inTok);
          return {
            embedding: normalizeVector(values),
            model: "text-embedding-3-small",
            usage: {
              inputTokens: inTok,
              outputTokens: 0,
              totalTokens: totTok,
              estimatedCostUsd: estimateAiCostUsd("text-embedding-3-small", inTok, 0),
              isEstimated: !data?.usage?.prompt_tokens,
            },
          };
        }
      }
    } catch {
      // Fall back to deterministic local embedding
    }
  }

  return {
    embedding: deterministicLocalEmbedding(clean, EMBEDDING_DIM),
    model: "satmi-hashed-ngram-768",
    usage: {
      inputTokens: approxTokens,
      outputTokens: 0,
      totalTokens: approxTokens,
      estimatedCostUsd: 0,
      isEstimated: true,
    },
  };
}

function parseJsonFromLlmOutput<T>(rawText: string): T | null {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim()) as T;
      } catch {
        // continue
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clampPromptChars(text: string, maxChars: number): string {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.55);
  const tail = maxChars - head;
  return `${s.slice(0, head)}\n\n[...middle context truncated to enforce paid-API token budget...]\n\n${s.slice(-tail)}`;
}

/**
 * Generates structured JSON using the configured AI provider (`anthropic` Haiku 5.5,
 * `gemini`, or `openai`) with strict paid-API spend circuit breakers and a
 * guaranteed deterministic local fallback.
 */
export async function generateStructuredJson<T>(params: {
  systemInstruction: string;
  userPrompt: string;
  temperature?: number;
  ticketId?: string;
  maxTokens?: number;
  skipBudgetGuard?: boolean;
  fallback: () => T | Promise<T>;
}): Promise<{
  data: T;
  provider: "anthropic" | "gemini" | "openai" | "local_heuristic";
  model: string;
  usage: AiTokenUsage;
}> {
  const temperature = params.temperature ?? 0.15;
  const budgetCaps = getPaidAiBudgetCaps();
  const safeSystemInstruction = clampPromptChars(
    params.systemInstruction,
    Math.floor(budgetCaps.maxInputTokens * 1.2),
  );
  const safeUserPrompt = clampPromptChars(
    params.userPrompt,
    Math.floor(budgetCaps.maxInputTokens * 2.5),
  );
  const estimatedInputTokens = estimateTokenCount(
    `${safeSystemInstruction}\n${safeUserPrompt}`,
  );

  const chatPref = getActiveChatProviderPreference();

  // Pre-flight Paid API Budget & Rate Circuit Breaker
  if (chatPref !== "local_heuristic" && !params.skipBudgetGuard) {
    const budgetCheck = await checkPaidAiBudgetGuard({ ticketId: params.ticketId });
    if (!budgetCheck.allowed) {
      logAiProviderWarning("budget_guard", {
        provider: chatPref,
        reason: budgetCheck.reason,
        ticketId: params.ticketId || null,
        daySpendUsd: budgetCheck.daySpendUsd,
        monthSpendUsd: budgetCheck.monthSpendUsd,
        hourlyRequests: budgetCheck.hourlyRequests,
      });
      const fallbackData = await params.fallback();
      return {
        data: fallbackData,
        provider: "local_heuristic",
        model: "satmi-local-grounded-v1 (budget-guard)",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          isEstimated: true,
        },
      };
    }
  }

  const anthropicKey = getAnthropicApiKey();
  if (chatPref === "anthropic" && anthropicKey) {
    const model = resolveStrictAnthropicHaikuModel();
    const maxOutputTokens = Math.min(
      budgetCaps.maxOutputTokens,
      Math.max(128, Math.round(params.maxTokens ?? budgetCaps.maxOutputTokens)),
    );
    const timeoutMs = Math.max(5000, Number(process.env.ANTHROPIC_TIMEOUT_MS || 25000));
    const maxAttempts = 2;
    const jsonInstructionSuffix =
      '\n\nCRITICAL: Respond with a single valid JSON object only. Keep "reasoning" concise (1-2 sentences). Do not include markdown fences or extra prose.';
    const promptWithJsonDirective = safeUserPrompt.includes("Return JSON")
      ? `${safeUserPrompt}${jsonInstructionSuffix}`
      : `${safeUserPrompt}${jsonInstructionSuffix}`;
    // claude-haiku-5-5 deprecates `temperature` and supports `thinking: { type: "disabled" }` for deterministic low-cost JSON
    const isHaiku55 = /haiku-5-5/i.test(model);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: maxOutputTokens,
            ...(isHaiku55 ? { thinking: { type: "disabled" } } : { temperature }),
            system: [
              {
                type: "text",
                text: safeSystemInstruction,
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: [
              {
                role: "user",
                content: promptWithJsonDirective,
              },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          const payload = (await res.json()) as {
            model?: string;
            stop_reason?: string;
            content?: Array<{ type?: string; text?: string }>;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          const rawText = (payload.content || [])
            .filter((b) => b.type === "text" || typeof b.text === "string")
            .map((b) => b.text || "")
            .join("\n");
          const parsed = parseJsonFromLlmOutput<T>(rawText);
          if (parsed !== null) {
            const um = payload.usage;
            const uncachedIn = Number(um?.input_tokens ?? estimatedInputTokens);
            const cacheReadTokens = Number(um?.cache_read_input_tokens ?? 0);
            const cacheWriteTokens = Number(um?.cache_creation_input_tokens ?? 0);
            const inputTokens = uncachedIn + cacheReadTokens + cacheWriteTokens;
            const outputTokens = Number(um?.output_tokens ?? estimateTokenCount(rawText));
            const totalTokens = inputTokens + outputTokens;
            const actualModel = resolveStrictAnthropicHaikuModel(payload.model || model);
            const costUsd = estimateAiCostUsd(actualModel, uncachedIn, outputTokens, {
              cacheReadTokens,
              cacheWriteTokens,
            });
            recordPaidUsageInCircuitBreaker(costUsd, params.ticketId);
            return {
              data: parsed,
              provider: "anthropic",
              model: actualModel,
              usage: {
                inputTokens,
                outputTokens,
                totalTokens,
                estimatedCostUsd: costUsd,
                isEstimated: typeof um?.input_tokens !== "number",
                cacheReadTokens,
                cacheWriteTokens,
              },
            };
          }

          logAiProviderWarning("generateStructuredJson", {
            provider: "anthropic",
            model,
            attempt: attempt + 1,
            reason: "json_parse_failure",
            stopReason: payload.stop_reason || "unknown",
            snippet: rawText.slice(0, 200),
          });
          if (attempt + 1 < maxAttempts) {
            await sleepWithJitter(attempt, 500);
            continue;
          }
          break;
        }

        const errSnippet = await res.text().catch(() => "");
        logAiProviderWarning("generateStructuredJson", {
          provider: "anthropic",
          model,
          attempt: attempt + 1,
          status: res.status,
          error: errSnippet.slice(0, 240),
        });

        // Never retry auth/bad-request/credit errors to avoid wasting time or requests
        if (!isRetryableHttpStatus(res.status)) {
          break;
        }
        if (attempt + 1 < maxAttempts) {
          await sleepWithJitter(attempt, 900);
          continue;
        }
        break;
      } catch (err) {
        const isTimeout =
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|aborted/i.test(err.message));
        logAiProviderWarning("generateStructuredJson", {
          provider: "anthropic",
          model,
          attempt: attempt + 1,
          reason: isTimeout ? "timeout" : "network_error",
          timeoutMs,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attempt + 1 < maxAttempts) {
          await sleepWithJitter(attempt, 900);
          continue;
        }
      }
    }

    // Strict Haiku mode: unless cross-provider fallback is explicitly opted in, return local heuristic
    if (process.env.AI_ALLOW_CROSS_PROVIDER_FALLBACK !== "true") {
      const fallbackData = await params.fallback();
      return {
        data: fallbackData,
        provider: "local_heuristic",
        model: "satmi-local-grounded-v1",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          isEstimated: true,
        },
      };
    }
  }

  const geminiKey = getGeminiApiKey();
  if (geminiKey && (chatPref === "gemini" || process.env.AI_ALLOW_CROSS_PROVIDER_FALLBACK === "true")) {
    const candidateModels = [
      ...new Set([DEFAULT_GEMINI_CHAT_MODEL, ...FALLBACK_GEMINI_CHAT_MODELS].filter(Boolean)),
    ];
    const chatTimeoutMs = Math.max(5000, Number(process.env.GEMINI_TIMEOUT_MS || 28000));
    const configuredThinkingBudget = Number(process.env.GEMINI_THINKING_BUDGET ?? 0);
    const thinkingBudget =
      Number.isFinite(configuredThinkingBudget) && configuredThinkingBudget >= 0
        ? Math.min(1024, Math.round(configuredThinkingBudget))
        : 0;

    const isMockRetryTest = Boolean(process.env.AI_PROVIDER_RETRY_BASE_MS);
    const activeModels = isMockRetryTest
      ? candidateModels
      : candidateModels.filter((m) => !unavailableLiveGeminiModels.has(m));

    for (let modelIdx = 0; modelIdx < activeModels.length; modelIdx++) {
      const model = activeModels[modelIdx];
      if (!isMockRetryTest && unavailableLiveGeminiModels.has(model)) {
        continue;
      }
      const hasUnthrottledLaterModel =
        !isMockRetryTest &&
        activeModels
          .slice(modelIdx + 1)
          .some((m) => (rateLimitedLiveGeminiModels.get(m) || 0) <= Date.now());

      if (!isMockRetryTest && hasUnthrottledLaterModel) {
        const cooldownUntil = rateLimitedLiveGeminiModels.get(model) || 0;
        if (cooldownUntil > Date.now()) {
          continue;
        }
      }
      const maxAttempts = modelIdx === 0 ? 3 : 2;
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent`;
      const supportsThinkingConfig = /^gemini-2\.5-flash$/i.test(model);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": geminiKey,
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: safeSystemInstruction }],
              },
              contents: [
                {
                  role: "user",
                  parts: [{ text: safeUserPrompt }],
                },
              ],
              generationConfig: {
                temperature,
                responseMimeType: "application/json",
                ...(supportsThinkingConfig
                  ? { thinkingConfig: { thinkingBudget } }
                  : {}),
              },
            }),
            signal: AbortSignal.timeout(chatTimeoutMs),
          });

          if (res.ok) {
            const payload = (await res.json()) as {
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
                finishReason?: string;
              }>;
              usageMetadata?: {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
                totalTokenCount?: number;
              };
            };
            const rawText =
              payload?.candidates?.[0]?.content?.parts
                ?.map((p) => p.text || "")
                .join("\n") || "";
            const parsed = parseJsonFromLlmOutput<T>(rawText);
            if (parsed !== null) {
              const um = payload?.usageMetadata;
              const inputTokens = Number(um?.promptTokenCount ?? estimatedInputTokens);
              const outputTokens = Number(
                um?.candidatesTokenCount ?? estimateTokenCount(rawText),
              );
              const totalTokens = Number(
                um?.totalTokenCount ?? inputTokens + outputTokens,
              );
              const costUsd = estimateAiCostUsd(model, inputTokens, outputTokens);
              recordPaidUsageInCircuitBreaker(costUsd, params.ticketId);
              return {
                data: parsed,
                provider: "gemini",
                model,
                usage: {
                  inputTokens,
                  outputTokens,
                  totalTokens,
                  estimatedCostUsd: costUsd,
                  isEstimated: !um?.promptTokenCount,
                },
              };
            }

            logAiProviderWarning("generateStructuredJson", {
              model,
              attempt: attempt + 1,
              reason: "json_parse_failure",
              finishReason: payload?.candidates?.[0]?.finishReason || "UNKNOWN",
              snippet: rawText.slice(0, 200),
            });
            if (attempt + 1 < maxAttempts) {
              await sleepWithJitter(attempt, 500);
              continue;
            }
            break;
          }

          const errSnippet = await res.text().catch(() => "");
          logAiProviderWarning("generateStructuredJson", {
            model,
            attempt: attempt + 1,
            status: res.status,
            error: errSnippet.slice(0, 240),
          });

          if (res.status === 404) {
            if (!isMockRetryTest) {
              unavailableLiveGeminiModels.add(model);
            }
            // Model unavailable for this key/project -> immediately try next fallback model
            break;
          }

          if (res.status === 429 && !isMockRetryTest) {
            rateLimitedLiveGeminiModels.set(
              model,
              Date.now() + (modelIdx === 0 ? 60_000 : 10_000),
            );
            if (hasUnthrottledLaterModel) {
              // Fail over immediately to an available unthrottled fallback model
              break;
            }
          }

          if (isRetryableHttpStatus(res.status) && attempt + 1 < maxAttempts) {
            await sleepWithJitter(attempt, 850);
            continue;
          }
          break;
        } catch (err) {
          const isTimeout =
            err instanceof Error &&
            (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|aborted/i.test(err.message));
          logAiProviderWarning("generateStructuredJson", {
            model,
            attempt: attempt + 1,
            reason: isTimeout ? "timeout" : "network_error",
            timeoutMs: chatTimeoutMs,
            error: err instanceof Error ? err.message : String(err),
          });
          if (attempt + 1 < maxAttempts) {
            await sleepWithJitter(attempt, 850);
            continue;
          }
        }
      }
    }
  }

  const openAiKey = getOpenAiApiKey();
  if (openAiKey && (chatPref === "openai" || process.env.AI_ALLOW_CROSS_PROVIDER_FALLBACK === "true")) {
    try {
      const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: budgetCaps.maxOutputTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: safeSystemInstruction },
            { role: "user", content: safeUserPrompt },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const payload = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
        const rawText = payload?.choices?.[0]?.message?.content || "";
        const parsed = parseJsonFromLlmOutput<T>(rawText);
        if (parsed !== null) {
          const inputTokens = Number(
            payload?.usage?.prompt_tokens ?? estimatedInputTokens,
          );
          const outputTokens = Number(
            payload?.usage?.completion_tokens ?? estimateTokenCount(rawText),
          );
          const totalTokens = Number(
            payload?.usage?.total_tokens ?? inputTokens + outputTokens,
          );
          const costUsd = estimateAiCostUsd(model, inputTokens, outputTokens);
          recordPaidUsageInCircuitBreaker(costUsd, params.ticketId);
          return {
            data: parsed,
            provider: "openai",
            model,
            usage: {
              inputTokens,
              outputTokens,
              totalTokens,
              estimatedCostUsd: costUsd,
              isEstimated: !payload?.usage?.prompt_tokens,
            },
          };
        }
      }
    } catch {
      // Fall through to deterministic fallback
    }
  }

  const fallbackData = await params.fallback();
  return {
    data: fallbackData,
    provider: "local_heuristic",
    model: "satmi-local-grounded-v1",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      isEstimated: true,
    },
  };
}
