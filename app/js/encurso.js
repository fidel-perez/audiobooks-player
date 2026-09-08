/**
 * 📖 "En curso" modal — progress monitor + play queue.
 *
 * Four lists:
 *  - Libro en progreso: the ONE currently-active book (state.active) — the book on
 *    the main #bookCard. It rides ABOVE "Libros abiertos" and is pulled OUT of it,
 *    so the shelf always opens on what you're reading now. Shelf-independent (shown
 *    whichever día/noche estantería you view); hidden when nothing is loaded. This
 *    is also where the active card's tap lands (the card opens THIS modal).
 *  - Libros abiertos: books in progress. Two sources, unified into one list:
 *      · local docs (IndexedDB-backed state.docs) — instant activate + play;
 *      · synced catalog books in progress on ANOTHER device (from the json-store
 *        progress blob) that aren't loaded here — a ▶ downloads them from the
 *        raspi library and resumes. This is what makes the shelf feel like one
 *        page across devices. A local row shows the FURTHEST position reached on
 *        any device (the merged json-store `pos`), so progress you made on the
 *        phone shows up on the tablet's shelf. A finished book leaves this list
 *        for the ✔ fold below — it is never dropped from the shelf.
 *      Long-pressing (right-click) a row opens a popover — the same rating
 *      controls as the biblioteca (⭐/👤/👍/👎) plus 🧹 "clear progress" (back to
 *      0%, into the random pool) and 🗑 remove. So when a book finishes you can
 *      rate it and then either leave it tracked as "read" or clear it.
 *      ORDER: last opened first, and NOTHING else (`sortByLastOpened`). Rating a
 *      book, 🧹-ing it, or just listening to it must never move it — only opening
 *      a book moves it, to the top. (✅ doesn't reorder either: it moves the row
 *      DOWN into the fold, keeping its place inside it.)
 *  - ✔ Terminados: the same rows, only finished — folded away behind a count chip
 *    (`splitFinished`). They are NOT pruned: a read book is how you get back to
 *    its author, and pruning stays a hand job. They are only moved down and shut
 *    away, so the live shelf stops reading as a graveyard. Collapsed by default,
 *    and it stays open across a repaint once you open it — because managing it
 *    (🗑 by 🗑) is exactly what repaints this modal. The rows keep the SAME
 *    long-press menu, so ✅ un-marks a book straight back onto "abiertos".
 *  - En cola: the catalog paths queued to play next (managed from a book's
 *    🔝 / ⬇️ controls in the shared book menu). A row is a CARD and nothing
 *    else: tapping it opens the book's ficha. Both things you can do TO the cola
 *    — reordering (🔝▲▼⤓) and unqueueing (🗑, which confirms) — live in one place,
 *    the «Multiselección» bar, which a right-click / long-press on any row turns
 *    on. Choose books, then act on them.
 *
 * "Abiertos" and "en cola" are EXCLUSIVE: a queued book is never also listed as
 * open, even though queueing no longer clears its progress (it keeps its place and
 * picks up where you left it when you open it again). ✅ terminado, on the other
 * hand, never takes a book OFF the shelf — it just folds the row into ✔ Terminados
 * (and un-✅ sends it back up). Only 🗑 takes a book off entirely.
 *
 * This modal is the successor to the removed library tab strip — the one place
 * to track / manage / resume the books in flight.
 *
 * Both lists are built from the SAME `buildBookCard` as the biblioteca modal, so
 * a book looks identical wherever it appears (status rings, title + year, saga
 * line, author caption, ✔ terminado cue, right-click menu). Each shelf only adds
 * what it needs: ▶ glyph + % badge + progress bar on "libros abiertos", and the
 * 🗑 control beside the card on "en cola". A row for a book held on ANOTHER device
 * carries no glyph of its own — it used to show ☁, which is exactly the
 * per-surface decoration "one card everywhere" rules out.
 *
 * SELECT, never play: tapping ANY row here only makes that book the active book
 * (loads it, closes the modal) — it NEVER starts audio. The player's ▶ Play
 * button is the sole thing that begins playback (enforced by
 * `shouldPlayOnActivate` + the `select` flag threaded through activateDoc /
 * loadBook). One continuity rule: re-tapping the book that's already PLAYING
 * leaves it playing (no stop); only SWAPPING to a different book stops the
 * current one (and still doesn't auto-play the new one). See the "en curso ·
 * select-only" tests.
 */

import { $, setStatus } from "./dom.js";
import { state } from "./state.js";
// MODE_META (glyph + label per shelf) is shared with the 📈 reading-log view;
// the modal toggle is tinted blue = night / yellow = day via the mode-* classes.
import { currentMode, toggleMode, normMode, MODE_META } from "./mode.js";
import { setShortRun } from "./sleepPreset.js";
import {
  docPct,
  isDocFinished,
  isDocRecent,
  isSrcFinished,
  chunkAtCharIn,
  clampOffset,
  refreshProgress,
  getSyncedOpenBooks,
  syncedProgressFor,
  openedTsFor,
  isDropped,
  markDocRead,
} from "./progress.js";
import { activateDoc, clearActive, syncActiveToShelf } from "./library.js";
import { openModal, closeModal, wireModal } from "./modal.js";
import {
  getQueueBooks,
  getQueueCached,
  selectQueuedBook,
  removeQueueSelection,
  moveQueueSelection,
  openCatalogBook,
  ensureCatalog,
  ensureFavorites,
  bookForRow,
  buildBookCard,
  openBookMenu,
  isQueued,
  removeFromQueue,
} from "./biblioteca.js";
import { confirmDialog } from "./ui.js";
import { spinnerLine } from "./busy.js";

function emptyRow(text) {
  return Object.assign(document.createElement("div"), {
    className: "bib-empty",
    textContent: text,
  });
}

// Is the ✔ Terminados fold open? Module state, like the biblioteca's filter
// drawer (`drawerOpen`) — deliberately NOT persisted (collapsed is the resting
// state), and deliberately not re-read off the DOM: it must survive a REPAINT,
// because 🗑-ing a book from inside the fold re-renders the whole modal, and a
// fold that snapped shut after every delete would be unusable.
let doneOpen = false;

