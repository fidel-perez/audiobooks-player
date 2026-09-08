/**
 * Catalog browser over a static book list — Standard Ebooks + Project
 * Gutenberg titles in `data/catalog.json`. Public-copy replacement for the
 * pi-scale (88k-book) personal-library browser: no favorites, wishlist,
 * sagas, author index or offline predictive buffer. A book's EPUB is fetched
 * from its public URL at open time and fed into the same local reader every
 * upload already uses (handleFiles); no book bytes ever live in this repo.
 */

import { $, setStatus, showToast, TOAST_UNDO_MS } from "./dom.js";
import { state } from "./state.js";
import {
  activateDoc,
  clearActive,
  handleFiles,
  evictOneFinished,
  unloadDocBySrc,
} from "./library.js";
import { openModal, wireModal, closeModal } from "./modal.js";
import { shortName } from "./utils.js";
import {
  finishedSrcSet,
  isSrcFinished,
  isDocFinished,
  markDocFinished,
  unmarkDocFinished,
  resetProgressByKey,
  dropProgress,
  isDropped,
  progressKeyForSrc,
  syncedProgressFor,
} from "./progress.js";
import { apiFetch } from "./storage.js";
import { currentMode, normMode } from "./mode.js";

const CATALOG_URL = "data/catalog.json";
const QUEUE_KEY = "audiobooks-queue";
const API_BASE = "/kv/";

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

// Catalog: loaded once, then read in-memory. `{books: [{p,t,a,lang,source,url}]}`
// — `p` is the catalog id, doubling as the "path" every other module already
// keys progress/queue entries on (see NOTES.md handoff: keeping this field
// name avoids touching encurso.js/progress.js at all).
let catalog = null;
let catalogPromise = null;
let libraryUp = null; // null = not probed yet; true/false once ensureCatalog settles

// Play queue: `[{id, mode}]`, day/night shelves like the pi build (mode.js).
let queue = [];

export async function initCatalog() {
  libraryUp = await ensureCatalog();
  await refreshQueue();
  refreshActiveBookCard();
}

export function ensureCatalog() {
  if (catalog) return Promise.resolve(true);
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const r = await fetch(CATALOG_URL, { headers: { Accept: "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!j || !Array.isArray(j.books)) throw new Error("bad catalog");
        catalog = {
          books: j.books.map((b) => ({
            p: b.id,
            t: b.title,
            a: b.author,
            lang: b.lang,
            source: b.source,
            url: b.url,
          })),
        };
        return true;
      } catch (_) {
        catalog = null;
        catalogPromise = null; // let a later demand retry
        return false;
      }
    })();
  }
  return catalogPromise;
}

/** No favorites/reactions/wishlist blobs in the public copy — nothing to load.
 *  Kept as an async stub: encurso.js awaits it alongside ensureCatalog. */
export async function ensureFavorites() {}

export function bookByPath(path) {
  if (!catalog) return null;
  return catalog.books.find((b) => b.p === path) || null;
}

/** The catalog book behind a row, by id; a minimal stand-in when it can't
 *  resolve (catalog not loaded, or the id fell out of the 18-title list). */
export function bookForRow(src, name) {
  if (!src) return null;
  return bookByPath(src) || { p: src, t: name || src, a: "" };
}

function stubFromPath(path) {
  return { p: path, t: String(path), a: "" };
}

function alphaCmp(a, b) {
  return collator.compare(a.a || "", b.a || "") || collator.compare(a.t || "", b.t || "");
}

/** Every catalog book, alphabetical by author then title. */
function allBooks() {
  return catalog ? catalog.books.slice().sort(alphaCmp) : [];
}

/* ===================== play queue ===================== */

function queueEntries(body) {
  const arr = Array.isArray(body) ? body : Array.isArray(body?.list) ? body.list : [];
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const id = typeof it === "string" ? it : it && typeof it.id === "string" ? it.id : null;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, mode: normMode(it && it.mode) });
    }
  }
  return out;
}

