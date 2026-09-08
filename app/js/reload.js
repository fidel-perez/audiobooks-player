/**
 * Reload gate: never refresh on top of an in-flight progress upload, and never
 * refresh into a page the network can't serve.
 *
 * Two things reload this app — tapping the build line ("nueva versión — toca
 * para actualizar") and the `controllerchange` handler in index.html when a new
 * service worker takes over. On the tap that finds a real update they are the
 * SAME event: the tap asks the worker to update, and the update is what fires
 * controllerchange. Both must therefore route through here, and only the first
 * of them may navigate — see the `reloading` latch below.
 *
 * Either can also land while progress.js still holds edits
 * the server hasn't confirmed; the reload then kills the in-flight PATCH and its
 * retry timer mid-flight. The map itself is durable (localStorage + IndexedDB, and
 * the boot pull re-pushes it), so nothing is LOST — but the upload the user is
 * watching silently doesn't finish, which is exactly what the sync banner exists
 * to make visible.
 *
 * So: while unsynced, defer the reload and say so. `syncNow()` kicks a pull+push
 * immediately, so an ONLINE device confirms within a round-trip and reloads on its
 * own — no deadlock. An offline device keeps the "activa Internet" banner and its
 * 6 s retry loop, and simply never auto-reloads; the user can close the tab.
 *
 * THE SECOND GATE. A confirmed push proves the json store was reachable for one
 * PATCH. It does NOT prove the shell is fetchable: `online` fires the moment the
 * radio associates, before the route (or the tailnet tunnel) is up. Reconnecting
 * at the end of a night's offline reading, the progress PATCH squeezed through,
 * the deferred reload fired, the navigation found no route — and the browser
 * painted its own "connect to the Internet" error page over a perfectly healthy
 * app. The service worker now falls back to the cached shell (sw.js
 * `navigationFirst`), so that page can no longer appear; this second gate means
 * we don't even lean on that fallback. Probe the shell over the real network
 * first, and hold the reload until it answers.
 *
 * THE THIRD GATE — NEVER ON TOP OF A BOOK THAT IS BEING READ. An automatic
 * refresh (the pi-shell's "a bundle moved", the service worker's takeover) is
 * only ever worth taking at a moment that costs nothing, and mid-paragraph is
 * the most expensive moment there is: the reload drops the Piper engine and the
 * whole read-ahead — measured on the phone, 20 to 40 seconds of silence before
 * the first word comes back — and the app returns at the LAST SAVED word, which
 * the 5 s autosave leaves up to a paragraph behind. So the reader hears a long
 * load and then the paragraph they had just heard, again, per reload.
 *
 * Both automatic callers believe they already check this, and neither can:
 *
 *   - pi-shell's `takeTheUpdate` asks its own `anyPlaying()`, which is "is an
 *     <audio> element unpaused". Under Piper that is FALSE at every paragraph
 *     seam and for the whole of every synthesis (there is no keep-alive element
 *     on this engine — see player.js#play — and a cold synthesis on the phone's
 *     single WASM thread runs tens of seconds). Its comment still describes the
 *     device voice's looping keep-alive, which Piper does not have.
 *   - the service worker's `controllerchange` never looked at playback at all.
 *
 * And the two gates above make it worse rather than better: a night of OFFLINE
 * reading holds the reload as unsynced, so it does not fire when it was asked
 * for — it fires hours later, the moment the network returns, which is squarely
 * in the middle of the next morning's listening. That is the reported "it plays
 * a paragraph or two, then plays them again, and takes ages loading".
 *
 * So the reload waits for silence, asked of the PLAYER's own state rather than
 * of the audio element: `speaking && !paused` stays true across a seam and
 * across a synthesis, which is exactly the span that must not be interrupted. A
 * reader's own tap on the build line is NOT gated — that one is a deliberate ask.
 */

import { showSyncBanner } from "./dom.js";
import { hasUnsyncedProgress, onSyncConfirmed, syncNow } from "./progress.js";
import { state } from "./state.js";

let pending = false;

/**
 * Has a reload already been committed?
 *
 * `location.reload()` does not stop the script that called it — the navigation
 * is queued and the current turn runs on. So two paths that both decide to
 * refresh (the ⚙️ build line's tap AND the service-worker takeover it triggers)
 * each get their call in, and the browser performs BOTH: the app visibly loads,
 * then loads again. Every reload in this app goes through here, so one latch
 * covers every combination of them.
 */
