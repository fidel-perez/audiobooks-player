/**
 * The document library: file loading, the tab strip, activating / removing
 * docs, and chapter selection.
 */

import { MAX_DOCS, LS_POS_PREFIX, LS_ACTIVE_KEY } from "./config.js";
import {
  dropChapterOpeningNumbers,
  dropNumberLinesFromChunks,
  dropPrintChromeFromChunks,
  numberDenseIn,
  numberScaleIn,
  setDoubletEdit,
  setNumberDense,
  setNumberScale,
} from "./cleanForSpeech.js";
import { doubletEditIn } from "./deDoublet.js";
import { $, setStatus } from "./dom.js";
import { idbDelete, storeDoc } from "./db.js";
import { ensureHydrated, processPdf } from "./pdf.js";
import { isEpubFile, processEpub } from "./epub.js";
import { isTextFile, processTextFile } from "./text.js";
import {
  docPct,
  saveProgress,
  isDocFinished,
  openedTsFor,
  registerOpenBook,
  dropProgress,
  syncedProgressFor,
  chunkAtCharIn,
  clampOffset,
} from "./progress.js";
import { currentMode, normMode } from "./mode.js";
import {
  jumpAndMaybePlay,
  play,
  prewarmResumePoint,
  setPlaying,
  stopAll,
  updateProgress,
} from "./player.js";
import { state } from "./state.js";
import { shortName } from "./utils.js";
import { confirmDialog } from "./ui.js";

/* ===================== chapters ===================== */
export function renderChapters() {
  const sel = $("chapter");
  if (!state.chapters.length) {
    $("chapWrap").classList.add("hidden");
    sel.innerHTML = "";
    return;
  }
  sel.innerHTML = '<option value="">— Selecciona capítulo —</option>';
  state.chapters.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = i;
    const skipped = state.chapterSkipped[i];
    // Skipped front/back matter stays visible (proof it exists) but greyed and
    // unselectable — the reader treats it as if it weren't there.
    o.textContent = skipped ? `⤫ ${c.title}` : c.title;
    if (skipped) {
      o.disabled = true;
      o.className = "chap-skip";
    }
    sel.appendChild(o);
  });
  $("chapWrap").classList.remove("hidden");
}

/** Jump to a chapter by its index in state.chapters. */
export function gotoChapter(i) {
  if (i === "" || i == null) return;
  jumpAndMaybePlay(state.chapters[i].charIndex, false);
}

/* ===================== tab strip ===================== */
export function renderTabs() {
  // The visible tab strip was removed; a future "in-progress" modal will manage
  // multiple docs. Guard so callers keep working with no #tabs in the DOM.
  const wrap = $("tabs");
  if (!wrap) return;
  wrap.innerHTML = "";
  state.docs.forEach((d, i) => {
    const el = document.createElement("div");
    el.className = `tab${i === state.active ? " active" : ""}`;
    el.title = d.name;
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = `${i + 1}. ${shortName(d.name)}`;
    const pp = document.createElement("span");
    pp.className = "pp";
    pp.textContent = `${docPct(d)}%`;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Quitar este documento";
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeDoc(i);
    });
    el.appendChild(nm);
    el.appendChild(pp);
    el.appendChild(x);
    el.addEventListener("click", () => activateDoc(i));
    wrap.appendChild(el);
  });
}

/* ===================== activate / remove ===================== */

/**
 * Decide whether ACTIVATING a doc should also START playback.
 *
 * The invariant the "en curso" modal relies on: SELECTING a book there never
 * auto-plays — the ONLY thing that starts audio is the player's ▶ Play button.
 * So `select: true` always wins and returns false, even when a book was already
 * playing or the caller asked to force play. Everywhere else keeps the prior
 * rule: an explicit `forcePlay` (the 🎲 random pick / auto-advance) always plays,
 * and a plain switch keeps playing only if something already was. Kept a pure,
 * exported function so the "select must not play" rule is unit-testable without
 * driving the whole DOM/audio machinery.
 */
export function shouldPlayOnActivate({
  wasPlaying = false,
  forcePlay = false,
  select = false,
} = {}) {
  if (select) return false;
  return !!(wasPlaying || forcePlay);
}

