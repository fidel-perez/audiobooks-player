/**
 * ONE READER AT A TIME, across every window of this app on this browser.
 *
 * Nothing else in the app coordinates instances, and Piper is deliberately built
 * so a HIDDEN page keeps reading: the audio comes out of a real <audio> element,
 * which the browser keeps running with the screen off or the tab in the
 * background (that is the whole reason the device voice was replaced). So a
 * window left playing does not stop being a reader just because you cannot see
 * it — and this app is normally open twice, because the installed PWA is a
 * separate window from the Chrome tab it was installed from.
 *
 * Press ▶ in the second one and BOTH read the same book, each advancing its own
 * paragraphs and each saving its own position. What you hear is two readings
 * intertwined; what the synced progress gets is the two of them overwriting each
 * other. Inside one page this cannot happen — `speakGen` retires every stale
 * callback and the audio graph pauses the playing element before it starts
 * another — but neither of those guards can see across windows.
 *
 * So: pressing ▶ CLAIMS playback, out loud. Every other window of this origin
 * hears the claim and pauses itself, exactly as if its ⏸ had been pressed, which
 * saves its place. Last ▶ wins, which is what the person tapping it means. A
 * paused window never reaches `advance`, so a ghost can never take the reading
 * back on its own.
 *
 * BroadcastChannel is the channel; a `storage` event is the fallback for a
 * browser without it (the write is what the other windows see — the writing
 * window gets no event of its own, which is exactly the semantics wanted).
 *
 * ---
 *
 * AND THE HALF THAT CHANNEL CANNOT REACH. Both mechanisms above are scoped to
 * the ORIGIN. The pi-shell serves its pages from `piapp.localhost` and the Pi's
 * own faces are ordinary http origins, so the installed app and a browser tab on
 * the same book are two readers that cannot hear each other's claim at all —
 * exactly the case this module exists to stop, in the one configuration where it
 * was silently absent. The only thing those two share is the json store they
 * already sync progress through, so the claim goes there too: ▶ PUTs
 * `/api/audiobooks-reader`, and a window that is reading polls it and stands
 * down when it finds someone else's id.
 *
 * THREE THINGS KEEP THAT FROM PAUSING A BOOK NOBODY IS COMPETING FOR:
 *
 *  - a window polls only after ITS OWN claim was accepted by the server, so a
 *    stale claim left by yesterday's window can never be read as "newer";
 *  - it is scoped to the docKey. Two windows of one browser share a pair of
 *    speakers, so there the last ▶ wins whatever the book — but the server claim
 *    spans DEVICES, and the phone reading one book while the desktop reads
 *    another is two people in two rooms, not a conflict;
 *  - offline it does nothing. The PUT fails, no poll starts, and playback is
 *    exactly what it was before this existed.
 *
 * Identity, not timestamps: two devices' clocks disagree, and a claim ruled
 * "newer" by a fast clock would pause the window the reader is actually holding.
 * The last write to land wins, which is the same "last ▶ wins" the local half
 * already means.
 */

import { apiFetch } from "./storage.js";

const CHANNEL = "audiobooks:playback";
const LS_CLAIM = "audiobooks:playbackClaim";
/** The shared claim, in the same store the progress map lives in. */
const CLAIM_PATH = "/kv/audiobooks-reader";
/** How often a reading window asks whether the book was taken from it. */
const POLL_MS = 15000;

/**
 * Who this window is. The claim has to be ignorable by its sender: a
 * BroadcastChannel does not echo to itself, but the storage fallback shares one
 * key with every window, so identity is what keeps a claim from pausing the very
 * window that made it.
 */
const meId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let chan;
let onStolen = null;

function handle(msg) {
  if (!msg || msg.type !== "claim" || msg.id === meId) return;
  if (onStolen) onStolen();
}