/**
 * The cola's MULTI-SELECT — a MODE, and the ONLY way a queued book moves.
 *
 * The 🔜 En cola header carries a «Multiselección» chip, and a right-click /
 * long-press on ANY cola row turns the same mode on (picking that row) and off
 * again — the gesture you already make on a row you want to do something with.
 * With the mode OFF the cola is a plain list: tapping a row opens the book's
 * «Book and author» modal, and the row carries no reorder controls at all. With
 * it ON, tapping a row SELECTS it (the row is highlighted) and the bar's 🔝▲▼⤓
 * move every selected book at once, keeping their order.
 *
 * REORDER LIVES IN ONE PLACE. Each row used to carry its own ▲▼ stack, live in
 * both modes, doing one of two different things depending on whether that row
 * happened to be selected — two narrow buttons on every row, for something done
 * rarely, crowding the card and racing each other one whole-list PUT at a time.
 * The bar is a single control surface that says how many books it will move and
 * moves them in one write; the rows are back to being cards.
 *
 * A mode rather than a checkbox column because the cola row is already a full
 * book card: a per-row ☐ added a permanent control to every row for something
 * you do rarely, and it was easy to miss. The chip says what state the list is in
 * and leaves the row itself as the tap target it looks like.
 *
 * `picked` is module state, like `doneOpen`: it has to survive the repaint a
 * selection tap itself causes — which is why a tick repaints ATTRIBUTES only
 * (renderEnCurso re-pulls the catalog, the queue AND the progress blob, far too
 * much for a tap). Both the mode and the selection are cleared when the modal is
 * opened and when the día/noche shelf flips; the selection is also pruned on
 * every paint to the paths still on the visible cola, so a book unqueued here or
 * on another device drops out of it.
 */
let multi = false;
const picked = new Set();

/** Is the cola in multi-select mode? */
export function queueMultiOn() {
  return multi;
}

/** The selected cola paths, in no particular order. Exported for the tests — the
 *  selection is otherwise only observable through the DOM. */
export function queueSelection() {
  return [...picked];
}

/** Select / deselect one cola path. Returns whether it is now selected. */
export function toggleQueuePick(path) {
  if (picked.has(path)) picked.delete(path);
  else picked.add(path);
  return picked.has(path);
}

/** Turn the mode on/off (or to `on` when given). Leaving it always drops the
 *  selection: a highlight you can no longer see is a trap for the next move. */
export function setQueueMulti(on) {
  multi = on === undefined ? !multi : !!on;
  if (!multi) picked.clear();
  return multi;
}

export function clearQueueSelection() {
  picked.clear();
}

/**
 * Every día/noche toggle in the app. There is ONE shelf mode per device, so both
 * chips must always read the same — they are painted and wired together rather
 * than each keeping its own copy:
 *  - `modeToggle`       — the 📖 En curso head: which shelf you are LOOKING at.
 *  - `authorModeToggle` — the «Book and author» head: which shelf a book added
 *                         from there (🔜 cola, category bulk-add, saga) lands on.
 * Same state, two places it matters.
 */
const MODE_TOGGLE_IDS = ["modeToggle", "authorModeToggle"];

/**
 * Paint the current-shelf cue on every mode toggle's glyph/label. Idempotent —
 * safe to call on load, on toggle, and on every modal open.
 */
export function applyModeCue() {
  const m = currentMode();
  const meta = MODE_META[m];
  for (const id of MODE_TOGGLE_IDS) {
    const tog = $(id);
    if (!tog) continue;
    tog.textContent = `${meta.glyph} ${meta.label}`;
    tog.setAttribute("aria-label", `Modo ${meta.label} — toca para cambiar de estantería`);
    tog.classList.toggle("mode-night", m === "night");
    tog.classList.toggle("mode-day", m === "day");
  }
  // The top-bar chip reads the same shelf, but is HELD rather than tapped
  // (main.js), so it stays out of MODE_TOGGLE_IDS: those ids get a click that
  // flips, and a chip that flipped on a stray tap in the dark would re-shelve
  // the next book opened.
  const chip = $("chipShelf");
  if (chip) chip.textContent = `${meta.glyph} ${meta.label}`;
}

/**
 * FLIPPING THE SHELF MOVES NOTHING: each book keeps its estantería, and the
 * player parks the off-shelf one (library.js#syncActiveToShelf). Re-shelving is
 * 🌙⇄☀️. Pinned by tests/audiobooks-shelf-keeps-open-book.test.js.
 */

/**
 * The one flip: both toggles and the held #now transcript run this.
 *
 * @returns {string} the shelf now in force.
 */
export function flipShelf() {
  const mode = toggleMode();
  syncActiveToShelf(mode); // the player follows the shelf; no book moves
  // A day book is followed awake, so it wants «⏱️ Corto»; night the long pair.
  // Only the shelf arms it; the ⚙️ chip stays free.
  setShortRun(mode === "day");
  applyModeCue(); // repaint EVERY chip, not just the one tapped
  setQueueMulti(false); // the other shelf is another cola — this selection means nothing there
  renderEnCurso(); // repaint both lists for the new shelf
  return mode;
}

/** Char offset of a doc's current position (its curChunk's start). */
function docPos(d) {
  if (!d.chunks || !d.chunks.length) return 0;
  return d.chunks[Math.min(d.curChunk, d.chunks.length - 1)].start;
}

/** The trailing "63%" badge on an open-book card (the ✔ tag carries "done"). */
function pctChip(pct) {
  const badge = document.createElement("span");
  badge.className = "bib-pct";
  badge.textContent = `${pct}%`;
  return badge;
}

