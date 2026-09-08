/**
 * "The app heard you and is working" — the feedback layer for everything that
 * takes long enough to be mistaken for a freeze.
 *
 * THE BUG THIS EXISTS FOR. Boot and the 📚 open both run multi-second blocks of
 * SYNCHRONOUS work on the main thread (a 14 MB catalog parsed, then five passes
 * over ~88 000 entries; an 88k collator sort on the first render). While one of
 * those runs the page still accepts taps — the modal even opens, because that is
 * a style change the compositor can make on its own — but nothing else moves,
 * and the reader reads it as a broken app rather than a busy one.
 *
 * Two rules come out of that, and this module is what makes both cheap:
 *
 * 1. **The spinner must animate on the COMPOSITOR, not the main thread.** A
 *    `transform: rotate` (or `opacity`) animation keeps running while JS blocks;
 *    anything driven by a timer, a text swap, or an emoji frame freezes with the
 *    rest of the page and becomes the very thing it was meant to disprove. That
 *    is why `.spin` in `_base.css` animates transform and nothing else.
 *
 * 2. **The spinner has to be PAINTED before the block starts.** Setting a class
 *    and then synchronously grinding in the same task shows the user nothing:
 *    the browser never gets a frame in between. `nextPaint()` is the wait for
 *    that frame, and `withBusyOverlay` bakes it in so a caller cannot forget it.
 *
 * The shape this settled on: ONE spinner, the centered overlay below. Per-control
 * rings — a spinner nested inside the button or chip you pressed — are gone by
 * request; the reader found them noise. So every wait routes to the same curtain,
 * and `spinnerLine` (an in-slot "still loading" row for a list/card) is the only
 * other place a `.spin` appears.
 */

/** Class on the small rotating ring (see `.spin` in css/_base.css). */
const SPIN_CLASS = "spin";

/**
 * A spinner + label row for an empty list / card slot ("still loading", not
 * "nothing here"). `role="status"` so a screen reader is told too — the ring is
 * `aria-hidden`, since a spinning graphic announces nothing on its own.
 */
export function spinnerLine(text, className = "") {
  const row = document.createElement("div");
  row.className = `loading-line${className ? ` ${className}` : ""}`;
  row.setAttribute("role", "status");
  const ring = document.createElement("span");
  ring.className = SPIN_CLASS;
  ring.setAttribute("aria-hidden", "true");
  row.appendChild(ring);
  const label = document.createElement("span");
  label.textContent = text;
  row.appendChild(label);
  return row;
}

/**
 * Resolve after the browser has had a chance to PAINT.
 *
 * Two frames, not one: work queued in a `requestAnimationFrame` callback still
 * runs BEFORE that frame's paint, so a single rAF would put the heavy block
 * right back in front of the pixels it is waiting for. The second callback can
 * only run once the first frame has been committed.
 *
 * Degrades to an already-resolved promise where there is no rAF (the test shim,
 * a worker) — the caller's `await` then simply costs a microtask.
 */
export function nextPaint() {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    raf(() => raf(() => resolve()));
  });
}

/* A single MessageChannel, reused: `postMessage` is a macrotask with no clamp,
   unlike `setTimeout(0)`, which the browser floors at ~4 ms once a few of them
   nest — a slicing loop that yields twenty times would pay 80 ms of pure sleep
   for it. Resolvers queue in order, so concurrent yielders can't steal each
   other's turn.

   Gated on `requestAnimationFrame`, which is the honest test for "this
   environment has a rendering loop to yield TO". Under Node (the test shim) an
   open MessagePort is a live handle that keeps the event loop alive, so taking
   this path there hangs the process after the last test rather than exiting —
   and there is no frame budget to protect in the first place. */
let chan = null;
const waiting = [];

function macrotask() {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (chan === null && typeof MessageChannel === "function") {
    chan = new MessageChannel();
    chan.port1.onmessage = () => {
      const next = waiting.shift();
      if (next) next();
    };
  }
  if (!chan) return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    waiting.push(resolve);
    chan.port2.postMessage(0);
  });
}

/**
 * Hand the main thread back so queued input, rendering and the compositor get a
 * turn, then continue. `scheduler.yield()` where it exists (it resumes at a
 * higher priority than a fresh task, so a sliced loop is not starved by every
 * unrelated timer that piled up); a MessageChannel hop otherwise.
 */
export function yieldToMain() {
  const s = globalThis.scheduler;
  if (s && typeof s.yield === "function") return s.yield();
  return macrotask();
}

/** ~One frame's worth of work between yields: long enough that the slicing
 *  overhead is noise, short enough that a tap is never held up perceptibly. */
const SLICE_MS = 12;

const now = () =>
  typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * `items.forEach(fn)` broken into ~`budgetMs` slices, yielding to the main
 * thread in between. This is what turns "the app is frozen for two seconds" into
 * "the app is a little slower for two seconds" — the taps that arrive during it
 * are handled between slices instead of after the whole pass.
 *
 * The clock is only read every 256 items: `performance.now()` per element would
 * be a measurable share of the loop it is timing.
 */
export async function sliceForEach(items, fn, budgetMs = SLICE_MS) {
  const list = items || [];
  let start = now();
  for (let i = 0; i < list.length; i++) {
    fn(list[i], i);
    if ((i & 0xff) === 0xff && now() - start >= budgetMs) {
      await yieldToMain();
      start = now();
    }
  }
  return list;
}

