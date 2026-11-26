import { NextResponse } from "next/server";
import { isSameOrigin } from "../../../../lib/auth/access";
import {
  checkLoginLockout,
  clearLoginFailures,
  clientIpFromRequest,
  recordLoginFailure,
} from "../../../../lib/auth/rate-limit";
import { withRequestDatabase } from "../../../../lib/database";
import { getTrustedAppOrigin } from "../../../../lib/http";
import {
  authenticateUser,
  issuePersistedSession,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "../../../../lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const origin = getTrustedAppOrigin(request);

  if (!isSameOrigin(request)) {
    if (!isJson) {
      return NextResponse.redirect(new URL("/auth/sign-in?error=unavailable", origin), 303);
    }
    return NextResponse.json({ ok: false, error: "Invalid request origin." }, { status: 403 });
  }

  try {
    let email = "";
    let password = "";

    if (isJson) {
      const body = (await request.json().catch(() => null)) as {
        email?: string;
        password?: string;
      } | null;
      email = String(body?.email || "").trim();
      password = String(body?.password || "");
    } else {
      const formData = await request.formData().catch(() => null);
      email = String(formData?.get("email") || "").trim();
      password = String(formData?.get("password") || "");
    }

    if (!email || !password) {
      if (!isJson) {
        return NextResponse.redirect(new URL("/auth/sign-in?error=missing", origin), 303);
      }
      return NextResponse.json(
        { ok: false, error: "Email and password are required." },
        { status: 400 },
      );
    }

    const normalizedEmail = email.toLowerCase();
    const clientIp = clientIpFromRequest(request);
    // Lock strictly per-account at 5 attempts (12 cross-IP), reserving IP-wide blocks for >= 30 failed sprays
    const checkKeys = [
      `acct:${clientIp}:${normalizedEmail}`,
      `acct_email:${normalizedEmail}`,
      `ip:${clientIp}`,
    ];
    const failureRules = [
      { key: `acct:${clientIp}:${normalizedEmail}`, maxAttempts: 5 },
      { key: `acct_email:${normalizedEmail}`, maxAttempts: 12 },
      { key: `ip:${clientIp}`, maxAttempts: 30 },
    ];
    const clearKeys = [
      `acct:${clientIp}:${normalizedEmail}`,
      `acct_email:${normalizedEmail}`,
    ];

    const result = await withRequestDatabase(async () => {
      const lockout = await checkLoginLockout(checkKeys);
      if (lockout.blocked) {
        return {
          locked: true as const,
          retryAfterSeconds: lockout.retryAfterSeconds,
        };
      }

      const auth = await authenticateUser(normalizedEmail, password);
      if (!auth.user || auth.error) {
        await recordLoginFailure(failureRules, 5, 15 * 60_000, 15 * 60_000);
        return {
          locked: false as const,
          user: null,
          error: auth.error || "The email or password is incorrect.",
        };
      }

      await clearLoginFailures(clearKeys);
      const token = await issuePersistedSession(auth.user);
      return {
        locked: false as const,
        user: auth.user,
        token,
      };
    });

    if (result.locked) {
      if (!isJson) {
        return NextResponse.redirect(new URL("/auth/sign-in?error=locked", origin), 303);
      }
      return NextResponse.json(
        {
          ok: false,
          error: `Too many failed sign-in attempts. Please wait ${Math.ceil(
            result.retryAfterSeconds / 60,
          )} minute(s) and try again.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(result.retryAfterSeconds) },
        },
      );
    }

    if (!result.user || !result.token) {
      if (!isJson) {
        return NextResponse.redirect(new URL("/auth/sign-in?error=invalid", origin), 303);
      }
      return NextResponse.json(
        { ok: false, error: result.error || "The email or password is incorrect." },
        { status: 401 },
      );
    }

    const response = isJson
      ? NextResponse.json({ ok: true, user: result.user })
      : NextResponse.redirect(new URL("/", origin), 303);

    response.cookies.set(SESSION_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });

    return response;
  } catch (err) {
    console.error("Sign-in endpoint error:", err);
    if (!isJson) {
      return NextResponse.redirect(new URL("/auth/sign-in?error=unavailable", origin), 303);
    }
    return NextResponse.json(
      { ok: false, error: "Sign-in is temporarily unavailable. Please try again." },
      { status: 500 },
    );
  }
}