/** A local doc's shelf reading: the % to show — the FURTHEST position reached on
 *  ANY device — and whether it counts as terminado. The finished rule is the same
 *  one a ☁ row's `done` carries (progress.js `entryFinished`): the ✅ flag, or a
 *  genuine 100%. Computed ONCE per paint and handed to docRow, because
 *  paintOpenBooks needs the same answer to decide which of the two shelves the row
 *  lands on. (NOT `isSrcFinished`: that one is keyed on the catalog `src`, so it is
 *  blind to a local upload, which has none.) */
function docShelfState(d) {
  // Cross-device position: if another device pushed this book further along
  // (its json-store `pos` is ahead of this device's local offset), show + resume
  // from that furthest point so the shelf reads the same on every device.
  const sync = syncedProgressFor(d.docKey);
  const ahead = sync && sync.pos > docPos(d) ? sync : null;
  const pct = ahead ? ahead.pct : docPct(d);
  return { pct, done: isDocFinished(d.docKey) || pct >= 100, recent: isDocRecent(d.docKey) };
}

/** One "libros abiertos" row for a LOCAL doc: seguir + long-press popover.
 *  The SAME card as the biblioteca (buildBookCard) — status rings, title + year,
 *  right-click menu — plus the ▶ active glyph, the % badge and the bar.
 *  `st` is its docShelfState (the caller already needs it, to pick the shelf). */
function docRow(d, st) {
  const i = state.docs.indexOf(d);

  // Same book card everywhere: resolve the catalog entry (by src, else by the
  // stored filename) so the card carries the shared cues — favorite-author tint,
  // rating rings, author + saga lines, year. A local drop, which has no catalog
  // identity to resolve at all, just shows the neutral card.
  const bk = bookForRow(d.src, d.name) || {
    p: d.src || null,
    t: d.name,
    a: "",
    _local: !d.src,
  };

  // Tap OR right-click → the same «Book and author» modal; its ▶️ Abrir runs
  // onOpen (select-only, never auto-plays — the modal's whole invariant).
  const menu = {
    kind: "local",
    docKey: d.docKey,
    src: d.src || null,
    onAfter: () => renderEnCurso(),
    onOpen: () => openDocFromEnCurso(d),
  };
  return buildBookCard(bk, {
    icon: i === state.active ? "▶" : "",
    finished: st.done,
    pct: st.pct,
    chip: pctChip(st.pct),
    title: `Abrir "${d.name}" y opciones (▶️ Abrir selecciona; pulsa ▶ Play para leer)`,
    onClick: () => openBookMenu(bk, menu),
    menu,
  });
}

/**
 * SELECT a local open-book row: reposition where needed, make it the active
 * book, and close the modal — but NEVER start playback (the invariant this whole
 * modal keeps; only ▶ Play plays).
 *
 * Playback continuity: re-tapping the book that's ALREADY PLAYING leaves it
 * playing, untouched (no stop, no reposition) — only a SWAP to a different book
 * stops the current one (activateDoc enforces this). Repositioning therefore
 * only applies when we're actually going to (re)activate a not-currently-playing
 * book:
 *  - a finished book is parked on its last body paragraph, so we rewind it to
 *    the start of the real text (skipping front matter, like a fresh open) so
 *    the next ▶ Play replays it instead of reading one line and stopping;
 *  - otherwise, if another device pushed this book further along, resume at that
 *    furthest point so the shelf reads the same on every device.
 * Exported so the "select-only" behaviour is testable without a DOM click.
 */
export function openDocFromEnCurso(d) {
  const i = state.docs.indexOf(d);
  const playingThis = i === state.active && state.speaking && !state.paused;
  if (!playingThis) {
    if (isDocFinished(d.docKey)) {
      d.curChunk = chunkAtCharIn(d.chunks, d.bodyStartChar || 0);
      d.chunkOffset = 0; // replaying from the top: first word of the first paragraph
    } else {
      const sync = syncedProgressFor(d.docKey);
      const ahead = sync && sync.pos > docPos(d) ? sync : null;
      if (ahead) {
        d.curChunk = chunkAtCharIn(d.chunks, ahead.pos);
        // Adopt the other device's WORD too, not just its paragraph — the whole
        // point of the shelf is that both devices read the same place.
        d.chunkOffset = clampOffset(d.chunks[d.curChunk], ahead.off);
      }
    }
  }
  activateDoc(i, false, true); // select-only: never auto-plays; a swap stops the old
  closeModal("progressModal");
}

/**
 * One "libros abiertos" row for a catalog book in progress on another device
 * (not loaded here): tapping it downloads from the raspi library and SELECTS it
 * at the saved position (paused — ▶ Play starts it); long-press opens the rating
 * + remove popover.
 */
function remoteRow(entry) {
  // Shared status cue from the catalog entry. A remote row always HAS a src, but
  // it may be one the catalog no longer knows, so `bookForRow` also tries the
  // stored filename — otherwise the row shows a raw ".epub" name with no author
  // and no saga (see bookForRow).
  const bk = bookForRow(entry.src, entry.title) || {
    p: entry.src,
    t: entry.title,
    a: "",
    _local: false,
  };

  const menu = {
    kind: "remote",
    docKey: entry.docKey,
    src: entry.src,
    onAfter: () => renderEnCurso(),
    onOpen: () => {
      openCatalogBook(entry.src, entry.title);
      closeModal("progressModal");
    },
  };
  // NO leading glyph. It used to carry a ☁ ("lives on another device — resuming
  // re-downloads it"), but "one card everywhere" wins over that cue: which device
  // holds the file is an implementation detail of the tap, and the row is
  // otherwise identical to a local one. The button's title still says it.
  return buildBookCard(bk, {
    finished: entry.done, // ✅ greys the row and keeps it here, like a local one
    pct: entry.pct,
    chip: pctChip(entry.pct),
    title: `Abrir "${entry.title}" desde la biblioteca y opciones (▶️ Abrir; pulsa ▶ Play para leer)`,
    onClick: () => openBookMenu(bk, menu),
    menu,
  });
}

