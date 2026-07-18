import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

/**
 * Minimal out-of-band notification channel. Per the operator spec, only
 * budget breaches and hard blockers may notify between visits; everything
 * else waits for the Brief. Delivery is a Slack-compatible webhook POST
 * (works with Slack incoming webhooks and anything accepting {text}),
 * fire-and-forget with one retry, and always logged to the activity trail.
 */

export interface OutboundNotification {
  title: string;
  text: string;
  kind: "budget_breach" | "hard_blocker";
  entityType: string;
  entityId: string;
}

const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

async function postWebhook(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export function outboundNotificationService(db: Db) {
  async function notifyCompany(companyId: string, notification: OutboundNotification) {
    const row = await db
      .select({ url: companies.notificationWebhookUrl })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    const url = row?.url?.trim();
    if (!url) return false;

    const body = {
      text: `*${notification.title}*\n${notification.text}`,
      paperclip: {
        kind: notification.kind,
        entityType: notification.entityType,
        entityId: notification.entityId,
      },
    };

    let delivered = false;
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2 && !delivered; attempt += 1) {
      try {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        await postWebhook(url, body);
        delivered = true;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "outbound-notifications",
      agentId: null,
      runId: null,
      action: delivered ? "notification.webhook_sent" : "notification.webhook_failed",
      entityType: notification.entityType,
      entityId: notification.entityId,
      details: {
        kind: notification.kind,
        title: notification.title,
        ...(lastError && !delivered ? { error: lastError } : {}),
      },
    });
    return delivered;
  }

  /** Fire-and-forget wrapper: never lets notification failures break the caller. */
  function notifyCompanyInBackground(companyId: string, notification: OutboundNotification) {
    void notifyCompany(companyId, notification).catch(() => {});
  }

  return { notifyCompany, notifyCompanyInBackground };
}