/**
 * Move a loaded doc to the FURTHEST place any device has reached, when that is
 * ahead of where this one left it. Returns true if it moved.
 *
 * The en-curso row has always done this (`openDocFromEnCurso`); every other entry
 * point — the boot restore, a tab switch, 🎲, the queue's auto-advance — opened
 * the book at this device's own offset instead, so a device that had been closed
 * while another read on reopened in the past. Doing it here makes it universal
 * rather than one path's special case.
 */
function adoptAheadPlace(d) {
  // A boot-restored doc is cold until something asks for its chunks; this is one
  // of the two places that does (see pdf.js#ensureHydrated).
  ensureHydrated(d);
  const chunks = d.chunks || [];
  if (!chunks.length || isDocFinished(d.docKey)) return false;
  const sync = syncedProgressFor(d.docKey);
  if (!sync) return false;
  const at = chunks[Math.min(d.curChunk || 0, chunks.length - 1)].start;
  if (!(sync.pos > at)) return false;
  d.curChunk = chunkAtCharIn(chunks, sync.pos);
  // Adopt the other device's WORD too, not just its paragraph — otherwise we
  // re-read whatever it had already spoken of that paragraph.
  d.chunkOffset = clampOffset(chunks[d.curChunk], sync.off);
  return true;
}

/**
 * A server pull landed and some LOADED books sit behind the position another
 * device pushed (progress.js#reconcileAheadDocs fires `audiobooks:ahead`). Adopt
 * it. The book playback is ENGAGED on — playing or paused — is skipped:
 * progress.js already excludes it, and this is the belt to that braces. A book
 * must never jump out from under the listener, and a pause does not end the
 * listening; the ▶ is still under their thumb.
 */
export function adoptAheadDocs(keys) {
  const engaged = state.speaking;
  let moved = false;
  for (const key of keys || []) {
    const i = state.docs.findIndex((d) => d.docKey === key);
    if (i < 0 || (engaged && i === state.active)) continue;
    if (!adoptAheadPlace(state.docs[i])) continue;
    moved = true;
    if (i === state.active) {
      state.curChunk = state.docs[i].curChunk;
      state.chunkOffset = state.docs[i].chunkOffset;
      updateProgress();
      // The ONE case the reader can SEE: the bar on the open book just moved.
      // Silently it reads as the app losing their place; named, it reads as the
      // sync doing its job.
      setStatus("⤴️ Posición actualizada desde otro dispositivo.");
    }
  }
  if (moved) renderTabs();
}

