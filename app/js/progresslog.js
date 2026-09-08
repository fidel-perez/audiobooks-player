/**
 * Per-night reading log — "how many minutes did I actually advance last night?"
 *
 * The app is used to fall asleep to. You cannot remember how far you got, or
 * whether the sleep-mode auto-stop fired at all, because you were asleep when it
 * happened. This module keeps the receipt: for each book, for each night, the
 * minutes of listening ADVANCED (`f`) and the minutes REWOUND (`b`, the sleep
 * rewind), so the morning after you can read "+45 / −15" and know the night
 * worked. Surfaced by the ⚙️ → 📈 «Registro de progreso» modal.
 *
 * WHAT A MINUTE MEANS HERE. The same thing the player's ⏱ readout means:
 * content-minutes at the CURRENT speed (BASE_WPM × rate, via the book's own
 * chars-per-word). So a night's `f` is the amount the ⏱ clock moved, not
 * wall-clock time spent — which is the number you want when the question is
 * "how much of the book did I get through".
 *
 * WHAT COUNTS AS A NIGHT. The day rolls over at 06:00 local, not at midnight: a
 * session from 23:40 to 01:20 is ONE night, filed under the date it started. A
 * calendar-day bucket would split every single bedtime session in two and make
 * the log unreadable for exactly its main use.
 *
 * WHAT IS AND IS NOT COUNTED. A minute counts only if the voice was SPEAKING it:
 * `noteRead` takes the live playback state and drops any save taken while
 * stopped or paused. That is what makes the number trustworthy — a seek is
 * indistinguishable from reading by size alone, so anything that leans on size
 * lets short ones through, and "I dragged the slider a bit before bed" is a
 * short one. Behind that gate sit two backstops: `noteSeek` (called from the
 * seek funnels, player.js#jumpToChar and #stepChunk) drops the sample a jump's
 * own `saveProgress` produces even mid-playback, and anything larger than
 * MAX_SAMPLE_MIN is refused outright, which covers the paths that move a book
 * without going through either (a cross-device catch-up adoption, say).
 * Backward movement is never counted as negative advance; the
 * only thing that fills `b` is `noteRewind`, called from the sleep rewind. Those
 * re-listened minutes DO count forward again next night, on purpose: `f` answers
 * "how much did I advance tonight", and you did advance through them again.
 *
 * SYNC. One tiny json-store blob `audiobooks-progress-log`, same shape of deal as
 * the progress mirror: localStorage is the durable offline copy, the server copy
 * is merged in on boot (per book per night, the LARGER count wins — a log entry
 * only ever grows, so a merge can never lose a night), and the merged blob is
 * PUT back debounced. A full PUT rather than a deep-merge PATCH because the blob
 * is PRUNED (KEEP_DAYS) and a merge can't delete; single-device-at-a-time use
 * makes last-write-wins safe here exactly as it is for progress.
 */

import { LS_PROGRESS_LOG } from "./config.js";
import { apiFetch } from "./storage.js";

const API_BASE = "/kv/";
const LOG_KEY = "audiobooks-progress-log";
const PUSH_DEBOUNCE_MS = 4000;

/** The hour a "night" is filed under the previous date up to. */
export const DAY_ROLLOVER_H = 6;
/** Nights kept before pruning — comfortably past the "last few days" question. */
export const KEEP_DAYS = 30;
/**
 * Backstop for the paths that move a book without passing `noteSeek` — a save
 * bigger than this is one of those, not listening. Playback saves every
 * paragraph (player.js's own auto-advance) plus a 5 s watchdog, so a real step
 * is tens of seconds even at 3×; this sits far above that on purpose, because
 * the playing gate is what does the actual work and a cap tight enough to catch
 * seeks would start eating real reading off a throttled tab.
 */
export const MAX_SAMPLE_MIN = 3;

/** docKey -> dayKey -> { f: minutes advanced, b: minutes rewound } */
let log = loadLocal();
let ready = false; // server GET merged in (safe to PUT)
let pushTimer = null;
/** docKeys whose next sample is a seek's own save and must not be counted. */
const seekSkip = new Set();

/* ===================== day bucketing ===================== */

/**
 * The night `ts` belongs to, as "YYYY-MM-DD" in LOCAL time, rolling over at
 * DAY_ROLLOVER_H. Shifting the instant back by the rollover and then taking its
 * local date does the whole job — 01:20 shifts into the previous evening, 22:00
 * stays put — and it stays correct across a DST change, because the shift is
 * applied to the local clock reading, not to a fixed UTC offset.
 */
