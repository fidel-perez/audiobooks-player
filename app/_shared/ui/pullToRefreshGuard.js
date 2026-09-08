/**
 * A pull-down at the top of the page never reloads the app.
 *
 * Every app here is a single-page PWA holding live state a reload destroys —
 * audiobooks loses playback position and a warm voice model, todoapp and
 * macrotrackingapp lose an open edit. The browser's native pull-to-refresh
 * gesture is indistinguishable from an ordinary scroll-up-past-the-top, which
 * happens constantly while reading a long transcript or a long task list. So
 * the gesture is pure downside for us: there is nothing it can usefully do that
 * the app doesn't already do on its own.
 *
 * WHY CSS IS NOT ENOUGH. `overscroll-behavior-y: contain` on html/body is the
 * documented fix and it works on Chromium. WebKit shipped the property but
 * deliberately does NOT let it cancel the top pull-to-refresh gesture, so on
 * iOS Safari the CSS silently does nothing and the app reloads anyway. That is
 * the failure this module exists for. It sets the CSS itself (so an app needs
 * no stylesheet change to be covered) AND installs the touch guard WebKit
 * requires, which is a no-op on browsers the CSS already handled.
 *
 * WHY IT DOESN'T BREAK INNER SCROLLERS. The guard only cancels a touchmove when
 * the scroll container the finger actually started in is already at its top and
 * the finger is moving DOWN — i.e. exactly the overscroll that would trigger the
 * refresh, and never a real scroll. A modal body mid-scroll, an upward drag, and
 * a multi-touch pinch are all left alone. The listener must be non-passive to
 * be able to preventDefault at all; it is attached once, at the document, and
 * does no work beyond a scrollTop read per move.
 *
 * NOTE ON STANDALONE PWAs: an installed home-screen PWA has no pull-to-refresh
 * on either platform, so the guard is redundant there — but the same page is
 * also opened in a normal tab, which is where the reloads were coming from.
 *
 * WHY THE MODAL RULE LIVES HERE. A modal with nothing of its own to scroll
 * turns every drag inside it into page scroll: the browser's scroll chain
 * walks out of the overlay and moves the page behind it. That needs one more
 * question per touchmove, and a SECOND document-level touchmove listener
 * asking it would race this one over the same events — so the modal rule is a
 * branch in this listener, decided from state touchstart already collected.
 * The overlay list is modal-top.css's, and
 * tests/modal-scroll-page-frozen.test.js pins the two lists equal.
 */

/** Nearest ancestor of `el` that can actually scroll vertically, or null. */
function scrollableAncestor(el, doc) {
  const win = doc.defaultView;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    // A scroller must both overflow AND be allowed to scroll. Checking only
    // scrollHeight > clientHeight matches `overflow: hidden` elements, which
    // don't scroll and would wrongly suppress the guard for everything inside.
    if (node.scrollHeight > node.clientHeight) {
      const overflowY = win.getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return node;
    }
  }
  return null;
}

/**
 * The overlay elements an open modal is built from: modal-top.css's class list
 * plus the `dialog:modal` rule at the foot of that file (pitasks and notavoz
 * build modals on `<dialog>`, the rest on the classes). A closed modal is
 * display:none, so a touch can only START inside an open one and there is no
 * open-state to track. Tests pin this list to modal-top.css's.
 */
export const MODAL_SELECTOR =
  ".modal-overlay, .modal-backdrop, .modal, dialog:modal";

/** Nearest ancestor of `el` that is a modal overlay, or null. */
function modalAncestor(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.matches && node.matches(MODAL_SELECTOR)) return node;
  }
  return null;
}

/**
 * Install the guard. Idempotent per document — calling it twice wires one set
 * of listeners, so an app can call it from more than one entry point safely.
 *
 * @param {object}   [opts]
 * @param {Document} [opts.doc]  Injectable for tests.
 * @returns {{destroy: Function}}
 */
export function installPullToRefreshGuard({ doc = globalThis.document } = {}) {
  const noop = { destroy() {} };
  if (!doc || !doc.addEventListener) return noop; // Node shim in tests/_shim.js
  if (doc.__pullToRefreshGuard) return doc.__pullToRefreshGuard;

  // Belt: correct on Chromium, and covers apps with no stylesheet change.
  // `contain` (not `none`) so inner scrollers still stop at their own edge
  // instead of chaining, while horizontal gestures are untouched.
  if (doc.documentElement && doc.documentElement.style) {
    doc.documentElement.style.overscrollBehaviorY = "contain";
  }

  let startY = 0;
  /** The scroller the gesture began in — null means the page itself. */
  let scroller = null;
  /** The modal overlay the gesture began in — null means the page itself. */
  let modal = null;
  let tracking = false;

  const onTouchStart = (e) => {
    // Multi-touch is a pinch/zoom, never a pull-to-refresh. Leave it alone.
    tracking = e.touches && e.touches.length === 1;
    if (!tracking) return;
    startY = e.touches[0].clientY;
    scroller = scrollableAncestor(e.target, doc);
    modal = modalAncestor(e.target);
  };

  const onTouchMove = (e) => {
    if (!tracking || !e.touches || e.touches.length !== 1) return;

    // Inside a modal whose nearest scroller lies OUTSIDE it — a modal with
    // nothing of its own to scroll — the drag would scroll the page behind
    // the modal, in either direction, so it is cancelled outright. A modal
    // with its own scroller (a long body, or macrotrackingapp's overflow:auto
    // backdrop) falls through and is left to scroll below.
    if (modal && !(scroller && modal.contains(scroller))) {
      if (e.cancelable) e.preventDefault();
      return;
    }

    // Positive delta = finger moving DOWN the screen = content pulled down.
    // Only that direction can trigger the refresh; an upward drag is a normal
    // scroll and must never be cancelled.
    if (e.touches[0].clientY - startY <= 0) return;

    const top = scroller
      ? scroller.scrollTop
      : doc.scrollingElement
        ? doc.scrollingElement.scrollTop
        : 0;
    // Already at the top and still pulling down: this move is the overscroll.
    // `> 0` (not `!== 0`) so a rubber-banded negative scrollTop still counts.
    if (top > 0) return;
    if (e.cancelable) e.preventDefault();
  };

  const onTouchEnd = () => {
    tracking = false;
    scroller = null;
    modal = null;
  };

  doc.addEventListener("touchstart", onTouchStart, { passive: true });
  // MUST be non-passive: a passive listener cannot preventDefault, which is the
  // only thing this module does. Do not "optimize" this to passive: true.
  doc.addEventListener("touchmove", onTouchMove, { passive: false });
  doc.addEventListener("touchend", onTouchEnd, { passive: true });
  doc.addEventListener("touchcancel", onTouchEnd, { passive: true });

  const handle = {
    destroy() {
      doc.removeEventListener("touchstart", onTouchStart);
      doc.removeEventListener("touchmove", onTouchMove);
      doc.removeEventListener("touchend", onTouchEnd);
      doc.removeEventListener("touchcancel", onTouchEnd);
      delete doc.__pullToRefreshGuard;
    },
  };
  doc.__pullToRefreshGuard = handle;
  return handle;
}
