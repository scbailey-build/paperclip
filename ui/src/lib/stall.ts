import type { Issue } from "@paperclipai/shared";

/** Stall rule: no progress past the threshold on an active or blocked card. */
export const STALL_THRESHOLD_DAYS = 7;

export function isStalled(issue: Issue, now: number): boolean {
  return (
    (issue.status === "in_progress" || issue.status === "blocked") &&
    new Date(issue.updatedAt).getTime() < now - STALL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000
  );
}
