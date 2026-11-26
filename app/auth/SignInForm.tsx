"use client";

import { FormEvent, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";

export default function SignInForm({
  configured = true,
  initialError = "",
}: {
  configured?: boolean;
  initialError?: string;
}) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("email") || params.has("password") || params.has("error")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");

    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => null);

      if (res.ok && data?.ok) {
        window.location.assign("/");
        return;
      }

      if (data?.error && res.status !== 500) {
        setError(data.error);
        setBusy(false);
        return;
      }

      if (
        process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      ) {
        try {
          const { error: signInError } =
            await createSupabaseBrowserClient().auth.signInWithPassword({
              email,
              password,
            });
          if (!signInError) {
            window.location.assign("/");
            return;
          }
        } catch {
          // ignore fallback error
        }
      }

      setError(data?.error || "The email or password is incorrect.");
      setBusy(false);
    } catch {
      setError("Sign-in is temporarily unavailable. Please contact your administrator.");
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      method="post"
      action="/api/auth/sign-in"
      onSubmit={submit}
    >
      <label className="block text-left">
        <span className="block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">
          Email address
        </span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="name@company.com"
          className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground hover:border-ring/50 focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted"
        />
      </label>

      <label className="block text-left">
        <span className="block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">
          Password
        </span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
          className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground hover:border-ring/50 focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted"
        />
      </label>

      {!configured && (
        <p className="rounded-lg bg-warning/15 p-2.5 text-xs font-medium text-warning" role="status">
          Sign-in is unavailable on this server.
        </p>
      )}

      {error && (
        <p className="rounded-lg bg-destructive/15 p-2.5 text-xs font-medium text-destructive" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !configured}
        className="w-full inline-flex items-center justify-center h-10 px-4 rounded-lg border border-primary bg-primary text-primary-foreground font-semibold text-sm tracking-wide transition shadow-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
