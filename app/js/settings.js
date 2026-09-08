/**
 * Cross-device synced settings — the global reading SPEED and both sleep-mode
 * NUMBERS (how long before it stops, how far it rewinds).
 *
 * Speed used to be per-device localStorage only; the operator asked for it to
 * survive a browser storage-wipe and to follow them across devices. Sleep mode's
 * "rewind N minutes when it auto-stops" was likewise made configurable and
 * device-following, and `sleepMin` joined them on 2026-07-31 — the pi-shell app
 * is a separate ORIGIN with its own empty localStorage, so it had quietly been
 * running the 40-min default for weeks while the 45 set in the Pi's browser face
 * sat where it could never reach. All three mirror to one tiny json-store blob
 * `audiobooks-settings` = `{ rate, sleepMin, rewindMin, sleepShortMin,
 * sleepShortRewind, sleepShortRate, voice }`.
 *
 * The three `sleepShort*` keys are the ⏱️ Corto preset's own numbers (the pair
 * 2026-08-04, its speed 2026-08-06), synced by the same argument as `sleepMin`:
 * how long a 3 a.m. run should be, and how fast it should read, are facts about
 * the reader. Its ARMING still does not travel — that is tonight's decision on one
 * handset, not a preference. `rate` is the LONG preset's speed: with ⏱️ Corto
 * armed the ⚡ slider is editing `sleepShortRate`, and main.js sends it there.
 *
 * WHAT DELIBERATELY DOES NOT SYNC: the 😴 on/off switch. The numbers describe the
 * person falling asleep; whether the watchdog is wanted at all describes the
 * device they fall asleep holding, and a laptop must not inherit the phone's
 * answer. The ⚙️ note says which is which, because a split nobody states is a
 * split discovered as a disagreement at 4 a.m.
 *
 * Every write is an ATOMIC per-key dict PATCH (json_store deep-merges just the
 * key(s) we send) — never a whole-blob PUT — so, exactly like the progress/queue
 * writes, a stale in-memory copy can never overwrite a key it didn't touch.
 *
 * The VOICE rides here too (`voice`: the engine+voice value, a string), because
 * the operator asked for the choice to follow them across devices. Volume stays
 * per-device on purpose — it depends on the hardware and on the room, not on
 * the reader.
 */

import { apiFetch } from "./storage.js";

const API_BASE = "/kv/";
const SETTINGS_KEY = "audiobooks-settings";
const PUSH_DEBOUNCE_MS = 600;

let pushTimer = null;
// key -> latest numeric value, all flushed together in one deep-merge PATCH.
const pending = Object.create(null);

/* ===================== who owns a control right now ===================== */

/**
 * Controls the reader has changed BY HAND this session. A synced pull must never
 * overwrite one.
 *
 * `pullSettings` is a boot fetch with no deadline: it can land seconds in, long
 * after the ⚙️ sheet is open and the speed slider has been dragged. When it did,
 * the server's value won — and that value is older BY DEFINITION, since the hand
 * change pushed over it 600 ms ago (see `pushSetting`'s debounce). The slider
 * snapped back under the finger and the reader's own choice was lost. A control
 * the reader has just set is theirs; the pull only fills in the ones they have
 * not touched.
 *
 * Session-scoped on purpose: the durable answer is the blob itself, which the
 * hand change has already pushed to.
 */
const handSet = new Set();

/** Record that the reader set this control themselves. */
export function markHandSet(id) {
  if (id) handSet.add(id);
}

/** Has the reader set this control themselves this session? */
export function isHandSet(id) {
  return handSet.has(id);
}

/** Test seam: forget every hand-set control. */
export function resetHandSet() {
  handSet.clear();
}

/**
 * Run `fn` once `modal` is shut — synchronously if it already is, or if there is
 * no such element.
 *
 * Rewriting a control while its sheet is OPEN is the app editing itself in front
 * of the reader: values move, the enhanced-select labels re-render, and none of
 * it was asked for. Deferring costs nothing, because a synced value only matters
 * when the control is next used.
 *
 * `hidden` is the modal's own open/shut state (modal.js), so watching the
 * attribute needs no new event — the same shape biblioteca.js uses to resync the
 * offline buffer on modal close. An environment without MutationObserver applies
 * immediately rather than never: a value that lands early beats one that is
 * dropped.
 */
export function whenClosed(modal, fn) {
  if (!modal || modal.hidden || typeof MutationObserver !== "function") {
    fn();
    return;
  }
  const obs = new MutationObserver(() => {
    if (!modal.hidden) return;
    obs.disconnect();
    fn();
  });
  obs.observe(modal, { attributes: true, attributeFilter: ["hidden"] });
}

/**
 * GET the settings blob once and hand the parsed object to `apply`. Best-effort:
 * any failure (store unreachable, absent key) leaves the per-device localStorage
 * values in place, so the app still works offline / on a local copy. Called on
 * boot AFTER the localStorage values are applied, so a synced value overrides
 * the local default when the server has one. `apply` should pick out and clamp
 * whichever keys it recognises ({ rate, sleepMin, rewindMin, voice }, …).
 */
export async function pullSettings(apply) {
  try {
    const r = await apiFetch(API_BASE + SETTINGS_KEY, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!r.ok) return;
    const j = await r.json();
    if (
      j &&
      typeof j === "object" &&
      !Array.isArray(j) &&
      typeof apply === "function"
    ) {
      apply(j);
    }
  } catch (_) {
    /* store unreachable — keep the local values */
  }
}

/**
 * Debounced ATOMIC push of one or more synced settings. Each call stages a key's
 * latest value; on the debounce edge every staged key goes out in ONE dict PATCH
 * that json_store deep-merges, touching only those keys. A stale/never-loaded
 * copy can therefore only set the keys it actually changed, never clobber the
 * blob. Offline is a no-op — localStorage already holds the values and the next
 * change re-pushes.
 *
 * Numbers are coerced (the speed slider hands over a string); non-empty strings
 * go as-is, which is what carries the voice id. Anything else — an empty string,
 * a NaN from a half-typed field — is dropped rather than written, so a bad value
 * can never propagate to the other devices.
 */
export function pushSetting(key, value) {
  if (!key) return;
  let v;
  if (typeof value === "string" && !/^\s*-?\d*\.?\d+\s*$/.test(value)) {
    if (!value.trim()) return;
    v = value;
  } else {
    v = Number(value);
    if (!Number.isFinite(v)) return;
  }
  pending[key] = v;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const body = {};
    for (const k of Object.keys(pending)) {
      body[k] = pending[k];
      delete pending[k];
    }
    apiFetch(API_BASE + SETTINGS_KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: document.visibilityState === "hidden",
      body: JSON.stringify(body),
    }).catch(() => {
      /* offline — localStorage holds it; the next change re-pushes */
    });
  }, PUSH_DEBOUNCE_MS);
}
