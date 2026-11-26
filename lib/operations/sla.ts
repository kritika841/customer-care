export const SLA_MINUTES_BY_PRIORITY: Record<string, number> = {
  urgent: 60,
  high: 240,
  normal: 720,
  low: 1440,
};

export function slaMinutesForPriority(priority?: string | null): number {
  const key = String(priority || "normal").toLowerCase();
  return SLA_MINUTES_BY_PRIORITY[key] ?? SLA_MINUTES_BY_PRIORITY.normal;
}

export function computeSlaDueAt(
  anchor: string | Date,
  priority?: string | null,
): string {
  const baseMs = new Date(anchor).getTime();
  const safeBaseMs = Number.isFinite(baseMs) ? baseMs : Date.now();
  return new Date(
    safeBaseMs + slaMinutesForPriority(priority) * 60_000,
  ).toISOString();
}

export function expandOrderCodeVariants(rawCode: string): string[] {
  const clean = String(rawCode || "")
    .replace(/^#/, "")
    .replace(/[\s:-]+/g, "")
    .trim()
    .toUpperCase();
  if (!clean) return [];
  const variants = new Set<string>([clean]);
  // Common customer typos for Satmi's `SI0...` Shopify/Shiprocket prefix (SIO, S10, S1O, SL0)
  const satmiMatch = clean.match(/^(?:SI0|SIO|S10|S1O|SLO|SL0)(\d{5,})$/);
  if (satmiMatch?.[1]) {
    variants.add(`SI0${satmiMatch[1]}`);
    variants.add(`S10${satmiMatch[1]}`);
    variants.add(`SIO${satmiMatch[1]}`);
  }
  return [...variants];
}

export function extractOrderOrPhoneHints(text: string): {
  orderCodes: string[];
  phones: string[];
} {
  const clean = String(text || "");
  const orderCodes = new Set<string>();
  const phones = new Set<string>();

  // Match contiguous #S10729974, S10729974, SI0715783, SIO729617, #12345, etc.
  const orderMatches = clean.matchAll(/(?:#|\b)([A-Z0-9]{1,4}\d{5,}|#\d{4,})\b/gi);
  for (const m of orderMatches) {
    const token = (m[1] || m[0]).replace(/^#/, "").trim().toUpperCase();
    // Skip pure 10-digit Indian mobile numbers accidentally caught without `#`
    if (/^[6-9]\d{9}$/.test(token)) continue;
    if (token.length >= 4 && token.length <= 24) orderCodes.add(token);
  }

  // Also match space-separated Satmi order codes like "SIO 727479", "SI0 729974", "S10 729974"
  const spacedMatches = clean.matchAll(/(?:#|\b)(S[I1L][0O])\s*[-:]?\s*(\d{5,})\b/gi);
  for (const m of spacedMatches) {
    const token = `${m[1]}${m[2]}`.toUpperCase();
    if (token.length >= 4 && token.length <= 24) orderCodes.add(token);
  }

  // Match 10-digit Indian phone numbers (optionally prefixed with +91 / 91 / 0, allowing inner space/dash)
  const phoneMatches = clean.matchAll(/(?:\+?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5})\b/g);
  for (const m of phoneMatches) {
    const digits = String(m[1] || "").replace(/[\s-]+/g, "");
    if (/^[6-9]\d{9}$/.test(digits)) phones.add(digits);
  }

  return {
    orderCodes: [...orderCodes].slice(0, 12),
    phones: [...phones].slice(0, 4),
  };
}

export type Customer360Summary = {
  totalOrders: number;
  totalSpend: number;
  pastTicketsCount: number;
  codOrders: number;
  prepaidOrders: number;
  codRatioPercent: number;
  rtoOrders: number;
  rtoRatePercent: number;
  deliveredOrders: number;
};

export function computeCustomer360(
  orders: Array<Record<string, unknown>>,
  pastTicketsCount: number,
): Customer360Summary {
  let totalSpend = 0;
  let codOrders = 0;
  let prepaidOrders = 0;
  let rtoOrders = 0;
  let deliveredOrders = 0;

  for (const o of orders) {
    const status = String(o.status || "").toUpperCase();
    const payment = String(o.payment_method || "").toUpperCase();
    const amount = Number(o.total || 0);

    if (Number.isFinite(amount) && !status.includes("CANCEL")) {
      totalSpend += amount;
    }

    if (payment.includes("COD") || payment.includes("CASH")) {
      codOrders++;
    } else if (payment) {
      prepaidOrders++;
    }

    if (status.includes("RTO")) {
      rtoOrders++;
    } else if (status.includes("DELIVERED")) {
      deliveredOrders++;
    }
  }

  const totalOrders = orders.length;
  const paymentTotal = codOrders + prepaidOrders;
  const codRatioPercent = paymentTotal
    ? Math.round((codOrders / paymentTotal) * 100)
    : 0;
  const rtoRatePercent = totalOrders
    ? Math.round((rtoOrders / totalOrders) * 100)
    : 0;

  return {
    totalOrders,
    totalSpend: Math.round(totalSpend),
    pastTicketsCount,
    codOrders,
    prepaidOrders,
    codRatioPercent,
    rtoOrders,
    rtoRatePercent,
    deliveredOrders,
  };
}

export function formatDurationCompact(ms: number): string {
  const absMins = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (absMins < 60) return `${absMins}m`;
  const hrs = Math.floor(absMins / 60);
  const mins = absMins % 60;
  if (hrs < 24) return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs ? `${days}d ${remHrs}h` : `${days}d`;
}

export function evaluateSlaState(
  ticket: {
    status?: string | null;
    priority?: string | null;
    created_at?: string | null;
    first_response_at?: string | null;
    sla_due_at?: string | null;
    last_direction?: string | null;
  },
  nowMs = Date.now(),
): {
  state: "resolved" | "breached" | "due_soon" | "on_track" | "responded";
  label: string;
} {
  if (ticket.status === "resolved") {
    return { state: "resolved", label: "Resolved" };
  }

  const dueMs = ticket.sla_due_at
    ? new Date(ticket.sla_due_at).getTime()
    : new Date(
        computeSlaDueAt(
          ticket.created_at || new Date(nowMs).toISOString(),
          ticket.priority,
        ),
      ).getTime();

  const awaitingFirstResponse = !ticket.first_response_at;
  const needsReply = ticket.last_direction === "inbound";

  if (!awaitingFirstResponse && !needsReply) {
    return { state: "responded", label: "Replied" };
  }

  const diffMs = dueMs - nowMs;
  if (diffMs < 0) {
    return {
      state: "breached",
      label: `SLA +${formatDurationCompact(diffMs)}`,
    };
  }
  const slaWindowMs = slaMinutesForPriority(ticket.priority) * 60_000;
  if (diffMs <= Math.min(60 * 60_000, slaWindowMs * 0.25)) {
    return {
      state: "due_soon",
      label: `Due ${formatDurationCompact(diffMs)}`,
    };
  }
  return {
    state: "on_track",
    label: `SLA ${formatDurationCompact(diffMs)}`,
  };
}
