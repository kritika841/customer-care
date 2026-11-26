"use client";

import { useState } from "react";
import { CheckCircle2, Star } from "lucide-react";
import { Button } from "../../../components/ui/button";

export default function CsatForm({
  token,
  ticketNumber,
  subject = "",
  customerName,
  initialScore,
  initialComment,
}: {
  token: string;
  ticketNumber: string | number;
  subject?: string;
  customerName: string;
  initialScore: number | null;
  initialComment: string;
}) {
  const [score, setScore] = useState<number>(initialScore || 0);
  const [hovered, setHovered] = useState<number>(0);
  const [comment, setComment] = useState(initialComment || "");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(Boolean(initialScore));
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!score) {
      setError("Please tap a star rating from 1 to 5.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/support/csat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, score, comment }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Could not submit feedback");
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit feedback");
    } finally {
      setBusy(false);
    }
  }

  const displayScore = hovered || score;
  const labels = ["", "Very poor", "Needs improvement", "Okay", "Good", "Excellent"];

  if (submitted) {
    return (
      <div className="panel p-7 text-center space-y-4">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 size={26} />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-bold text-foreground">Thank you for your feedback!</h1>
          <p className="text-xs text-muted-foreground">
            Your {score}-star rating for Case #{String(ticketNumber).padStart(4, "0")} has been saved.
          </p>
        </div>
        <div className="flex justify-center gap-1 text-amber-500">
          {[1, 2, 3, 4, 5].map((n) => (
            <Star
              key={n}
              size={22}
              className={n <= score ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}
            />
          ))}
        </div>
        {comment && (
          <p className="rounded-xl border border-border bg-muted/30 p-3 text-xs text-muted-foreground italic">
            “{comment}”
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel p-6 sm:p-8 space-y-6">
      <div className="space-y-1.5 text-center">
        <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
          Case #{String(ticketNumber).padStart(4, "0")}
        </p>
        <h1 className="text-xl font-bold tracking-tight text-foreground">
          How was your support experience{customerName ? `, ${customerName}` : ""}?
        </h1>
        {subject && (
          <p className="text-xs text-muted-foreground truncate max-w-md mx-auto">{subject}</p>
        )}
      </div>

      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`Rate ${n} out of 5 stars`}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(0)}
              onClick={() => setScore(n)}
              className="p-1.5 rounded-xl transition hover:scale-110 cursor-pointer"
            >
              <Star
                size={32}
                className={
                  n <= displayScore
                    ? "fill-amber-400 text-amber-400"
                    : "text-muted-foreground/35 hover:text-amber-300"
                }
              />
            </button>
          ))}
        </div>
        <span className="text-xs font-medium text-muted-foreground min-h-[18px]">
          {labels[displayScore] || "Select a star rating"}
        </span>
      </div>

      <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
        <span>Anything else we could improve? (Optional)</span>
        <textarea
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Tell us what went well or how we can do better…"
          className="rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20 resize-y"
        />
      </label>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" className="w-full h-10 text-sm" disabled={busy}>
        {busy ? "Submitting…" : "Submit Feedback"}
      </Button>
    </form>
  );
}
