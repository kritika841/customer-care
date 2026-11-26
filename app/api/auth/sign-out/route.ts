import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isSameOrigin } from "../../../../lib/auth/access";
import { withRequestDatabase } from "../../../../lib/database";
import { revokeSessionByToken, SESSION_COOKIE_NAME } from "../../../../lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await withRequestDatabase(() => revokeSessionByToken(token)).catch(() => null);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    expires: new Date(0),
    path: "/",
  });
  return response;
}