async function putQueueList(entries) {
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entries.map((e) => ({ id: e.id, mode: e.mode }))),
    });
    if (!r.ok) return false;
    queue = queueEntries(await r.json());
    return true;
  } catch (_) {
    return false;
  }
}

async function refreshQueue() {
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    queue = queueEntries(await r.json());
    return queue;
  } catch (_) {
    return null;
  }
}

export function isQueued(path) {
  return queue.some((e) => e.id === path);
}

function queueModeOf(path) {
  const e = queue.find((x) => x.id === path);
  return normMode(e && e.mode);
}

/** Re-seat `path` to the top or bottom of its own day/night shelf, stepping
 *  over the other shelf's entries. Pure. */
function moveWithinShelf(list, path, top) {
  const i = list.findIndex((e) => e.id === path);
  if (i < 0) return list;
  const out = list.slice();
  const [entry] = out.splice(i, 1);
  const same = out.map((e, k) => (e.mode === entry.mode ? k : -1)).filter((k) => k >= 0);
  const at = top ? (same.length ? same[0] : 0) : same.length ? same[same.length - 1] + 1 : out.length;
  out.splice(at, 0, entry);
  return out;
}

/** A book entering the queue is PARKED, not restarted: unload this device's
 *  copy, leave its reading position alone. Best-effort. */
async function parkQueuedBook(path) {
  try {
    const cur = state.docs[state.active];
    if (cur && cur.src === path) clearActive();
    await unloadDocBySrc(path);
  } catch (e) {
    console.error("queue park failed:", e);
  }
}

async function addToQueue(path, top = false, mode = currentMode()) {
  if (isQueued(path)) return;
  queue.push({ id: path, mode }); // optimistic
  await parkQueuedBook(path);
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ id: path, mode }]),
    });
    if (r.ok) {
      queue = queueEntries(await r.json());
      if (top) {
        queue = moveWithinShelf(queue, path, true);
        await putQueueList(queue);
      }
      return;
    }
    // Rejected (legacy dict shape under the key): rebuild from a fresh read and
    // persist the canonical array, migrating it in the same write.
    await refreshQueue();
    if (!isQueued(path)) queue.push({ id: path, mode });
    if (top) queue = moveWithinShelf(queue, path, true);
    await putQueueList(queue);
  } catch (e) {
    console.error("queue add failed:", e); // offline: optimistic push stands
  }
}

async function dropFromQueue(paths) {
  const gone = new Set(paths.filter((p) => queue.some((e) => e.id === p)));
  if (!gone.size) return true;
  queue = queue.filter((e) => !gone.has(e.id)); // optimistic
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _op: "remove_by_id", ids: [...gone] }),
    });
    if (r.ok) {
      queue = queueEntries(await r.json());
      return true;
    }
    await refreshQueue();
    queue = queue.filter((e) => !gone.has(e.id));
    return await putQueueList(queue);
  } catch (e) {
    console.error("queue remove failed:", e);
    return false;
  }
}

export async function removeFromQueue(path) {
  await dropFromQueue([path]);
}

export async function removeQueueSelection(paths) {
  const sel = paths.filter((p) => isQueued(p));
  if (!sel.length) return "gone";
  return (await dropFromQueue(sel)) ? "ok" : "offline";
}

/** Reorder a SET of queued books: `how` is -1/+1 (one slot) or "top"/"bottom".
 *  Folds into a fresh server read, like every whole-list queue write. */