export function activateDoc(i, forcePlay, select) {
  if (i < 0 || i >= state.docs.length) return;
  const wasPlaying = state.speaking && !state.paused;
  // En-curso "select" of the book that's ALREADY PLAYING must not interrupt it:
  // keep it playing, no teardown, no reposition. Only a SWAP to a different book
  // stops playback (and even then never auto-plays the new one — see
  // shouldPlayOnActivate). forcePlay callers (🎲 / auto-advance) still fall
  // through to (re)start playback as before.
  if (select && i === state.active && wasPlaying) return;
  if (state.active >= 0) {
    state.docs[state.active].curChunk = state.curChunk;
    state.docs[state.active].chunkOffset = state.chunkOffset;
    saveProgress();
  }
  stopAll(true);

  state.active = i;
  const d = state.docs[i];
  // The one book that MUST be warm. Boot leaves every restored doc cold and pays
  // for exactly this one, here, instead of for all twenty before the first paint.
  ensureHydrated(d);
  // Open at the furthest place ANY device reached, not just this one's. The boot
  // restore and the server pull race, so progress.js fires `audiobooks:ahead`
  // after a pull lands too; both paths are idempotent (forward-only).
  adoptAheadPlace(d);
  state.fullText = d.fullText;
  // Print numbering ("48" alone between two paragraphs) is only recognisable
  // against the whole book, and stored text is never re-parsed.
  const numbered = numberScaleIn(d.fullText);
  setNumberScale(numbered);
  if (numbered) dropNumberLinesFromChunks(d.chunks, d.fullText);
  else dropChapterOpeningNumbers(d.chunks, d.fullText, d.chapters);
  // A verse marker needs the newline the chunk lost, so this re-cut is what
  // retrofits a book already imported.
  const dense = numberDenseIn(d.fullText);
  setNumberDense(dense);
  if (dense) dropPrintChromeFromChunks(d.chunks, d.fullText);
  // A book imported before this shipped keeps its doublets in the stored text;
  // the speak-time pass is what takes them out of the audio.
  setDoubletEdit(doubletEditIn(d.fullText));
  state.charTotal = d.charTotal;
  state.chunks = d.chunks;
  state.chapters = d.chapters;
  state.chapterSkipped = d.chapterSkipped || [];
  state.bodyStartChar = d.bodyStartChar || 0;
  state.bodyEndChar = d.bodyEndChar || d.charTotal;
  state.pageCharStarts = d.pageCharStarts;
  state.numPages = d.numPages;
  state.wordsBefore = d.wordsBefore;
  state.totalWords = d.totalWords;
  state.curChunk = d.curChunk;
  // Switching back to a book resumes on the WORD it was paused on, not the top
  // of its paragraph — the doc carries the offset the same way it carries curChunk.
  state.chunkOffset = d.chunkOffset || 0;
  state.docKey = d.docKey;
  // Remember which book is open so a page reload reopens THIS one, not docs[0].
  try {
    localStorage.setItem(LS_ACTIVE_KEY, d.docKey);
  } catch (_) {}

  // Opening a catalog book puts it on the SHARED cross-device "en curso" shelf
  // right away (not only after the first playback save), so another instance
  // sees it immediately. No-op for local uploads (no src) and never regresses a
  // further-along position another device already pushed.
  registerOpenBook(d);

  $("controls").hidden = false;
  renderChapters();
  renderTabs();
  // The old status + resume-note lines are gone: biblioteca.js renders a
  // book card into #bookCard in their place (title + author, right-click to
  // valorate, tap for the author's other books). Fire the event it listens on.
  document.dispatchEvent(
    new CustomEvent("audiobooks:activated", { detail: { doc: d } }),
  );
  updateProgress();

  if (shouldPlayOnActivate({ wasPlaying, forcePlay, select })) {
    play();
    return;
  }
  // Nothing is going to play on its own, so the book is now sitting open with a
  // ▶ waiting to be pressed. Spend that idle time rendering the paragraph the
  // press will land on — the wait the user hit ("a couple of paragraphs till it
  // all works") is that first synthesis happening after the tap instead of
  // before it. The player owns the warm-up so its `base` cannot drift from the
  // one speakCurrent computes; a different base is a different cache key, and a
  // render nobody asks for.
  prewarmResumePoint();
}

/**
 * User-initiated 🗑 removal (from the 📖 en-curso long-press menu): drop the book
 * from this device AND forget its cross-device progress, so it leaves the "en
 * curso" shelf for good instead of re-listing as a ☁ row on the next refresh
 * (the "trash quitar but it still shows En curso" bug). Confirms first; returns
 * true iff the book was actually removed. The MAX_DOCS auto-eviction uses
 * removeDocSilent, which KEEPS the progress entry (the book stays resumable).
 */
export async function removeDoc(i) {
  if (i < 0 || i >= state.docs.length) return false;
  const { docKey, name } = state.docs[i];
  if (
    !(await confirmDialog({
      title: "Quitar de en curso",
      message: `«${shortName(name)}»`,
      okLabel: "Sí",
      cancelLabel: "No",
      danger: true,
    }))
  ) {
    return false;
  }
  await removeDocSilent(i);
  dropProgress(docKey); // forget the synced entry so it can't re-list as ☁
  return true;
}

/**
 * Evict a locally-loaded doc whose book was trashed on ANOTHER device — a
 * tombstone pulled into the synced map (progress.js fires `audiobooks:dropped`,
 * main.js routes it here). Cleanup only: the shelf already hides it (`isDropped`),
 * so this just frees the MAX_DOCS slot + its IndexedDB text, KEEPING the progress
 * tombstone so the deletion still propagates. Never evicts the currently-active
 * doc — a book you're listening to isn't yanked mid-sentence (the caller filters
 * it out; this re-checks). Returns true iff a doc was unloaded.
 */
export async function evictDroppedDoc(docKey) {
  if (!docKey) return false;
  const i = state.docs.findIndex((d) => d.docKey === docKey);
  if (i < 0 || i === state.active) return false;
  await removeDocSilent(i);
  return true;
}

