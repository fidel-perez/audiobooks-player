/**
 * A hold is a second meaning on a control that already has one.
 *
 * Android's long press is text selection, a context menu, or a pan whose
 * `pointercancel` kills the timer: that is why a hold never fires.
 */

/** How long a control is held before its second meaning fires. Every app reads
 *  THIS one, so a hold feels the same everywhere. */
export const HOLD_MS = 500;

/**
 * Give `el` a second meaning at `ms`, swallowing the click its release fires.
 *
 * `onHold` returns false when the hold no longer applies, so the ordinary click
 * runs instead.
 *
 * @returns {() => boolean} true once per landed hold, for the click to check.
 */
export function holdable(el, onHold, ms = HOLD_MS) {
  let timer = null;
  let landed = false;
  el.addEventListener("contextmenu", (event) => event.preventDefault());
  el.addEventListener("pointerdown", (event) => {
    landed = false;
    clearTimeout(timer);
    // Or a few px of finger drift during the hold becomes a pan.
    el.setPointerCapture?.(event.pointerId);
    timer = setTimeout(() => {
      landed = onHold() !== false;
      if (landed) {
        // The buzz is the only tell: the finger is still on the control.
        navigator.vibrate?.(40);
      }
    }, ms);
  });
  const stop = () => clearTimeout(timer);
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  return () => {
    const was = landed;
    landed = false;
    return was;
  };
}
