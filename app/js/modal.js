/**
 * Minimal overlay-modal helper shared by the ⚙️ settings sheet and the 📚
 * server-library browser. A modal is any `.modal` element with `[data-close]`
 * triggers (the ✕ button and the backdrop). Esc closes the topmost open modal,
 * and so does the browser's back button — a back gesture with a modal open used
 * to leave the page outright, which stops playback.
 */

import { $ } from "./dom.js";
import { createBackGuard } from "../_shared/history/backGuard.js";

const guard = createBackGuard();

/** id -> the back-guard handle for the currently open instance of that modal. */
const openLayers = new Map();

/** id -> callbacks fired when that modal goes open→closed by ANY route (✕,
 *  backdrop, Esc, back gesture, or a programmatic closeModal). A modal that
 *  stacks its own layered state — the «Book and author» breadcrumb trail — hooks
 *  this to release that state no matter how it was dismissed. */
const closeHooks = new Map();

export function openModal(id) {
  const m = $(id);
  if (!m || !m.hidden) return;
  m.hidden = false;
  openLayers.set(id, guard.push(() => closeModal(id)));
}

export function closeModal(id) {
  const m = $(id);
  const wasOpen = !!m && !m.hidden;
  if (m) m.hidden = true;
  const layer = openLayers.get(id);
  if (layer) {
    layer.release();
    openLayers.delete(id);
  }
  if (wasOpen) {
    const set = closeHooks.get(id);
    if (set) for (const fn of set) fn();
  }
}

/** Register a callback for when `id` closes. Returns an unsubscribe fn. */
export function onModalClose(id, fn) {
  let set = closeHooks.get(id);
  if (!set) closeHooks.set(id, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

/**
 * Push an extra back-guard layer onto the shared guard, for breadcrumb
 * navigation INSIDE a modal that re-renders in place (a book tapped in the
 * «Book and author» list swaps the modal's content without opening a new modal).
 * The first, root layer is the one openModal pushes (back closes the modal);
 * each deeper step pushes one of these (back steps to the previous crumb).
 * Returns the guard's release handle.
 */
export function pushBackLayer(dismiss) {
  return guard.push(dismiss);
}

/** Wire a modal's close triggers once, at startup. */
export function wireModal(id) {
  const m = $(id);
  if (!m) return;
  m.querySelectorAll("[data-close]").forEach((el) =>
    el.addEventListener("click", () => closeModal(id)),
  );
}

/** Global Esc handler: close the last (topmost) open modal. */
export function bindModalEsc() {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = Array.from(document.querySelectorAll(".modal")).filter(
      (m) => !m.hidden,
    );
    if (open.length) closeModal(open[open.length - 1].id);
  });
}
