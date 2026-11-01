// Einfache Hintergrund-Aufträge (z. B. Leads per KI prüfen). Laufen im Prozess nacheinander ab; der Fortschritt
// ist über die API abrufbar. Ergebnisse landen direkt in der Datenbank, ein Neustart verliert nur den Rest des Auftrags.
import { token } from "../crypto.js";

const jobs = new Map();
const MAX_KEEP = 50;

export function startJob(kind, items, worker, { label = "" } = {}) {
  const id = token(9);
  const job = { id, kind, label, total: items.length, done: 0, failed: 0, status: "running", error: null, results: {}, started_at: Date.now(), finished_at: null, cancel: false };
  jobs.set(id, job);
  if (jobs.size > MAX_KEEP) jobs.delete(jobs.keys().next().value);
  (async () => {
    for (const item of items) {
      if (job.cancel) { job.status = "cancelled"; break; }
      try {
        const res = await worker(item);
        if (res !== undefined) job.results[res] = (job.results[res] || 0) + 1;
        job.done++;
      } catch (err) {
        job.failed++;
        job.error = err.message;
        // Abo-Limit o. Ä.: Rest des Auftrags abbrechen statt jeden Lead einzeln scheitern zu lassen.
        if (err.retryAt || err.stopJob) { job.status = "paused"; break; }
      }
    }
    if (job.status === "running") job.status = "done";
    job.finished_at = Date.now();
  })();
  return publicJob(job);
}

export function publicJob(job) {
  if (!job) return null;
  const { cancel, ...rest } = job;
  return rest;
}

export function getJob(id) {
  return publicJob(jobs.get(id));
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (job) job.cancel = true;
  return publicJob(job);
}

export function listJobs() {
  return [...jobs.values()].reverse().map(publicJob);
}
