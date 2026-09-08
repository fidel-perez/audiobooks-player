/**
 * A back button that never leaves the app.
 *
 * These are single-page PWAs with no routing: every "screen" is a modal, a
 * details panel, or a context menu layered over one document. The browser's
 * back button therefore has nothing useful to navigate to — it either exits the
 * app outright (killing audio playback, losing an unsaved edit) or, if an app
 * pushed its own history entries, walks a stack that drifts out of sync with
 * what is actually on screen.
 *
 * The guard pins the app on a CUSHION of sentinel history entries. A back
 * gesture pops one sentinel; we dismiss the topmost open layer (if any) and
 * immediately push a sentinel back, so the position in history never moves and
 * the app is never exited by back.
 *
 * The cushion is why it is a stack and not a single entry. A back gesture is a
 * navigation the browser performs on its own schedule: press back three times
 * fast (or flick an Android edge-swipe, which fires easily twice) and the
 * browser can walk several entries before our popstate handler ever runs to push
 * one back. With a single sentinel that walk reaches the previous site — the tab
 * unloads, playback dies, and the reader gets the browser's "Leave site?" prompt
 * they never asked for. `cushion` entries deep, a burst has to exceed the whole
 * cushion within one JS turn to get out, which a human thumb cannot do. Every
 * popstate tops the cushion back up, so it never erodes.
 *
 * A cushion of pushes is not enough on its own, though. Chrome's
 * history-manipulation intervention marks same-document entries that were
 * pushed WITHOUT user activation as skippable, and back walks straight over
 * them — so a cushion pinned at install (module load: no gesture) and topped up
 * from popstate (a browser-driven event: no gesture) is invisible to back on
 * Android, and the second press in a row leaves the app. That is why the guard
 * ALSO re-pins from a real user gesture (`GESTURES`): entries pushed inside a
 * pointerdown/keydown carry activation, Chrome honours them, and back stops on
 * them like any ordinary entry. The gesture pins are the ones that count, so
 * `blessed` tracks only those; the popstate pin stays as a fallback for engines
 * without the intervention, and is skipped while blessed sentinels still stand
 * so history does not grow by an entry per back press.
 *
 * The gap this leaves is a burst of backs with no interaction anywhere in it: it
 * spends blessed sentinels without replacing any. `cushion` presses deep is well
 * past a mistap, and the next tap anywhere in the app restores the cushion.
 *
 * Deliberately leaving is still possible — long-pressing back opens the
 * browser's history list and jumps straight past the cushion, and the tab close
 * / home gesture is always there. What is gone is the ACCIDENTAL exit.
 *
 * Layers are a stack, not history entries: open a modal, `push` its dismisser;
 * close it by any means (✕, Esc, backdrop), `release` the handle. Whichever
 * happens first wins, and the stack stays honest either way.
 *
 * Apps whose layers are opened by scattered class toggles can skip the stack
 * and pass `onBack`, which runs when the stack is empty. Returning nothing (or
 * false) from `onBack` is fine — the guard re-pins regardless.
 */

const SENTINEL = "__backGuard";

/** How many sentinel entries stand between the app and the site before it. Three
 *  absorbs the fastest realistic burst (an edge-swipe that registers twice, or a
 *  panicked triple-tap) while keeping the history list short enough that a
 *  deliberate long-press-back escape is still one gesture. */
const CUSHION = 3;

/** Events that carry transient user activation, so a pushState inside one
 *  produces a history entry Chrome's intervention will not skip. pointerdown
 *  covers touch and mouse on anything current; touchstart is the fallback for
 *  engines without Pointer Events; keydown covers a desktop keyboard. They
 *  overlap by design — the top-up is a no-op once the cushion is full. */
const GESTURES = ["pointerdown", "touchstart", "keydown"];

/** Listening in capture, and passively: the guard must see the gesture before
 *  any handler can stopPropagation it, and must never delay a scroll. */
const GESTURE_OPTS = { capture: true, passive: true };

/**
 * @param {object}   [opts]
 * @param {Function} [opts.onBack]  Called on back when no layer is stacked.
 * @param {number}   [opts.cushion] Sentinel entries to keep stacked (see CUSHION).
 * @param {object}   [opts.win]     Injectable for tests.
 * @param {object}   [opts.hist]    Injectable for tests.
 */
export function createBackGuard({
  onBack,
  cushion = CUSHION,
  win = globalThis.window,
  hist = globalThis.history,
} = {}) {
  /** @type {Array<{dismiss: Function}>} */
  const layers = [];

  const wanted = Math.max(1, cushion);

  /** Sentinels pinned under a real user gesture — the only ones Chrome's
   *  history-manipulation intervention leaves standing. */
  let blessed = 0;

  const pin = () => hist.pushState({ [SENTINEL]: true }, "");

  const onPopState = () => {
    // One sentinel is gone. Assume it was a blessed one: the count is only ever
    // allowed to be pessimistic, since over-counting is what would let back out.
    if (blessed > 0) blessed -= 1;

    const top = layers.pop();
    if (top) {
      // A layer's own close path may call release(); it is already off the
      // stack, so the release is a no-op and the dismiss cannot recurse.
      top.dismiss();
    } else if (onBack) {
      onBack();
    }

    // Gestureless, so Chrome will skip it — but it holds the position on every
    // other engine, and it is all there is once the blessed cushion is spent.
    // While blessed sentinels remain they already hold, and pushing here too
    // would grow history by one entry for every back ever pressed.
    if (blessed === 0) pin();
  };

  /** Re-pin from inside a user gesture, where pushState still buys a history
   *  entry back will actually stop on. Runs on every tap; pushes nothing once
   *  the cushion is full. */
  const onGesture = () => {
    while (blessed < wanted) {
      pin();
      blessed += 1;
    }
  };

  for (let i = 0; i < wanted; i++) pin();
  win.addEventListener("popstate", onPopState);
  for (const type of GESTURES) win.addEventListener(type, onGesture, GESTURE_OPTS);

  return {
    /**
     * Register a dismissible layer. Back closes the most recently pushed one.
     * @param {Function} dismiss  Closes the layer. Must be idempotent.
     * @returns {{release: Function}}  Call `release` when the layer closes by
     *   any other route, so back doesn't dismiss a layer that is already gone.
     */
    push(dismiss) {
      const layer = { dismiss };
      layers.push(layer);
      return {
        release() {
          const i = layers.indexOf(layer);
          if (i >= 0) layers.splice(i, 1);
        },
      };
    },

    /** How many layers back would have to close before `onBack` runs. */
    get depth() {
      return layers.length;
    },

    /** Tear down (tests; no app needs this — the guard lives for the page). */
    destroy() {
      win.removeEventListener("popstate", onPopState);
      for (const type of GESTURES) {
        win.removeEventListener(type, onGesture, GESTURE_OPTS);
      }
      layers.length = 0;
    },
  };
}