/** Index of the most recently opened doc (max openedTs), `pred` narrowing the
 *  candidates. Falls back when none carries an open stamp. */
function mostRecentlyOpenedIndex(fallback, pred) {
  let best = -1;
  let bestTs = 0;
  state.docs.forEach((d, i) => {
    if (pred && !pred(d)) return;
    const ts = openedTsFor(d.docKey);
    if (ts > bestTs) {
      bestTs = ts;
      best = i;
    }
  });
  return best >= 0 ? best : fallback;
}

/** Empty the player slot without unloading anything: no card, no controls, and
 *  no book to reopen on the next boot. */
export function clearActive() {
  // Parked, not dropped: it reopens where it stopped. (🗑 already spliced its
  // doc out, so it saves nothing.)
  const cur = state.docs[state.active];
  if (cur) {
    cur.curChunk = state.curChunk;
    cur.chunkOffset = state.chunkOffset;
    saveProgress();
  }
  stopAll();
  // An empty slot must be empty to the lock screen too: `play()` guards only on
  // the loaded chunks.
  state.chunks = [];
  state.docKey = "";
  state.active = -1;
  // "" means PARKED ON PURPOSE. Removing the key read as "never set", so the
  // next reload opened docs[0] — a book nobody chose.
  try {
    localStorage.setItem(LS_ACTIVE_KEY, "");
  } catch (_) {}
  $("controls").hidden = true;
  document.dispatchEvent(new CustomEvent("audiobooks:cleared"));
  renderTabs();
}

/**
 * An off-shelf book kept PLAYING on the card while you viewed the other
 * estantería: the shelves-are-one-list leak. Moves nothing; re-shelving stays
 * 🌙⇄☀️.
 */
export function syncActiveToShelf(mode) {
  const m = normMode(mode);
  const cur = state.docs[state.active];
  if (cur && normMode(cur.mode) === m) return;
  const onShelf = (d) => normMode(d.mode) === m;
  const i = mostRecentlyOpenedIndex(state.docs.findIndex(onShelf), onShelf);
  if (i >= 0) activateDoc(i, false, true);
  else if (cur) clearActive();
}

/** Remove doc `i` without confirming — used by MAX_DOCS auto-eviction. */
async function removeDocSilent(i) {
  if (i < 0 || i >= state.docs.length) return;
  const key = state.docs[i].docKey;
  const wasActive = i === state.active;
  // Removing the book that is READING means SILENCE, never a hand-off to whichever
  // book happens to sit next to it on the shelf. Playback dies HERE, before the
  // neighbour is activated below: activateDoc reads `state.speaking` as "carry on"
  // (shouldPlayOnActivate), so while the removed book was still flagged as speaking,
  // 🗑 — and 🔜, which parks the open book the same way — started reading a book
  // nobody chose. It also cuts the voice at once instead of letting the deleted book
  // talk on across the await below.
  if (wasActive) stopAll();
  state.docs.splice(i, 1);
  try {
    await idbDelete(key);
  } catch (_) {}
  try {
    localStorage.removeItem(LS_POS_PREFIX + key);
  } catch (_) {}
  if (state.docs.length === 0) {
    clearActive();
    setStatus("No hay documentos cargados.");
    return;
  }
  if (wasActive) {
    state.active = -1;
    // Hand off to the LAST-KNOWN-OPEN book (max openedTs), not whichever doc
    // happens to sit at this shelf index — parking the active book to the queue
    // used to jump to a seemingly-random neighbour. Fall back to the index
    // neighbour only when nothing carries an open stamp (local uploads).
    activateDoc(mostRecentlyOpenedIndex(Math.min(i, state.docs.length - 1)));
  } else {
    if (i < state.active) state.active--;
    renderTabs();
  }
}

/**
 * Drop this device's copy of a catalog book, no confirm — queueing it IS the
 * confirmation (`parkQueuedBook`: a queued book leaves "abiertos"). Unlike
 * removeDoc this leaves the PROGRESS ENTRY alone, which is what lets the book
 * keep its place: the local `LS_POS_PREFIX` offset goes with the doc, but
 * `loadSavedPos` falls back to the synced entry, so reopening it from the queue
 * resumes where you were. If the book was the active one, removeDocSilent stops
 * the reading and activates its neighbour, silently (or clears the player).
 * Returns true iff a doc was actually unloaded.
 */