export async function moveQueueSelection(paths, how) {
  if (!(await refreshQueue())) return "offline";
  const sel = paths.filter((p) => isQueued(p));
  if (!sel.length) return "gone";
  const mode = queueModeOf(sel[0]);
  const picked = new Set(sel);
  const slots = [];
  queue.forEach((e, k) => {
    if (e.mode === mode) slots.push(k);
  });
  let arr = slots.map((k) => queue[k]);
  if (how === "top" || how === "bottom") {
    const inSel = arr.filter((e) => picked.has(e.id));
    const rest = arr.filter((e) => !picked.has(e.id));
    arr = how === "top" ? [...inSel, ...rest] : [...rest, ...inSel];
  } else {
    const a = arr.slice();
    if (how < 0) {
      for (let k = 1; k < a.length; k++) {
        if (picked.has(a[k].id) && !picked.has(a[k - 1].id)) [a[k - 1], a[k]] = [a[k], a[k - 1]];
      }
    } else {
      for (let k = a.length - 2; k >= 0; k--) {
        if (picked.has(a[k].id) && !picked.has(a[k + 1].id)) [a[k], a[k + 1]] = [a[k + 1], a[k]];
      }
    }
    arr = a;
  }
  const out = queue.slice();
  slots.forEach((k, n) => {
    out[k] = arr[n];
  });
  queue = out;
  return (await putQueueList(queue)) ? "ok" : "offline";
}

export function getQueueCached() {
  const mode = currentMode();
  return queue.filter((e) => e.mode === mode).map((e) => bookByPath(e.id) || stubFromPath(e.id));
}

export async function getQueueBooks() {
  await Promise.all([ensureCatalog(), refreshQueue()]);
  const mode = currentMode();
  return queue.filter((e) => e.mode === mode).map((e) => bookByPath(e.id) || stubFromPath(e.id));
}

export async function selectQueuedBook(bk) {
  const removal = removeFromQueue(bk.p); // unawaited: the open waits on no store
  const opened = await loadBook(bk, false, true); // select-only: never auto-plays
  if (!opened) {
    // A failed open must not spend the queue entry.
    await removal;
    await addToQueue(bk.p, true);
  }
  return opened;
}

export function openCatalogBook(src, title) {
  const bk = bookByPath(src) || { p: src, t: title || src };
  loadBook(bk, false, true); // select-only: never auto-plays
}

/* ===================== opening a book ===================== */

