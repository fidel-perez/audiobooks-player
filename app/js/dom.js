/**
 * Tiny DOM helpers shared across modules.
 */

export const $ = (id) => document.getElementById(id);

export const isAndroid = /android/i.test(navigator.userAgent);

/**
 * Write a status line.
 *
 * It still lands in #status — the line the app shows when NO book is loaded —
 * but while a book IS loaded that line is hidden behind the active-book card
 * (catalog.js paintActiveBookCard), and then the text goes to the toast
 * instead. Exactly one surface is visible at any moment, so nothing is said
 * twice and nothing is said into the void.
 *
 * The `#status.hidden` gate is load-bearing, not incidental: it is what "toast
 * whatever the card is hiding" means. Anything that leaves #status VISIBLE while
 * a card is up keeps its message on the raw line and gets no toast — so un-hide
 * BEFORE writing (main.js's skipped-docs warning; library.js's cleared event),
 * never after, or the message lands in both places.
 */
export function setStatus(text) {
  const el = $("status");
  if (el) el.textContent = text;
  if (el && el.hidden) showToast(text);
}

/**
 * Persistent sync banner (bottom of the main screen, under #toast): shown while
 * there is unsynced progress that can't reach the server, so the user knows to
 * enable Internet. Unlike #status (transient, hidden behind the active-book card
 * while reading), this bar stays put across playback until a push confirms.
 * Null-safe so a module import under the test shim never throws.
 */
export function showSyncBanner(text) {
  const el = $("syncBanner");
  if (!el) return;
  if (text) el.textContent = text;
  el.hidden = false;
}

export function hideSyncBanner() {
  const el = $("syncBanner");
  if (el) el.hidden = true;
}

/* ===================== toast ===================== */

/**
 * The status line you can actually SEE.
 *
 * While a book is loaded the active-book card covers #status, so every
 * setStatus() during a reading session went into a hidden div: the whole
 * end-of-book auto-advance ("🔜 Siguiente en la cola: X", "🎲 Auto: X"), every
 * load error, the sleep warnings. A book ended and the next one started speaking
 * with nothing on screen to say why.
 *
 * #toast is a slot of its own under the card. It is NOT #status (the card
 * deliberately supersedes that line) and it is NOT the card (which is the book's
 * identity, not a log). Null-safe, like the banner above.
 */
const TOAST_MS = 6000;

/** The auto-advance line has to survive being READ and ACTED ON — a phone in a
 *  pocket at the end of a chapter. Long enough to catch, short enough to go away. */
export const TOAST_UNDO_MS = 20000;

// #toast lives UNDER the player card, so any open modal (z-index 1000) paints
// straight over it: a surface that opens a modal cannot report through here at
// all, and must use a dialog instead (see bulkQueueButton in catalog.js).
let toastTimer = null;

/**
 * Show `text` for `ms`. `undo` — `{ label, onUndo }` — adds the one control the
 * toast may carry: a back-out button. Non-destructive by contract (the player
 * never grows a one-tap destructive control).
 */
export function showToast(text, { ms = TOAST_MS, undo = null } = {}) {
  const el = $("toast");
  if (!el) return;
  if (toastTimer) clearTimeout(toastTimer);
  el.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = text;
  el.appendChild(msg);
  if (undo) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-undo";
    b.textContent = undo.label;
    b.addEventListener("click", () => {
      hideToast(); // one shot: the line goes with the tap
      undo.onUndo();
    });
    el.appendChild(b);
  }
  el.hidden = false;
  toastTimer = setTimeout(hideToast, ms);
}

export function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  const el = $("toast");
  if (!el) return;
  el.innerHTML = "";
  el.hidden = true;
}
