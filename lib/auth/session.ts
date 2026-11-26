import { randomBytes, randomUUID } from "node:crypto";
import { getRuntimeEnv, ensureSchema } from "../database";

export type DashboardUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

export const SESSION_COOKIE_NAME = "satmi_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

let ephemeralDevSecret: string | undefined;

function getSecretKey(): string {
  const configured = (process.env.SESSION_SECRET || "").trim();
  if (configured.length >= 32) {
    return configured;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be configured with at least 32 characters in production.",
    );
  }
  if (configured.length > 0) {
    return configured;
  }
  ephemeralDevSecret ??= randomBytes(32).toString("hex");
  return ephemeralDevSecret;
}

async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

type SessionPayload = {
  sub: string;
  email: string;
  name: string;
  role: string;
  jti?: string;
  sv?: number;
  exp: number;
};

export async function createSessionToken(
  user: DashboardUser,
  options?: { jti?: string; sessionVersion?: number },
): Promise<string> {
  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    ...(options?.jti ? { jti: options.jti } : {}),
    ...(options?.sessionVersion !== undefined ? { sv: options.sessionVersion } : {}),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const jsonStr = JSON.stringify(payload);
  const encodedPayload = Buffer.from(jsonStr).toString("base64url");
  const key = await getCryptoKey(getSecretKey());
  const sigBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload),
  );
  const signature = Buffer.from(sigBuffer).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionTokenPayload(
  token: string,
): Promise<SessionPayload | null> {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;

  try {
    const key = await getCryptoKey(getSecretKey());
    const sigBytes = Buffer.from(signature, "base64url");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(encodedPayload),
    );
    if (!valid) return null;

    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (!payload || typeof payload !== "object") return null;

    if (
      typeof payload.exp !== "number" ||
      Math.floor(Date.now() / 1000) > payload.exp
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<DashboardUser | null> {
  const payload = await verifySessionTokenPayload(token);
  if (!payload) return null;
  return {
    id: String(payload.sub || ""),
    email: String(payload.email || ""),
    name: String(payload.name || payload.email || ""),
    role: String(payload.role || "user"),
  };
}

/**
 * Issues a server-persisted, revocable session backed by `dashboard_sessions` and `auth_users.session_version`.
 */
export async function issuePersistedSession(user: DashboardUser): Promise<string> {
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);

  const userRow = await runtime.DB.prepare(
    "SELECT COALESCE(session_version, 1) AS session_version FROM auth_users WHERE id = ?",
  )
    .bind(user.id)
    .first<{ session_version: number }>()
    .catch(() => null);

  const sessionVersion = Number(userRow?.session_version || 1);
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  await runtime.DB.prepare(
    `INSERT INTO dashboard_sessions (id, user_id, session_version, expires_at)
     VALUES (?, ?, ?, ?::timestamptz)`,
  )
    .bind(jti, user.id, sessionVersion, expiresAt)
    .run();

  return createSessionToken(user, { jti, sessionVersion });
}

/**
 * Verifies the HMAC session cookie AND revalidates against `dashboard_sessions` + live user status/role in DB.
 */
export async function verifyLiveSession(token: string): Promise<DashboardUser | null> {
  const payload = await verifySessionTokenPayload(token);
  if (!payload || !payload.jti || !payload.sub) return null;

  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);

  const sessionRow = await runtime.DB.prepare(
    `SELECT id, user_id, session_version, expires_at, revoked_at
     FROM dashboard_sessions
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
  )
    .bind(payload.jti, payload.sub)
    .first<{
      id: string;
      user_id: string;
      session_version: number;
      expires_at: string;
      revoked_at: string | null;
    }>()
    .catch(() => null);

  if (!sessionRow || sessionRow.revoked_at) return null;
  if (new Date(sessionRow.expires_at).getTime() <= Date.now()) return null;

  let userRow = await runtime.DB.prepare(
    `SELECT id, email, name, role, banned_until, COALESCE(session_version, 1) AS session_version
     FROM auth_users
     WHERE id = ?
     LIMIT 1`,
  )
    .bind(payload.sub)
    .first<{
      id: string;
      email: string;
      name: string;
      role: string;
      banned_until: string | null;
      session_version: number;
    }>()
    .catch(() => null);

  if (!userRow) {
    userRow = await runtime.DB.prepare(
      `SELECT id::text AS id, email,
              COALESCE(raw_user_meta_data->>'name', email) AS name,
              COALESCE(raw_app_meta_data->>'role', 'user') AS role,
              banned_until,
              1 AS session_version
       FROM auth.users
       WHERE id::text = ?
       LIMIT 1`,
    )
      .bind(payload.sub)
      .first<{
        id: string;
        email: string;
        name: string;
        role: string;
        banned_until: string | null;
        session_version: number;
      }>()
      .catch(() => null);
  }

  if (!userRow) return null;
  if (userRow.banned_until && new Date(userRow.banned_until).getTime() > Date.now()) {
    return null;
  }

  const tokenSv = Number(payload.sv ?? 1);
  if (Number(userRow.session_version) !== tokenSv || Number(sessionRow.session_version) !== tokenSv) {
    return null;
  }

  return {
    id: userRow.id,
    email: userRow.email,
    name: userRow.name || userRow.email,
    role: userRow.role || "user",
  };
}

export async function revokeSessionByToken(token: string | undefined): Promise<void> {
  if (!token) return;
  const payload = await verifySessionTokenPayload(token);
  if (!payload?.jti) return;
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  await runtime.DB.prepare(
    "UPDATE dashboard_sessions SET revoked_at = NOW() WHERE id = ?",
  )
    .bind(payload.jti)
    .run()
    .catch(() => null);
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  await runtime.DB.prepare(
    "UPDATE auth_users SET session_version = COALESCE(session_version, 1) + 1 WHERE id = ?",
  )
    .bind(userId)
    .run()
    .catch(() => null);
  await runtime.DB.prepare(
    "UPDATE dashboard_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL",
  )
    .bind(userId)
    .run()
    .catch(() => null);
  await runtime.DB.prepare("DELETE FROM auth.refresh_tokens WHERE user_id::text = ?")
    .bind(userId)
    .run()
    .catch(() => null);
  await runtime.DB.prepare("DELETE FROM auth.sessions WHERE user_id::text = ?")
    .bind(userId)
    .run()
    .catch(() => null);
}

export async function authenticateUser(
  email: string,
  password: string,
): Promise<{ user: DashboardUser | null; error?: string }> {
  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedEmail || !password) {
    return { user: null, error: "Please enter both email and password." };
  }

  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);

  try {
    let row = await runtime.DB.prepare(`
      SELECT id, email, name, role, banned_until,
             (encrypted_password = crypt(?, encrypted_password)) AS password_matches
      FROM auth_users
      WHERE LOWER(email) = LOWER(?)
      LIMIT 1
    `)
      .bind(password, trimmedEmail)
      .first<{
        id: string;
        email: string;
        name: string;
        role: string;
        banned_until: string | null;
        password_matches: boolean;
      }>()
      .catch(() => null);

    if (!row) {
      row = await runtime.DB.prepare(`
        SELECT id::text AS id, email,
               COALESCE(raw_user_meta_data->>'name', email) AS name,
               COALESCE(raw_app_meta_data->>'role', 'user') AS role,
               banned_until,
               (encrypted_password = crypt(?, encrypted_password)) AS password_matches
        FROM auth.users
        WHERE LOWER(email) = LOWER(?)
        LIMIT 1
      `)
        .bind(password, trimmedEmail)
        .first<{
          id: string;
          email: string;
          name: string;
          role: string;
          banned_until: string | null;
          password_matches: boolean;
        }>()
        .catch(() => null);
    }

    // Check password BEFORE revealing disabled/banned state (prevents account enumeration)
    if (!row || !row.password_matches) {
      return { user: null, error: "The email or password is incorrect." };
    }

    if (row.banned_until && new Date(row.banned_until).getTime() > Date.now()) {
      return {
        user: null,
        error: "This account has been disabled. Please contact your administrator.",
      };
    }

    return {
      user: {
        id: row.id,
        email: row.email,
        name: row.name || row.email,
        role: row.role || "user",
      },
    };
  } catch (err) {
    console.error("Authentication error:", err);
    return { user: null, error: "Authentication failed. Please try again." };
  }
}
