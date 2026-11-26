import { withRequestDatabase } from "../../../../lib/database";
import { errorResponse, errorResponse as requestErrorResponse, HttpError } from "../../../../lib/http";
import { access } from "../../../../lib/operations/access";
import { validateRemoteAttachmentUrl } from "../../../../lib/operations/attachment-url";
import { ticketAccess } from "../../../../lib/operations/support";
import { operationsDb } from "../../../../lib/operations/schema";
import { gmailAttachment } from "../../../../lib/operations/gmail";

const MAX_REMOTE_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15 MB

async function readResponseWithSizeCap(res: Response, maxBytes: number): Promise<Uint8Array> {
  const lenHeader = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(lenHeader) && lenHeader > maxBytes) {
    throw new HttpError(413, "Remote attachment exceeds the 15 MB limit");
  }
  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new HttpError(413, "Remote attachment exceeds the 15 MB limit");
    }
    return new Uint8Array(ab);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new HttpError(413, "Remote attachment exceeds the 15 MB limit");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function inferMimeType(name: string, explicit?: string): string {
  if (explicit && explicit !== "application/octet-stream") return explicit;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    txt: "text/plain; charset=utf-8",
    csv: "text/csv; charset=utf-8",
  };
  return map[ext] || explicit || "application/octet-stream";
}

function isSafeInlineType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    (lower.startsWith("image/") && !lower.includes("svg")) ||
    lower === "application/pdf" ||
    lower.startsWith("video/") ||
    lower.startsWith("audio/") ||
    lower.startsWith("text/plain")
  );
}

async function GETHandler(r: Request) {
  try {
    const u = await access(r, "support"),
      url = new URL(r.url),
      inlineRequested = url.searchParams.get("inline") === "1",
      db = await operationsDb();
    const m = await db.transaction(async (sql) => {
      const [row] =
        await sql`SELECT id, ticket_id, gmail_message_id, attachments FROM support_messages WHERE id=${url.searchParams.get("message") || ""}`;
      if (!row) throw new HttpError(404, "Message not found");
      await ticketAccess(sql, row.ticket_id, u, false);
      return row;
    });
    const attachment = (Array.isArray(m.attachments) ? m.attachments : []).find(
      (a: { attachmentId: string }) =>
        a.attachmentId === url.searchParams.get("attachment"),
    ) as
      | {
          attachmentId: string;
          name: string;
          mimeType?: string;
          size?: number;
          dataBase64?: string;
          url?: string;
        }
      | undefined;
    if (!attachment) throw new HttpError(404, "Attachment not found");

    const fileName = attachment.name || "attachment";
    const contentType = inferMimeType(fileName, attachment.mimeType);
    const disposition =
      inlineRequested && isSafeInlineType(contentType) ? "inline" : "attachment";

    if (attachment.dataBase64) {
      const buf = Buffer.from(attachment.dataBase64, "base64");
      return new Response(buf, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (attachment.url) {
      const safeUrl = validateRemoteAttachmentUrl(attachment.url);
      const remote = await fetch(safeUrl.toString(), {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!remote.ok) {
        throw new HttpError(502, "Could not fetch remote media attachment");
      }
      const remoteType = inferMimeType(
        fileName,
        remote.headers.get("content-type") || attachment.mimeType,
      );
      const remoteDisposition =
        inlineRequested && isSafeInlineType(remoteType) ? "inline" : "attachment";
      const bytes = await readResponseWithSizeCap(remote, MAX_REMOTE_ATTACHMENT_BYTES);
      return new Response(Buffer.from(bytes), {
        headers: {
          "Content-Type": remoteType,
          "Content-Disposition": `${remoteDisposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if ((attachment.size || 0) > 10 * 1024 * 1024)
      throw new HttpError(
        400,
        "Attachment exceeds the 10 MB download limit. Open it in Gmail.",
      );
    const data = await gmailAttachment(
      m.gmail_message_id,
      attachment.attachmentId,
    );
    return new Response(Buffer.from(data.data, "base64url"), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(...args: Parameters<typeof GETHandler>) {
  try {
    return await withRequestDatabase(() => GETHandler(...args), 20000);
  } catch (error) {
    return requestErrorResponse(error);
  }
}