/**
 * The cola as it is CURRENTLY PAINTED — one entry per row, in list order, each
 * holding the nodes a selection tick has to touch.
 *
 * A tick (and the mode chip) used to rebuild the whole list: `paintQueue` wiped
 * `#queueList` and re-ran `buildBookCard` for every queued book, because the
 * picked state was baked into each row at build time. On a phone with a long cola
 * that is the difference between an instant tint and the seconds-long lag reported
 * 2026-07-30 ("it seems to work but clicking takes a few secs"): every tap threw
 * away N cards and their status cues, rebuilt them, and made the browser lay the
 * whole list out again — with a Piper synthesis competing for the same main thread.
 *
 * So the mark is now a CLASS TOGGLE on rows that already exist (`applyQueuePicks`),
 * and nothing about a row is frozen at build time: the card's click and the row's
 * long-press both read `multi` live, and the bar reads `picked` live, so turning
 * the mode on or off is a repaint of attributes rather than of the list. Same
 * principle as musica's keyed diff.
 */
let queueRows = [];

/**
 * A cola WRITE in flight (a move, from the multiselección bar).
 *
 * The mover re-pulls the queue, permutes it and PUTs the whole list back, so two
 * overlapping moves are two permutations of the same base — the second one is
 * computed from a list the first has already changed, and it wins. On a slow link
 * that window is seconds long and the list on screen has not moved yet, which is
 * exactly when a reader taps again. So a second tap is DROPPED rather than queued,
 * and the bar's movers go dead while the write is out so the drop is visible.
 */
let queueBusy = false;

/** What a failed move gets to SAY. A queue write that doesn't land used to leave
 *  the cola exactly as it was with no explanation — which is indistinguishable
 *  from "the app ignored my tap", and is what a reorder over a dead tunnel looked
 *  like (reported 2026-08-01: "I tried both ways and nothing"). The store is the
 *  only place the order lives, so there is nothing to do but say so. */
const WRITE_NOTE = {
  offline: "⚠️ No se pudo cambiar la cola: sin conexión con el servidor. Inténtalo de nuevo.",
  gone: "⚠️ Esos libros ya no están en la cola.",
};

/** Run one cola write, then repaint from what actually landed — and say so when
 *  nothing did. */
async function runQueueWrite(write) {
  if (queueBusy) return;
  queueBusy = true;
  setQueueNote(""); // the previous attempt's verdict is not this one's
  applyQueuePicks(); // the movers read queueBusy: they grey out for the round trip
  let result = "offline"; // a throw is a write that did not land, like any other
  try {
    result = await write();
  } finally {
    queueBusy = false;
  }
  await renderEnCurso();
  // AFTER the repaint: paintQueue leaves the note alone, but a note written
  // before it would still be reporting on a list the reader is no longer seeing.
  if (result !== "ok") setQueueNote(WRITE_NOTE[result] || WRITE_NOTE.offline);
}

/**
 * Paint the selection onto the rows already on screen: the tint and what each row
 * says it will do. No DOM is created or destroyed here — this is what a tick and
 * the mode chip run instead of a repaint.
 */
function applyQueuePicks() {
  for (const r of queueRows) {
    const mine = picked.has(r.p);
    // The tint sits on the ROW so it covers the card and its 🗑 — the whole row
    // is what is selected (.enc-picked, css/_modal.css).
    r.row.classList.toggle("enc-picked", mine);
    // Said out loud as well as tinted: a chosen row is a pressed control, and that
    // is the one cue a dropped stylesheet cannot take away.
    if (multi) r.card.setAttribute("aria-pressed", String(mine));
    else r.card.removeAttribute("aria-pressed");
    r.card.title = multi
      ? `${mine ? "Quitar de" : "Añadir a"} la selección — «${r.t}»`
      : `Abrir "${r.t}" y opciones (▶️ Abrir pasa a abiertos; pulsa ▶ Play para leer) · ` +
        "clic derecho o pulsación larga: multiselección para mover";
  }
  applyQueueBulk();
}

/** The cola's one-line verdict slot (empty ⇒ hidden). It sits between the bar and
 *  the list, INSIDE the modal, because #toast lives under the player card and any
 *  open modal paints straight over it — a surface that opens a modal cannot report
 *  through the toast at all. */
function setQueueNote(text) {
  const el = $("queueNote");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

/** One queue row: the card, and nothing else. Moving AND removing are the
 *  multiselección bar's job, and only its — a row is a book, not a control panel.
 *
 *  Tapping the card does one of two things, depending on the header's
 *  «Multiselección» chip: normally it opens the book's «Book and author» modal
 *  (▶️ Abrir from there SELECTS the book — it never auto-plays, only ▶ Play
 *  does); in multi-select mode it adds/removes the row from the selection and
 *  highlights it. Which of the two is decided when the row is TAPPED, not when it
 *  is built, so flipping the mode costs no repaint.
 *
 *  RIGHT-CLICK / LONG-PRESS is the mode switch. Everywhere else in the app that
 *  gesture opens the «Book and author» menu; here it turns multiselección on
 *  (choosing the row you pressed) and off again, because on the cola the thing
 *  you reach for a row to do is MOVE it, and the ficha is one plain tap away.
 *
 *  The row is registered in `queueRows`; its tint and title are then painted by
 *  `applyQueuePicks`, which is also what every later tick runs. */
function queueRow(bk) {
  // Same book card everywhere: the queued book carries the same favorite-author
  // tint, rating rings, year, saga line and author caption as it does in the
  // biblioteca — and here it carries nothing else at all.
  const menu = {
    kind: "queue",
    src: bk.p,
    onAfter: () => renderEnCurso(),
    onOpen: () => {
      selectQueuedBook(bk);
      closeModal("progressModal");
    },
  };
  const row = buildBookCard(bk, {
    finished: isSrcFinished(bk.p),
    // Title, tint and aria come from applyQueuePicks below — they depend on the
    // MODE and the selection, which both change without the row being rebuilt.
    onClick: () => {
      // Read live: the same handler serves both modes for the row's whole life.
      if (!multi) {
        openBookMenu(bk, menu);
        return;
      }
      toggleQueuePick(bk.p);
      applyQueuePicks(); // a tick touches attributes only — no rebuild, no network
    },
    // No `menu`: buildBookCard would bind the contextmenu to the ficha, and on
    // this list that gesture belongs to the mode below.
  });

  // The way in AND out of multiselección, from the row itself. Entering picks the
  // row pressed — a long-press that chose nothing would be a mode change and then
  // a second tap to do what you already pointed at.
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (multi) setQueueMulti(false); // …and out again: the selection goes with it
    else {
      setQueueMulti(true);
      picked.add(bk.p);
    }
    applyQueuePicks();
  });

  // Registered for applyQueuePicks: the card is the row's first child (see
  // buildBookCard), and it is what carries the title + aria-pressed.
  queueRows.push({ p: bk.p, t: bk.t, row, card: row.children[0] });
  return row;
}

