import { redirect } from "next/navigation";
import { getTrustedAppOrigin } from "../http";
import { createSupabaseServerClient } from "../supabase/server";
import {
  SESSION_COOKIE_NAME,
  verifyLiveSession,
  type DashboardUser,
} from "./session";

export type { DashboardUser };

function roleOf(user: { role?: unknown }) {
  return typeof user.role === "string" && user.role ? user.role : "user";
}

export function rolesOf(user: { role?: unknown }): string[] {
  return roleOf(user)
    .split(",")
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
}

export function hasRole(user: { role?: unknown }, target: string): boolean {
  return rolesOf(user).includes(target.trim().toLowerCase());
}

export function isAdmin(user: { role?: unknown }): boolean {
  return hasRole(user, "admin");
}

export function isSupportManager(user: { role?: unknown }): boolean {
  return isAdmin(user) || hasRole(user, "support_manager");
}

export function isSupportRole(user: { role?: unknown }): boolean {
  return (
    isSupportManager(user) ||
    hasRole(user, "support_agent") ||
    hasRole(user, "customer_support")
  );
}

function dashboardUser(user: {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}): DashboardUser {
  return {
    id: user.id,
    email: user.email || "",
    name:
      typeof user.user_metadata?.name === "string" && user.user_metadata.name
        ? user.user_metadata.name
        : user.email || "User",
    role: roleOf({ role: user.app_metadata?.role }),
  };
}

export async function currentDashboardUser(): Promise<DashboardUser | null> {
  try {
    const { cookies } = await import("next/headers");
    const cookieStore = await cookies();

    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (sessionCookie) {
      const localUser = await verifyLiveSession(sessionCookie);
      if (localUser) return localUser;
    }

    const hasAuthCookie = cookieStore
      .getAll()
      .some((c) => c.name.includes("-auth-token") || c.name.startsWith("sb-"));
    if (
      hasAuthCookie &&
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ) {
      const supabase = await createSupabaseServerClient();
      const { data } = await supabase.auth.getUser();
      if (data.user) return dashboardUser(data.user);
    }
  } catch {
    /* ignore unauthenticated session */
  }
  if (
    process.env.NODE_ENV === "development" &&
    process.env.ALLOW_DEV_AUTH_BYPASS === "true"
  ) {
    return {
      id: "usr_admin_1",
      email: "admin@satmi.in",
      name: "Kritika Singh",
      role: "admin",
    };
  }
  return null;
}

export async function requirePageUser(): Promise<DashboardUser> {
  const user = await currentDashboardUser();
  if (!user) redirect("/auth/sign-in");
  return user;
}

export async function requirePageAdmin(): Promise<DashboardUser> {
  const user = await requirePageUser();
  if (!isAdmin(user)) redirect("/");
  return user;
}

export async function requireApiUser() {
  const user = await currentDashboardUser();
  if (!user) {
    return {
      user: null,
      response: Response.json({ error: "Authentication required" }, { status: 401 }),
    } as const;
  }
  return { user, response: null } as const;
}

export async function requireApiAdmin() {
  const result = await requireApiUser();
  if (result.response) return result;
  if (!isAdmin(result.user)) {
    return {
      user: null,
      response: Response.json({ error: "Administrator access required" }, { status: 403 }),
    } as const;
  }
  return result;
}

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const trustedOrigin = getTrustedAppOrigin(request);
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const isProd = process.env.NODE_ENV === "production";

  if (origin) {
    if (origin === trustedOrigin) return true;
    if (host) {
      const cleanHost = host.split(",")[0].trim();
      const protocol =
        request.headers.get("x-forwarded-proto") || (isProd ? "https" : "http");
      if (origin === `${protocol}://${cleanHost}`) return true;
      if (!isProd && (origin === `http://${cleanHost}` || origin === `https://${cleanHost}`)) {
        return true;
      }
    }
    return false;
  }

  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (refOrigin === trustedOrigin) return true;
      if (host) {
        const cleanHost = host.split(",")[0].trim();
        if (refOrigin === `https://${cleanHost}` || (!isProd && refOrigin === `http://${cleanHost}`)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  return !isProd;
}