/** The channel, or null on a browser without one. Opened once, lazily. */
function channel() {
  if (chan !== undefined) return chan;
  chan = null;
  try {
    if (typeof BroadcastChannel === "function") {
      chan = new BroadcastChannel(CHANNEL);
      chan.onmessage = (e) => handle(e?.data);
      // Node (the tests) keeps the event loop alive for an open channel; the
      // browser has no such method and does not need one.
      if (typeof chan.unref === "function") chan.unref();
    }
  } catch (_) {
    chan = null;
  }
  if (!chan && typeof addEventListener === "function") {
    // Only when there is no channel: a browser with both would deliver the same
    // claim twice, and while pausing twice is harmless it is noise to debug.
    addEventListener("storage", (e) => {
      if (e?.key !== LS_CLAIM || !e.newValue) return;
      try {
        handle(JSON.parse(e.newValue));
      } catch (_) {}
    });
  }
  return chan;
}

/**
 * Say what to do when ANOTHER window claims playback. One callback, replaced
 * rather than added to, so wiring it twice cannot pause the book twice.
 */
export function setOnPlaybackStolen(cb) {
  onStolen = typeof cb === "function" ? cb : null;
  channel(); // start listening from the moment somebody cares
}

/**
 * This window is about to read `docKey`: tell the others to stop. Fire-and-forget
 * — a blocked BroadcastChannel, a full localStorage or an unreachable store must
 * never stop playback.
 */
export function claimPlayback(docKey = "") {
  const msg = { type: "claim", id: meId, at: Date.now(), docKey };
  try {
    channel()?.postMessage(msg);
  } catch (_) {}
  try {
    localStorage.setItem(LS_CLAIM, JSON.stringify(msg));
  } catch (_) {}
  claimAcrossOrigins(msg);
}

/**
 * This window has stopped reading, so stop asking whether it still holds the
 * book. The claim itself STAYS on the server: it is the record of who read last,
 * and clearing it would leave the next window with nothing to lose to.
 */
export function releasePlayback() {
  stopPolling();
}

/* =============== the cross-origin half: one claim in the store =============== */

let pollTimer = null;
/** The book this window is watching the shared claim for, or null when it is not
 *  reading — or when its own claim never reached the store, which is the same
 *  thing as far as standing down goes. */
let watching = null;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  watching = null;
}

/** Take the shared claim, and watch it only if the store actually took it. */
function claimAcrossOrigins(msg) {
  stopPolling();
  apiFetch(CLAIM_PATH, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ id: msg.id, at: msg.at, docKey: msg.docKey || "" }),
  })
    .then((r) => {
      // Offline, or a store that refused: no claim of ours is up there, so
      // whatever IS up there is not something we can tell we lost to — it may
      // well be yesterday's. Stay silent and keep reading.
      if (r?.ok) watchClaim(msg.docKey || "");
    })
    .catch(() => {});
}

function watchClaim(docKey) {
  watching = docKey;
  pollTimer = setInterval(checkClaim, POLL_MS);
  // Node (the tests) keeps the event loop alive for a pending interval; the
  // browser has no such method and does not need one.
  if (typeof pollTimer?.unref === "function") pollTimer.unref();
}

/**
 * One round: is the book still ours? Resolves to true when this window stood
 * down. Never throws — an unreachable store leaves the local half in charge,
 * exactly as before this existed.
 */
async function checkClaim() {
  if (watching === null) return false;
  const docKey = watching;
  let held;
  try {
    // `no-store` because a cached claim is a claim from the past, and acting on
    // one would pause a book nobody took. sw.js keeps this path network-only for
    // the same reason.
    const r = await apiFetch(CLAIM_PATH, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!r?.ok) return false;
    held = await r.json();
  } catch (_) {
    return false; // unreachable store → the local half is all we have, as before
  }
  if (!held || typeof held !== "object") return false;
  // An absent document reads as `{}` (json_store answers 200 for one that was
  // never written), and an empty claim belongs to nobody — matching it against
  // an empty docKey would have a window stand down to a store with nothing in it.
  if (typeof held.id !== "string" || !held.id) return false;
  if (held.id === meId) return false; // still ours
  if ((held.docKey || "") !== docKey) return false; // another device, another book
  stopPolling();
  if (onStolen) onStolen();
  return true;
}

/** Test seam: run one round now instead of waiting out the poll interval. */
export function pollClaimOnce() {
  return checkClaim();
}

/** Test seam: this window's identity. */
export function instanceId() {
  return meId;
}