/**
 * The ONE thing that orders "libros abiertos": most recently OPENED first, local
 * ▶ rows and cross-device ☁ rows interleaved in the same sequence (a book you
 * opened on the phone last night outranks one you opened here last week — the
 * shelf reads the same on every device).
 *
 * Nothing ELSE may move a row. 🧹 limpiar, ✅ terminado, a rating, the position
 * autosave — none of them re-open a book, so none of them reorder the list; they
 * all preserve the entry's `openedTs` (see progress.js). Sorts in place and
 * returns the array; `Array.sort` is stable, so rows with no open time on record
 * (a local upload that never synced) keep the order they were collected in.
 */
export function sortByLastOpened(rows) {
  return rows.sort((a, b) => (b.openedTs || 0) - (a.openedTs || 0));
}

/**
 * Split the (already ordered) "libros abiertos" rows into THREE fates: the live
 * shelf, the "Terminados recientemente" inbox, and gone-from-en-curso. Order is
 * preserved inside both visible lists — the fold is a shelf too, so the book you
 * finished last night sits above the one you finished last year.
 *
 * The inbox is now its OWN bit: `recent` (✅ "Leído recientemente"), independent of
 * `done` (📖 library). So the fold is exactly the `recent` rows. Taking a book out
 * of the inbox (✅ off) clears `recent`; if it's still 📖 leído (`done`) but no
 * longer in progress it drops OFF the en-curso view entirely — it lives in the
 * biblioteca 📖 Leídos filter now, not on this shelf. Only a row that is still
 * genuinely in progress (not `done`) falls back onto "abiertos".
 *
 * The ACTIVE book always stays on the LIVE shelf: the ▶ glyph and the green ring
 * say "this is where you are", so it never folds away or drops off mid-listen.
 */
export function splitFinished(rows) {
  const abiertos = [];
  const terminados = [];
  for (const r of rows) {
    if (r.recent && !r.active) terminados.push(r); // ✅ recent inbox (the fold)
    else if (r.active || !r.done) abiertos.push(r); // live shelf (in progress / active)
    // else: 📖 leído, not recent, not in progress — off en-curso, in the library only
  }
  return { abiertos, terminados };
}

/** Set a section header's count chip. A zero count HIDES the chip: every one of
 *  these lists paints an explicit empty state ("No hay libros abiertos…", "Cola
 *  vacía…") that already says it, and a «0» beside the title only repeats it.
 *  Missing element is a no-op so the older markup keeps working. */
function setSectionCount(id, n) {
  const el = $(id);
  if (!el) return;
  el.textContent = String(n);
  el.hidden = !n;
}

/** Reflect the fold's state on the toggle (caret + aria) and on the list. */
function applyDoneFold() {
  const btn = $("encDoneToggle");
  const list = $("encDoneList");
  const caret = $("encDoneCaret");
  if (!btn || !list) return;
  btn.setAttribute("aria-expanded", String(doneOpen));
  btn.title = doneOpen
    ? "Terminados recientemente — toca para plegar"
    : "Terminados recientemente — toca para desplegar";
  list.hidden = !doneOpen;
  if (caret) caret.textContent = doneOpen ? "▾" : "▸";
}

/** Paint the ✔ Terminados fold from the finished rows of THIS estantería. The
 *  whole section hides when nothing is finished, so a clean shelf shows no empty
 *  drawer — and a fold emptied by 🗑 shuts itself. */
function paintTerminados(rows) {
  const sec = $("encDoneSec");
  const list = $("encDoneList");
  const count = $("encDoneCount");
  if (!sec || !list || !count) return;
  list.innerHTML = "";
  rows.forEach((r) => list.appendChild(r.el));
  count.textContent = String(rows.length);
  sec.hidden = !rows.length;
  if (!rows.length) doneOpen = false; // 🗑-ed the last one: the fold folds itself
  applyDoneFold();
}

/** Paint the CURRENT shelf's "libros abiertos" list from the (already-merged)
 *  map. Day and night each show only their own books; a book's shelf comes from
 *  the live doc (local rows) or its synced progress entry (remote ☁ rows).
 *
 *  A QUEUED book never appears here, whatever its progress: "abiertos" and "en
 *  cola" are exclusive, and "en cola" is where a queued book lives. That's the
 *  rule that lets queueing keep the reading position — the entry survives, so
 *  without this filter the book would sit on BOTH shelves. Finished books DO stay
 *  on the shelf: they just drop into the ✔ Terminados fold below. Only 🗑 takes a
 *  book off it. */
/**
 * Paint the "Libro en progreso" section: the single ACTIVE book (state.active) —
 * the one on the main #bookCard. It sits above "Libros abiertos" and is excluded
 * from it, so the shelf always opens on what you're reading now.
 *
 * Shelf-FILTERED, like every other row: the active book shows only on ITS OWN
 * día/noche estantería, not on both. Each shelf is a self-contained «En curso» —
 * so moving the active book día→noche (the 🌙⇄☀️ button) makes it leave día and
 * appear on noche at its saved place, instead of hanging on both. (It used to be
 * deliberately shelf-independent — painted on whichever shelf you viewed — which
 * is what made the two shelves read as one shared list.) So the row is a
 * placeholder whenever you are LOOKING at the other estantería: flipping the toggle moves no
 * book (see above), and a noche book painted onto the día shelf is exactly the
 * leak the split exists to prevent. Same for a book just trashed on another
 * device (isDropped) or landed on the other shelf by a sync while we were away —
 * the row would otherwise be a lie about where the book lives. The SECTION itself
 * always shows: its header carries ⏭️/✅, and ⏭️ is how you start the cola with
 * nothing open. Its row is the
 * SAME docRow as the shelf
 * (▶ glyph, % bar, right-click menu); tapping it re-selects the book
 * (openDocFromEnCurso) and closes the modal, never auto-playing.
 */