export function dayKey(ts) {
  const d = new Date(ts);
  d.setHours(d.getHours() - DAY_ROLLOVER_H);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The last `n` night keys ending with the one `nowTs` falls in, newest first. */
export function recentDayKeys(n, nowTs) {
  const out = [];
  const d = new Date(nowTs);
  d.setHours(d.getHours() - DAY_ROLLOVER_H);
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${day}`);
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/* ===================== local durability ===================== */

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_PROGRESS_LOG);
    if (raw) {
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) return sanitize(j);
    }
  } catch (_) {}
  return {};
}

function persistLocal() {
  try {
    localStorage.setItem(LS_PROGRESS_LOG, JSON.stringify(log));
  } catch (_) {}
}

/** Keep only well-formed { docKey: { dayKey: {f,b} } }, dropping anything else. */
function sanitize(blob) {
  const out = {};
  for (const [key, days] of Object.entries(blob)) {
    if (!days || typeof days !== "object" || Array.isArray(days)) continue;
    const kept = {};
    for (const [day, v] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (!v || typeof v !== "object") continue;
      const f = Number(v.f) || 0;
      const b = Number(v.b) || 0;
      if (f > 0 || b > 0) kept[day] = { f, b };
    }
    if (Object.keys(kept).length) out[key] = kept;
  }
  return out;
}

/** Drop nights older than KEEP_DAYS, and books left with none. */
function prune(nowTs) {
  const cutoff = recentDayKeys(KEEP_DAYS, nowTs).pop();
  for (const [key, days] of Object.entries(log)) {
    for (const day of Object.keys(days)) {
      if (day < cutoff) delete days[day];
    }
    if (!Object.keys(days).length) delete log[key];
  }
}

/* ===================== recording ===================== */

/** Minutes rounded to the tenth — the display precision, so the blob stays tiny. */
function round(n) {
  return Math.round(n * 10) / 10;
}

function bucket(docKey, ts) {
  const days = log[docKey] || (log[docKey] = {});
  const day = dayKey(ts);
  return days[day] || (days[day] = { f: 0, b: 0 });
}

/**
 * A deliberate jump is about to save. Suppress the one sample it produces, so
 * navigation is never mistaken for listening. Called from the seek funnel.
 */
export function noteSeek(docKey) {
  if (docKey) seekSkip.add(docKey);
}

/**
 * Record `mins` of listening advanced in `docKey`, from a save taken while
 * `playing` (i.e. `state.speaking && !state.paused`).
 *
 * THE PLAYING GATE IS THE REAL DEFENCE, and `noteSeek` + MAX_SAMPLE_MIN are the
 * backstops behind it. Minutes only exist if the voice was actually speaking
 * them, so every move made with playback stopped — dragging the 📍 slider,
 * stepping paragraphs before bed, jumping to a chapter to check something — is
 * excluded by construction rather than by being recognised. Recognising them was
 * the leak: a SHORT seek looks exactly like a long stretch of reading, so the
 * size cap alone let anything under it through.
 *
 * A non-playing save still consumes a pending suppression (see `noteSeek`), so a
 * flag can never sit there and swallow the first real minutes of the next
 * session.
 */
export function noteRead(docKey, mins, ts, playing) {
  if (!docKey) return;
  if (seekSkip.delete(docKey)) return; // this save belongs to a jump
  if (!playing) return; // nothing was being spoken, so nothing was listened to
  if (!(mins > 0) || mins > MAX_SAMPLE_MIN) return;
  const b = bucket(docKey, ts);
  b.f = round(b.f + mins);
  schedulePush(ts);
}

/** Record `mins` stepped BACK in `docKey` — the sleep-mode rewind. */
export function noteRewind(docKey, mins, ts) {
  if (!docKey || !(mins > 0)) return;
  const b = bucket(docKey, ts);
  b.b = round(b.b + mins);
  schedulePush(ts);
}

/** The whole log — `{ docKey: { dayKey: {f,b} } }`. Read-only to callers. */
export function progressLog() {
  return log;
}

/** One book's nights, or an empty object. */
export function daysFor(docKey) {
  return log[docKey] || {};
}

/**
 * Total minutes of listening ADVANCED across every book and every kept night —
 * the "horas acumuladas" headline on the ⚙️ Registro badge. Forward minutes only
 * (`f`): the badge answers "how much have I got through", so the sleep rewind
 * isn't subtracted. Bounded by KEEP_DAYS, like everything else in the blob.
 */
export function totalListenedMin() {
  let m = 0;
  for (const days of Object.values(log)) {
    for (const v of Object.values(days)) m += v.f || 0;
  }
  return m;
}

/** Test seam: forget everything (in memory and locally). */
export function resetLog() {
  log = {};
  seekSkip.clear();
  persistLocal();
}

/* ===================== sync ===================== */

/** Merge a server blob in: per book per night, the larger count wins. */
function mergeInto(base, incoming) {
  for (const [key, days] of Object.entries(sanitize(incoming))) {
    const mine = base[key] || (base[key] = {});
    for (const [day, v] of Object.entries(days)) {
      const cur = mine[day] || (mine[day] = { f: 0, b: 0 });
      cur.f = Math.max(cur.f, v.f);
      cur.b = Math.max(cur.b, v.b);
    }
  }
  return base;
}

/**
 * Pull the server blob and merge it in. Best-effort: a failure leaves the local
 * copy — and `ready` false, so nothing is PUT over data we failed to read.
 */
export async function refreshLog() {
  try {
    const r = await apiFetch(API_BASE + LOG_KEY, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!r.ok) return false;
    const j = await r.json();
    if (!j || typeof j !== "object" || Array.isArray(j)) return false;
    mergeInto(log, j);
    ready = true;
    persistLocal();
    return true;
  } catch (_) {
    return false;
  }
}

function schedulePush(ts) {
  prune(ts);
  persistLocal();
  if (!ready) return; // wait for the GET, or a PUT would drop other devices' nights
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    flushLog();
  }, PUSH_DEBOUNCE_MS);
}

function flushLog() {
  if (!ready) return;
  apiFetch(API_BASE + LOG_KEY, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    keepalive: document.visibilityState === "hidden",
    body: JSON.stringify(log),
  }).catch(() => {
    /* offline — localStorage holds it; the next night's first sample re-pushes */
  });
}

/** Push now if anything is pending — the pagehide flush rides along with this. */
export function flushLogNow() {
  if (!pushTimer) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  flushLog();
}

// Boot: pull + merge, then push once so last night's offline reading uploads.
(async () => {
  const ok = await refreshLog();
  if (ok) flushLog();
})();
