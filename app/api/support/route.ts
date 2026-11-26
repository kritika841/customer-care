import { randomUUID } from "node:crypto";
import { withRequestDatabase } from "../../../lib/database";
import { errorResponse, errorResponse as requestErrorResponse, getTrustedAppOrigin, HttpError } from "../../../lib/http";
import { access, admin, manager } from "../../../lib/operations/access";
import { operationsDb } from "../../../lib/operations/schema";
import {
  supportData,
  mutateSupport,
  refreshAgents,
  searchCustomersAndOrders,
  supportEvent,
  supportInsights,
  ticketAccess,
} from "../../../lib/operations/support";
import { syncMailbox, flushOutbox } from "../../../lib/operations/gmail";
import {
  connectMetaToken,
  listMetaPages,
  syncMetaInboxes,
  flushMetaOutbox,
} from "../../../lib/operations/meta";
import {
  deleteKnowledgeDocument,
  fetchLiveOrderTrackingInfo,
  listKnowledgeDocuments,
  syncStoreKnowledgeToRag,
  upsertKnowledgeDocument,
  type KnowledgeCategory,
} from "../../../lib/operations/rag";
import {
  autoDraftPendingInboundTickets,
  getAiSettings,
  getAiTokenSpendReport,
  processAiMemoryCommand,
  recordDeclineAndMaybeLearn,
  rephraseAdminClarification,
  resolveAiEscalationWithAdminAnswer,
  runAiAgentOnTicket,
  simulateAiAgentQuery,
  updateAiSettings,
  type AiOperatingMode,
} from "../../../lib/operations/ai-agent";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function GETHandler(r: Request) {
  try {
    const u = await access(r, "support");
    const url = new URL(r.url);
    const mode = url.searchParams.get("mode");
    if (mode === "customer_search") {
      if (!manager(u)) {
        const ticketId = (url.searchParams.get("ticketId") || "").trim();
        if (!ticketId) throw new HttpError(403, "Manager access or assigned ticket context required");
        const db = await operationsDb();
        await db.transaction((sql) => ticketAccess(sql, ticketId, u, false));
      }
      const results = await searchCustomersAndOrders(url.searchParams.get("q") || "");
      return Response.json({ results });
    }
    if (mode === "track_order") {
      const ticketId = (url.searchParams.get("ticketId") || "").trim();
      if (!manager(u)) {
        if (!ticketId) throw new HttpError(403, "Manager access or assigned ticket context required");
        const db = await operationsDb();
        await db.transaction((sql) => ticketAccess(sql, ticketId, u, false));
      }
      const tracking = await fetchLiveOrderTrackingInfo({
        awb: url.searchParams.get("awb") || undefined,
        orderId: url.searchParams.get("orderId") ? Number(url.searchParams.get("orderId")) : null,
        orderCode: url.searchParams.get("orderCode") || undefined,
      });
      if (!tracking) throw new HttpError(404, "No tracking details found for this order");
      return Response.json({ ok: true, tracking });
    }
    if (mode === "insights") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const days = Number(url.searchParams.get("days") || 14);
      return Response.json(await supportInsights(days));
    }
    if (mode === "token_usage") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const days = Number(url.searchParams.get("days") || 30);
      return Response.json(await getAiTokenSpendReport(days));
    }
    if (mode === "knowledge") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const category = url.searchParams.get("category") || "all";
      const search = url.searchParams.get("q") || "";
      const db = await operationsDb();
      const [documents, aiSettings, pendingEscalations, aiTimeline] = await Promise.all([
        listKnowledgeDocuments({ category, search }),
        getAiSettings(),
        db
          .prepare(
            `SELECT e.*, t.ticket_number, t.subject, t.customer_name, t.customer_email, t.channel, t.external_username
             FROM support_ai_escalations e
             JOIN support_tickets t ON t.id = e.ticket_id
             WHERE e.status = 'pending'
             ORDER BY e.created_at DESC
             LIMIT 40`,
          )
          .all<Record<string, unknown>>()
          .catch(() => ({ results: [] as Record<string, unknown>[] })),
        db
          .prepare(
            `SELECT
               t.id AS ticket_id,
               t.ticket_number,
               t.subject,
               t.customer_name,
               t.customer_email,
               t.channel,
               t.external_username,
               t.ai_status,
               t.ai_confidence,
               COALESCE(
                 (SELECT LEFT(TRIM(REGEXP_REPLACE(sm_in.body, '<[^>]+>', ' ', 'g')), 500)
                  FROM support_messages sm_in
                  WHERE sm_in.ticket_id = t.id AND sm_in.direction = 'inbound'
                    AND NOT (sm_in.body ~* '^(Facebook created this chat because |Facebook ने यह चैट इसलिए बनाई है क्योंकि |Auto-label added:|Lead stage set to |You are responding to a user comment)')
                  ORDER BY sm_in.created_at DESC LIMIT 1),
                 t.subject
               ) AS customer_query,
               COALESCE(ai_msg.body, '') AS ai_reply_body,
               ai_msg.created_at AS ai_reply_at,
               COALESCE(ai_msg.delivery_status, '') AS ai_delivery_status,
               COALESCE(esc.ai_question_for_admin, '') AS ai_question_for_admin,
               COALESCE(esc.escalation_type, '') AS escalation_type,
               COALESCE(esc.action_category, '') AS action_category,
               COALESCE(esc.status, '') AS escalation_status,
               COALESCE(ai_msg.created_at, esc.created_at, t.updated_at) AS activity_at
             FROM support_tickets t
             LEFT JOIN LATERAL (
               SELECT body, created_at, delivery_status
               FROM support_messages sm
               WHERE sm.ticket_id = t.id
                 AND (sm.delivery_status = 'ai_draft' OR sm.created_by = 'ai_agent')
               ORDER BY sm.created_at DESC LIMIT 1
             ) ai_msg ON TRUE
             LEFT JOIN LATERAL (
               SELECT ai_question_for_admin, escalation_type, action_category, status, created_at
               FROM support_ai_escalations e
               WHERE e.ticket_id = t.id
               ORDER BY e.created_at DESC LIMIT 1
             ) esc ON TRUE
             WHERE ai_msg.body IS NOT NULL OR esc.ai_question_for_admin IS NOT NULL
             ORDER BY COALESCE(ai_msg.created_at, esc.created_at, t.updated_at) DESC
             LIMIT 60`,
          )
          .all<Record<string, unknown>>()
          .catch(() => ({ results: [] as Record<string, unknown>[] })),
      ]);
      return Response.json({
        documents,
        aiSettings,
        pendingEscalations: pendingEscalations.results,
        aiTimeline: aiTimeline.results,
      });
    }
    return Response.json(
      await supportData(
        u,
        url.searchParams.get("ticket") || undefined,
        {
          page: Number(url.searchParams.get("page") || 1),
          queue: url.searchParams.get("queue") || "all",
          channel: url.searchParams.get("channel") || "all",
          search: url.searchParams.get("q") || "",
          sort: url.searchParams.get("sort") || "newest",
        },
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

async function POSTHandler(r: Request) {
  try {
    const u = await access(r, "support");
    const b = await r.json();

    if (b.action === "meta_pages") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      if (b.accessToken && !admin(u)) {
        throw new HttpError(403, "Administrator access required to supply a custom Meta token");
      }
      const pages = await listMetaPages(b.accessToken ? String(b.accessToken) : undefined);
      return Response.json({ ok: true, pages });
    }

    if (b.action === "meta_connect") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      if (b.accessToken && !admin(u)) {
        throw new HttpError(403, "Administrator access required to update Meta token");
      }
      const connected = await connectMetaToken(
        b.accessToken ? String(b.accessToken) : undefined,
        u.id,
        b.pageId ? String(b.pageId) : undefined,
      );
      await syncMetaInboxes(30).catch(() => null);
      const missingNotice = connected.missingPermissions?.length
        ? ` Missing permissions on System Token: ${connected.missingPermissions.join(", ")}.`
        : "";
      const noticeParts = [
        connected.facebookPage?.name
          ? `Connected Facebook Page (${connected.facebookPage.name})`
          : "",
        connected.instagramAccount?.username
          ? `Connected Instagram (${connected.instagramAccount.username})`
          : "",
      ].filter(Boolean);
      return Response.json({
        ok: true,
        ...connected,
        notice: (noticeParts.join(" & ") || "Connected Meta inbox") + "." + missingNotice,
      });
    }

    if (b.action === "team") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      await refreshAgents();
      return Response.json({ ok: true, notice: "Refreshed support team." });
    }

    if (b.action === "ai_run_ticket") {
      const ticketId = String(b.ticketId || "").trim();
      if (!ticketId) throw new HttpError(400, "Ticket ID is required");
      const db = await operationsDb();
      await db.transaction((sql) => ticketAccess(sql, ticketId, u, false));
      const result = await runAiAgentOnTicket({
        ticketId,
        actorId: u.id,
        forceCompact: b.forceCompact === true,
      });
      const outcomeLabel =
        result.decision.decision === "auto_reply"
          ? result.safeModeActive
            ? "AI generated a grounded reply draft (Safe Mode: not sent to customer)."
            : "AI queued a grounded reply for customer delivery."
          : result.decision.decision === "human_action_required"
            ? `AI flagged ticket for human action (${result.decision.humanActionCategory || "escalation"}).`
            : "AI requested missing store context from admin.";
      return Response.json({
        ok: true,
        ...result,
        notice: outcomeLabel,
      });
    }

    if (b.action === "ai_batch_triage") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const db = await operationsDb();
      const candidates = await db
        .prepare(
          `SELECT id FROM support_tickets
           WHERE status <> 'resolved'
             AND COALESCE(ai_status, 'idle') = 'idle'
           ORDER BY updated_at DESC
           LIMIT 8`,
        )
        .all<{ id: string }>();
      let drafts = 0;
      let askedAdmin = 0;
      let humanActions = 0;
      for (const row of candidates.results) {
        const res = await runAiAgentOnTicket({
          ticketId: String(row.id),
          actorId: u.id,
        });
        if (res.decision.decision === "auto_reply") drafts++;
        else if (res.decision.decision === "human_action_required") humanActions++;
        else askedAdmin++;
      }
      await Promise.allSettled([flushOutbox(), flushMetaOutbox()]);
      return Response.json({
        ok: true,
        processed: candidates.results.length,
        drafts,
        askedAdmin,
        humanActions,
        notice: `AI Triage processed ${candidates.results.length} ticket(s): ${drafts} prepared, ${askedAdmin} asking for input, ${humanActions} flagged for human action.`,
      });
    }

    if (b.action === "ai_approve_reply") {
      const ticketId = String(b.ticketId || "").trim();
      if (!ticketId) throw new HttpError(400, "Ticket ID is required");
      const db = await operationsDb();
      await db.transaction((sql) => ticketAccess(sql, ticketId, u, false));
      const draftRow = await db
        .prepare(
          "SELECT body, resolve_after_send FROM support_messages WHERE ticket_id = ? AND delivery_status = 'ai_draft' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(ticketId)
        .first<{ body?: string; resolve_after_send?: boolean }>();
      const bodyToSend = String(b.proposedReply || draftRow?.body || "").trim();
      if (!bodyToSend) throw new HttpError(400, "No proposed AI reply found to approve");

      const appOrigin = getTrustedAppOrigin(r);
      const replyRes = await mutateSupport(
        {
          action: "reply",
          ticketId,
          version: b.version,
          body: bodyToSend,
          requestKey: String(b.requestKey || randomUUID()),
          resolve: b.resolve !== undefined ? Boolean(b.resolve) : Boolean(draftRow?.resolve_after_send),
        },
        u,
        { appOrigin },
      );

      await db.transaction(async (sql) => {
        await sql`
          UPDATE support_tickets
          SET ai_approval_status = 'approved',
              ai_decline_reason = ''
          WHERE id = ${ticketId}
        `;
        await supportEvent(sql, u.id, ticketId, "ai_reply_approved", {});
      });

      await Promise.allSettled([flushOutbox(), flushMetaOutbox()]);
      return Response.json({
        ...replyRes,
        ok: true,
        notice: "Approved and queued AI response for delivery.",
      });
    }

    if (b.action === "ai_decline_reply") {
      const ticketId = String(b.ticketId || "").trim();
      const declineReason = String(b.declineReason || "").trim();
      const correctedReply = String(b.correctedReply || "").trim();
      if (!ticketId) throw new HttpError(400, "Ticket ID is required");
      if (!declineReason) throw new HttpError(400, "Please enter a reason for declining");
      if (!correctedReply) throw new HttpError(400, "Please enter the corrected response");

      const db = await operationsDb();
      await db.transaction((sql) => ticketAccess(sql, ticketId, u, false));

      const ticketSnapshot = await db
        .prepare(
          `SELECT t.subject,
                  COALESCE(
                    (SELECT sm.body FROM support_messages sm WHERE sm.ticket_id = t.id AND sm.direction = 'inbound' ORDER BY sm.created_at DESC LIMIT 1),
                    t.subject
                  ) AS latest_query,
                  COALESCE(
                    (SELECT sm_ai.body FROM support_messages sm_ai WHERE sm_ai.ticket_id = t.id AND (sm_ai.delivery_status = 'ai_draft' OR sm_ai.created_by = 'ai_agent') ORDER BY sm_ai.created_at DESC LIMIT 1),
                    ''
                  ) AS proposed_reply
           FROM support_tickets t
           WHERE t.id = ?`,
        )
        .bind(ticketId)
        .first<{ subject?: string; latest_query?: string; proposed_reply?: string }>();

      const learningResult = await recordDeclineAndMaybeLearn({
        ticketId,
        customerQuery: String(b.customerQuery || ticketSnapshot?.latest_query || ticketSnapshot?.subject || ""),
        proposedReply: String(b.proposedReply || ticketSnapshot?.proposed_reply || ""),
        declineReason,
        correctedReply,
        actorId: u.id,
        actorName: u.name || u.email,
      });

      const appOrigin = getTrustedAppOrigin(r);
      const replyRes = await mutateSupport(
        {
          action: "reply",
          ticketId,
          version: b.version,
          body: correctedReply,
          requestKey: String(b.requestKey || randomUUID()),
          resolve: b.resolve !== false,
        },
        u,
        { appOrigin },
      );

      await Promise.allSettled([flushOutbox(), flushMetaOutbox()]);
      const learnNote = learningResult.learnedToMemory
        ? ` AI learned a new rule ("${learningResult.memoryTitle}") from your correction.`
        : ` Skipped global AI learning (${learningResult.skipReason || "order-specific query"}).`;

      return Response.json({
        ...replyRes,
        ok: true,
        ...learningResult,
        notice: `Sent corrected response.${learnNote}`,
      });
    }

    if (b.action === "ai_memory_command") {
      if (!manager(u)) throw new HttpError(403, "Manager access required to update AI memory");
      const instruction = String(b.instruction || "").trim();
      const result = await processAiMemoryCommand({
        instruction,
        actorId: u.id,
        actorName: u.name || u.email,
      });
      return Response.json({
        ok: true,
        ...result,
        notice: result.assistantReply,
      });
    }

    if (b.action === "ai_rephrase_preview") {
      const adminRawAnswer = String(b.adminRawAnswer || "").trim();
      if (!adminRawAnswer) throw new HttpError(400, "Enter your answer for the AI first");
      const ticketId = b.ticketId ? String(b.ticketId).trim() : "";
      if (ticketId) {
        const db = await operationsDb();
        await db.transaction((sql) => ticketAccess(sql, ticketId, u, false));
      }
      const preview = await rephraseAdminClarification({
        ticketId: ticketId || undefined,
        escalationId: b.escalationId ? String(b.escalationId) : undefined,
        customerName: b.customerName ? String(b.customerName) : undefined,
        channel: b.channel ? String(b.channel) : undefined,
        customerQuery: String(b.customerQuery || ""),
        aiQuestionForAdmin: b.aiQuestionForAdmin ? String(b.aiQuestionForAdmin) : undefined,
        adminRawAnswer,
      });
      return Response.json({ ok: true, ...preview });
    }

    if (b.action === "ai_resolve_escalation") {
      const ticketId = String(b.ticketId || "").trim();
      const adminRawAnswer = String(b.adminRawAnswer || "").trim();
      if (!ticketId || !adminRawAnswer) {
        throw new HttpError(400, "Ticket ID and admin answer are required");
      }
      const db = await operationsDb();
      await db.transaction((sql) => ticketAccess(sql, ticketId, u, false));
      const wantsMemorySave = b.saveToMemory === true;
      if (wantsMemorySave && !manager(u)) {
        throw new HttpError(403, "Manager access required to save rules to global AI memory");
      }
      const res = await resolveAiEscalationWithAdminAnswer({
        ticketId,
        escalationId: b.escalationId ? String(b.escalationId) : undefined,
        adminRawAnswer,
        rephrasedCustomerReply: b.rephrasedCustomerReply
          ? String(b.rephrasedCustomerReply)
          : undefined,
        saveToMemory: wantsMemorySave,
        canonicalMemoryTitle: b.canonicalMemoryTitle
          ? String(b.canonicalMemoryTitle)
          : undefined,
        canonicalQuestion: b.canonicalQuestion ? String(b.canonicalQuestion) : undefined,
        canonicalAnswer: b.canonicalAnswer ? String(b.canonicalAnswer) : undefined,
        resolveTicket: b.resolveTicket !== false,
        actorId: u.id,
        actorName: u.name || u.email,
      });
      return Response.json({
        ...res,
        notice: res.savedToMemory
          ? `AI rephrased your answer into the ticket draft and saved the generalized Q&A (${res.chunksIndexed} chunk(s)) to Store RAG Memory.`
          : "AI rephrased your answer into the ticket draft (not saved to global AI memory).",
      });
    }

    if (b.action === "ai_knowledge_sync") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const syncRes = await syncStoreKnowledgeToRag(u.id);
      const shopifyPart = syncRes.shopifyConfigured
        ? `, ${syncRes.shopifyProductsSynced} Shopify product(s)`
        : "";
      return Response.json({
        ok: true,
        ...syncRes,
        notice: `Synced Store Knowledge to RAG (${syncRes.totalDocuments} documents, ${syncRes.totalChunks} indexed chunks${shopifyPart}).`,
      });
    }

    if (b.action === "ai_knowledge_upsert") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const upserted = await upsertKnowledgeDocument({
        id: b.documentId ? String(b.documentId) : undefined,
        title: String(b.title || ""),
        category: String(b.category || "faq") as KnowledgeCategory,
        content: String(b.content || ""),
        sourceRef: b.sourceRef ? String(b.sourceRef) : undefined,
        isActive: b.isActive !== false,
        actorId: u.id,
      });
      return Response.json({
        ok: true,
        ...upserted,
        notice: `Indexed "${String(b.title || "").trim()}" (${upserted.chunksIndexed} RAG chunk(s)).`,
      });
    }

    if (b.action === "ai_knowledge_delete") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const docId = String(b.documentId || "").trim();
      if (!docId) throw new HttpError(400, "Document ID is required");
      await deleteKnowledgeDocument(docId);
      return Response.json({ ok: true, notice: "Knowledge document removed from RAG." });
    }

    if (b.action === "ai_simulate") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const query = String(b.query || "").trim();
      if (!query) throw new HttpError(400, "Enter a test customer query to simulate");
      const sim = await simulateAiAgentQuery({
        query,
        channel: b.channel ? String(b.channel) : "instagram",
        customerEmail: b.customerEmail ? String(b.customerEmail) : undefined,
        customerPhone: b.customerPhone ? String(b.customerPhone) : undefined,
      });
      return Response.json({ ok: true, simulation: sim });
    }

    if (b.action === "nomenclature_update") {
      if (!admin(u)) throw new HttpError(403, "Admin access required to rename ticketing nomenclature");
      const updated = await updateAiSettings(
        {
          ticketLabelSingular:
            b.ticketLabelSingular !== undefined ? String(b.ticketLabelSingular) : undefined,
          ticketLabelPlural:
            b.ticketLabelPlural !== undefined ? String(b.ticketLabelPlural) : undefined,
        },
        u.id,
      );
      return Response.json({
        ok: true,
        aiSettings: updated,
        notice: `Updated nomenclature to "${updated.ticketLabelSingular}" / "${updated.ticketLabelPlural}".`,
      });
    }

    if (b.action === "ai_settings_update") {
      if (!manager(u)) throw new HttpError(403, "Manager access required");
      const updated = await updateAiSettings(
        {
          operatingMode: b.operatingMode as AiOperatingMode | undefined,
          approvalModeEnabled:
            b.approvalModeEnabled !== undefined ? Boolean(b.approvalModeEnabled) : undefined,
          liveOutboundEnabled:
            b.liveOutboundEnabled !== undefined ? Boolean(b.liveOutboundEnabled) : undefined,
          testRecipientAllowlist: b.testRecipientAllowlist as string[] | string | undefined,
          compactionTokenThreshold:
            b.compactionTokenThreshold !== undefined
              ? Number(b.compactionTokenThreshold)
              : undefined,
          autoReplyConfidenceThreshold:
            b.autoReplyConfidenceThreshold !== undefined
              ? Number(b.autoReplyConfidenceThreshold)
              : undefined,
          vipOrderValueThreshold:
            b.vipOrderValueThreshold !== undefined
              ? Number(b.vipOrderValueThreshold)
              : undefined,
          debounceSeconds:
            b.debounceSeconds !== undefined ? Number(b.debounceSeconds) : undefined,
          brandPersonaPrompt:
            b.brandPersonaPrompt !== undefined ? String(b.brandPersonaPrompt) : undefined,
          ...(admin(u) && b.ticketLabelSingular !== undefined
            ? { ticketLabelSingular: String(b.ticketLabelSingular) }
            : {}),
          ...(admin(u) && b.ticketLabelPlural !== undefined
            ? { ticketLabelPlural: String(b.ticketLabelPlural) }
            : {}),
        },
        u.id,
      );
      const modeDesc = updated.approvalModeEnabled
        ? "Approval Mode ON (Excel Review Table)"
        : updated.envLiveOutboundEnabled
          ? `Auto-Send Mode ON (Confidence ≥ ${Math.round(updated.autoReplyConfidenceThreshold * 100)}%)`
          : `Auto-Send Mode ON in Dashboard (Confidence ≥ ${Math.round(updated.autoReplyConfidenceThreshold * 100)}%; external send held by AI_LIVE_OUTBOUND_ENABLED=false)`;
      return Response.json({
        ok: true,
        aiSettings: updated,
        notice: `Updated AI settings: ${modeDesc}.`,
      });
    }

    if (b.action === "sync") {
      if (manager(u)) {
        await refreshAgents();
      }
      let gmailOk = false;
      try {
        await syncMailbox();
        await flushOutbox();
        gmailOk = true;
      } catch {
        // Gmail may not be connected yet; continue syncing Meta inboxes
      }
      const metaResult = await syncMetaInboxes(30).catch((err) => ({
        imported: 0,
        threadsSynced: 0,
        channels: {} as Record<string, { threads: number; imported: number; error: string }>,
        error: err instanceof Error ? err.message : "Meta sync failed",
      }));
      await flushMetaOutbox().catch(() => null);

      // Automatically prepare AI draft / auto-send responses for newly synced inbound tickets
      await autoDraftPendingInboundTickets(15).catch(() => null);
      await Promise.allSettled([flushOutbox(), flushMetaOutbox()]);

      const channelNotes = Object.entries(metaResult.channels || {})
        .filter(([, info]) => Boolean(info.error))
        .map(([ch, info]) => `${ch}: ${info.error}`);

      return Response.json({
        ok: true,
        gmailSynced: gmailOk,
        metaImported: metaResult.imported,
        threadsSynced: metaResult.threadsSynced ?? 0,
        notice: `Synced 30-day DMs & Email (${metaResult.imported} new message${metaResult.imported === 1 ? "" : "s"} across ${metaResult.threadsSynced ?? 0} Meta threads).`,
        ...(channelNotes.length ? { warning: channelNotes.join(" | ") } : {}),
      });
    }

    const appOrigin = getTrustedAppOrigin(r);
    const result = await mutateSupport(b, u, { appOrigin });
    if (b.action === "reply" || b.action === "retry") {
      try {
        await Promise.allSettled([flushOutbox(), flushMetaOutbox()]);
        const msgId = "messageId" in result ? String(result.messageId || "") : "";
        if (msgId) {
          const db = await operationsDb();
          const msgRow = await db
            .prepare(
              `SELECT m.delivery_status, m.last_error, t.channel
               FROM support_messages m
               JOIN support_tickets t ON t.id = m.ticket_id
               WHERE m.id = ?`,
            )
            .bind(msgId)
            .first<{ delivery_status?: string; last_error?: string; channel?: string }>();
          if (msgRow?.delivery_status === "failed") {
            return Response.json({
              ...result,
              deliveryStatus: "failed",
              deliveryError: msgRow.last_error || "Message delivery failed",
            });
          }
          if (msgRow?.delivery_status === "sent") {
            const channelName =
              msgRow.channel === "instagram"
                ? "Instagram DM"
                : msgRow.channel === "facebook"
                  ? "Facebook Messenger"
                  : "Email";
            return Response.json({
              ...result,
              deliveryStatus: "sent",
              notice: `Reply sent to ${channelName}.`,
            });
          }
        }
      } catch {
        return Response.json({
          ...result,
          notice:
            "Reply saved in the outbox and will be delivered on next sync.",
        });
      }
    }
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(...args: Parameters<typeof GETHandler>) {
  try { return await withRequestDatabase(() => GETHandler(...args), 20000); }
  catch (error) { return requestErrorResponse(error); }
}

export async function POST(...args: Parameters<typeof POSTHandler>) {
  try { return await withRequestDatabase(() => POSTHandler(...args), 270000); }
  catch (error) { return requestErrorResponse(error); }
}