async function loadBook(bk, forcePlay, select) {
  const openIdx = state.docs.findIndex((d) => d.src === bk.p && !isDropped(d.docKey));
  if (openIdx >= 0) {
    closeModal("bibModal");
    closeModal("bookModal");
    setStatus(`"${bk.t}" ya estaba abierto en este dispositivo.`);
    activateDoc(openIdx, forcePlay, select);
    return true;
  }
  if (!bk.url) {
    setStatus(`"${bk.t}" no tiene un origen descargable.`);
    return false;
  }
  setStatus(`Descargando "${bk.t}"…`);
  let file;
  try {
    const r = await fetch(bk.url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const name = decodeURIComponent(bk.url.split("/").pop() || "") || `${shortName(bk.t)}.epub`;
    file = new File([blob], name, { type: blob.type || "application/epub+zip" });
  } catch (e) {
    setStatus(`Error al descargar "${bk.t}": ${e.message}`);
    return false;
  }
  closeModal("bibModal");
  closeModal("bookModal");
  const idx = await handleFiles([file], bk.p, bk.a);
  if (!(idx >= 0)) return false;
  activateDoc(idx, forcePlay, select);
  return true;
}

/* ===================== auto-advance ===================== */

function nothingLeftToRead() {
  showToast("📚 No queda ningún libro sin leer en el catálogo.");
}

/** A book just finished: play, in priority order, the next QUEUED book (on the
 *  finished book's shelf), else the next catalog book after it (wrapping),
 *  else a random one — an 18-title catalog needs none of the pi build's
 *  offline buffer or series-gap machinery to do this. */
export async function advanceAfterFinish(finishedSrc) {
  const prev = state.docs[state.active] || null;
  const hasCatalog = await ensureCatalog();
  if (!hasCatalog) {
    showToast("📚 Sin catálogo: no hay libro siguiente que buscar.");
    return;
  }
  await evictOneFinished(); // free a slot before the advance appends one
  const shelf = prev ? normMode(prev.mode) : normMode(currentMode());
  const done = finishedSrcSet();

  const modeQueue = queue.filter((e) => e.mode === shelf);
  for (const e of modeQueue) {
    if (e.id === prev?.src || done.has(e.id)) continue;
    const bk = bookByPath(e.id);
    if (!bk) continue;
    const removal = removeFromQueue(e.id); // unawaited: the open waits on no store
    setStatus(`🔜 Siguiente en la cola: "${bk.t}".`);
    if (await advanceTo(bk, prev, bk)) return;
    await removal;
    await addToQueue(e.id, true, e.mode);
    break;
  }

  const matches = allBooks().filter((bk) => {
    const qe = queue.find((x) => x.id === bk.p);
    return !qe || normMode(qe.mode) === shelf;
  });
  if (!matches.length) return nothingLeftToRead();
  const canLand = (bk) => bk.p !== finishedSrc && !done.has(bk.p);
  const idx = finishedSrc ? matches.findIndex((b) => b.p === finishedSrc) : -1;
  if (idx >= 0 && matches.length > 1) {
    for (let step = 1; step < matches.length; step++) {
      const bk = matches[(idx + step) % matches.length];
      if (canLand(bk)) {
        setStatus(`🔜 Siguiente: "${bk.t}".`);
        if (await advanceTo(bk, prev, null)) return;
        break;
      }
    }
  }
  const pool = matches.filter(canLand);
  if (!pool.length) return nothingLeftToRead();
  const bk = pool[Math.floor(Math.random() * pool.length)];
  setStatus(`🎲 Auto: "${bk.t}".`);
  await advanceTo(bk, prev, null);
}

/** Load the auto-advance's pick and say so on screen, with a way back. */
async function advanceTo(bk, prev, requeued) {
  if (!(await loadBook(bk, true))) return false;
  const back = prev ? bookForRow(prev.src, prev.name) : null;
  showToast(`▶ Ahora: «${bk.t}»`, {
    ms: TOAST_UNDO_MS,
    undo: back ? { label: `↩ Volver a «${back.t}»`, onUndo: () => undoAdvance(prev, requeued) } : null,
  });
  return true;
}

async function undoAdvance(prev, requeued) {
  const i = state.docs.indexOf(prev);
  if (i >= 0) activateDoc(i, false, true);
  else if (prev?.src) {
    const bk = bookByPath(prev.src);
    if (bk) await loadBook(bk, false, true);
  }
  if (requeued) await addToQueue(requeued.p, true);
}

/* ===================== the book card ===================== */

/** ONE card shape everywhere: the catalog list, the queue and the "libros
 *  abiertos" shelf. No favorite/reaction rings, no gender/saga badges — see
 *  NOTES.md; only title, author, and the ✔ finished cue this book carries. */
export function buildBookCard(bk, opts = {}) {
  const row = document.createElement("div");
  row.className = opts.rowClass ? `bib-row ${opts.rowClass}` : "bib-row";

  const b = document.createElement("button");
  b.type = "button";
  b.className = opts.itemClass ? `bib-item ${opts.itemClass}` : "bib-item";
  b.title = opts.title || "Tocar para ver el libro";

  if (opts.icon) {
    const i = document.createElement("span");
    i.className = "ico";
    i.textContent = opts.icon;
    b.appendChild(i);
  }

  const l = document.createElement("span");
  l.className = "lbl";
  const t = document.createElement("span");
  t.className = "bib-title";
  t.textContent = bk.t;
  l.appendChild(t);
  if (bk.a) {
    const a = document.createElement("span");
    a.className = "bib-author";
    a.textContent = bk.a;
    l.appendChild(a);
  }
  if (bk.lang || bk.source) {
    const s = document.createElement("span");
    s.className = "bib-saga";
    s.textContent = [bk.lang ? bk.lang.toUpperCase() : "", bk.source || ""]
      .filter(Boolean)
      .join(" · ");
    l.appendChild(s);
  }
  b.appendChild(l);

  if (isQueued(bk.p)) b.classList.add("st-queued");
  markFinishedCue(b, !!opts.finished);

  if (opts.onClick) b.addEventListener("click", opts.onClick);
  row.appendChild(b);
  if (opts.menu) {
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openBookMenu(bk, opts.menu);
    });
  }
  return row;
}

