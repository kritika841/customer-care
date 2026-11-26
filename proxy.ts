import { NextResponse, type NextRequest } from "next/server";
import { verifySessionTokenPayload, SESSION_COOKIE_NAME } from "./lib/auth/session";

const PUBLIC_PAGE_PREFIXES = ["/auth/sign-in", "/csat/"];
const PUBLIC_API_ROUTES = new Set([
  "/api/auth/sign-in",
  "/api/auth/sign-out",
  "/api/support/csat",
  "/api/support/meta/webhook",
  "/api/support/gmail/push",
  "/api/cron/support",
]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_API_ROUTES.has(pathname)) return true;
  if (PUBLIC_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return true;
  }
  return false;
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next({ request });
  }

  // Allow explicit dev-only bypass when enabled locally
  if (
    process.env.NODE_ENV === "development" &&
    process.env.ALLOW_DEV_AUTH_BYPASS === "true"
  ) {
    return NextResponse.next({ request });
  }

  // 1. Verify signed local session cookie (presence, signature, and expiry)
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionCookie) {
    const payload = await verifySessionTokenPayload(sessionCookie);
    if (payload && payload.sub) {
      return NextResponse.next({ request });
    }
  }

  // 2. Allow Supabase auth cookie through for server-side verification when Supabase Auth is configured
  const hasSupabaseCookie =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) &&
    request.cookies
      .getAll()
      .some((c) => c.name.includes("-auth-token") || c.name.startsWith("sb-"));
  if (hasSupabaseCookie) {
    return NextResponse.next({ request });
  }

  // 3. Reject unauthenticated API requests and redirect unauthenticated page visits
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401 },
    );
  }

  const signInUrl = new URL("/auth/sign-in", request.url);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
