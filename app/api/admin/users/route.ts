import { randomUUID } from "node:crypto";
import { errorResponse, errorResponse as requestErrorResponse } from "../../../../lib/http";
import { isSameOrigin, requireApiAdmin } from "../../../../lib/auth/access";
import { revokeAllUserSessions } from "../../../../lib/auth/session";
import { ensureSchema, getRuntimeEnv, logActivity, withRequestDatabase } from "../../../../lib/database";
import { operationsDb } from "../../../../lib/operations/schema";
import { assignWaitingTickets } from "../../../../lib/operations/support";

export const dynamic = "force-dynamic";

export type ManagedUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  createdAt?: string | Date;
  lastSignInAt?: string | Date | null;
};

const ALLOWED_ROLES = [
  "admin",
  "customer_support",
  "support_manager",
  "support_agent",
  "operations",
  "warehouse",
  "user",
] as const;

function validatePassword(password: string): string | null {
  if (password.length < 10) {
    return "Password must be at least 10 characters long.";
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}

function messageOf(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "message" in error)
    return String(error.message || fallback);
  return fallback;
}

async function hasSupabaseAuthTables(db: ReturnType<typeof getRuntimeEnv>["DB"]): Promise<boolean> {
  const row = await db
    .prepare("SELECT to_regclass('auth.users') AS tbl")
    .first<{ tbl: string | null }>()
    .catch(() => null);
  return Boolean(row?.tbl);
}

async function audit(
  actor: { id: string; email: string; name: string; role: string },
  eventType: string,
  message: string,
  details: Record<string, unknown>,
) {
  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  await logActivity(runtime.DB, "admin", eventType, message, details, "info", {
    id: actor.id,
    name: actor.name || actor.email,
    role: actor.role || "admin",
  });
}

async function handleGET() {
  const access = await requireApiAdmin();
  if (access.response) return access.response;

  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);

  try {
    const hasSup = await hasSupabaseAuthTables(runtime.DB);
    const supabaseRows = hasSup
      ? await runtime.DB.prepare(`
          SELECT
            id::text AS id,
            email,
            COALESCE(raw_user_meta_data->>'name', email) AS name,
            COALESCE(raw_app_meta_data->>'role', 'user') AS role,
            banned_until,
            created_at,
            last_sign_in_at
          FROM auth.users
          ORDER BY created_at DESC
        `).all<{
          id: string;
          email: string;
          name: string;
          role: string;
          banned_until: string | null;
          created_at: string;
          last_sign_in_at: string | null;
        }>()
      : { results: [] };

    const localRows = await runtime.DB.prepare(`
      SELECT id, email, name, role, banned_until, created_at, NULL AS last_sign_in_at
      FROM auth_users
      ORDER BY created_at DESC
    `).all<{
      id: string;
      email: string;
      name: string;
      role: string;
      banned_until: string | null;
      created_at: string;
      last_sign_in_at: string | null;
    }>();

    const userMap = new Map<string, ManagedUser>();

    for (const u of localRows.results) {
      const email = (u.email || "").trim().toLowerCase();
      if (!email) continue;
      userMap.set(email, {
        id: u.id,
        name: u.name || u.email || "",
        email: u.email || "",
        role: u.role || "user",
        banned: Boolean(u.banned_until && new Date(u.banned_until).getTime() > Date.now()),
        banReason: "",
        createdAt: String(u.created_at || ""),
        lastSignInAt: null,
      });
    }

    for (const u of supabaseRows.results) {
      const email = (u.email || "").trim().toLowerCase();
      if (!email) continue;
      userMap.set(email, {
        id: u.id,
        name: u.name || u.email || "",
        email: u.email || "",
        role: u.role || "user",
        banned: Boolean(u.banned_until && new Date(u.banned_until).getTime() > Date.now()),
        banReason: "",
        createdAt: String(u.created_at || ""),
        lastSignInAt: u.last_sign_in_at ? String(u.last_sign_in_at) : null,
      });
    }

    const users = Array.from(userMap.values()).sort((a, b) => {
      const timeA = new Date(a.createdAt || 0).getTime();
      const timeB = new Date(b.createdAt || 0).getTime();
      return timeB - timeA;
    });

    return Response.json({ users, total: users.length, currentUserId: access.user.id });
  } catch (error) {
    return Response.json({ error: messageOf(error, "Could not load users") }, { status: 500 });
  }
}