function markFinishedCue(btn, done) {
  btn.classList.toggle("st-done", !!done);
  if (!done) return;
  const c = document.createElement("span");
  c.className = "bib-check";
  c.textContent = "📖";
  c.title = "Leído";
  btn.appendChild(c);
}

function bookRow(bk) {
  const menu = { src: bk.p, onAfter: () => catalog && renderCatalog() };
  return buildBookCard(bk, {
    finished: isSrcFinished(bk.p),
    title: "Tocar para ver el libro y sus opciones",
    onClick: () => openBookMenu(bk, menu),
    menu,
  });
}

/* ===================== catalog list modal (#bibModal) ===================== */

let searchQuery = "";

export async function openCatalog() {
  openModal("bibModal");
  if (!catalog) {
    const list = $("bibList");
    list.innerHTML = "";
    list.textContent =
      libraryUp === false
        ? "El catálogo no responde. Comprueba la conexión y vuelve a intentarlo."
        : "Cargando el catálogo…";
    $("bibCount").textContent = "";
  }
  if (await ensureCatalog()) renderCatalog();
}

function filteredBooks() {
  const books = allBooks();
  const q = searchQuery.trim().toLowerCase();
  if (!q) return books;
  return books.filter((bk) => `${bk.t} ${bk.a}`.toLowerCase().includes(q));
}

function renderCatalog() {
  const list = $("bibList");
  const matches = filteredBooks();
  $("bibCount").textContent = matches.length ? `${matches.length} libro(s)` : "";
  list.innerHTML = "";
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "bib-empty";
    empty.textContent = "Ningún libro con esta búsqueda.";
    list.appendChild(empty);
    return;
  }
  matches.forEach((bk) => list.appendChild(bookRow(bk)));
}

/* ===================== the book menu (#bookModal) ===================== */

let openMenuBook = null;
let openMenuCtx = null;

function resolveMenuCtx(bk, ctx) {
  const src = ctx.src || bk.p || null;
  const doc = ctx.docKey
    ? state.docs.find((d) => d.docKey === ctx.docKey) || null
    : (src ? state.docs.find((d) => d.src === src) : null) || null;
  const progKey = ctx.docKey || (doc && doc.docKey) || progressKeyForSrc(src);
  const hasProgress = !!doc || (!!progKey && !!syncedProgressFor(progKey));
  return { src, doc, progKey, hasProgress };
}

/** Open the single-book action sheet: ▶️ open, queue, finished mark, clear
 *  progress, remove from "en curso". Replaces the pi build's «Book and
 *  author» modal — there is no author browse without an author index. */
export function openBookMenu(bk, ctx = {}) {
  openMenuBook = bk;
  openMenuCtx = ctx;
  paintBookMenu();
  openModal("bookModal");
}

function closeBookMenu() {
  openMenuBook = null;
  openMenuCtx = null;
  closeModal("bookModal");
}