let reloading = false;

/**
 * Is this reload one nobody asked for? Latched by the window hook the pi-shell
 * and the service worker call, and never cleared: once an automatic refresh is
 * in the pipeline every step of it — including the one the sync confirm fires
 * hours later — has to keep waiting for silence.
 */
let automatic = false;

/** Is the player mid-book right now? True across seams and syntheses. */
const isReading = () => !!(state.speaking && !state.paused);

// How long to wait before re-asking whether the book has stopped. The reader is
// listening, so this is deliberately quiet: no banner, no status line.
// `__RELOAD_SILENCE_RETRY_MS` is a test hook, as in piper.js; real clients never
// set it and get the full interval.
const SILENCE_RETRY_MS = 5000;
const silenceRetryMs = () => Number(globalThis.__RELOAD_SILENCE_RETRY_MS) || SILENCE_RETRY_MS;
let silenceTimer = null;

function doReload() {
  if (reloading) return;
  if (automatic && isReading()) {
    // Not now. Re-ask until the book stops — a pause, the end of a chapter, the
    // sleep-mode auto-stop. The update simply arrives at the next quiet moment,
    // which is the whole design of the shell's own gate.
    if (silenceTimer === null) {
      silenceTimer = setInterval(() => {
        if (reloading || isReading()) return;
        clearInterval(silenceTimer);
        silenceTimer = null;
        doReload();
      }, silenceRetryMs());
    }
    return;
  }
  reloading = true;
  location.reload();
}

/** Has the page already committed to refreshing? Lets a caller skip its own. */
export function reloadCommitted() {
  return reloading;
}

// How long to wait before re-probing a shell that wasn't reachable yet. Long
// enough not to hammer a warming tunnel, short enough that the app refreshes
// itself within a moment of the network genuinely coming back.
const SHELL_RETRY_MS = 3000;

/**
 * Can we actually FETCH the app shell right now? `?_bust=` makes the service
 * worker pass the request straight to the network (see sw.js), so a cached shell
 * can't answer "yes" on our behalf — which is the whole point: we are asking
 * about the network, not about the cache.
 */
async function shellReachable() {
  try {
    const r = await fetch(`index.html?_bust=${Date.now()}`, {
      method: "HEAD",
      cache: "no-store",
    });
    return !!(r && r.ok);
  } catch (_) {
    return false;
  }
}

/** Reload once the shell answers over the network; retry quietly until it does. */
async function reloadWhenShellReachable() {
  if (await shellReachable()) {
    doReload();
    return;
  }
  showSyncBanner("✅ Progreso guardado — esperando red para recargar.");
  setTimeout(reloadWhenShellReachable, SHELL_RETRY_MS);
}

/**
 * Reload now if the progress map is synced; otherwise show the banner, wait for
 * the confirming push, and reload then. Returns true when the reload was DEFERRED
 * (so a caller like the controllerchange handler knows the page is staying put).
 * Idempotent: further presses while deferred re-show the banner and do nothing
 * else, since the pending reload already fires on the next confirm.
 *
 * The immediate path stays synchronous: nothing is pending, the user asked for a
 * refresh, and if the network is down the SW serves the cached shell.
 */
/**
 * The automatic entry point: the pi-shell's "a bundle moved" announcement and
 * the service worker's takeover. Same gate chain as the tap, plus the wait for
 * silence — see THE THIRD GATE above.
 */
export function reloadWhenSyncedIfIdle() {
  automatic = true;
  return reloadWhenSynced();
}

/** Test seam: is a reload parked waiting for the book to stop? */
export function waitingForSilence() {
  return silenceTimer !== null;
}

export function reloadWhenSynced() {
  // A navigation is already committed, so there is nothing left to hold back —
  // false, not true: the caller would otherwise paint "waiting for sync" over a
  // page that is on its way out.
  if (reloading) return false;
  if (!hasUnsyncedProgress()) {
    doReload();
    return false;
  }
  showSyncBanner("⏳ Subiendo progreso… se recargará al terminar.");
  if (pending) return true;
  pending = true;
  onSyncConfirmed(() => reloadWhenShellReachable());
  syncNow(); // online → confirms in one round-trip; offline → retry loop + banner
  return true;
}
