import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, issueUrl, relativeTime } from "../lib/utils";
import { Link } from "../lib/router";
import { MarkdownBody } from "./MarkdownBody";

/**
 * Card peek: the plan-first drawer opened from a Board card. Shows the card's
 * pre-drafted plan (issue document `plan`) with one-tap approve, inline edit,
 * and attachment upload — the operator reviews the plan without leaving the
 * floor. Uses existing primitives only: issue documents (+ revisions),
 * request_confirmation interactions, comments, attachments.
 */

const PLAN_KEY = "plan";

export function BoardCardPeek({ issueId, onClose }: { issueId: string; onClose: () => void }) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
  });

  const {
    data: plan,
    isLoading: planLoading,
    isError: planMissing,
  } = useQuery({
    queryKey: ["issues", "documents", issueId, PLAN_KEY] as const,
    queryFn: () => issuesApi.getDocument(issueId, PLAN_KEY),
    retry: false,
  });

  const { data: interactions } = useQuery({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
  });

  const { data: attachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issueId),
    queryFn: () => issuesApi.listAttachments(issueId),
  });

  const pendingConfirmation = (interactions ?? []).find(
    (interaction): interaction is IssueThreadInteraction =>
      interaction.kind === "request_confirmation" && interaction.status === "pending",
  );

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["issues"] });
  };

  const approvePlan = useMutation({
    mutationFn: async () => {
      if (pendingConfirmation) {
        return issuesApi.acceptInteraction(issueId, pendingConfirmation.id);
      }
      return issuesApi.addComment(issueId, "Plan approved from the Board.");
    },
    onSettled: refresh,
  });

  const savePlan = useMutation({
    mutationFn: () =>
      issuesApi.upsertDocument(issueId, PLAN_KEY, {
        title: plan?.title ?? "Plan",
        format: "markdown",
        body: draft,
        changeSummary: "Edited from the Board.",
        baseRevisionId: plan?.latestRevisionId ?? null,
      }),
    onSuccess: () => setEditing(false),
    onSettled: refresh,
  });

  const requestPlan = useMutation({
    mutationFn: () =>
      issuesApi.addComment(
        issueId,
        "Please draft a plan for this card as the issue document with key `plan` before starting work.",
      ),
    onSettled: refresh,
  });

  const uploadAttachment = useMutation({
    mutationFn: (file: File) => issuesApi.uploadAttachment(selectedCompanyId!, issueId, file),
    onSettled: () => {
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) });
    },
  });

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-ops-line bg-ops-bg text-ops-body text-ops-ink shadow-none">
      <div className="flex items-start gap-ops-2 border-b border-ops-line p-ops-4">
        <div className="min-w-0 flex-1">
          <p className="text-ops-detail text-ops-ink-muted">{issue?.identifier ?? ""}</p>
          <p className="font-ops-accent">{issue?.title ?? "…"}</p>
          {issue && (
            <p className="mt-ops-1 text-ops-detail text-ops-ink-muted">
              {issue.status.replace(/_/g, " ")} · updated {relativeTime(issue.updatedAt)} ·{" "}
              <Link to={issueUrl(issue)} className="underline">
                open full card
              </Link>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="border border-ops-line px-ops-2 py-ops-1 text-ops-detail hover:bg-ops-bg-raised"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-ops-4">
        <div className="flex items-baseline justify-between">
          <h3 className="font-ops-accent text-ops-ink-muted">Plan</h3>
          {plan && !editing && (
            <span className="text-ops-detail text-ops-ink-muted">
              rev {plan.latestRevisionNumber} · {relativeTime(plan.updatedAt)}
            </span>
          )}
        </div>

        {planLoading && <p className="mt-ops-2 text-ops-ink-muted">Loading…</p>}

        {planMissing && !planLoading && (
          <div className="mt-ops-2">
            <p>No plan drafted yet.</p>
            <button
              type="button"
              disabled={requestPlan.isPending}
              onClick={() => requestPlan.mutate()}
              className="mt-ops-2 border border-ops-line px-ops-3 py-ops-1 font-ops-accent hover:bg-ops-bg-raised"
            >
              {requestPlan.isSuccess ? "Plan requested" : "Request plan"}
            </button>
          </div>
        )}

        {plan && !editing && (
          <>
            <div className="mt-ops-2 border border-ops-line bg-ops-bg-raised p-ops-3">
              <MarkdownBody>{plan.body}</MarkdownBody>
            </div>
            <div className="mt-ops-3 flex gap-ops-2">
              <button
                type="button"
                disabled={approvePlan.isPending || approvePlan.isSuccess}
                onClick={() => approvePlan.mutate()}
                className={cn(
                  "px-ops-3 py-ops-1 font-ops-accent",
                  approvePlan.isSuccess
                    ? "border border-ops-line text-ops-ink-muted"
                    : "bg-ops-accent text-ops-accent-ink",
                )}
              >
                {approvePlan.isSuccess
                  ? "Plan approved"
                  : pendingConfirmation
                    ? "Approve plan"
                    : "Approve plan"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(plan.body);
                  setEditing(true);
                }}
                className="border border-ops-line px-ops-3 py-ops-1 hover:bg-ops-bg-raised"
              >
                Edit
              </button>
            </div>
            {pendingConfirmation && (
              <p className="mt-ops-2 text-ops-detail text-ops-ink-muted">
                The assignee is waiting on this approval to start work.
              </p>
            )}
          </>
        )}

        {editing && (
          <div className="mt-ops-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={14}
              className="w-full border border-ops-line bg-ops-bg p-ops-2 text-ops-body text-ops-ink"
              aria-label="Plan markdown"
            />
            <div className="mt-ops-2 flex gap-ops-2">
              <button
                type="button"
                disabled={savePlan.isPending}
                onClick={() => savePlan.mutate()}
                className="bg-ops-accent px-ops-3 py-ops-1 font-ops-accent text-ops-accent-ink"
              >
                Save plan
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="border border-ops-line px-ops-3 py-ops-1 hover:bg-ops-bg-raised"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="mt-ops-6">
          <h3 className="font-ops-accent text-ops-ink-muted">Attachments</h3>
          <ul className="mt-ops-2 space-y-ops-1">
            {(attachments ?? []).map((attachment) => (
              <li key={attachment.id} className="flex items-baseline gap-ops-2">
                <a
                  href={`/api/attachments/${attachment.id}/content`}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate underline"
                >
                  {attachment.originalFilename ?? attachment.objectKey}
                </a>
                <span className="ml-auto shrink-0 text-ops-detail text-ops-ink-muted">
                  {Math.max(1, Math.round(attachment.byteSize / 1024))} KB
                </span>
              </li>
            ))}
            {(attachments ?? []).length === 0 && (
              <li className="text-ops-ink-muted">Nothing attached.</li>
            )}
          </ul>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) uploadAttachment.mutate(file);
            }}
          />
          <button
            type="button"
            disabled={uploadAttachment.isPending}
            onClick={() => fileInputRef.current?.click()}
            className="mt-ops-2 border border-ops-line px-ops-3 py-ops-1 hover:bg-ops-bg-raised"
          >
            {uploadAttachment.isPending ? "Uploading…" : "Attach a file"}
          </button>
        </div>
      </div>
    </div>
  );
}