async function handlePOST(request: Request) {
  const access = await requireApiAdmin();
  if (access.response) return access.response;
  if (!isSameOrigin(request))
    return Response.json({ error: "Invalid request origin" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid request" }, { status: 400 });
  const action = String(body.action || "");
  const userId = String(body.userId || "").trim();

  const runtime = getRuntimeEnv();
  await ensureSchema(runtime.DB);
  await operationsDb();
  const hasSup = await hasSupabaseAuthTables(runtime.DB);

  if (action === "create") {
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    const rawRole = String(body.role || "");
    if (!(ALLOWED_ROLES as readonly string[]).includes(rawRole)) {
      return Response.json({ error: "Invalid role specified" }, { status: 400 });
    }
    const role = rawRole;
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
      return Response.json(
        { error: "A valid name and email address are required" },
        { status: 400 },
      );
    }
    const pwErr = validatePassword(password);
    if (pwErr) {
      return Response.json({ error: pwErr }, { status: 400 });
    }

    if (hasSup) {
      const existingAuth = await runtime.DB.prepare(
        "SELECT id FROM auth.users WHERE LOWER(email) = LOWER(?)",
      )
        .bind(email)
        .first();
      if (existingAuth) {
        return Response.json(
          { error: "A user with this email address already exists." },
          { status: 409 },
        );
      }
    }

    const existingLocal = await runtime.DB.prepare(
      "SELECT id FROM auth_users WHERE LOWER(email) = LOWER(?)",
    )
      .bind(email)
      .first();
    if (existingLocal) {
      return Response.json(
        { error: "A user with this email address already exists." },
        { status: 409 },
      );
    }

    let newId: string = randomUUID();
    if (hasSup) {
      const insertAuth = await runtime.DB.prepare(`
        INSERT INTO auth.users (
          instance_id, id, aud, role, email, encrypted_password,
          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
          created_at, updated_at
        ) VALUES (
          '00000000-0000-0000-0000-000000000000',
          gen_random_uuid(),
          'authenticated',
          'authenticated',
          ?,
          crypt(?, gen_salt('bf', 10)),
          NOW(),
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', ?),
          jsonb_build_object('name', ?, 'email_verified', true),
          NOW(),
          NOW()
        )
        RETURNING id::text
      `)
        .bind(email, password, role, name)
        .first<{ id: string }>();
      if (insertAuth?.id) newId = insertAuth.id;
    }

    await runtime.DB.prepare(`
      INSERT INTO auth_users (id, email, encrypted_password, name, role, session_version, created_at)
      VALUES (?, ?, crypt(?, gen_salt('bf', 10)), ?, ?, 1, NOW())
    `)
      .bind(newId, email, password, name, role)
      .run();

    const supportRole = role === "customer_support" ? "support_agent" : role;
    if (["admin", "support_manager", "support_agent"].includes(supportRole)) {
      await runtime.DB.prepare(`
        INSERT INTO support_agents (user_id, email, name, role, available)
        VALUES (?, ?, ?, ?, true)
        ON CONFLICT (user_id) DO UPDATE
        SET email = EXCLUDED.email, name = EXCLUDED.name, role = EXCLUDED.role, available = true
      `)
        .bind(newId, email, name || email, supportRole)
        .run();
    }

    await audit(access.user, "auth.user_created", `Added dashboard user ${email}`, {
      targetUserId: newId,
      targetEmail: email,
      role,
    });
    return Response.json(
      {
        ok: true,
        message: "User added. They can now sign in with the password you assigned.",
      },
      { status: 201 },
    );
  }

  if (!userId) return Response.json({ error: "User is required" }, { status: 400 });

  if (action === "update_info") {
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const rawRole = body.role !== undefined ? String(body.role) : "";
    if (rawRole && !(ALLOWED_ROLES as readonly string[]).includes(rawRole)) {
      return Response.json({ error: "Invalid role specified" }, { status: 400 });
    }
    const role = rawRole;

    if (!name || (email && !/^\S+@\S+\.\S+$/.test(email))) {
      return Response.json(
        { error: "A valid name and email address are required" },
        { status: 400 },
      );
    }

    if (userId === access.user.id && role && role !== "admin") {
      return Response.json(
        { error: "You cannot remove your own administrator access" },
        { status: 400 },
      );
    }

    if (hasSup) {
      await runtime.DB.prepare(`
        UPDATE auth.users
        SET email = COALESCE(NULLIF(?, ''), email),
            raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', ?),
            raw_app_meta_data = CASE WHEN ? != '' THEN COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', ?) ELSE raw_app_meta_data END,
            updated_at = NOW()
        WHERE id::text = ?
      `)
        .bind(email || "", name, role || "", role || "", userId)
        .run();
    }

    await runtime.DB.prepare(`
      UPDATE auth_users
      SET email = COALESCE(NULLIF(?, ''), email),
          name = COALESCE(NULLIF(?, ''), name),
          role = CASE WHEN ? != '' THEN ? ELSE role END
      WHERE id = ?
    `)
      .bind(email || "", name, role || "", role || "", userId)
      .run();

    const supportRole = role === "customer_support" ? "support_agent" : role;
    if (supportRole && ["admin", "support_manager", "support_agent"].includes(supportRole)) {
      await runtime.DB.prepare(`
        INSERT INTO support_agents (user_id, email, name, role, available)
        VALUES (?, ?, ?, ?, true)
        ON CONFLICT (user_id) DO UPDATE
        SET role = EXCLUDED.role,
            name = CASE WHEN ? != '' THEN ? ELSE support_agents.name END,
            email = CASE WHEN ? != '' THEN ? ELSE support_agents.email END,
            available = true
      `)
        .bind(
          userId,
          email || "",
          name || "",
          supportRole,
          name || "",
          name || "",
          email || "",
          email || "",
        )
        .run();
    } else if (role) {
      await runtime.DB.prepare("UPDATE support_agents SET available = false WHERE user_id = ?")
        .bind(userId)
        .run();
    }

    if (role) {
      await revokeAllUserSessions(userId);
    }

    await audit(access.user, "auth.user_updated", "Updated dashboard user profile", {
      targetUserId: userId,
      email: email || undefined,
      name,
      role: role || undefined,
    });
    return Response.json({ ok: true, message: "User details updated." });
  }

  if (action === "set_role") {
    const rawRole = String(body.role || "");
    if (!(ALLOWED_ROLES as readonly string[]).includes(rawRole)) {
      return Response.json({ error: "Invalid role specified" }, { status: 400 });
    }
    const role = rawRole;
    if (userId === access.user.id && role !== "admin") {
      return Response.json(
        { error: "You cannot remove your own administrator access" },
        { status: 400 },
      );
    }
    if (hasSup) {
      await runtime.DB.prepare(`
        UPDATE auth.users
        SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', ?),
            updated_at = NOW()
        WHERE id::text = ?
      `)
        .bind(role, userId)
        .run();
    }

    await runtime.DB.prepare("UPDATE auth_users SET role = ? WHERE id = ?")
      .bind(role, userId)
      .run();

    const supportRole = role === "customer_support" ? "support_agent" : role;
    if (["admin", "support_manager", "support_agent"].includes(supportRole)) {
      const u = await runtime.DB.prepare("SELECT email, name FROM auth_users WHERE id = ?")
        .bind(userId)
        .first<{ email: string; name: string }>();
      await runtime.DB.prepare(`
        INSERT INTO support_agents (user_id, email, name, role, available)
        VALUES (?, ?, ?, ?, true)
        ON CONFLICT (user_id) DO UPDATE
        SET role = EXCLUDED.role, available = true
      `)
        .bind(userId, u?.email || "", u?.name || "", supportRole)
        .run();
    } else {
      await runtime.DB.prepare("UPDATE support_agents SET available = false WHERE user_id = ?")
        .bind(userId)
        .run();
    }

    await revokeAllUserSessions(userId);

    await audit(access.user, "auth.role_changed", "Changed a dashboard user role", {
      targetUserId: userId,
      role,
    });
    return Response.json({ ok: true, message: "Role updated and active sessions refreshed." });
  }

  if (action === "force_logout") {
    if (hasSup) {
      await runtime.DB.prepare(`
        UPDATE auth.users
        SET reauthentication_sent_at = NOW(),
            updated_at = NOW()
        WHERE id::text = ?
      `)
        .bind(userId)
        .run()
        .catch(() => null);
    }
    await revokeAllUserSessions(userId);

    await audit(access.user, "auth.force_logout", "Terminated all active sessions for user", {
      targetUserId: userId,
    });
    return Response.json({
      ok: true,
      message: "User forced out. All active sessions have been revoked.",
    });
  }

  if (action === "disable") {
    if (userId === access.user.id)
      return Response.json({ error: "You cannot disable your own account" }, { status: 400 });

    if (hasSup) {
      await runtime.DB.prepare(`
        UPDATE auth.users
        SET banned_until = NOW() + INTERVAL '100 years',
            reauthentication_sent_at = NOW(),
            updated_at = NOW()
        WHERE id::text = ?
      `)
        .bind(userId)
        .run();
    }

    await runtime.DB.transaction(async (sql) => {
      await sql`
        UPDATE auth_users
        SET banned_until = NOW() + INTERVAL '100 years',
            session_version = COALESCE(session_version, 1) + 1
        WHERE id = ${userId}
      `;
      await sql`
        UPDATE dashboard_sessions
        SET revoked_at = NOW()
        WHERE user_id = ${userId} AND revoked_at IS NULL
      `;
      await sql`UPDATE support_agents SET available = false WHERE user_id = ${userId}`;
      await sql`
        UPDATE support_tickets
        SET assignee_id = NULL, version = version + 1, updated_at = NOW()
        WHERE assignee_id = ${userId} AND status <> 'resolved'
      `;
      await assignWaitingTickets(sql);
    });

    await revokeAllUserSessions(userId);

    await audit(access.user, "auth.user_disabled", "Disabled a dashboard user", {
      targetUserId: userId,
    });
    return Response.json({
      ok: true,
      message: "User disabled, active sessions revoked, and open tickets reassigned.",
    });
  }

  if (action === "enable") {
    if (hasSup) {
      await runtime.DB.prepare(`
        UPDATE auth.users
        SET banned_until = NULL,
            updated_at = NOW()
        WHERE id::text = ?
      `)
        .bind(userId)
        .run();
    }

    await runtime.DB.prepare("UPDATE auth_users SET banned_until = NULL WHERE id = ?")
      .bind(userId)
      .run();
    await audit(access.user, "auth.user_enabled", "Enabled a dashboard user", {
      targetUserId: userId,
    });
    return Response.json({ ok: true, message: "User enabled." });
  }

  if (action === "delete") {
    if (!userId) {
      return Response.json({ error: "Select a user to delete" }, { status: 400 });
    }
    if (userId === access.user.id) {
      return Response.json({ error: "You cannot delete your own account" }, { status: 400 });
    }

    const supTarget = hasSup
      ? await runtime.DB.prepare(
          "SELECT id::text AS id, email, COALESCE(raw_app_meta_data->>'role', 'user') AS role FROM auth.users WHERE id::text = ?",
        )
          .bind(userId)
          .first<{ id: string; email: string; role: string }>()
      : null;
    const localTarget = await runtime.DB.prepare(
      "SELECT id, email, role FROM auth_users WHERE id = ?",
    )
      .bind(userId)
      .first<{ id: string; email: string; role: string }>();

    const targetEmail = (supTarget?.email || localTarget?.email || "").trim().toLowerCase();
    const targetRole = supTarget?.role || localTarget?.role || "";
    if (!targetEmail && !supTarget && !localTarget) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    if (targetRole === "admin") {
      const supAdmins = hasSup
        ? await runtime.DB.prepare(
            "SELECT COUNT(*)::int AS count FROM auth.users WHERE COALESCE(raw_app_meta_data->>'role', 'user') = 'admin' AND (banned_until IS NULL OR banned_until < NOW()) AND id::text <> ?",
          )
            .bind(userId)
            .first<{ count: number }>()
        : { count: 0 };
      const localAdmins = await runtime.DB.prepare(
        "SELECT COUNT(*)::int AS count FROM auth_users WHERE role = 'admin' AND (banned_until IS NULL OR banned_until < NOW()) AND id <> ? AND LOWER(email) <> LOWER(?)",
      )
        .bind(userId, targetEmail)
        .first<{ count: number }>();
      if ((supAdmins?.count ?? 0) + (localAdmins?.count ?? 0) < 1) {
        return Response.json(
          { error: "At least one active administrator account must remain" },
          { status: 400 },
        );
      }
    }

    const candidateIds = Array.from(
      new Set([userId, supTarget?.id, localTarget?.id].filter((v): v is string => Boolean(v))),
    );

    for (const idToClean of candidateIds) {
      await revokeAllUserSessions(idToClean);
      await runtime.DB.prepare(
        "UPDATE support_tickets SET assignee_id = NULL, updated_at = NOW(), version = version + 1 WHERE assignee_id = ?",
      )
        .bind(idToClean)
        .run();
      await runtime.DB.prepare("DELETE FROM support_agents WHERE user_id = ?")
        .bind(idToClean)
        .run();
    }

    if (targetEmail) {
      await runtime.DB.prepare("DELETE FROM support_agents WHERE LOWER(email) = LOWER(?)")
        .bind(targetEmail)
        .run();
      if (hasSup) {
        await runtime.DB.prepare("DELETE FROM auth.users WHERE id::text = ? OR LOWER(email) = LOWER(?)")
          .bind(userId, targetEmail)
          .run();
      }
      await runtime.DB.prepare("DELETE FROM auth_users WHERE id = ? OR LOWER(email) = LOWER(?)")
        .bind(userId, targetEmail)
        .run();
    } else {
      if (hasSup) {
        await runtime.DB.prepare("DELETE FROM auth.users WHERE id::text = ?")
          .bind(userId)
          .run();
      }
      await runtime.DB.prepare("DELETE FROM auth_users WHERE id = ?")
        .bind(userId)
        .run();
    }

    await audit(access.user, "auth.user_deleted", "Deleted a dashboard user", {
      targetUserId: userId,
      targetEmail,
    });
    return Response.json({
      ok: true,
      message: `${targetEmail || "User"} removed, sessions revoked, and any assigned tickets were unassigned.`,
    });
  }

  if (action === "set_password") {
    const newPassword = String(body.password || "");
    const pwErr = validatePassword(newPassword);
    if (pwErr) {
      return Response.json({ error: pwErr }, { status: 400 });
    }

    if (hasSup) {
      await runtime.DB.prepare(`
        UPDATE auth.users
        SET encrypted_password = crypt(?, gen_salt('bf', 10)),
            reauthentication_sent_at = NOW(),
            updated_at = NOW()
        WHERE id::text = ?
      `)
        .bind(newPassword, userId)
        .run();
    }

    await runtime.DB.prepare(
      "UPDATE auth_users SET encrypted_password = crypt(?, gen_salt('bf', 10)) WHERE id = ?",
    )
      .bind(newPassword, userId)
      .run();

    await revokeAllUserSessions(userId);

    await audit(access.user, "auth.password_changed", "Assigned a new dashboard password", {
      targetUserId: userId,
    });
    return Response.json({ ok: true, message: "Password changed and existing sessions revoked." });
  }

  return Response.json({ error: "Unsupported action" }, { status: 400 });
}

export async function GET(...args: Parameters<typeof handleGET>) {
  try {
    return await withRequestDatabase(() => handleGET(...args), 20000);
  } catch (error) {
    return requestErrorResponse(error) || errorResponse(error);
  }
}

export async function POST(...args: Parameters<typeof handlePOST>) {
  try {
    return await withRequestDatabase(() => handlePOST(...args), 20000);
  } catch (error) {
    return requestErrorResponse(error) || errorResponse(error);
  }
}