/* ===================== the centered, blocking overlay =====================
 *
 * The ONE spinner in this app. There is deliberately no per-control ring: a
 * spinner tucked into a button (a chip, 📚) was the thing the reader asked us to
 * kill outright. Every wait long enough to need feedback — opening the library
 * onto the 88k sort/render that freezes the thread, re-filtering or re-sorting
 * it, pressing ▶ onto a Piper synthesis that produces no audio for seconds —
 * raises THIS: one centered curtain, and nothing on the control itself.
 *
 * It also earns its keep as a curtain. A second press during one of these waits
 * does not queue more work worth doing; it queues a SECOND reader, or a second
 * open — the very "two readings intertwined" report this exists to kill — so the
 * overlay swallows taps while it is up. The two halves are split on purpose:
 *
 *  - The backdrop is up IMMEDIATELY (`.is-active`), transparent, swallowing taps
 *    from the first frame. That is the part the reader asked for by name: once
 *    the action is in flight, a second tap must land on nothing.
 *  - The DIM + the spinner are delay-gated (`.is-shown` after `revealDelayMs`).
 *    An action that finishes inside the delay flashes no spinner at all — the
 *    backdrop went up and came down between two frames, invisibly — so the common
 *    warm case pays no visible curtain, only the genuinely slow one does.
 *
 * One element, ref-counted, because a play-overlay and a library-overlay could in
 * principle overlap and the first to finish must not tear the other's curtain
 * down. The spinner is the same compositor-animated `.spin` as everywhere else,
 * so it keeps turning through the very main-thread block it is reporting. */

let overlayEl = null;
let overlayDepth = 0;
let overlayRevealTimer = null;

function ensureOverlay() {
  if (typeof document === "undefined" || !document.body) return null;
  // Cached in the browser (the element is a permanent child of <body>); rebuilt
  // only when it is not in the current body — which never happens in the browser
  // but does under the test shim, where each case installs a fresh document.
  if (overlayEl && overlayEl.parentNode === document.body) return overlayEl;
  overlayEl = null;
  const el = document.createElement("div");
  el.className = "busy-overlay";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  const box = document.createElement("div");
  box.className = "busy-overlay-box";
  const ring = document.createElement("span");
  ring.className = `${SPIN_CLASS} busy-overlay-ring`;
  ring.setAttribute("aria-hidden", "true");
  box.appendChild(ring);
  const label = document.createElement("span");
  label.className = "busy-overlay-label";
  box.appendChild(label);
  el.appendChild(box);
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}

/** Update the line under the spinner (e.g. a download percentage) while up. */
export function setBusyOverlayLabel(text) {
  if (!overlayEl) return;
  const label = overlayEl.querySelector(".busy-overlay-label");
  if (label) label.textContent = text || "";
}

/**
 * Raise the blocking overlay and return its release fn.
 *
 * Blocks taps on the very next frame (`is-active`). The dim + spinner
 * (`is-shown`) come up on a schedule set by `revealDelayMs`:
 *
 *  - `> 0` — DELAY-GATED. Reveal only if the overlay is still up after the
 *    delay, so a fast/warm action flashes nothing. Right for an ASYNC wait that
 *    leaves the thread free to fire the timer — ▶ onto a Piper synthesis.
 *  - `<= 0` — IMMEDIATE. Reveal synchronously, now, so a paint can put the
 *    curtain on screen BEFORE a SYNCHRONOUS block that would otherwise hold the
 *    thread past any timer (the 88k filter/sort). `withBusyOverlay` uses this and
 *    lets a frame through before the work.
 *
 * Ref-counted: the curtain drops when the LAST holder releases, and every
 * release is idempotent.
 */
export function showBusyOverlay({ label = "", revealDelayMs = 180 } = {}) {
  const el = ensureOverlay();
  overlayDepth += 1;
  if (el) {
    setBusyOverlayLabel(label);
    el.classList.add("is-active");
    el.setAttribute("aria-busy", "true");
    if (revealDelayMs <= 0) {
      // A synchronous block is about to start; the timer could not fire until it
      // was over. Reveal now and let the caller paint before it blocks.
      el.classList.add("is-shown");
    } else if (overlayRevealTimer === null && !el.classList.contains("is-shown")) {
      overlayRevealTimer = setTimeout(() => {
        overlayRevealTimer = null;
        if (overlayEl && overlayEl.classList.contains("is-active")) {
          overlayEl.classList.add("is-shown");
        }
      }, revealDelayMs);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    overlayDepth = Math.max(0, overlayDepth - 1);
    if (overlayDepth > 0) return;
    if (overlayRevealTimer !== null) {
      clearTimeout(overlayRevealTimer);
      overlayRevealTimer = null;
    }
    if (overlayEl) {
      overlayEl.classList.remove("is-shown");
      overlayEl.classList.remove("is-active");
      overlayEl.removeAttribute("aria-busy");
      setBusyOverlayLabel("");
    }
  };
}

/**
 * Run `work` under the blocking overlay, dropping it whatever `work` does — a
 * frame is let through first (via the reveal gate), so the curtain is on screen
 * before any synchronous block starts. The wrapper for every action that must
 * not stay pressable while it works.
 */
export async function withBusyOverlay(work, opts) {
  // Immediate reveal + a painted frame first: these callers (the 88k filter/sort)
  // block the thread synchronously, so the curtain has to be ON SCREEN before the
  // block, not scheduled to appear during it. A caller can still override
  // `revealDelayMs` to opt back into the delay-gated behaviour.
  const release = showBusyOverlay({ revealDelayMs: 0, ...opts });
  try {
    await nextPaint();
    return await work();
  } finally {
    release();
  }
}