export async function unloadDocBySrc(src) {
  if (!src) return false;
  const i = state.docs.findIndex((d) => d.src === src);
  if (i < 0) return false;
  await removeDocSilent(i);
  return true;
}

/**
 * Free a MAX_DOCS slot before an auto-advance load so a long binge doesn't
 * silently stall at the limit. Evicts the oldest *finished* doc (by `order`);
 * if none are finished, the oldest non-active doc overall. Never touches the
 * active doc. No-op while under the limit. Returns true if it evicted one.
 */
export async function evictOneFinished() {
  if (state.docs.length < MAX_DOCS) return false;
  const cand = state.docs
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => i !== state.active);
  if (!cand.length) return false;
  const finished = cand.filter(({ d }) => isDocFinished(d.docKey));
  const pool = finished.length ? finished : cand;
  pool.sort((a, b) => (a.d.order || 0) - (b.d.order || 0));
  await removeDocSilent(pool[0].i);
  return true;
}

/* ===================== loading / clearing ===================== */
/**
 * Parse + persist books into the library. The ONLY caller is the biblioteca's
 * catalog download (openCatalogBook / loadBook), which always passes `srcPath` +
 * `author`; the ➕ local-file picker that used to call it with neither is gone,
 * pending a redo as an upload INTO the raspi biblioteca. The `srcPath`-less path
 * is kept working (a doc with no `src` just doesn't sync cross-device).
 */
export async function handleFiles(files, srcPath, author) {
  if (!files.length) return;
  let added = -1;
  for (const f of files) {
    if (state.docs.length >= MAX_DOCS) {
      setStatus(`Límite de ${MAX_DOCS} documentos alcanzado. No se añaden más.`);
      break;
    }
    const key = `${f.name}_${f.size}`.replace(/[^\w.\-]/g, "_");
    const existing = state.docs.findIndex((d) => d.docKey === key);
    if (existing >= 0) {
      // Re-opening an already-loaded book (re)assigns it to the CURRENT shelf, so
      // toggling to day mode and opening a night book moves it to the day shelf.
      const doc = state.docs[existing];
      let dirty = false;
      if (doc.mode !== currentMode()) {
        doc.mode = currentMode();
        dirty = true;
      }
      // A book first opened without a src (drag-drop, or an offline folder
      // browse) and later re-opened FROM the library gains its catalog path now,
      // so it starts syncing to the cross-device shelf instead of staying local.
      if (srcPath && !doc.src) {
        doc.src = srcPath;
        if (author && !doc.a) doc.a = author;
        dirty = true;
      }
      if (dirty) storeDoc(doc); // persist the shelf move / src (fire-and-forget)
      if (added < 0) added = existing;
      continue;
    }
    setStatus(`Procesando "${f.name}"…`);
    try {
      let doc;
      if (isEpubFile(f)) doc = await processEpub(f, key);
      else if (isTextFile(f)) doc = await processTextFile(f, key);
      else doc = await processPdf(f, key);
      doc.order = Date.now();
      // Opening a fresh book puts it on the CURRENT en-curso shelf (day/night).
      doc.mode = currentMode();
      // Remember the raspi-library path + author so this book syncs to the
      // cross-device "en curso" shelf AND its author page resolves even when the
      // catalog can't (rebuilt / momentarily down). A FUTURE "upload a book"
      // feature will put uploads INTO the raspi biblioteca, so they'll carry a
      // src + author too and sync exactly like library books do today.
      if (srcPath) doc.src = srcPath;
      if (author) doc.a = author;
      state.docs.push(doc);
      await storeDoc(doc);
      if (added < 0) added = state.docs.length - 1;
    } catch (err) {
      setStatus(`Error con "${f.name}": ${err.message}`);
    }
  }
  if (state.active < 0 && added >= 0) {
    activateDoc(added);
  } else {
    renderTabs();
    if (added >= 0) {
      setStatus("Añadido y guardado.");
    }
  }
  // Index of the doc just loaded (or the pre-existing match), so callers like
  // the 🎲 random-book flow can activate + play it. -1 if nothing loaded.
  return added;
}