function paintInProgress() {
  const sec = $("encProgressSec");
  const list = $("encProgressList");
  if (!sec || !list) return;
  list.innerHTML = "";
  const i = state.active;
  const d = i >= 0 && i < state.docs.length ? state.docs[i] : null;
  const live = !!d && !isDropped(d.docKey) && normMode(d.mode) === currentMode();
  // The section stays on an EMPTY shelf, with a placeholder row: ⏭️ lives in its
  // header and starting the cola is exactly what you want with nothing open. ✅
  // has no book to mark read, so it greys out instead of vanishing.
  list.appendChild(
    live ? docRow(d, docShelfState(d)) : emptyRow("Ningún libro abierto en esta estantería."),
  );
  const fin = $("encFinishBtn");
  if (fin) fin.disabled = !live;
  sec.hidden = false;
}

/**
 * ⏭️ Siguiente / ✅ Terminar: close the active book out into ✔ Terminados
 * recientemente. Both mark it read; the ONE difference is what happens next.
 * ✅ Terminar stops there and leaves the player empty. ⏭️ Siguiente also starts
 * the head of the cola, so it is "finish and carry on" — and with an empty cola
 * there is nothing to carry on to, so it does nothing at all.
 *
 * Both confirm: the header names neither end of the move, so the dialog does.
 */
export async function advanceFromProgress(finish) {
  const d = state.docs[state.active] || null;
  // ✅ with nothing open has nothing to mark: the button is disabled for it.
  if (finish && !d) return;
  const title = d ? bookForRow(d.src, d.name)?.t || d.name : "";
  // ✅ Terminar never reaches for the cola. For ⏭️, the book being parked may
  // ALSO head it: taking that entry as "the next book" hands loadBook a doc that
  // is already open, which resolves back to the slot we are parking — the active
  // book never changes and the tap looks dead. Skip every entry pointing at it
  // and start the first OTHER one.
  const next = finish ? null : getQueueCached().find((b) => b.p !== d?.src) || null;
  // ⏭️ with nothing to start is a no-op, NOT a quiet ✅: finishing the book here
  // would be the mark the reader never asked for, and it is the one they'd have
  // to hunt down in the fold to undo.
  if (!finish && !next) {
    setStatus("🔜 La cola está vacía: no hay libro siguiente.");
    return;
  }
  const ok = await confirmDialog({
    title: finish ? "Terminar el libro" : "Siguiente libro",
    message: d
      ? `«${title}» pasa a ✔ Terminados recientemente` +
        (next ? ` y empieza «${next.t}», el primero de la cola.` : ".")
      : `Empieza «${next.t}», el primero de la cola.`,
    okLabel: finish ? "Terminar" : "Siguiente",
    cancelLabel: "Cancelar",
  });
  if (!ok) return;
  if (d) markDocRead(d.docKey);
  // A queued book is hidden from "abiertos" AND from the ✔ fold, so leaving the
  // parked book in the cola drops it out of both places this move promised to
  // put it.
  if (d?.src && isQueued(d.src)) await removeFromQueue(d.src);
  // Park BEFORE the download: the book leaves «Libro en progreso» even when the
  // next one never loads (offline, or gone from the library).
  if (d) clearActive();
  // Awaited: this modal stays open over the download, and an early repaint would
  // paint the book we just parked as still active.
  //
  // A failed open used to leave ⏭️ looking dead: the only notice was a setStatus
  // this modal paints over. Say it where the press was.
  if (next && !(await selectQueuedBook(next))) {
    await confirmDialog({
      title: "⏭️ Siguiente",
      message: `No se pudo abrir «${next.t}». Sin conexión sólo se abren los libros ya descargados.`,
      okLabel: "Vale",
      cancelLabel: "",
    });
  }
  renderEnCurso();
}

