// Hintergrund-Abgleich: IMAP aller Postfächer + KI-Einordnung neuer Antworten.
import { q } from "../db.js";
import { syncMailbox, imapConfigured } from "../mail/imap.js";
import { classifyPendingConversations } from "../ai/features.js";

let timer = null;
let running = false;
export const syncLoopState = { lastRunAt: null, lastError: null };

export async function syncAll() {
  if (running) return;
  running = true;
  try {
    const boxes = q.all("SELECT * FROM mailboxes WHERE status != 'disabled'");
    for (const mb of boxes) {
      if (!imapConfigured(mb)) continue;
      await syncMailbox(mb).catch(err => console.warn(`[sync] ${mb.email}: ${err.message}`));
    }
    await classifyPendingConversations().catch(err => { syncLoopState.lastError = `KI: ${err.message}`; });
    syncLoopState.lastRunAt = Date.now();
  } finally {
    running = false;
  }
}

export function startSync(intervalMs) {
  stopSync();
  const loop = async () => {
    await syncAll().catch(err => { syncLoopState.lastError = err.message; });
    timer = setTimeout(loop, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(loop, 8000);
  timer.unref?.();
}

export function stopSync() {
  if (timer) clearTimeout(timer);
  timer = null;
}