function menuButton(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bib-chip bib-act";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function paintBookMenu() {
  const body = $("bookMenuBody");
  if (!body || !openMenuBook) return;
  const bk = bookByPath(openMenuBook.p) || openMenuBook;
  const ctx = openMenuCtx || {};
  const { src, progKey, hasProgress } = resolveMenuCtx(bk, ctx);
  const finished = progKey ? isDocFinished(progKey) || isSrcFinished(src) : false;
  const onShelf = !!progKey && !isDropped(progKey);

  body.innerHTML = "";
  const head = document.createElement("div");
  head.appendChild(buildBookCard(bk, { finished }));
  body.appendChild(head);

  const rerender = () => {
    paintBookMenu();
    if (typeof ctx.onAfter === "function") ctx.onAfter();
  };

  const actions = document.createElement("div");
  actions.className = "cat-queue-controls";
  actions.appendChild(
    menuButton("▶️ Abrir", async () => {
      closeBookMenu();
      await loadBook(bk, false, true);
    }),
  );
  if (src) {
    actions.appendChild(
      isQueued(src)
        ? menuButton("❌ Quitar de la cola", async () => {
            await removeFromQueue(src);
            rerender();
          })
        : menuButton("🔜 Añadir a la cola", async () => {
            await addToQueue(src, true);
            rerender();
          }),
    );
  }
  if (progKey) {
    actions.appendChild(
      finished
        ? menuButton("↩️ Quitar «leído»", () => {
            unmarkDocFinished(progKey);
            rerender();
          })
        : menuButton("✅ Marcar leído", () => {
            markDocFinished(progKey);
            rerender();
          }),
    );
    if (hasProgress) {
      actions.appendChild(
        menuButton("🧹 Limpiar progreso", () => {
          resetProgressByKey(progKey);
          rerender();
        }),
      );
    }
    if (onShelf) {
      actions.appendChild(
        menuButton("🗑 Quitar de «en curso»", () => {
          dropProgress(progKey);
          rerender();
        }),
      );
    }
  }
  body.appendChild(actions);
}

/* ===================== active-book card + boot placeholder ===================== */

function renderActiveBookCard(doc) {
  const host = $("bookCard");
  if (!host || !doc) return;
  const bk = bookForRow(doc.src, doc.name);
  host.innerHTML = "";
  host.appendChild(
    buildBookCard(bk, {
      icon: "📖",
      finished: isDocFinished(doc.docKey),
      rowClass: "book-card-row",
      itemClass: "book-card-item",
      title: "Toca para «En curso» · clic derecho para opciones",
      onClick: () => document.dispatchEvent(new CustomEvent("audiobooks:open-encurso")),
      menu: { docKey: doc.docKey, src: bk.p, onAfter: () => renderActiveBookCard(doc) },
    }),
  );
  host.hidden = false;
  $("status").hidden = true;
  $("resumeNote").hidden = true;
}

function refreshActiveBookCard() {
  if (state.active < 0) return;
  renderActiveBookCard(state.docs[state.active]);
}

function clearActiveBookCard() {
  const host = $("bookCard");
  if (host) {
    host.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "book-card-empty";
    btn.textContent = "📖 En curso — elige un libro";
    btn.title = "Abrir «En curso»: tus libros abiertos y la cola";
    btn.addEventListener("click", () =>
      document.dispatchEvent(new CustomEvent("audiobooks:open-encurso")),
    );
    host.appendChild(btn);
    host.hidden = false;
  }
  $("status").hidden = false;
  $("resumeNote").hidden = false;
}

/** Boot is over: whatever the card slot holds now is the truth. */
export function settleBootCard() {
  if (state.active < 0) clearActiveBookCard();
}

/* ===================== wiring ===================== */

export function bindCatalog() {
  wireModal("bibModal");
  wireModal("bookModal");

  const btn = $("catalogBtn");
  if (btn) btn.addEventListener("click", openCatalog);

  document.addEventListener("audiobooks:activated", (e) => renderActiveBookCard(e.detail?.doc));
  document.addEventListener("audiobooks:cleared", clearActiveBookCard);
  // Boot hasn't restored the library yet at bind time; settleBootCard() (from
  // main.js, after the restore) resolves the slot either way.

  const search = $("bibSearch");
  if (search) {
    search.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      if (catalog) renderCatalog();
    });
  }
  const searchBtn = $("bibSearchBtn");
  if (searchBtn && search) {
    searchBtn.addEventListener("click", () => {
      const show = search.hidden;
      search.hidden = !show;
      searchBtn.setAttribute("aria-pressed", String(show));
      if (show) {
        search.focus();
      } else if (searchQuery) {
        searchQuery = "";
        search.value = "";
        if (catalog) renderCatalog();
      }
    });
  }
}
