export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Resolves a trusted application origin without blindly trusting spoofable Host / X-Forwarded-Host headers.
 * Prefers configured NEXT_PUBLIC_APP_URL / APP_URL, and validates fallback hosts.
 */
export function getTrustedAppOrigin(requestOrHeaders?: Request | Headers | null): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "").trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through if misconfigured
    }
  }

  let rawHost = "";
  let rawProto = "";
  if (requestOrHeaders) {
    const hdrs = requestOrHeaders instanceof Request ? requestOrHeaders.headers : requestOrHeaders;
    const trustProxy = process.env.TRUST_PROXY_HOST === "true";
    rawHost = (trustProxy ? hdrs.get("x-forwarded-host") : null) || hdrs.get("host") || "";
    rawProto = (trustProxy ? hdrs.get("x-forwarded-proto") : null) || "";
  }

  const cleanHost = rawHost.split(",")[0].trim().toLowerCase();
  const allowedHosts = new Set(
    (process.env.ALLOWED_APP_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const isLocalHost =
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(cleanHost);
  const isSafeHostname =
    /^[a-z0-9.-]+(?::\d{1,5})?$/.test(cleanHost) &&
    (allowedHosts.size > 0 ? allowedHosts.has(cleanHost) : process.env.NODE_ENV !== "production" || isLocalHost);

  if (cleanHost && isSafeHostname) {
    const proto =
      rawProto === "http" || rawProto === "https"
        ? rawProto
        : isLocalHost
          ? "http"
          : "https";
    return `${proto}://${cleanHost}`;
  }

  return process.env.NODE_ENV === "production"
    ? "https://localhost"
    : "http://127.0.0.1:5010";
}
export function requestErrorMessage(error: unknown, fallback = "Could not load data") {
  if (error instanceof Error && (error.name === "TimeoutError" || /signal timed out/i.test(error.message))) return "The connection took too long. Please retry.";
  return error instanceof Error ? error.message : fallback;
}
export function isTransientRequestError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "TimeoutError" ||
    /signal timed out|temporarily busy|did not return a usable response|failed to fetch|networkerror/i.test(
      error.message,
    )
  );
}
export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpError)
    return Response.json({ error: message }, { status: error.status });
  if (error instanceof SyntaxError)
    return Response.json(
      { error: "Invalid or malformed JSON request body.", code: "INVALID_JSON" },
      { status: 400 },
    );
  const code = (error as {code?:string})?.code;
  if (['CONNECTION_CLOSED','CONNECTION_ENDED','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','CONNECT_TIMEOUT'].includes(code || '')) return Response.json({error:'The data service is temporarily unavailable. Please retry.',code:'SERVICE_UNAVAILABLE'},{status:503});
  if (code === '55P03') return Response.json({error:'The data service is busy updating records. Please retry shortly.',code:'DATABASE_BUSY'},{status:503});
  if(code === 'CONNECTION_DESTROYED') return Response.json({error:'The database connection was reset. Please retry this action.',code:'DATABASE_CONNECTION_RESET'},{status:503});
  if(code === '23505') return Response.json({error:'This record already exists. Refresh to see the saved record.',code:'DUPLICATE_RECORD'},{status:409});
  if(code === '23503') return Response.json({error:'A linked record is missing or still in use. Refresh and check your selection.',code:'INVALID_REFERENCE'},{status:409});
  if(code === '57014' || /timeout|timed out/i.test(message)) return Response.json({error:'The data service took too long to respond. Refresh to check the result before retrying.',code:'SERVICE_TIMEOUT'},{status:503});
  if (/quota|data transfer|compute.*limit/i.test(message))
    return Response.json(
      {
        error:
          "The database has reached its service quota. An account administrator must restore database capacity before live data can load.",
        code: "DATABASE_QUOTA",
      },
      { status: 503 },
    );
  if (/not configured|required to create a Supabase/i.test(message))
    return Response.json(
      {
        error:
          "Dashboard connection settings are incomplete. Configure the database and authentication settings.",
        code: "CONFIGURATION_REQUIRED",
      },
      { status: 503 },
    );
  console.error("Dashboard request failed", {
    name: error instanceof Error ? error.name : "Error",
    code: (error as { code?: string })?.code,
  });
  return Response.json(
    {
      error:
        "The server could not complete this request. Please retry. If it continues, check the server connection.",
      code: "SERVER_ERROR",
    },
    { status: 500 },
  );
}
export async function readJson<T = Record<string, unknown>>(
  response: Response,
): Promise<T> {
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      response.status === 401
        ? "Your session expired. Please sign in again."
        : response.status === 504
          ? "The service is temporarily busy. Please retry in a moment."
          : "The server did not return a usable response. Please retry.",
    );
  }
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`,
    );
  return data as T;
}
export const required = (v: unknown, label: string) => {
  const s = String(v ?? "").trim();
  if (!s || s.length > 10000) throw new HttpError(400, `${label} is required`);
  return s;
};
export function quantity(v: unknown, label = "Quantity", zero = false) {
  const n = Number(v);
  if (
    v === "" ||
    v === null ||
    v === undefined ||
    !Number.isFinite(n) ||
    (zero ? n < 0 : n <= 0)
  )
    throw new HttpError(
      400,
      `${label} must be ${zero ? "non-negative" : "positive"}`,
    );
  return n;
}