function paintOpenBooks() {
  // No closeBookMenu() here: the «Book and author» menu is now the independent
  // `authorModal` layer, NOT a popover living inside a card this repaint replaces
  // (see biblioteca.js dismissBookMenu). So repainting the shelf underneath must
  // LEAVE it open — otherwise every edit made from the menu while it sits over
  // «En curso» (rate / 📖 leído / bulk-queue, all of which repaint via
  // ctx.onAfter=renderEnCurso) would slam the menu shut. Action sites that truly
  // remove the book the menu is open on (🗑 quitar, 🌙☀️ re-shelve) close it by
  // hand at their own call sites. Mirrors renderCatalog's dismissBookMenu(false).
  paintInProgress(); // the active book rides its own section above the shelf
  const mode = currentMode();
  // Local docs on this shelf, then catalog books in progress on other devices
  // (also filtered to this shelf) — then ONE list, ordered by last open, and only
  // THEN split into the live shelf and the ✔ fold, so both read last-opened first.
  const rows = state.docs
    // `isDropped` hides a doc trashed on ANOTHER device the instant its tombstone
    // is pulled — the eviction that frees the doc/IDB (reconcileDroppedDocs) is
    // async, so the shelf can't wait on it to read correctly.
    // The ACTIVE book rides the "Libro en progreso" section above, not this one —
    // the top of the shelf is "what I'm reading now", and a book can't be in both.
    .filter(
      (d) =>
        normMode(d.mode) === mode &&
        !isQueued(d.src) &&
        !isDropped(d.docKey) &&
        state.docs.indexOf(d) !== state.active,
    )
    // A local upload never reaches the synced map (no `src`, so no openedTs);
    // its load time is the only open time it has.
    .map((d) => {
      const st = docShelfState(d);
      return {
        openedTs: openedTsFor(d.docKey) || d.order || 0,
        done: st.done,
        recent: st.recent,
        active: state.docs.indexOf(d) === state.active,
        el: docRow(d, st),
      };
    });
  // Exclude EVERY locally-loaded book from the remote rows (regardless of shelf)
  // so a book we hold locally never also shows as a ☁ duplicate. A ☁ row is by
  // definition not loaded here, so it can never be the active book.
  const localKeys = new Set(state.docs.map((d) => d.docKey));
  // A docKey is `filename_size`, so one book re-converted (or renamed in the
  // library) carries two of them and key-matching alone paints it twice — once
  // local, once ☁, both landing in the ✔ fold. The catalog path is the book's
  // real identity, so a src already on screen takes no second row.
  const seenSrc = new Set(state.docs.map((d) => d.src).filter(Boolean));
  getSyncedOpenBooks(localKeys)
    .filter((e) => e.mode === mode && !isQueued(e.src) && !seenSrc.has(e.src))
    .map((e) => (seenSrc.add(e.src), e))
    .forEach((e) =>
      rows.push({ openedTs: e.openedTs, done: e.done, recent: e.recent, el: remoteRow(e) }),
    );

  const { abiertos, terminados } = splitFinished(sortByLastOpened(rows));

  const list = $("encList");
  list.innerHTML = "";
  abiertos.forEach((r) => list.appendChild(r.el));
  setSectionCount("encOpenCount", abiertos.length);
  if (!list.children.length) {
    list.appendChild(
      emptyRow(
        mode === "day"
          ? "No hay libros abiertos en modo día ☀️."
          : "No hay libros abiertos en modo noche 🌙.",
      ),
    );
  }
  paintTerminados(terminados);
}

/** Repaint both lists. The open-books list paints instantly, then repaints once
 *  the cross-device progress AND the queue are pulled — the queue matters to the
 *  OPEN list too (a queued book is hidden from it), so the second paint waits for
 *  both. getQueueBooks is what re-syncs the queue (and needs the catalog to
 *  resolve titles).
 *
 *  NOTHING here may gate the FIRST paint on the network. It used to: the very
 *  first statement awaited ensureCatalog(), whose fetch was untimed, so a tunnel
 *  that had associated but wasn't routing yet hung the await and paintOpenBooks
 *  never ran at all. Both lists then sat as the empty markup index.html ships —
 *  no rows, and not even the "no hay libros / cola vacía" text, which is what
 *  made it read as "the app lost my books" rather than "the app can't reach the
 *  pi". Reported 2026-07-18 and recovered by toggling the shelf, which only
 *  helped because the toggle calls this function again after the hung fetch had
 *  finally settled. So: paint from cache first, then network, then repaint. */
export async function renderEnCurso() {
  applyModeCue(); // keep the toggle glyph + 📖 tint in sync with the shelf
  paintOpenBooks(); // from whatever is already in memory — never awaits
  paintQueue(getQueueCached(), false);

  // Status cues + the rating menu need the catalog + favorites. Both are usually
  // already warm (preloaded on app start), so this resolves instantly in the
  // common case; a cold open just paints the neutral card first, then repaints.
  let reached = true;
  try {
    await Promise.all([ensureCatalog(), ensureFavorites()]);
    paintOpenBooks(); // catalog landed: rows can resolve titles + status cues
    const [books] = await Promise.all([getQueueBooks(), refreshProgress()]);
    paintOpenBooks(); // repaint with the merged progress + the fresh queue
    paintQueue(books, true);
  } catch (e) {
    // A throw here means we could not reach the pi. Say so — the lists keep the
    // cached paint above, and the empty states below name the reason instead of
    // claiming the shelf is empty.
    console.error("en-curso refresh failed:", e);
    reached = false;
  }
  if (!reached) markStale();
}

/**
 * Paint the multi-select mode: the header chip's on/off cue, and the bar of
 * block-movers over the cola.
 *
 * The bar rides with the MODE, not with the selection — it is what tells you the
 * mode is on and what you are meant to do next ("elige libros y muévelos"). Its
 * movers are disabled while nothing is selected, so it can never move something
 * you didn't choose.
 */
function applyQueueBulk() {
  const chip = $("queueMultiChip");
  if (chip) {
    chip.setAttribute("aria-pressed", String(multi));
    chip.classList.toggle("on", multi);
    chip.title = multi
      ? "Multiselección activa — toca los libros para elegirlos, luego muévelos con 🔝▲▼⤓"
      : "Multiselección: elegir varios libros y moverlos juntos (o clic derecho en un libro)";
  }
  const count = $("queueBulkCount");
  if (count) count.textContent = String(picked.size);
  const bar = $("queueBulkBar");
  if (bar) bar.hidden = !multi;
  for (const id of [
    "queueBulkTop",
    "queueBulkUp",
    "queueBulkDown",
    "queueBulkBottom",
    "queueBulkDel",
  ]) {
    const b = $(id);
    if (b) b.disabled = !picked.size || queueBusy;
  }
  const del = $("queueBulkDel");
  if (del) {
    del.title =
      picked.size > 1
        ? `Quitar ${picked.size} libros de la cola`
        : "Quitar de la cola el libro elegido";
  }
}

/** Paint the 🔜 list. `synced` says whether `books` came from a completed pull —
 *  an empty list we actually confirmed says "cola vacía", an empty list we never
 *  managed to fetch says so instead of lying about it.
 *
 *  This is the EXPENSIVE path (N cards, N status lookups, a full layout) and it is
 *  reserved for a change of CONTENT: a pull, a move that landed, an unqueue. A
 *  change of SELECTION or of mode goes through applyQueuePicks instead. */
