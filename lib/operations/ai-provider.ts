import { createHash } from "node:crypto";

export type AiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  isEstimated: boolean;
};

export function estimateAiCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const m = String(model || "").toLowerCase();
  if (!m || m.includes("local") || m.includes("hashed") || m === "empty") {
    return 0;
  }
  let inputPer1M = 0.15;
  let outputPer1M = 0.6;
  if (m.includes("embedding")) {
    inputPer1M = m.includes("text-embedding-3-small") ? 0.02 : 0.15;
    outputPer1M = 0;
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
  const usd = (inputTokens * inputPer1M + outputTokens * outputPer1M) / 1_000_000;
  return Number(usd.toFixed(8));
}

export const EMBEDDING_DIM = 768;
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
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
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

export function getConfiguredAiProviderInfo(): {
  provider: "gemini" | "openai" | "local_heuristic";
  chatModel: string;
  embeddingModel: string;
  apiKeyConfigured: boolean;
} {
  if (getGeminiApiKey()) {
    return {
      provider: "gemini",
      chatModel: DEFAULT_GEMINI_CHAT_MODEL,
      embeddingModel: DEFAULT_GEMINI_EMBED_MODELS[0],
      apiKeyConfigured: true,
    };
  }
  if (getOpenAiApiKey()) {
    return {
      provider: "openai",
      chatModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      apiKeyConfigured: true,
    };
  }
  return {
    provider: "local_heuristic",
    chatModel: "satmi-local-grounded-v1 (configure GEMINI_API_KEY for Gemini 2.5 Flash)",
    embeddingModel: "satmi-hashed-ngram-768 (configure GEMINI_API_KEY for text-embedding-004)",
    apiKeyConfigured: false,
  };
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

/**
 * Generates structured JSON using Google Gemini (gemini-2.5-flash),
 * with optional OpenAI fallback and a guaranteed deterministic fallback function.
 */
export async function generateStructuredJson<T>(params: {
  systemInstruction: string;
  userPrompt: string;
  temperature?: number;
  fallback: () => T | Promise<T>;
}): Promise<{
  data: T;
  provider: "gemini" | "openai" | "local_heuristic";
  model: string;
  usage: AiTokenUsage;
}> {
  const temperature = params.temperature ?? 0.15;
  const geminiKey = getGeminiApiKey();
  const estimatedInputTokens = estimateTokenCount(
    `${params.systemInstruction}\n${params.userPrompt}`,
  );

  if (geminiKey) {
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
                parts: [{ text: params.systemInstruction }],
              },
              contents: [
                {
                  role: "user",
                  parts: [{ text: params.userPrompt }],
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
              return {
                data: parsed,
                provider: "gemini",
                model,
                usage: {
                  inputTokens,
                  outputTokens,
                  totalTokens,
                  estimatedCostUsd: estimateAiCostUsd(model, inputTokens, outputTokens),
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
  if (openAiKey) {
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
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: params.systemInstruction },
            { role: "user", content: params.userPrompt },
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
          return {
            data: parsed,
            provider: "openai",
            model,
            usage: {
              inputTokens,
              outputTokens,
              totalTokens,
              estimatedCostUsd: estimateAiCostUsd(model, inputTokens, outputTokens),
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
