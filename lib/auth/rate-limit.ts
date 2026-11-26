import { ensureSchema, getRuntimeEnv } from "../database";

export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 64);
  return "unknown";
}

/**
 * Checks whether a login key (e.g., `ip:...` or `email:...`) is currently locked out.
 */
export async function checkLoginLockout(keys: string[]): Promise<{
  blocked: boolean;
  retryAfterSeconds: number;
}> {
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  const now = Date.now();
  let maxRetry = 0;

  for (const key of keys) {
    const row = await runtime.DB.prepare(
      "SELECT attempts, first_attempt_at, locked_until FROM auth_login_attempts WHERE key = ?",
    )
      .bind(key)
      .first<{
        attempts: number;
        first_attempt_at: string;
        locked_until: string | null;
      }>()
      .catch(() => null);

    if (row?.locked_until) {
      const lockMs = new Date(row.locked_until).getTime();
      if (Number.isFinite(lockMs) && lockMs > now) {
        maxRetry = Math.max(maxRetry, Math.ceil((lockMs - now) / 1000));
      }
    }
  }

  return { blocked: maxRetry > 0, retryAfterSeconds: maxRetry };
}

/**
 * Records a failed login attempt and locks out after `maxAttempts` within `windowMs`.
 */
export async function recordLoginFailure(
  keys: string[],
  maxAttempts = 5,
  windowMs = 15 * 60_000,
  lockoutMs = 15 * 60_000,
): Promise<void> {
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  const now = Date.now();

  for (const key of keys) {
    const existing = await runtime.DB.prepare(
      "SELECT attempts, first_attempt_at FROM auth_login_attempts WHERE key = ?",
    )
      .bind(key)
      .first<{ attempts: number; first_attempt_at: string }>()
      .catch(() => null);

    const firstMs = existing?.first_attempt_at
      ? new Date(existing.first_attempt_at).getTime()
      : 0;
    const withinWindow = firstMs > 0 && now - firstMs < windowMs;
    const nextAttempts = withinWindow ? Number(existing?.attempts || 0) + 1 : 1;
    const lockedUntil =
      nextAttempts >= maxAttempts ? new Date(now + lockoutMs).toISOString() : null;
    const firstAttemptIso = withinWindow
      ? new Date(firstMs).toISOString()
      : new Date(now).toISOString();

    await runtime.DB.prepare(
      `INSERT INTO auth_login_attempts (key, attempts, first_attempt_at, locked_until)
       VALUES (?, ?, ?::timestamptz, ?::timestamptz)
       ON CONFLICT (key) DO UPDATE SET
         attempts = EXCLUDED.attempts,
         first_attempt_at = EXCLUDED.first_attempt_at,
         locked_until = EXCLUDED.locked_until`,
    )
      .bind(key, nextAttempts, firstAttemptIso, lockedUntil)
      .run()
      .catch(() => null);
  }
}

/**
 * Clears login failure counters after successful authentication.
 */
export async function clearLoginFailures(keys: string[]): Promise<void> {
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  for (const key of keys) {
    await runtime.DB.prepare("DELETE FROM auth_login_attempts WHERE key = ?")
      .bind(key)
      .run()
      .catch(() => null);
  }
}

/**
 * Generic sliding-window rate limiter backed by PostgreSQL `api_rate_limits`.
 */
export async function consumeRateLimit(
  key: string,
  maxHits: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  const now = Date.now();
  const row = await runtime.DB.prepare(
    "SELECT hits, window_start FROM api_rate_limits WHERE key = ?",
  )
    .bind(key)
    .first<{ hits: number; window_start: string }>()
    .catch(() => null);

  const windowMs = windowSeconds * 1000;
  const startMs = row?.window_start ? new Date(row.window_start).getTime() : 0;
  const activeWindow = startMs > 0 && now - startMs < windowMs;
  const nextHits = activeWindow ? Number(row?.hits || 0) + 1 : 1;
  const nextStartIso = activeWindow
    ? new Date(startMs).toISOString()
    : new Date(now).toISOString();

  await runtime.DB.prepare(
    `INSERT INTO api_rate_limits (key, hits, window_start)
     VALUES (?, ?, ?::timestamptz)
     ON CONFLICT (key) DO UPDATE SET
       hits = EXCLUDED.hits,
       window_start = EXCLUDED.window_start`,
  )
    .bind(key, nextHits, nextStartIso)
    .run()
    .catch(() => null);

  if (nextHits > maxHits) {
    const remaining = Math.max(1, Math.ceil((startMs + windowMs - now) / 1000));
    return { allowed: false, retryAfterSeconds: remaining };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