function paintQueue(books, synced) {
  const qEl = $("queueList");
  if (!qEl) return;
  // Drop from the selection anything no longer ON this cola — unqueued here, or
  // by another device, or simply on the other día/noche shelf now. A tick that
  // outlived its row would silently ride along in the next block move.
  const onScreen = new Set(books.map((b) => b.p));
  for (const p of [...picked]) if (!onScreen.has(p)) picked.delete(p);
  qEl.innerHTML = "";
  queueRows = []; // the rows about to be discarded must not be painted again
  setSectionCount("encQueueCount", books.length);
  if (!books.length) {
    // "Loading" gets a live ring, "empty" gets plain text — the difference has to
    // be visible at a glance, and a ⏳ glyph froze along with everything else
    // while the catalog was being indexed, which is precisely when this state is
    // on screen. markStale() replaces the ring if the pull never lands.
    qEl.appendChild(
      synced
        ? emptyRow("Cola vacía. Añade libros desde la biblioteca (🔜).")
        : spinnerLine("Cargando la cola…", "bib-empty"),
    );
  } else {
    books.forEach((bk) => qEl.appendChild(queueRow(bk)));
  }
  // The rows are built neutral; this is what puts the mode and the surviving
  // selection onto them (and repaints the bar).
  applyQueuePicks();
}

/** Replace any "loading" placeholder with an explicit unreachable notice, so an
 *  empty modal is never mistaken for lost data. */
function markStale() {
  for (const id of ["encList", "queueList"]) {
    const el = $(id);
    if (el && el.querySelector(".bib-empty")) {
      el.innerHTML = "";
      el.appendChild(
        emptyRow("⚠️ No se pudo contactar con el servidor. Vuelve a abrir 📖."),
      );
    }
  }
}

/** Wire the 📖 button, the day/night shelf toggle, the ✔ Terminados fold, and the
 *  modal close triggers. */
export function bindEnCurso() {
  wireModal("progressModal");
  const openEnCurso = () => {
    openModal("progressModal");
    setQueueMulti(false); // the cola opens as a plain list; the chip turns it on
    setQueueNote(""); // last session's failed move is not news now
    renderEnCurso();
  };
  // The active-book card (and the no-book placeholder button) are the ONLY openers
  // now (the 📖 top-bar button is gone). They live in biblioteca.js — which
  // encurso.js imports FROM, so a direct call would be a cycle. They fire this
  // event instead; same decoupling as `audiobooks:activated`.
  document.addEventListener("audiobooks:open-encurso", openEnCurso);
  // Both chips (En curso + «Book and author») flip the same per-device mode, and
  // both repaint the en-curso lists: the author modal can be open ON TOP of En
  // curso (that is one of the ways in), so a flip made up there must not leave
  // the shelf underneath showing the other shelf's books.
  for (const id of MODE_TOGGLE_IDS) {
    const tog = $(id);
    if (!tog) continue;
    tog.addEventListener("click", flipShelf);
  }

  // ⏭️/✅ live in the #encProgressSec header, which shows on an empty shelf too:
  // ⏭️ still starts the cola there, ✅ greys out (paintInProgress).
  for (const [id, finish] of [
    ["encNextBtn", false],
    ["encFinishBtn", true],
  ]) {
    const btn = $(id);
    if (btn) btn.addEventListener("click", () => advanceFromProgress(finish));
  }

  // The «Multiselección» chip in the 🔜 En cola header: what turns the cola's
  // rows from "tap to open the book" into "tap to choose it". The mode changes
  // what a row DOES, not what is in it — and the rows read it live — so this
  // repaints attributes only, never the list.
  const chip = $("queueMultiChip");
  if (chip) {
    chip.addEventListener("click", () => {
      setQueueMulti();
      applyQueuePicks();
    });
  }

  // The cola's block-move bar: ▲▼ one slot, 🔝⤓ to the ends, ✕ to leave the mode.
  // Every mover re-pulls the queue inside moveQueueSelection, so the repaint
  // runQueueWrite ends with shows what actually landed on the server, not our
  // optimism — and a second tap during that round trip is dropped, not stacked.
  const bulk = [
    ["queueBulkTop", "top"],
    ["queueBulkUp", -1],
    ["queueBulkDown", +1],
    ["queueBulkBottom", "bottom"],
  ];
  for (const [id, how] of bulk) {
    const btn = $(id);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      if (!picked.size) return;
      runQueueWrite(() => moveQueueSelection(queueSelection(), how));
    });
  }
  // 🗑 takes the whole selection OFF the cola. The only removal on this list now:
  // the per-row 🗑 is gone with the per-row ▲▼, so unqueueing goes through the
  // same choose-then-act shape as moving. It is the one control here that cannot
  // be undone by tapping again, so it ALWAYS confirms — naming the count, or the
  // book itself when there is only one, because "quitar 7 libros" is a different
  // decision from "quitar éste". The confirm runs BEFORE runQueueWrite so a dialog
  // left open doesn't hold the write lock and swallow the next tap.
  const delBtn = $("queueBulkDel");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (!picked.size || queueBusy) return;
      const paths = queueSelection();
      const only = paths.length === 1 && queueRows.find((r) => r.p === paths[0]);
      if (
        !(await confirmDialog({
          title: "Quitar de la cola",
          message: only ? `«${only.t}»` : `${paths.length} libros`,
          okLabel: "Sí",
          cancelLabel: "No",
          danger: true,
        }))
      )
        return;
      runQueueWrite(() => removeQueueSelection(paths));
    });
  }
  // ✕ LEAVES the mode (and drops the selection with it) — the way out of
  // multi-select from the bar itself, without hunting for the chip again.
  const clearBtn = $("queueBulkClear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      setQueueMulti(false);
      applyQueuePicks();
    });
  }
  // The fold is the one thing in this modal you can tap without consequence: it
  // opens nothing, moves nothing, deletes nothing.
  const done = $("encDoneToggle");
  if (done) {
    done.addEventListener("click", () => {
      doneOpen = !doneOpen;
      applyDoneFold();
    });
  }
  applyModeCue(); // paint the toggle tint on load from the persisted shelf
}
