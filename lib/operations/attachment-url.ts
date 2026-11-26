import { isIP } from "node:net";
import { HttpError } from "../http";

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  "fbcdn.net",
  "cdninstagram.com",
  "fbsbx.com",
  "facebook.com",
  "instagram.com",
];

/**
 * Validates remote attachment URLs to prevent SSRF against internal/metadata hosts.
 */
export function validateRemoteAttachmentUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "Invalid attachment URL");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "Only HTTPS attachment URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !host ||
    isIP(host) !== 0 ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new HttpError(403, "Attachment host is not permitted");
  }
  const allowed = ALLOWED_MEDIA_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed) {
    throw new HttpError(403, "Attachment host is outside the approved media CDN allowlist");
  }
  return parsed;
}
