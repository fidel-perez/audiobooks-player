/**
 * Day / night "En curso" mode.
 *
 * The 📖 en-curso shelf is split into two INDEPENDENT collections — a NIGHT
 * shelf (bedtime books; dozing off in the last 15 min is fine) and a DAY shelf
 * (books you need to keep following). Each has its own "libros abiertos" AND its
 * own "en cola". The toggle in the en-curso modal switches which shelf you see
 * and which one a newly-opened book joins; the 📖 top-bar button is tinted blue
 * (night) or yellow (day) so the current shelf is visible without opening it.
 *
 * The mode is a persisted, PER-DEVICE global (localStorage) — it is deliberately
 * NOT synced, so two devices can be on different shelves at once. What DOES sync
 * is a book's ASSIGNED mode, which travels with its progress entry (libros
 * abiertos) and its queue entry (en cola), so the two shelves read the same on
 * every device. A book with no explicit mode counts as NIGHT (the default), so
 * every pre-existing in-progress book lands on the night shelf after this ships.
 *
 * SO: `currentMode()` may be read ONLY where a book is PUT somewhere — a real
 * open (library.js#handleFiles) and a queue add (catalog.js#addToQueue). The
 * toggle itself is NOT such a site: it switches shelf and moves nothing, though
 * it parks the off-shelf book (library.js#syncActiveToShelf). Every
 * other site reads the shelf OFF the book (`doc.mode`, the progress entry's
 * `mode`) and treats a missing one as night. A save path that consulted the view
 * instead would silently MOVE books between shelves as you toggled: that was the
 * saveProgress bug, and it hit every pre-split book, i.e. all of them. Pinned by
 * tests/audiobooks-shelf-assignment.test.js.
 */

import { LS_MODE } from "./config.js";

export const MODES = ["night", "day"];

/** Glyph + label per shelf, shared by every surface that names one (the en-curso
 *  toggle, the 📈 reading-log toggle) so the two can never drift apart. */
export const MODE_META = {
  night: { glyph: "🌙", label: "Noche" },
  day: { glyph: "☀️", label: "Día" },
};

/** Normalise any value to a valid mode; anything but "day" reads as "night". */
export function normMode(m) {
  return m === "day" ? "day" : "night";
}

let current = load();

function load() {
  try {
    return normMode(localStorage.getItem(LS_MODE));
  } catch (_) {
    return "night";
  }
}

/** The mode this device is currently viewing / assigning to newly-opened books. */
export function currentMode() {
  return current;
}

/** Set + persist the mode. Returns the new (normalised) mode. */
export function setMode(m) {
  current = normMode(m);
  try {
    localStorage.setItem(LS_MODE, current);
  } catch (_) {}
  return current;
}

/** Flip night↔day and persist. Returns the new mode. */
export function toggleMode() {
  return setMode(current === "day" ? "night" : "day");
}
