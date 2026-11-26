"use client";

import { Download, FileText, Plus, Trash2 } from "lucide-react";
import { Modal } from "../app/Modal";
import { Button } from "./ui/button";
import type { ReplyTemplate } from "../lib/support-ui";

export function SupportModals({
  lightboxImage,
  onCloseLightbox,
  newTicketOpen,
  onCloseNewTicket,
  ticketSingular,
  newEmail,
  onNewEmailChange,
  newSubject,
  onNewSubjectChange,
  newQuery,
  onNewQueryChange,
  onSubmitQuickTicket,
  templatesOpen,
  onCloseTemplates,
  templatesList,
  templateDraft,
  onTemplateDraftChange,
  onAct,
  busy,
}: {
  lightboxImage: { src: string; name: string; downloadUrl: string } | null;
  onCloseLightbox: () => void;
  newTicketOpen: boolean;
  onCloseNewTicket: () => void;
  ticketSingular: string;
  newEmail: string;
  onNewEmailChange: (v: string) => void;
  newSubject: string;
  onNewSubjectChange: (v: string) => void;
  newQuery: string;
  onNewQueryChange: (v: string) => void;
  onSubmitQuickTicket: (e: React.FormEvent) => void;
  templatesOpen: boolean;
  onCloseTemplates: () => void;
  templatesList: ReplyTemplate[];
  templateDraft: ReplyTemplate | null;
  onTemplateDraftChange: (v: ReplyTemplate | null) => void;
  onAct: (action: string, b?: Record<string, unknown>) => Promise<boolean>;
  busy: boolean;
}) {
  return (
    <>
      <Modal
        title={lightboxImage?.name || "Attachment preview"}
        open={Boolean(lightboxImage)}
        onClose={onCloseLightbox}
        wide
      >
        {lightboxImage && (
          <div className="space-y-4">
            <div className="flex items-center justify-center rounded-xl border border-border bg-muted/30 p-2 max-h-[70vh] overflow-auto">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightboxImage.src}
                alt={lightboxImage.name}
                className="max-h-[65vh] w-auto rounded-lg object-contain"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <a
                href={lightboxImage.downloadUrl}
                download={lightboxImage.name}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-semibold text-primary-foreground hover:opacity-95 transition"
              >
                <Download size={14} /> Download
              </a>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title={`New ${ticketSingular.toLowerCase()}`}
        open={newTicketOpen}
        onClose={onCloseNewTicket}
      >
        <form className="space-y-3" onSubmit={onSubmitQuickTicket}>
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            <span>Customer email</span>
            <input
              type="email"
              placeholder="customer@example.com"
              value={newEmail}
              onChange={(e) => onNewEmailChange(e.target.value)}
              required
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring"
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            <span>Subject</span>
            <input
              type="text"
              placeholder="Order inquiry or issue summary"
              value={newSubject}
              onChange={(e) => onNewSubjectChange(e.target.value)}
              required
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-ring"
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
            <span>Customer query</span>
            <textarea
              placeholder="Write the customer query or ticket summary…"
              rows={4}
              value={newQuery}
              onChange={(e) => onNewQueryChange(e.target.value)}
              required
              className="rounded-lg border border-input bg-background p-3 text-sm text-foreground outline-none focus:border-ring resize-y"
            />
          </label>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={onCloseNewTicket}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              Create ticket
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        title="Quick response templates"
        open={templatesOpen}
        onClose={onCloseTemplates}
        wide
      >
        <div className="grid grid-cols-1 md:grid-cols-[0.85fr_1.15fr] gap-6">
          <div className="space-y-2.5">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Click any template or type{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-primary">
                /reply
              </code>
              . Placeholders:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-primary">
                {"{{customer_name}}"}
              </code>
              ,{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-primary">
                {"{{customer_email}}"}
              </code>
              ,{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-primary">
                {"{{order_id}}"}
              </code>
              .
            </p>
            <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
              {templatesList.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => onTemplateDraftChange(template)}
                  className={`w-full flex items-start gap-2.5 rounded-xl border p-3 text-left transition cursor-pointer ${
                    templateDraft?.id === template.id
                      ? "border-primary bg-accent/60 text-accent-foreground"
                      : "border-border bg-card hover:bg-muted/40 text-foreground"
                  }`}
                >
                  <FileText size={15} className="mt-0.5 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <strong className="block text-xs font-semibold truncate">
                      {template.name}{" "}
                      {template.shortcut && (
                        <span className="font-mono text-[10px] text-primary">
                          /{template.shortcut}
                        </span>
                      )}
                    </strong>
                    <small className="block text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                      {template.body.slice(0, 90)}
                      {template.body.length > 90 ? "…" : ""}
                    </small>
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                onTemplateDraftChange({
                  id: "",
                  name: "",
                  body: "",
                  macro_status: "",
                  macro_priority: "",
                  macro_tags: [],
                  shortcut: "",
                  updated_at: "",
                })
              }
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 py-2.5 text-xs font-semibold text-foreground hover:border-primary hover:bg-accent/40 transition cursor-pointer"
            >
              <Plus size={14} /> New template
            </button>
          </div>

          <form
            className="rounded-xl border border-border bg-muted/20 p-4 flex flex-col gap-3 min-h-[340px]"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!templateDraft) return;
              const ok = await onAct(
                templateDraft.id ? "template_update" : "template_create",
                {
                  templateId: templateDraft.id,
                  name: templateDraft.name,
                  body: templateDraft.body,
                  macroStatus: templateDraft.macro_status || "",
                  macroPriority: templateDraft.macro_priority || "",
                  macroTags: templateDraft.macro_tags || [],
                  shortcut: templateDraft.shortcut || "",
                },
              );
              if (ok) onTemplateDraftChange(null);
            }}
          >
            {templateDraft ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                    <span>Name</span>
                    <input
                      value={templateDraft.name}
                      maxLength={80}
                      onChange={(e) =>
                        onTemplateDraftChange({ ...templateDraft, name: e.target.value })
                      }
                      placeholder="e.g. NDR Update"
                      required
                    />
                  </label>
                  <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                    <span>Slash shortcut (optional)</span>
                    <input
                      value={templateDraft.shortcut || ""}
                      maxLength={24}
                      onChange={(e) =>
                        onTemplateDraftChange({ ...templateDraft, shortcut: e.target.value })
                      }
                      placeholder="e.g. ndr"
                    />
                  </label>
                </div>
                <label className="grid gap-1 text-xs font-semibold text-muted-foreground flex-1">
                  <span>Reply text</span>
                  <textarea
                    value={templateDraft.body}
                    rows={5}
                    onChange={(e) =>
                      onTemplateDraftChange({ ...templateDraft, body: e.target.value })
                    }
                    placeholder="Write a reusable response…"
                    required
                  />
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                    <span>Macro status</span>
                    <select
                      value={templateDraft.macro_status || ""}
                      onChange={(e) =>
                        onTemplateDraftChange({ ...templateDraft, macro_status: e.target.value })
                      }
                      className="h-8 rounded-lg border border-input bg-card px-2 text-xs text-foreground"
                    >
                      <option value="">No change</option>
                      <option value="open">Open</option>
                      <option value="in_progress">In progress</option>
                      <option value="waiting">Waiting</option>
                      <option value="escalated">Escalated</option>
                      <option value="resolved">Resolved</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                    <span>Macro priority</span>
                    <select
                      value={templateDraft.macro_priority || ""}
                      onChange={(e) =>
                        onTemplateDraftChange({ ...templateDraft, macro_priority: e.target.value })
                      }
                      className="h-8 rounded-lg border border-input bg-card px-2 text-xs text-foreground"
                    >
                      <option value="">No change</option>
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] font-semibold text-muted-foreground">
                    <span>Macro tags (comma)</span>
                    <input
                      value={(templateDraft.macro_tags || []).join(", ")}
                      onChange={(e) =>
                        onTemplateDraftChange({
                          ...templateDraft,
                          macro_tags: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="e.g. NDR, VIP"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <Button type="submit" variant="primary" size="sm" disabled={busy}>
                    Save template
                  </Button>
                  {templateDraft.id && (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        if (confirm(`Delete ${templateDraft.name}?`)) {
                          if (await onAct("template_delete", { templateId: templateDraft.id }))
                            onTemplateDraftChange(null);
                        }
                      }}
                    >
                      <Trash2 size={14} /> Delete
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground gap-2 py-12">
                <FileText size={28} className="opacity-40" />
                <h3 className="text-sm font-semibold text-foreground">Select a template</h3>
                <p className="text-xs max-w-xs">
                  Choose one to edit it, or create a new shared quick response.
                </p>
              </div>
            )}
          </form>
        </div>
      </Modal>
    </>
  );
}
