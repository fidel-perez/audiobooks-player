/**
 * Server-library browser + catalog filter bar.
 *
 * When the app is served from the Pi, an nginx location (`/biblioteca/`, JSON
 * autoindex) exposes the operator's document library
 * (`/home/pi/SSD_1TB_DATA/data/biblioteca/Biblioteca`, mounted read-only into
 * the static_server container). This module lets the user browse those folders
 * and load a PDF/EPUB/TXT/MD straight into the reader — no manual upload.
 *
 * TWO modes, chosen at open time:
 *  - Catalog mode (preferred): if `/biblioteca-index/catalog.json` is served
 *    (a flattened dump of the pi's books.db, built by
 *    bin/biblioteca/export_catalog.py), we show an action bar — 🎛️ filters,
 *    🔤 sort, 🔍 search, 🎲 random — over a flat, client-side-filtered book
 *    list. 🎛️ opens a drawer holding the narrowing chips (favorites ⭐/👤,
 *    reactions 👍/👎, primigenia 🏛️, finished ✔, a 3-state author-gender chip
 *    ♂/♀/⚥ defaulting to ⚥ (all), and a category dropdown); its badge NAMES the
 *    ones that are on ("🎛️ ♂ ⭐"), so a narrowed view stays legible — and legible
 *    about WHICH filter narrowed it — with the drawer shut.
 *  - Folder mode (fallback): no catalog served → the original raw folder
 *    browser over the nginx autoindex.
 *
 * It is a progressive enhancement: the 📚 button stays hidden unless the
 * listing endpoint answers (so a local/offline copy of the app is unaffected).
 * The reader itself remains local-only — a fetched file is parsed and persisted
 * through `handleFiles` (IndexedDB + localStorage), which is now the ONE way a
 * book enters the app (the ➕ local-file picker was removed).
 */

import { copyOrShow } from "../_shared/clipboard/copyText.js";
import { $, setStatus, showToast, TOAST_UNDO_MS } from "./dom.js";
import { state } from "./state.js";
import {
  activateDoc,
  clearActive,
  handleFiles,
  evictOneFinished,
  removeDoc,
  unloadDocBySrc,
} from "./library.js";
import { updateProgress } from "./player.js";
import { openModal, wireModal, closeModal, onModalClose, pushBackLayer } from "./modal.js";
import { confirmDialog } from "./ui.js";
import { shortName } from "./utils.js";
import {
  finishedSrcSet,
  isSrcFinished,
  isDocFinished,
  isDocReadish,
  isDocRecent,
  markDocFinished,
  unmarkDocFinished,
  markDocRecent,
  unmarkDocRecent,
  resetDocProgress,
  resetProgressByKey,
  setDocMode,
  dropProgress,
  isDropped,
  progressKeyForSrc,
  syncedProgressFor,
  getSyncedOpenBooks,
  openBookKeysMissingSrc,
  backfillSrcs,
} from "./progress.js";
import {
  idbPutFile,
  idbGetFile,
  idbFileKeys,
  idbDeleteFile,
  idbGetMeta,
  idbSetMeta,
  storeDoc,
} from "./db.js";
import { OFFLINE_BUFFER_SIZE } from "./config.js";
import { whenVoiceModelIdle } from "./piper.js";
import {
  normName,
  tokens,
  tokenSet,
  subsetMatch,
  seedAuthorDegree,
  buildSeedIndex,
  seedReactionFor,
  FAV_AUTHOR_NAMES,
} from "./reactions.js";
import {
  wishKey,
  buildWishIndex,
  sanitizeWishes,
  fulfilledKeys,
  pendingWishes,
  findInCatalog,
} from "./wishlist.js";
import { buildProfileText } from "./profile.js";
import { currentMode, normMode } from "./mode.js";
import {
  nextPaint,
  showBusyOverlay,
  sliceForEach,
  spinnerLine,
  withBusyOverlay,
} from "./busy.js";
import { apiFetch } from "./storage.js";

const ROOT = "/biblioteca/";
const CATALOG_URL = "/biblioteca-index/catalog.json";
// The last downloaded catalog, kept whole in the META_STORE as
// `{text, etag, lastModified, ts}`. See ensureCatalog for why it is stored here
// and not left to the HTTP cache.
const CATALOG_CACHE_KEY = "catalogCache";
// Ceiling on the FIRST catalog fetch, the one with no stored copy behind it. It
// IS a ~14 MB body on a slow phone radio, and losing this race means folder
// mode, so it is generous — but finite, so a half-up tunnel fails the load
// instead of hanging it forever. See ensureCatalog.
const CATALOG_COLD_TIMEOUT_MS = 60000;
// Ceiling on the background re-check, which is a 304 on a good day and has a
// perfectly good catalog already painted behind it. Short on purpose: nothing
// is waiting for it, and a request that hangs for a minute for no reader is
// just a radio left on.
const CATALOG_REVALIDATE_TIMEOUT_MS = 15000;
const READABLE = /\.(pdf|epub|txt|md|markdown|mdown|mkd|text)$/i;
// The flat catalog list can be huge (~88k). Render one page at a time (the
// filters are still the primary way to narrow it down); a pager below the list
// walks the full filtered set page by page, and the A–Z strip above it jumps
// straight to an author-initial (see letterStripFor).
const RENDER_CAP = 300;

/* ---- browse position: the modal is a SESSION, not a fresh start ----
 * Opening a book CLOSES the biblioteca (loadBookInner), and half the time the
 * book doesn't take. So the whole browse position survives that close and is
 * restored on the next 📚: which page you were on, where the list was scrolled,
 * whether the 🎛️ drawer was open, which book the 🎲 spotlighted. Only a change
 * to the filter SET rewinds it (rewindBrowse) — a close/reopen never does.
 * Session state, like the drawer: a page reload starts clean.
 */
let bibPage = 0; // current page into the filtered set (0-based)
let bibScroll = 0; // last known scrollTop of the modal body
let pickBook = null; // the 🎲 spotlighted book, so it can be repainted on reopen

// --- Favorites (LIVE, evolving data) -----------------------------------------
// Unlike the frozen catalog (primigenia 🏛️ is baked into each book's `v`
// field), favorites change as the user reads, so they must NOT go through the
// catalog rebuild. They live in json-store — one KV blob `{ "<path>": degree }`
// keyed by the book's stable catalog `p` (folder path). The app GETs it on
// modal open, merges onto the static catalog at runtime, and on each edit
// debounce-PATCHes ONLY the changed key(s) (json_store deep-merges the delta) →
// zero rebuild, instant. A per-key PATCH — never a whole-blob PUT — is what
// stops a data-loss wipe: if the GET silently failed (store down at open, a
// deploy 5xx → loadBlob yields {}), the old whole-blob PUT rewrote the server
// down to whatever the empty-ish in-memory map held, dropping every other
// favorite. Reached over HTTP through Caddy's `/api/` → json_store, like todoapp.
const API_BASE = "/api/";
const FAV_KEY = "audiobooks-favorites";
// 👍/👎 per-book reaction (path -> "like" | "dislike" | "none" tombstone) and
// author-level favorites (normalised author -> degree; 0 tombstones a seed).
// Separate blobs so each stays a tiny map and the legacy favorites key is
// untouched. Same live-wins-over-seed merge as the star (see js/reactions.js).
const REACT_KEY = "audiobooks-reactions";
const AUTHORS_KEY = "audiobooks-fav-authors";
// Play queue: an ordered list of catalog paths to read next. Stored server-side
// as a bare array of `{ id: "<path>" }` records so mutations use json-store's
// ATOMIC list ops — PATCH-append to add, PATCH `_op:remove_by_id` to drop — and
// two devices editing the queue can no longer clobber each other. (The old
// design PUT the whole `{ list: [...] }` blob: a stale second device wiped the
// first device's adds, last-writer-wins. reader still tolerates that legacy
// shape so an in-flight queue survives the format switch.) The 📖 "en curso"
// modal shows/manages it; on a book's natural end the head plays next (else a
// filtered 🎲 random) — see advanceAfterFinish.
const QUEUE_KEY = "audiobooks-queue";
// 🌠 Wishlist: books the library does NOT have, `{ "<normAuthor|normTitle>":
// {t, a} }`. Unlike every other blob here it is keyed on the book's NAME, not a
// catalog path — a wished book has no path yet. An entry is deleted (PATCHed to
// null) the instant the catalog answers for it, so "in the library" and "on the
// wishlist" can never both be true. See js/wishlist.js.
const WISH_KEY = "audiobooks-wishlist";
// ⭐ favorite is a plain on/off flag stored as a degree int: 0 = not a favorite,
// 1 = favorite. (Legacy blobs may hold 2/3 from the old "raise the star" feature;
// any value > 0 reads as favorite and a tap clears it — the degree is inert now.)
const SAVE_DEBOUNCE_MS = 600;

// path -> degree. Loaded once per session; edited optimistically, then flushed.
let favorites = {};
let saveTimer = null;

// path -> "like" | "dislike" | "none"; normAuthor -> degree. Loaded with the
// favorites; each flushed by its own debounced per-key PATCH.
let reactions = {};
let favAuthors = {};
let reactionsLoaded = false;
// `reactionsLoaded` latches at the START of ensureFavorites (it is the
// once-only guard), so it says "someone asked", not "the blobs are here". The
// card stamper needs the second question — it must not persist "this book has
// no rating" from an empty map that simply hasn't been filled yet.
let reactionsReady = false;
let saveReactTimer = null;
let saveAuthTimer = null;

// wishKey -> {t, a}, and the author-token index of the catalog they are matched
// against (rebuilt whenever the catalog loads). Both empty until ensureFavorites.
let wishes = {};
let wishIndex = null;

// Per-blob "changed keys since the last flush" deltas. Only these keys' latest
// values are PATCHed (a `null` DELETEs the key server-side); everything else in
// the blob is left untouched, so a flush can never overwrite the whole blob.
let favPending = {};
let reactPending = {};
let authPending = {};

// Ordered play queue as `{ id: "<catalog path>", mode: "day"|"night" }` records.
// `mode` is the en-curso shelf the book was queued onto (day/night have separate
// queues); getQueueBooks filters to the current shelf. Seeded from the server on
// the first biblioteca open and re-synced whenever the en-curso modal opens.
let queue = [];

/* ===================== offline book buffer =====================
 * Opening a book means a folder-list + a file download — a visible stall, and
 * impossible once offline (airplane mode at bedtime). So we keep book FILES
 * downloaded ahead of time in IndexedDB (FILE_STORE, keyed by catalog path),
 * ready to feed straight into the reader — parsing is in-shell, so a buffered
 * book opens with no network at all. Two kinds of entry, both maintained by
 * syncOfflineBuffer():
 *
 *  - PINNED: every book in the 🔜 queue (either shelf) plus every cross-device
 *    "en curso" book this device hasn't opened locally. These are the books the
 *    app is going to need next, so they are downloaded regardless of filters and
 *    kept until they leave the queue / shelf. A book already OPEN on this device
 *    needs no file: `docs` holds its extracted text (see js/db.js storeDoc).
 *  - SPARES: when the queue is short, random picks from the current filters,
 *    topping the buffer up to OFFLINE_BUFFER_SIZE, so an end-of-book
 *    auto-advance with an empty queue still finds a book to play offline.
 *
 * Anything cached that is neither pinned nor a current spare is deleted — leave
 * the queue, get dropped. The store survives reloads AND deploys (unlike the SW
 * Cache Storage, which is purged on every CACHE_NAME bump).
 */
let cachedPaths = new Set(); // catalog paths whose file is in FILE_STORE
let cacheIndexed = false; // has cachedPaths been hydrated from IndexedDB yet?
let syncing = false; // a syncOfflineBuffer() pass is in flight
// Books whose file loadBook is reading RIGHT NOW. Both flows that open a queued
// book (the en-curso ✓ and the end-of-book auto-advance) unqueue it first, and
// that fires a sync — which, without this, would delete the very file the open
// is about to read. Treated as pinned; loadBook drops the file itself when done.
const opening = new Set();

// author-token -> seed hints, built once the catalog is present (see below).
let seedIndex = null;

// Path segments below ROOT (decoded names); [] means we are at the root.
let stack = [];

// Catalog mode: loaded once, then filtered in-memory. null until first probed.
let catalog = null; // { books, buckets, counts } | null
// The single in-flight (then settled) load promise. Memoised so concurrent
// callers on boot — initBiblioteca() and the active-book card's await — share
// one fetch instead of the card racing ahead of a still-null catalog.
let catalogPromise = null;

// Filter state, persisted to localStorage so the emoji toggles + category
// survive a reload (the operator keeps the same narrow view between sessions).
const LS_FILTERS = "audiobooks_bib_filters";
// Stamped into the persisted blob. Bump when a DEFAULT changes in a way an
// already-stored blob must not keep carrying (see mergeStoredFilters).
// v2: `male` used to default TRUE. The chip was never touched on most installs,
//     so the catalog silently read "52280 libros" out of ~88k, and the only cue
//     was a badge saying "1" — a number that never said WHICH filter.
const FILTERS_V = 2;

// favBook = own ⭐ star, favAuth = 👤 favorite author, like = 👍, dislike = 👎 —
// four independent axes, each with its own chip in the 🎛️ drawer. like/dislike
// read the same per-book reaction, so turning both on yields the empty set (a
// book can't be both) — harmless, and honest about the contradiction.
// `finished` keeps only completed books (✔); `q` is a 🔍 free-text filter over
// title + author (accent-folded via normName), combined with the emoji/category
// chips like any other axis. `male`/`female` are driven by ONE 3-state chip:
// both-true or both-false has always meant "no gender constraint" (see
// genderOf), so the pair only ever encoded ♂ / ♀ / ⚥ — and the default is ⚥: a
// library that browses half its books until you find the chip is a lie.
// `sort` orders the (filtered) list — see SORT_MODES.
export function defaultFilters() {
  return { favBook: false, favAuth: false, like: false, dislike: false, prim: false, finished: false, male: false, female: false, cat: "", q: "", sort: "alpha" };
}

// Never reassigned: every read site in this module closes over this object.
const filters = defaultFilters();

/**
 * The 🔤 chip cycles these in order. `alpha` is the default and the only one
 * that needs no catalog dates; the other three read the optional `y` (year
 * written) and `d` (day added to the library) fields export_catalog.py emits.
 * A book missing the field sinks to the bottom of that sort.
 *
 * `needs` is the catalog field a mode can't work without. A catalog built from a
 * books.db without the pubdate/added columns carries NEITHER field, and every
 * date mode then degenerates to alphabetical — the chip cycles, the list never
 * moves. So the date modes are cycled ONLY when the loaded catalog actually
 * carries their field (see availableSortModes); otherwise 🔤 is the whole cycle
 * and says why. Re-run build_index.py + export_catalog.py on the pi to enable them.
 */
const SORT_MODES = [
  { id: "alpha", icon: "🔤", label: "alfabético (autor, título)", short: "A–Z" },
  { id: "newest", icon: "🆕", label: "año de escritura, descendente (más nuevo primero)", short: "año ↓", needs: "y" },
  { id: "oldest", icon: "🏺", label: "año de escritura, ascendente (más antiguo primero)", short: "año ↑", needs: "y" },
  { id: "added", icon: "📥", label: "añadido a la biblioteca: más reciente primero", short: "añadido ↓", needs: "d" },
];

// Is the 🎛️ drawer open? Session state, and it SURVIVES a close/reopen of the
// modal (it is part of the browse position); the filters it HOLDS are what
// persist to localStorage.
let drawerOpen = false;

/** The boolean axes, in drawer order — also the order the badge lists them. */
const BOOL_KEYS = ["favBook", "favAuth", "like", "dislike", "prim", "finished", "male", "female"];

/**
 * A persisted blob reconciled onto today's defaults. Pure — loadFilters owns the
 * storage. An unknown/absent sort id (older blob, renamed mode) falls back to
 * the default rather than ordering by a mode booksInOrder can't build.
 */
export function mergeStoredFilters(stored) {
  const f = defaultFilters();
  if (!stored || typeof stored !== "object") return f;
  for (const k of BOOL_KEYS) {
    if (typeof stored[k] === "boolean") f[k] = stored[k];
  }
  if (typeof stored.cat === "string") f.cat = stored.cat;
  if (typeof stored.q === "string") f.q = stored.q;
  if (SORT_MODES.some((m) => m.id === stored.sort)) f.sort = stored.sort;
  // A blob written before the version stamp that carries exactly the OLD default
  // (♂, never ♀) never recorded a choice — it recorded the bug. Drop it to ⚥. A
  // deliberate ♀, an already-⚥ pair, and a ♂ picked AFTER the stamp are untouched.
  if (stored.v !== FILTERS_V && f.male && !f.female) f.male = false;
  return f;
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(LS_FILTERS);
    if (!raw) return;
    const stored = JSON.parse(raw);
    Object.assign(filters, mergeStoredFilters(stored));
    // Stamp the version so the one-shot ♂→⚥ reset never runs twice — a ♂ chosen
    // on purpose from here on must stick.
    if (!stored || stored.v !== FILTERS_V) saveFilters();
  } catch (_) {}
}

function saveFilters() {
  try {
    localStorage.setItem(LS_FILTERS, JSON.stringify({ ...filters, v: FILTERS_V }));
  } catch (_) {}
}

function currentUrl() {
  return ROOT + stack.map((s) => encodeURIComponent(s) + "/").join("");
}

/** Build a /biblioteca/ URL from a catalog path (folder relative to root). */
function catalogFolderUrl(pathRel) {
  return (
    ROOT +
    pathRel
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/") +
    "/"
  );
}

async function listDir(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

/**
 * Has the Pi's library endpoint answered this session? null while the probe is
 * still out — which is the state 📚 can be pressed in, so the modal has three
 * cases to paint, not two (loading / up / not served from the Pi).
 */
let libraryUp = null;

/** Warm the library up in the background. The 📚 button never waits for it. */
export async function initBiblioteca() {
  // Silent, by design. This warm-up is BACKGROUND work — the reader can play,
  // seek and open ⚙️ throughout it, and never asked for it — so it earns no
  // feedback of its own. A ring on 📚 here was the "minispinner I didn't plan":
  // a spinner that appears unprompted on every boot for work nobody is waiting
  // on. Feedback now belongs only to the PRESS: if the reader opens 📚 before
  // this finishes, the open shows the centered overlay for exactly as long as it
  // is genuinely slow (see bindBiblioteca's click handler).
  await warmLibrary();
}

async function warmLibrary() {
  // BEFORE the probe: an offline boot throws below, and the buffer is precisely
  // what has to work then — the auto-advance reads this index to find the next
  // book without a network. (Hydrating it is a local IndexedDB read.)
  await ensureCacheIndex();
  try {
    await listDir(ROOT);
    libraryUp = true;
    // Preload what 📚 needs so the first press is instant instead of paying the
    // catalog + favorites round-trip on tap. The queue is pulled at boot too (not
    // just on the first 📚 / 📖 open) because the offline buffer is built around
    // it — a device that never opened a modal still downloads its queued books.
    await Promise.all([ensureCatalog(), ensureFavorites(), refreshQueue()]);
    // The active-book card was painted from the doc's own stamp before any of
    // this was on the wire (see renderActiveBookCard). Now that the real entry is
    // here, upgrade it — rating cue, saga line, 📚 author count.
    refreshActiveBookCard();
    if (catalog) syncOfflineBuffer();
    // Data came back (tunnel up, plane landed): download whatever the buffer is
    // missing now, instead of waiting for the next modal close.
    window.addEventListener("online", () => syncOfflineBuffer());
  } catch (_) {
    // Not served from the Pi (a copy opened from disk, the endpoint down). The
    // button stays on the bar and says so when pressed — a control that silently
    // disappears leaves the reader wondering what they did to lose it.
    libraryUp = false;
  }
}

/* ===================== offline book buffer (impl) ===================== */

/** Hydrate `cachedPaths` from IndexedDB once per session. */
async function ensureCacheIndex() {
  if (cacheIndexed) return;
  try {
    cachedPaths = new Set(await idbFileKeys());
  } catch (_) {
    /* no IndexedDB → the buffer is simply always empty */
  }
  cacheIndexed = true;
}

/**
 * The books whose file must be held no matter what the filters say: everything
 * in the 🔜 queue (BOTH shelves — you may toggle day/night offline) and every
 * cross-device "en curso" book. A book already open on this device is excluded:
 * `docs` holds its extracted text, so a second copy of the raw file is dead weight.
 */
export function pinnedFrom({ queuePaths, remoteSrcs, localSrcs, openingPaths }) {
  const pins = new Set(queuePaths);
  for (const src of remoteSrcs) pins.add(src);
  for (const src of localSrcs) pins.delete(src);
  for (const p of openingPaths) pins.add(p); // never GC a file mid-open
  return pins;
}

function pinnedPaths() {
  const localKeys = new Set(state.docs.map((d) => d.docKey));
  return pinnedFrom({
    queuePaths: queue.map((e) => e.id),
    // Finished ☁ books stay ON the shelf (greyed) but there is nothing left to
    // read in them — don't spend buffer slots downloading a book you're done with.
    remoteSrcs: getSyncedOpenBooks(localKeys)
      .filter((e) => !e.done)
      .map((e) => e.src),
    localSrcs: state.docs.map((d) => d.src).filter(Boolean),
    openingPaths: opening,
  });
}

/**
 * The exact set of files the buffer should hold: every pinned book (queue + open
 * shelf — ALWAYS held, even past `size`), plus as many ALREADY-CACHED in-filter
 * random spares as the QUEUE leaves room for. Everything else cached is garbage.
 *
 * The spare budget is `size − queueCount`, NOT `size − pins.size`: the open-book
 * shelf is covered unconditionally and must not eat into the random top-up. So a
 * short queue always tops the buffer up to `size` random picks regardless of how
 * many books you have open; a queue of `size` or longer leaves no random room.
 *
 * Pure, so the "leave the queue → lose the download" rule is testable without
 * IndexedDB. `pool` is the filtered random pool, in order.
 */
export function bufferKeepSet({ pins, cached, pool, size, queueCount }) {
  const spareTarget = Math.max(0, size - queueCount);
  const spares = pool
    .filter((bk) => cached.has(bk.p) && !pins.has(bk.p))
    .slice(0, spareTarget)
    .map((bk) => bk.p);
  return { keep: new Set([...pins, ...spares]), spareTarget };
}

/** Buffered books that still match the current filters and aren't pinned. */
function bufferedPicks(pins) {
  return randomPool().filter((bk) => cachedPaths.has(bk.p) && !pins.has(bk.p));
}

/** Download + store a catalog book's file. True if it landed. */
async function cacheBook(bk) {
  const file = await fetchBookFile(bk);
  if (!file) return false;
  try {
    await idbPutFile({ path: bk.p, name: file.name, blob: file, ts: Date.now() });
  } catch (_) {
    return false; // quota exceeded: keep what we have, stop growing
  }
  cachedPaths.add(bk.p);
  return true;
}

/** Forget a buffered file (opened, unqueued, or filtered out). */
async function dropCached(path) {
  try {
    await idbDeleteFile(path);
  } catch (_) {}
  cachedPaths.delete(path);
}

/** The buffered file for a catalog path, as a File the reader can parse. Null if absent. */
async function cachedFile(path) {
  if (!cachedPaths.has(path)) return null;
  let rec;
  try {
    rec = await idbGetFile(path);
  } catch (_) {
    return null;
  }
  if (!rec || !rec.blob) {
    cachedPaths.delete(path); // index drifted from the store — self-heal
    return null;
  }
  return rec.blob instanceof File
    ? rec.blob
    : new File([rec.blob], rec.name || "libro.epub", { type: rec.blob.type });
}

/**
 * Bring the buffer in line with what the app will need next: GC what no longer
 * belongs, download the pinned books that are missing, then top the rest up with
 * random picks from the current filters. Offline it still GCs (free bytes) but
 * downloads nothing. Idempotent and re-entrant-safe; call it after ANY change to
 * the queue, the open books, or the filters.
 */
export async function syncOfflineBuffer() {
  if (syncing || !catalog) return;
  syncing = true;
  try {
    await ensureCacheIndex();
    const pins = pinnedPaths();
    // The QUEUE alone claims the random budget; whatever it leaves over is filled
    // with random picks (an empty queue ⇒ OFFLINE_BUFFER_SIZE of them, the "5-10
    // books that would go next" backstop). Open books are pinned unconditionally
    // and do NOT shrink the random top-up — the buffer holds every open book plus
    // (size − queue) random picks.
    // ONE filtered pass over the catalog for the whole sync. `randomPool` runs
    // `filteredBooks` over all ~88 000 entries, and the top-up loop below used
    // to call it TWICE per book it downloaded (once in the `while` condition,
    // once to pick from) — so a pass cost 2 × OFFLINE_BUFFER_SIZE full catalog
    // filters, and a pass runs at boot, on every modal close and on every queue
    // change. Nothing the loop does can change the pool: the filters can't move
    // while a sync is in flight, and the only thing that DOES change (which
    // paths are cached) is tracked incrementally below.
    const pool = randomPool();
    const { keep, spareTarget } = bufferKeepSet({
      pins,
      cached: cachedPaths,
      pool,
      size: OFFLINE_BUFFER_SIZE,
      queueCount: queue.length,
    });
    for (const p of [...cachedPaths]) {
      if (!keep.has(p)) await dropCached(p);
    }
    if (!navigator.onLine) return; // offline: keep what we have, fetch no more

    // The GC above is local and free; everything below is bytes off the same
    // link the voice model is coming down. A model is tens of megabytes and it
    // downloads at exactly the moment this pass first runs — boot, where
    // prewarmResumePoint fires as soon as a book is restored. Splitting the
    // phone's bandwidth between them makes the reader wait twice as long for
    // the one thing they asked for. The buffer is speculative; it yields.
    await whenVoiceModelIdle();

    for (const p of pins) {
      if (!navigator.onLine) return;
      if (cachedPaths.has(p)) continue;
      const bk = bookByPath(p); // an orphaned path can't be downloaded — skip it
      if (bk) await cacheBook(bk);
      // Re-checked per book, not just once: a voice switch mid-pass starts a new
      // model download, and the rest of the buffer can wait for that one too.
      await whenVoiceModelIdle();
    }

    // How many spares we already hold, and which books could become one. Both
    // derived from `pool` once; the loop then only ever adds to the count and
    // removes from the candidates, so a top-up costs one catalog pass, not one
    // per book. Splicing a candidate out is also what retires a 404 — it can't
    // be drawn again this pass, which is what the old `failed` set was for.
    let spares = pool.filter(
      (bk) => cachedPaths.has(bk.p) && !pins.has(bk.p),
    ).length;
    const candidates = pool.filter(
      (bk) => !cachedPaths.has(bk.p) && !pins.has(bk.p),
    );
    while (spares < spareTarget && candidates.length) {
      if (!navigator.onLine) return;
      await whenVoiceModelIdle();
      const [bk] = candidates.splice(
        Math.floor(Math.random() * candidates.length),
        1,
      );
      if (await cacheBook(bk)) spares++;
    }
  } finally {
    syncing = false;
  }
}

/** Download a catalog book's readable file (no parsing). File, or null. */
async function fetchBookFile(bk) {
  const folderUrl = catalogFolderUrl(bk.p);
  let entries;
  try {
    entries = await listDir(folderUrl);
  } catch (_) {
    return null;
  }
  const readables = entries
    .filter((e) => e.type !== "directory" && READABLE.test(e.name))
    .sort((a, b) => rank(a.name) - rank(b.name));
  if (!readables.length) return null;
  const name = readables[0].name;
  try {
    const r = await fetch(folderUrl + encodeURIComponent(name));
    if (!r.ok) return null;
    const blob = await r.blob();
    return new File([blob], name, { type: blob.type });
  } catch (_) {
    return null;
  }
}

/**
 * Read the stored catalog, or undefined when there isn't one (or it is junk).
 *
 * A record that won't parse is DELETED rather than tolerated: it can only come
 * from a half-written write, and keeping it would fail every open forever while
 * looking like "the Pi is down".
 */
async function readCatalogCache() {
  try {
    const rec = await idbGetMeta(CATALOG_CACHE_KEY);
    if (!rec || typeof rec.text !== "string") return undefined;
    const data = JSON.parse(rec.text);
    if (!data || !Array.isArray(data.books)) throw new Error("bad catalog");
    return { ...rec, data };
  } catch (_) {
    try {
      await idbSetMeta(CATALOG_CACHE_KEY, undefined);
    } catch (_) {}
    return undefined;
  }
}

/**
 * Fetch the catalog, conditionally when we already hold a copy.
 *
 * Returns `{ status: 304 }` when the stored copy is still current — the whole
 * point of storing the validators — or `{ status: 200, text, data, etag,
 * lastModified }` for a body worth keeping. Anything else throws.
 *
 * TIMED. A tunnel that has associated but isn't routing yet accepts the request
 * and never answers — an await that never settles. Every caller that gates a
 * PAINT on this (renderEnCurso did) then leaves its lists as the empty markup
 * index.html ships: no rows, no empty-state text, no error.
 */
async function downloadCatalog(validators, timeoutMs) {
  const headers = { Accept: "application/json" };
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  else if (validators?.lastModified)
    headers["If-Modified-Since"] = validators.lastModified;
  const r = await fetch(CATALOG_URL, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 304) return { status: 304 };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  // `.text()` and not `.json()`: the string IS what we store, and `.json()`
  // would parse a copy we'd then have to re-serialise to keep.
  const text = await r.text();
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.books)) throw new Error("bad catalog");
  return {
    status: 200,
    text,
    data,
    etag: r.headers.get("ETag") || "",
    lastModified: r.headers.get("Last-Modified") || "",
  };
}

/**
 * Re-check the stored catalog against the Pi, in the background, once per load.
 *
 * A fresh body is written to the store and NOT swapped into the running
 * session: `catalog` and its indexes are what the open lists were painted from,
 * and replacing them under a rendered author page is how a list ends up
 * pointing at rows that no longer exist. The new copy is what the NEXT open
 * reads — which, for a catalog re-exported when a book is ingested, is soon
 * enough, and never at the cost of the paint on screen.
 *
 * Failure is silence by design: we already have a catalog: the app is not
 * degraded by not knowing whether it is the newest one.
 */
async function revalidateCatalog(validators) {
  if (!validators?.etag && !validators?.lastModified) return; // nothing to ask with
  try {
    const got = await downloadCatalog(validators, CATALOG_REVALIDATE_TIMEOUT_MS);
    if (got.status === 304) return;
    await writeCatalogCache(got);
  } catch (_) {}
}

/** Persist a downloaded catalog with the validators that identify it. */
async function writeCatalogCache(got) {
  try {
    await idbSetMeta(CATALOG_CACHE_KEY, {
      text: got.text,
      etag: got.etag,
      lastModified: got.lastModified,
      ts: Date.now(),
    });
  } catch (_) {} // a full quota costs us the fast path, not the app
}

/**
 * Load the flattened catalog once (cached after the first SUCCESS). A FAILED
 * attempt (offline at boot, a deploy 5xx) clears the cached promise so the next
 * caller retries instead of the whole session degrading to folder-fallback — the
 * bug behind "tapping the book card opened the author page only once, randomly":
 * a card first painted while the catalog was unreachable resolved to a local
 * book with no author, and nothing re-tried later. Returns true if catalog mode
 * is available.
 *
 * THE 14 MB IS DOWNLOADED ONCE, not once per open. It used to be once per open
 * everywhere: Caddy stamps `Cache-Control: no-store` on the whole route table,
 * so no browser ever kept it either, and inside pi-shell there is no HTTP cache
 * and no service worker to keep it in — `piapp://localhost` is a custom
 * protocol the shell answers itself. Measured over the tailnet: 25 s for the
 * body, against a 30 s ceiling. On a phone radio it lost that race, ensureCatalog
 * returned false, and 📚 opened the raw folder browser while «Book and author»
 * came up empty — the "it shows folders now" regression. So the body is kept in
 * the META_STORE and re-checked with `If-None-Match`, which is a 304 and ~70 ms.
 */
export function ensureCatalog() {
  if (catalog) return Promise.resolve(true);
  if (!catalogPromise) {
    catalogPromise = (async () => {
      try {
        const cached = await readCatalogCache();
        if (cached) {
          // Everything below this line used to run as ONE synchronous block,
          // and it is the app's longest freeze by a distance: two full
          // normalising passes over ~88 000 entries after a 14 MB parse. The
          // page accepted taps throughout and answered none of them. See
          // buildIndexes.
          await buildIndexes(cached.data);
          void revalidateCatalog(cached); // background: never gates this paint
          return true;
        }
        // No stored copy: this download is the only thing standing between the
        // user and folder mode, so it gets the long ceiling. Nothing is waiting
        // on a faster answer that doesn't exist.
        const got = await downloadCatalog(null, CATALOG_COLD_TIMEOUT_MS);
        await buildIndexes(got.data);
        void writeCatalogCache(got);
        return true;
      } catch (_) {
        catalog = null;
        catalogPromise = null; // allow a later demand to retry the fetch
        return false;
      }
    })();
  }
  return catalogPromise;
}

/**
 * Derive every catalog index, in slices, and publish the catalog once they are
 * all in hand.
 *
 * TWO things here are load-bearing:
 *
 * 1. **The passes yield.** `buildAuthorIndex` normalises ~88 000 author strings
 *    and `buildWishIndex` tokenises the same 88 000 again; back to back, after a
 *    14 MB `JSON.parse`, that is the multi-second window where the app looked
 *    dead — taps landed, modals even opened (the compositor can do that alone),
 *    and nothing answered until the last pass finished. Sliced, the same total
 *    work happens with the queue drained between slices, so a press taken during
 *    the load is handled during the load.
 *
 * 2. **`catalog` is assigned LAST.** It is the flag half this module reads to
 *    decide whether catalog mode is available (`if (catalog) …`), and now that
 *    the indexes are built across several tasks, setting it first would publish
 *    a catalog whose author/saga lookups are still half-empty — an author page
 *    listing 1 book instead of 12, a saga line that isn't there. Nothing may observe
 *    that intermediate state, so the assignment is the commit.
 *
 * `buildWishIndex` is NOT built here at all: it only answers "is this wish in
 * the library yet?", so a reader with no pending wishes — the common case — was
 * paying a full 88k tokenising pass at every boot for a question nobody asked.
 * It is built on first demand instead (see ensureWishIndex).
 */
async function buildIndexes(j) {
  orderCache = {}; // orderings belong to the rows we are replacing
  sortModesCache = null; // …and so does "which date sorts are possible"
  const saga = await buildSagaIndex(j.books);
  const authors = await buildAuthorIndex(j.books);
  const seeds = buildSeedIndex(); // over the SEED lists, not the catalog — cheap
  sagaIndex = saga;
  authorIndex = authors;
  seedIndex = seeds;
  wishIndex = null; // belongs to the rows we just replaced; rebuilt on demand
  nameIndex = null; // …same: the filename lookup is keyed on the OLD books
  qHayCache = new Map(); // …and so do the folded 🔍 haystacks
  catalog = j; // …the commit: everything the flag promises is now true
  populateCategories();
  pruneFulfilledWishes();
  healOpenBookSrcs(); // recover catalog paths on src-less in-progress books
}

/**
 * The wish → catalog lookup, built on first use and kept until the catalog is
 * replaced. Null when there is no catalog to index.
 */
function ensureWishIndex() {
  if (!wishIndex && catalog) wishIndex = buildWishIndex(catalog.books);
  return wishIndex;
}

/**
 * Load the live favorites blob from json-store once. Best-effort: any failure
 * (store unreachable, absent key) leaves `favorites` empty so the rest of the
 * biblioteca still works — favorites simply degrade to "none yet".
 */
export async function ensureFavorites() {
  if (reactionsLoaded) return;
  reactionsLoaded = true;
  const [favBlob, reactBlob, authBlob, wishBlob] = await Promise.all([
    loadBlob(FAV_KEY),
    loadBlob(REACT_KEY),
    loadBlob(AUTHORS_KEY),
    loadBlob(WISH_KEY),
    refreshQueue(),
  ]);
  // Favorites: keep only int-ish degree values.
  for (const [p, deg] of Object.entries(favBlob)) {
    const d = Number(deg);
    if (Number.isFinite(d)) favorites[p] = d;
  }
  // Reactions: only the three known string states.
  for (const [p, v] of Object.entries(reactBlob)) {
    if (v === "like" || v === "dislike" || v === "none") reactions[p] = v;
  }
  // Author favorites: int-ish degree by normalised author.
  for (const [a, deg] of Object.entries(authBlob)) {
    const d = Number(deg);
    if (Number.isFinite(d)) favAuthors[a] = d;
  }
  wishes = sanitizeWishes(wishBlob);
  // The catalog may already have loaded (both fetches run in parallel), in which
  // case this is the pass that prunes; otherwise ensureCatalog's call does it.
  pruneFulfilledWishes();
  reactionsReady = true;
}

/* ===================== wishlist ===================== */

/**
 * Drop every wish the library now answers for — the ONE way an entry leaves the
 * list (there is no "un-wish" button; owning the book IS the removal). Runs
 * whenever the catalog and the wishes are both in hand: at boot, and again on a
 * catalog reload after a Telegram ingest added books. Server-side the bot prunes
 * too, so this is a convergent second pass, not the only one.
 */
function pruneFulfilledWishes() {
  // The emptiness check comes FIRST: no wishes means no question to answer, and
  // ensureWishIndex would otherwise tokenise the whole 88k catalog to answer it.
  if (!Object.keys(wishes).length) return;
  const idx = ensureWishIndex();
  if (!idx) return;
  const done = fulfilledKeys(wishes, idx);
  if (!done.length) return;
  const delta = {};
  for (const k of done) {
    delete wishes[k];
    delta[k] = null; // json_store deletes a key PATCHed to null
  }
  patchBlob(WISH_KEY, delta);
}

/** The wishes the library still doesn't hold, sorted for display. */
function openWishes() {
  return pendingWishes(wishes, ensureWishIndex());
}

/** The catalog book this title/author already names, or null. */
function bookInLibrary(title, author) {
  const idx = ensureWishIndex();
  return idx ? findInCatalog(idx, { t: title, a: author }) : null;
}

/**
 * Add a wished book. `"blank"` / `"in-library"` on refusal (a book you own is
 * never a wish), else `"ok"`.
 */
function addWish(title, author) {
  const t = String(title || "").trim();
  const a = String(author || "").trim();
  if (!t || !a) return "blank";
  if (bookInLibrary(t, a)) return "in-library";
  const k = wishKey(a, t);
  wishes[k] = { t, a };
  patchBlob(WISH_KEY, { [k]: { t, a } });
  return "ok";
}

/** Is this exact wish already on the list? (Identity, not the fuzzy catalog match.) */
function hasWish(key) {
  return Object.prototype.hasOwnProperty.call(wishes, key);
}

/** Forget a wish outright (the operator changed their mind — not a fulfilment). */
function removeWish(key) {
  delete wishes[key];
  patchBlob(WISH_KEY, { [key]: null });
}

/** GET a json-store blob; {} on any failure or non-object body. */
async function loadBlob(key) {
  try {
    const r = await apiFetch(API_BASE + key, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j && typeof j === "object" && !Array.isArray(j)) return j;
  } catch (_) {
    /* store unreachable / absent key */
  }
  return {};
}

/**
 * ATOMIC per-key PATCH of a partial blob (optimistic UI already updated). Sends
 * ONLY `delta` — json_store deep-merges it into the stored blob, so the other
 * keys (this device's older marks, and any a CONCURRENT device wrote) survive.
 * A `null` value DELETEs that key. This is the whole point: unlike the old
 * whole-blob PUT, a flush built from a never-loaded (empty) in-memory map can
 * only touch the keys the user just changed — it cannot wipe the blob.
 */
function patchBlob(key, delta) {
  if (!delta || !Object.keys(delta).length) return;
  apiFetch(API_BASE + key, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    keepalive: document.visibilityState === "hidden",
    body: JSON.stringify(delta),
  }).catch((e) => console.error(`patch ${key} failed:`, e));
}

/** Record one changed key's latest value (null when the key was deleted) so the
 *  next flush PATCHes it. */
function queueDelta(pending, map, key) {
  pending[key] = key in map ? map[key] : null;
}

function saveFavorites(path) {
  queueDelta(favPending, favorites, path);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const delta = favPending;
    favPending = {};
    patchBlob(FAV_KEY, delta);
  }, SAVE_DEBOUNCE_MS);
}

function saveReactions(path) {
  queueDelta(reactPending, reactions, path);
  if (saveReactTimer) clearTimeout(saveReactTimer);
  saveReactTimer = setTimeout(() => {
    saveReactTimer = null;
    const delta = reactPending;
    reactPending = {};
    patchBlob(REACT_KEY, delta);
  }, SAVE_DEBOUNCE_MS);
}

function saveFavAuthors(key) {
  queueDelta(authPending, favAuthors, key);
  if (saveAuthTimer) clearTimeout(saveAuthTimer);
  saveAuthTimer = setTimeout(() => {
    saveAuthTimer = null;
    const delta = authPending;
    authPending = {};
    patchBlob(AUTHORS_KEY, delta);
  }, SAVE_DEBOUNCE_MS);
}

/* ===================== play queue ===================== */

/** Map a server queue body to de-duplicated `{ id, mode }` records. Accepts the
 *  current `[{id,mode?}]` shape and the legacy `[str]` / `{list:[str]}` shapes;
 *  a record with no `mode` (legacy, or queued before this feature) reads as the
 *  default NIGHT shelf, so nothing silently vanishes from the queue. */
function queueEntries(body) {
  const arr = Array.isArray(body)
    ? body
    : Array.isArray(body?.list)
      ? body.list
      : [];
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const id =
      typeof it === "string"
        ? it
        : it && typeof it.id === "string"
          ? it.id
          : null;
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, mode: normMode(it && it.mode) });
    }
  }
  return out;
}

/**
 * Re-sync the in-memory queue from the server (source of truth across devices).
 * Returns the fresh `{id,mode}` records, or null if the store was unreachable
 * (queue kept).
 */
/**
 * Write the whole queue as the canonical `[{id,mode}]` array. Callers MUST build
 * `entries` from a FRESH server read (via refreshQueue) and apply only their own
 * delta to it — so a stale/partial in-memory list is never the thing that lands.
 * THAT is what stops a whole-list write from dropping a book (the "a refresh
 * wiped my queue" data-loss bug). Three uses: (a) REORDER (moveQueueSelection,
 * after a refresh); (b) migrate a legacy `{list:[...]}` (or any non-array) key to
 * the array the atomic PATCH ops require; (c) the fallback when an atomic
 * append/remove is REJECTED (each first rebuilds its list from a fresh read).
 * Last-writer-wins — fine for a single operator.
 *
 * Returns whether the write LANDED. A queue write that fails used to be silent
 * (a console line nobody is looking at on a phone), which is exactly how a
 * reorder tapped over a dead tunnel read as "the app ignored me": the list was
 * repainted from the server's unchanged copy and nothing said why. Callers that
 * have somewhere to report it — the cola's movers — need the answer, so it is
 * returned rather than swallowed here.
 */
async function putQueueList(entries) {
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: document.visibilityState === "hidden",
      body: JSON.stringify(entries.map((e) => ({ id: e.id, mode: e.mode }))),
    });
    if (r.ok) {
      queue = queueEntries(await r.json());
      return true;
    }
    console.error("queue PUT rejected:", r.status);
    return false;
  } catch (e) {
    console.error("queue PUT failed:", e);
    return false;
  }
}

export async function refreshQueue() {
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    queue = queueEntries(body);
    // Self-heal a legacy `{list:[...]}` (or any non-array) key into the `[{id}]`
    // array the atomic PATCH append/remove ops need. Without this, every add
    // PATCHes a list onto a dict → json_store 400s → r.ok is false → the add is
    // dropped and vanishes on reload (the "queued book is gone after refresh"
    // bug). An absent/empty key answers `{}` 200 with nothing to migrate — skip.
    //
    // Also self-heal DUPLICATE ids: two devices can each pass their own
    // `isQueued` guard (neither saw the other's add) and the atomic list-append
    // writes both, so the stored array grows a repeat. queueEntries collapses it
    // on read, so the cola renders clean — but the blob keeps the dupe, and a
    // `remove_by_id` then has to clear more than one. When the deduped list is
    // SHORTER than the raw array we just read, write the clean list back so the
    // stored blob converges too. Guard on `queue.length` so a transient all-junk
    // parse (deduped to empty) can never PUT an empty list over a real queue.
    if (body && !Array.isArray(body) && queue.length) {
      await putQueueList(queue);
    } else if (Array.isArray(body) && queue.length && body.length > queue.length) {
      await putQueueList(queue);
    }
    return queue;
  } catch (_) {
    return null;
  }
}

/** True if a catalog path is already queued (on any shelf). */
export function isQueued(path) {
  return queue.some((e) => e.id === path);
}

/** Which día/noche cola a queued path sits in (night when it isn't queued —
 *  the mode.js "missing ⇒ night" contract; callers gate on isQueued first). */
export function queueModeOf(path) {
  const e = queue.find((x) => x.id === path);
  return normMode(e && e.mode);
}

/**
 * A book entering the 🔜 queue is PARKED, not restarted: this device's loaded
 * copy is unloaded so it leaves "libros abiertos" (the en-curso shelf also hides
 * every queued path — see paintOpenBooks — so a copy loaded on another device
 * doesn't keep it listed either), and that is all. Its reading position, its ✅
 * terminado mark and its hours-played tally are left ALONE: queueing a book you
 * are halfway through means "finish it later", not "start it over", and the
 * position now survives the unload because `loadSavedPos` falls back to the
 * synced entry when the local offset is gone.
 *
 * Best-effort: a failure here must never abort the queue write itself.
 */
async function parkQueuedBook(path) {
  try {
    // Queueing the book that is READING empties «Libro en progreso»: the cola is
    // where the reader just said it waits.
    //
    // clearActive parks the position (🧹 forgets it) and leaves the unload no
    // active doc to hand off — that hand-off belongs to 🗑.
    const cur = state.docs[state.active];
    if (cur && cur.src === path) clearActive();
    await unloadDocBySrc(path);
  } catch (e) {
    console.error("queue park failed:", e);
  }
}

/**
 * Move `path` to the first (`top`) or last slot of ITS OWN day/night shelf,
 * stepping over the other shelf's entries — the queue is one list but each shelf
 * reads only its own rows, so "top" must mean the top of what the operator sees.
 * Pure: returns a NEW array (the list is unchanged when the path isn't queued).
 */
export function moveWithinShelf(list, path, top) {
  const i = list.findIndex((e) => e.id === path);
  if (i < 0) return list;
  const out = list.slice();
  const [entry] = out.splice(i, 1);
  const same = out
    .map((e, k) => (e.mode === entry.mode ? k : -1))
    .filter((k) => k >= 0);
  const at = top
    ? same.length
      ? same[0]
      : 0
    : same.length
      ? same[same.length - 1] + 1
      : out.length;
  out.splice(at, 0, entry);
  return out;
}

/**
 * Add a path via an ATOMIC json-store list-append (PATCH), so a concurrent
 * device's queue is extended, never overwritten. The local push is optimistic;
 * the server's post-merge list (which includes other devices' entries) is
 * adopted on success. No-op if already queued.
 *
 * `top` (the 🔝 control) hoists the book to the head of its shelf afterwards.
 * The append still happens first — it is the write that cannot be lost — and the
 * reorder is a whole-list PUT applied to the server's own echo (the freshest
 * list there is), exactly like moveQueueSelection.
 */
async function addToQueue(path, top = false, mode = currentMode()) {
  if (isQueued(path)) return;
  queue.push({ id: path, mode }); // optimistic
  await parkQueuedBook(path); // off the "abiertos" shelf; progress untouched
  syncOfflineBuffer(); // pin + download it now, while we still have data
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: document.visibilityState === "hidden",
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
    // Append REJECTED — e.g. the key still holds a legacy `{list}` dict, so a
    // list-PATCH-onto-dict 400s. Rebuild from a FRESH server read (so the
    // fallback PUT can't drop entries another device added) and re-apply just our
    // add, then persist the canonical array (also migrating the legacy key).
    await refreshQueue();
    if (!isQueued(path)) queue.push({ id: path, mode });
    if (top) queue = moveWithinShelf(queue, path, true);
    await putQueueList(queue);
  } catch (e) {
    // Offline: the optimistic push stands; the next refresh reconciles.
    console.error("queue add failed:", e);
  }
}

/**
 * 🔝 / ⬇️ on a book that is ALREADY queued: re-seat it at the top or the
 * bottom of its shelf. Like every whole-list write, it folds its change into a
 * FRESH server read so it can't drop an entry another device added.
 *
 * Says what HAPPENED — "ok" / "offline" / "gone" — for the same reason
 * moveQueueSelection does: this is a control the operator taps and waits on, and
 * a move that never reached the store is indistinguishable from a tap the app
 * ignored. A dead store is refused UP FRONT (the fresh read is what the
 * whole-list PUT folds into; without one there is nothing safe to write), so a
 * move over a broken tunnel changes nothing at all instead of reordering the
 * local list and silently snapping back at the next sync.
 */
export async function moveQueueEnd(path, top) {
  if (!(await refreshQueue())) return "offline";
  if (!isQueued(path)) return "gone";
  queue = moveWithinShelf(queue, path, top);
  return (await putQueueList(queue)) ? "ok" : "offline";
}

/**
 * Append MANY paths in one atomic list-PATCH, preserving the given order — the
 * "🔜 Añadir saga a la cola" path, and the 🔝/⬇️ pair on a category header.
 * N separate addToQueue calls would be N racing PATCHes whose arrival order
 * decides the reading order, which for a saga is the one thing that must not be
 * left to the network. Already-queued paths are dropped (the append is not a
 * reorder), so re-adding a saga tops up the missing books instead of duplicating
 * the rest.
 *
 * `top` hoists the whole block to the head of its shelf afterwards, IN ORDER
 * (the same append-then-reorder shape addToQueue uses for its own 🔝: the
 * append is the write that cannot be lost, the reorder is a whole-list PUT
 * folded into the server's own echo). The hoist walks the block BACKWARDS
 * because each move seats one book at the head — front-to-back would land the
 * block reversed.
 *
 * Returns the paths it actually added, so a caller can offer an ↩ undo that
 * removes exactly those and nothing another device queued meanwhile.
 */
async function addManyToQueue(paths, top = false) {
  const mode = currentMode(); // the whole block lands on the shelf you're viewing
  // Filter against a FRESH read, not the in-memory queue: a saga is up to a dozen
  // books, and any that another device queued since our last refresh would be
  // appended a second time. Best-effort — offline, refreshQueue leaves `queue` as
  // it found it and we fall back to the local view.
  await refreshQueue();
  // Drop paths already queued AND repeats WITHIN this batch: a saga list can name
  // the same book twice, and isQueued only checks the live queue (which doesn't
  // hold it yet), so without the `seen` guard both copies pass and we append the
  // book twice. `seen.add(p)` returns the Set (truthy), so it both records and
  // admits the first occurrence.
  const seen = new Set();
  const fresh = paths.filter(
    (p) => p && !isQueued(p) && !seen.has(p) && seen.add(p),
  );
  if (!fresh.length) return [];
  const entries = fresh.map((id) => ({ id, mode }));
  queue.push(...entries); // optimistic
  for (const id of fresh) await parkQueuedBook(id); // off "abiertos"; progress kept
  syncOfflineBuffer(); // pin + download them now, while we still have data
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: document.visibilityState === "hidden",
      body: JSON.stringify(entries),
    });
    if (r.ok) {
      queue = queueEntries(await r.json());
      if (top) {
        queue = hoistBlock(queue, fresh);
        await putQueueList(queue);
      }
      return fresh;
    }
    // Append REJECTED (legacy `{list}` dict under the key): rebuild from a FRESH
    // server read so the fallback PUT can't drop another device's entries, re-apply
    // just our appends, and persist the canonical array. Same recovery as addToQueue.
    await refreshQueue();
    for (const e of entries) if (!isQueued(e.id)) queue.push(e);
    if (top) queue = hoistBlock(queue, fresh);
    await putQueueList(queue);
  } catch (e) {
    // Offline: the optimistic push stands; the next refresh reconciles.
    console.error("queue bulk add failed:", e);
  }
  return fresh;
}

/** Seat `paths` at the head of their shelf, keeping their given order. Exported
 *  for the unit test: the reverse walk is the whole trick and it is easy to get
 *  backwards. */
export function hoistBlock(list, paths) {
  let out = list;
  for (const p of [...paths].reverse()) out = moveWithinShelf(out, p, true);
  return out;
}

/**
 * Drop MANY paths in one atomic `remove_by_id` PATCH — the ↩ undo behind a bulk
 * add. One call, not N, for the same reason the add is one call: N racing
 * PATCHes against a list is where entries go missing.
 */
async function removeManyFromQueue(paths) {
  const ids = paths.filter((p) => isQueued(p));
  if (!ids.length) return;
  queue = queue.filter((e) => !ids.includes(e.id)); // optimistic
  syncOfflineBuffer(); // unpinned: their files are dropped (or kept as spares)
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: document.visibilityState === "hidden",
      body: JSON.stringify({ _op: "remove_by_id", ids }),
    });
    if (r.ok) {
      queue = queueEntries(await r.json());
      return;
    }
    // Rejected (legacy dict shape): fold the removal into a FRESH server read so
    // the fallback PUT can't drop another device's entries. Same as removeFromQueue.
    await refreshQueue();
    queue = queue.filter((e) => !ids.includes(e.id));
    await putQueueList(queue);
  } catch (e) {
    console.error("queue bulk remove failed:", e);
  }
}

/**
 * The 🔝 / ⬇️ controls, one entry point: put `bk` at the top (`top`) or the
 * bottom of the queue. A book not yet queued is added there; one already queued
 * is re-seated (the controls are idempotent — they never silently unqueue; 🗑 on
 * the "en cola" row is the one way out, and it confirms).
 *
 * Returns the re-seat's verdict ("ok" / "offline" / "gone") so a caller with
 * somewhere to report can say a move was lost. An ADD keeps the void contract and
 * always answers "ok": its write is an optimistic atomic append that stands
 * offline and reconciles at the next refresh, so there is no failure to report.
 */
export async function queueBook(bk, top) {
  if (isQueued(bk.p)) {
    const verdict = await moveQueueEnd(bk.p, top);
    // Another device can queue the book this one is READING; the re-seat is then
    // the only tap that reaches it. A failed move parks nothing.
    if (verdict === "ok") await parkQueuedBook(bk.p);
    return verdict;
  }
  await addToQueue(bk.p, top);
  return "ok";
}

/** Resolve a catalog path to its book object, or null if not in the catalog. */
export function bookByPath(path) {
  if (!catalog) return null;
  return catalog.books.find((b) => b.p === path) || null;
}

/** Accent-fold + collapse to a comparable token string (matches the same scheme
 *  the wishlist matcher uses): lower-case, strip diacritics, keep [a-z0-9]. */
function healNorm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let srcHealed = false;

/**
 * Recover the catalog `src` on in-progress books whose progress entry lost it —
 * opened before src-stamping existed, through the folder-browse fallback (no
 * catalog), or dropped by the old asymmetric merge. Without a `src`, a book can
 * never render as a cross-device "libros abiertos" row (the shelf needs the path
 * to re-download the file), so these get stranded on the one device that opened
 * them — the "otro dispositivo no encuentra los libros abiertos" bug.
 *
 * The entry's `title` is the stored FILENAME (e.g. "El universo elegante - Brian
 * Greene.epub"); we split it into `<title> - <author>` and match back to the
 * catalog. We heal ONLY on an UNAMBIGUOUS match — a wrong src would resume the
 * book from the wrong file, which is worse than leaving it local-only — so a
 * title (or title+author) that resolves to more than one catalog book is skipped.
 * Runs once per catalog load; the push carries no fresh `ts`, so it can't regress
 * a position another device advanced (see backfillSrcs).
 */
function healOpenBookSrcs() {
  if (srcHealed || !catalog || !Array.isArray(catalog.books)) return;
  srcHealed = true;
  const missing = openBookKeysMissingSrc();
  if (!missing.length) return;
  const pairs = [];
  for (const { docKey, title } of missing) {
    const bk = bookByFileName(title);
    if (bk) pairs.push({ docKey, src: bk.p });
  }
  if (pairs.length) backfillSrcs(pairs);
}

// Filename → catalog book, built on first use and thrown away with the catalog.
// A key that collides is set to null so a lookup can never resolve to an
// arbitrary one of several same-titled books.
let nameIndex = null;

function ensureNameIndex() {
  if (nameIndex || !catalog || !Array.isArray(catalog.books)) return nameIndex;
  const byTitle = new Map();
  const byTitleAuthor = new Map();
  const mark = (map, key, bk) => {
    if (!key) return;
    map.set(key, map.has(key) ? null : bk);
  };
  for (const b of catalog.books) {
    const t = healNorm(b.t);
    mark(byTitle, t, b);
    mark(byTitleAuthor, `${t}|${healNorm(b.a)}`, b);
  }
  nameIndex = { byTitle, byTitleAuthor };
  return nameIndex;
}

/**
 * Resolve a stored FILENAME ("El universo elegante - Brian Greene.epub") back to
 * its catalog book. Unambiguous matches only — a title that resolves to more than
 * one book yields null, since a wrong match would show the wrong saga (and, via
 * `healOpenBookSrcs`, resume from the wrong file).
 */
function bookByFileName(name) {
  const idx = ensureNameIndex();
  if (!idx || !name) return null;
  const fn = String(name).replace(/\.(epub|pdf|txt|md)$/i, "");
  const cut = fn.lastIndexOf(" - ");
  const t = healNorm(cut >= 0 ? fn.slice(0, cut) : fn);
  const a = cut >= 0 ? healNorm(fn.slice(cut + 3)) : "";
  if (!t) return null;
  return (a ? idx.byTitleAuthor.get(`${t}|${a}`) : null) || idx.byTitle.get(t) || null;
}

/**
 * The catalog book behind a row that CAME FROM the library: by `src` first, then
 * by the stored filename. The second leg is what puts the author, saga and year
 * lines on rows whose `src` no longer resolves — a book re-imported under a new
 * catalog path, or one opened through the folder-browse fallback, which stores the
 * browse URL rather than a catalog `p`. Those rows used to fall back to a bare
 * card titled with the raw ".epub" filename and carrying neither author nor saga,
 * which is how finished books in «Terminados recientemente» lost their saga line.
 *
 * A row with NO `src` is a file the reader dropped in by hand: it never claimed a
 * library identity, so it does not get guessed one here — matching its filename
 * against the catalog would silently hand a private upload the ratings, the queue
 * controls and the author page of a same-titled library book.
 */
export function bookForRow(src, name) {
  if (!src) return null;
  return bookByPath(src) || bookByFileName(name) || null;
}

/* ===================== sagas (Calibre series) ===================== */
//
// A book's saga is `bk.s` — an INDEX into catalog.series, not the name (the
// export interns the names; see export_catalog.py). `bk.n` is its position in
// that saga, absent when Calibre knows the saga but not the number. ~43% of the
// library is in one.

let sagaIndex = null; // saga id -> books, in reading order. Rebuilt with the catalog.
let authorIndex = null; // normalised author -> their books. Rebuilt with the catalog.

/** The saga's display name, or "" for a standalone book / a pre-saga catalog. */
export function sagaName(bk) {
  const names = catalog && catalog.series;
  if (!bk || !Array.isArray(names)) return "";
  return typeof bk.s === "number" ? names[bk.s] || "" : "";
}

/**
 * Reading order within a saga: by `n` ascending, so "book 2.5" (the novella
 * Calibre indexes between 2 and 3) lands where it belongs. A book whose `n` is
 * missing has no place in the sequence, so it sinks below the numbered ones and
 * sorts alphabetically among its unnumbered peers — better than pretending it is
 * book 0 and opening the saga with it.
 */
export function compareSagaOrder(a, b) {
  const an = typeof a.n === "number" ? a.n : Infinity;
  const bn = typeof b.n === "number" ? b.n : Infinity;
  if (an !== bn) return an - bn;
  return alphaCmp(a, b);
}

/** saga id -> its books in reading order. One pass over the catalog, on load. */
async function buildSagaIndex(books) {
  const idx = new Map();
  await sliceForEach(books, (b) => {
    if (typeof b.s !== "number") return;
    if (!idx.has(b.s)) idx.set(b.s, []);
    idx.get(b.s).push(b);
  });
  // Per-saga sorts, not one big one: a saga is a handful of books, so this is
  // cheap even though it is not itself sliced.
  for (const arr of idx.values()) arr.sort(compareSagaOrder);
  return idx;
}

/**
 * normalised author -> their books. One pass over the catalog, on load.
 *
 * The author page — and, until 2026-07-25, a «📚 N» chip on the active-book card —
 * answered "how many books does this author have?" with a full
 * `catalog.books.filter`. The catalog is ~88 000 entries and `normName` is not
 * free, so that was ~88 000 string normalisations per answer, on every paint. One
 * pass here replaces all of them with a Map lookup.
 */
async function buildAuthorIndex(books) {
  const idx = new Map();
  await sliceForEach(books, (b) => {
    if (!b.a) return;
    const k = normName(b.a);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(b);
  });
  return idx;
}

/**
 * Every catalog book by `author` (normalised match); [] when there is none.
 * The array is the index's own — read it, don't sort or splice it (same contract
 * as `sagaBooks`); callers that need an ordering copy first.
 */
export function authorBooks(author) {
  if (!author || !authorIndex) return [];
  return authorIndex.get(normName(author)) || [];
}

/**
 * Calibre's author field is MULTI-VALUED and its separator is `&` ("Neil Gaiman &
 * Terry Pratchett"); a hand-written OPF sometimes uses `;` or `|` for the same
 * thing. Split on those, and only those.
 *
 * A comma is NOT a separator here, and neither is " y ": Calibre writes a single
 * writer as "Apellido, Nombre" far more often than it bundles two, so splitting on
 * either would truncate real names ("García Márquez, Gabriel" → "García Márquez")
 * on tens of thousands of cards to tidy a handful.
 */
export function splitAuthors(name) {
  return String(name || "")
    .split(/[&;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The LEAD author of a (possibly multi-valued) author field — what a card's second
 * line shows (see authorLine). `build_index.py` keeps the first `<dc:creator>` of
 * the OPF, which is where Calibre puts the lead author, so "first" here is as close
 * to "main" as the metadata gets. "" when there is no author at all.
 */
export function firstAuthor(name) {
  return splitAuthors(name)[0] || "";
}

/**
 * "This is not a writer": the placeholder a Calibre library parks an anthology
 * under when no single hand owns it. The biblioteca has ~1300 books under «Varios
 * autores», so that author page is not a bibliography — it is a category the size
 * of a small library, and it must not paint 1300 cards (see openAuthorBooks, which
 * ships those sections COLLAPSED behind a 🔍 filter).
 *
 * There is no better name to put on those cards either: build_index.py records the
 * FIRST `<dc:creator>`, and for these books that creator IS the placeholder — no
 * real name was ever written down for the app to recover. A multi-author book whose
 * OPF DOES name its writers lands under "A & B" instead, and `firstAuthor` already
 * shows A there.
 */
const COLLECTIVE_AUTHORS = new Set(
  [
    "Varios autores",
    "Autores varios",
    "Varios",
    "VV.AA.",
    "AA.VV.",
    "VVAA",
    "AAVV",
    "Anónimo",
    "Autor desconocido",
    "Desconocido",
    "Sin autor",
    "Colectivo",
    "Antología",
    "Various authors",
    "Unknown",
  ].map(normName),
);

/** True for «Varios autores» / «VV.AA.» / «Anónimo» & co. — a bucket, not a hand. */
export function isCollectiveAuthor(name) {
  const k = normName(name);
  return !!k && COLLECTIVE_AUTHORS.has(k);
}

/**
 * Every catalog book in `bk`'s saga, in reading order (including `bk` itself);
 * empty for a standalone. Keyed on the saga id, NOT the author — a saga written
 * by more than one hand (or filed under "Autor & Otro") still comes back whole.
 */
export function sagaBooks(bk) {
  if (!bk || typeof bk.s !== "number" || !sagaIndex) return [];
  return sagaIndex.get(bk.s) || [];
}

// A saga numbered `n: 9999` (Calibre metadata is hand-typed) would otherwise
// paint ten thousand missing rows. Wider than this and the numbering is read as
// noise, not as a sequence with holes.
const MAX_SAGA_SPAN = 200;

/**
 * The positions of `books`' saga that the library does NOT hold: every integer
 * between the saga's first and last numbered book with no book on it. A saga
 * whose lowest number is 5 is missing 1..4 — a series starts at 1 (or at 0, when
 * a prequel says so), and the catalog only ever knows what it holds.
 *
 * Fractional positions (Calibre's `2.5` novellas) are never reported missing:
 * nothing declares that a saga has one. They are not holes either — a saga of
 * 1, 2, 2.5, 3 is complete.
 */
export function sagaGaps(books) {
  const nums = (books || []).map((b) => b.n).filter((n) => Number.isInteger(n));
  if (!nums.length) return [];
  const have = new Set(nums);
  const lo = Math.min(1, ...nums);
  const hi = Math.max(...nums);
  if (hi - lo > MAX_SAGA_SPAN) return [];
  const out = [];
  for (let i = lo; i <= hi; i++) if (!have.has(i)) out.push(i);
  return out;
}

/**
 * True when the saga carries at least one integer position — the only case in
 * which "is it complete?" has an answer at all. ~43% of the library is in a
 * saga, but Calibre knows the number for only some of it, and a saga of purely
 * unnumbered books is a bag, not a sequence.
 */
export function sagaIsNumbered(books) {
  return (books || []).some((b) => Number.isInteger(b.n));
}

/** The saga's author: the name most of its books carry (a saga can span hands). */
function sagaAuthor(books) {
  const seen = new Map();
  for (const b of books || []) if (b.a) seen.set(b.a, (seen.get(b.a) || 0) + 1);
  let best = "";
  let top = 0;
  for (const [a, c] of seen) {
    if (c > top) {
      best = a;
      top = c;
    }
  }
  return best;
}

/**
 * Drop paths from the queue via ONE atomic json-store removal (PATCH
 * `_op:remove_by_id`), so a concurrent device's other entries are untouched. The
 * local splice is optimistic; the server's post-removal list is adopted. Returns
 * whether the removal LANDED — the cola's bulk 🗑 reports a write that didn't
 * (see encurso.js runQueueWrite); the single-path caller below ignores it.
 *
 * One PATCH for the whole set, not one per book: `remove_by_id` already takes a
 * list, and N overlapping removals would each adopt a different post-removal echo.
 */
async function dropFromQueue(paths) {
  const gone = new Set(paths.filter((p) => queue.some((e) => e.id === p)));
  if (!gone.size) return true; // nothing of ours left to remove: already done
  queue = queue.filter((e) => !gone.has(e.id)); // optimistic
  syncOfflineBuffer(); // unpinned: their files are dropped (or kept as spares)
  try {
    const r = await apiFetch(API_BASE + QUEUE_KEY, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: document.visibilityState === "hidden",
      body: JSON.stringify({ _op: "remove_by_id", ids: [...gone] }),
    });
    if (r.ok) {
      queue = queueEntries(await r.json());
      return true;
    }
    // Removal rejected (legacy dict shape). Rebuild from a FRESH server read (so
    // we don't drop entries another device added) and re-apply just our removal,
    // then persist the post-removal array.
    await refreshQueue();
    queue = queue.filter((e) => !gone.has(e.id));
    return await putQueueList(queue);
  } catch (e) {
    console.error("queue remove failed:", e);
    return false;
  }
}

/** Drop ONE path from the queue. The auto-advance, the 🌙⇄☀️ re-shelve and the
 *  «Book and author» menu all unqueue a single book and none of them has anywhere
 *  to report a failure, so they keep the void contract. */
export async function removeFromQueue(path) {
  await dropFromQueue([path]);
}

/**
 * Drop a SET of queued paths — the cola's bulk 🗑. Like every queue write it says
 * what happened ("ok" / "offline" / "gone") so the modal can report a removal that
 * never reached the store instead of repainting the same list in silence.
 */
export async function removeQueueSelection(paths) {
  const sel = paths.filter((p) => isQueued(p));
  if (!sel.length) return "gone";
  return (await dropFromQueue(sel)) ? "ok" : "offline";
}

/**
 * Rewrite only the VISIBLE slots of the queue, leaving every other entry exactly
 * where it is. The queue is ONE array holding both shelves (plus entries the
 * catalog can no longer resolve), while the cola on screen is a filtered view of
 * it — so a reorder has to be expressed as a permutation of the rows the operator
 * can actually see, written back into the same array positions. `fn` receives the
 * visible entries in view order and returns them reordered.
 */
function rewriteVisible(list, isVisible, fn) {
  const slots = [];
  list.forEach((e, k) => {
    if (isVisible(e)) slots.push(k);
  });
  const arr = fn(slots.map((k) => list[k]));
  const out = list.slice();
  slots.forEach((k, n) => {
    out[k] = arr[n];
  });
  return out;
}

/**
 * Move a SET of queued paths one visible slot up (`dir` = -1) or down (+1),
 * keeping their relative order — the block move a multi-select needs.
 *
 * Selected rows step over unselected ones only: a selected row whose neighbour in
 * the direction of travel is also selected stays put (the block moves as one), and
 * a block already against the end of the list simply doesn't move. That is what
 * makes repeated taps walk a scattered selection up the cola and then hold it
 * there, instead of collapsing it into a clump or falling off the end.
 *
 * Pure — returns a NEW array. `isVisible` names the rows the operator sees.
 */
export function moveSelectionStep(list, paths, dir, isVisible = () => true) {
  const sel = new Set(paths);
  return rewriteVisible(list, isVisible, (arr) => {
    const a = arr.slice();
    if (dir < 0) {
      for (let k = 1; k < a.length; k++) {
        if (sel.has(a[k].id) && !sel.has(a[k - 1].id)) [a[k - 1], a[k]] = [a[k], a[k - 1]];
      }
    } else {
      for (let k = a.length - 2; k >= 0; k--) {
        if (sel.has(a[k].id) && !sel.has(a[k + 1].id)) [a[k], a[k + 1]] = [a[k + 1], a[k]];
      }
    }
    return a;
  });
}

/**
 * Send a SET of queued paths to the top (`top`) or the bottom of the visible
 * cola in one move, keeping their relative order — the 🔝 / ⤓ of a multi-select,
 * so a long queue doesn't have to be walked one tap at a time. Pure.
 */
export function moveSelectionEnd(list, paths, top, isVisible = () => true) {
  const sel = new Set(paths);
  return rewriteVisible(list, isVisible, (arr) => {
    const picked = arr.filter((e) => sel.has(e.id));
    const rest = arr.filter((e) => !sel.has(e.id));
    return top ? [...picked, ...rest] : [...rest, ...picked];
  });
}

/**
 * Reorder MANY queued books at once: `how` is -1 / +1 (one slot) or "top" /
 * "bottom" (to the end of the cola). Like every whole-list queue write it folds
 * its change into a FRESH server read, so it can't drop an entry another device
 * added, and the optimistic local order stands if the store is offline.
 *
 * The shelf comes from the FIRST still-queued path: a selection is made inside
 * one día/noche cola (the only cola on screen), so the others share it, and any
 * path that has since left the queue is dropped rather than resurrected.
 *
 * Returns what HAPPENED — "ok", "offline" or "gone" — because this is the one
 * queue write with a control the operator taps and waits on. A dead store is
 * refused UP FRONT (a fresh read is what the whole-list PUT folds into; without
 * one there is nothing safe to write), so a move over a broken tunnel changes
 * nothing at all instead of reordering the list on screen and silently snapping
 * back at the next sync. The cola turns the answer into a line the reader can
 * see — see encurso.js runQueueWrite.
 *
 * "Visible" has to mean exactly what the cola paints, or a move lands somewhere
 * the operator didn't point at. With a catalog in hand that is "resolves to a
 * book" (an orphaned path paints no row — the rule single-row ▲▼ follows), plus
 * the selection itself. With NO catalog it is every entry on the shelf: offline
 * the cola paints a stub row for each one (getQueueBooks), so they are all on
 * screen and all movable.
 */
export async function moveQueueSelection(paths, how) {
  if (!(await refreshQueue())) return "offline";
  const sel = paths.filter((p) => isQueued(p));
  if (!sel.length) return "gone";
  const picked = new Set(sel);
  const mode = queueModeOf(sel[0]);
  const isVisible = (e) =>
    e.mode === mode && (!catalog || picked.has(e.id) || !!bookByPath(e.id));
  queue =
    how === "top" || how === "bottom"
      ? moveSelectionEnd(queue, sel, how === "top", isVisible)
      : moveSelectionStep(queue, sel, how, isVisible);
  return (await putQueueList(queue)) ? "ok" : "offline";
}

/**
 * 🌙⇄☀️ on a QUEUED book: move its cola entry to the other día/noche shelf. The
 * queue is one list whose entries each carry their own `mode`, so this is the
 * cola's counterpart of setDocMode — the book leaves the shelf's cola it was in
 * and appears in the other one, never in both (the same "each shelf is a
 * self-contained En curso" rule the abiertos shelf follows).
 *
 * It lands at the BOTTOM of the cola it joins (moveWithinShelf with top=false):
 * leaving it at its old array index would seat it at an arbitrary spot in the
 * middle of the other shelf's reading order, which is not something the operator
 * asked for. ▲/▼ then move it from a known place.
 *
 * A whole-list PUT (a mode edit can't be expressed with the atomic append/remove
 * ops), so — like every whole-list write here — it folds its change into a FRESH
 * server read and can't drop an entry another device added. No-op when the path
 * isn't queued or is already on that shelf.
 */
export async function setQueueMode(path, mode) {
  const want = normMode(mode);
  await refreshQueue();
  const i = queue.findIndex((e) => e.id === path);
  if (i < 0 || queue[i].mode === want) return;
  const next = queue.slice();
  next[i] = { ...next[i], mode: want };
  queue = moveWithinShelf(next, path, false);
  await putQueueList(queue);
}

/**
 * Resolve the CURRENT shelf's queue to book objects, dropping any path no longer
 * in the catalog. Re-syncs from the server first so the 📖 en-curso modal
 * reflects queue edits made on other devices. Only entries whose `mode` matches
 * the current day/night shelf are returned — each shelf has its own queue.
 */
/**
 * The current shelf's queue from the IN-MEMORY list only — no fetch, no await.
 * Lets the en-curso modal paint the cola it already knows about before it gates
 * anything on the network (see encurso.js renderEnCurso). Resolves through the
 * catalog when it is warm and falls back to path-derived stubs when it is not,
 * so the rows carry titles either way.
 */
export function getQueueCached() {
  const mode = currentMode();
  return queue
    .filter((e) => e.mode === mode)
    .map((e) => (catalog ? bookByPath(e.id) : stubFromPath(e.id)) || stubFromPath(e.id));
}

export async function getQueueBooks() {
  await Promise.all([ensureCatalog(), ensureFavorites(), refreshQueue()]);
  const mode = currentMode();
  const entries = queue.filter((e) => e.mode === mode);
  if (catalog) {
    // The queue we just pulled is the buffer's pin list, and another device may
    // have added or dropped books since the last sync — reconcile the downloads.
    syncOfflineBuffer();
    return entries.map((e) => bookByPath(e.id)).filter(Boolean);
  }
  // Offline (catalog unreachable): the queue blob itself is cached by the SW, so
  // we still know WHAT is queued. Resolve each path to a stub card so "en cola"
  // stays populated and persistent offline — matching the online view instead of
  // silently emptying (the buffered files are pinned, so tapping still opens one).
  return entries.map((e) => stubFromPath(e.id));
}

/** A minimal book object built from a catalog path alone (no catalog needed):
 *  `p` = "Author/Title (calibreId)", so the last segment (minus the id) is the
 *  title and the first is the author. Used offline, where the catalog can't
 *  resolve the path to a full book. */
function stubFromPath(path) {
  const segs = String(path).split("/");
  const last = segs[segs.length - 1] || String(path);
  return {
    p: path,
    t: last.replace(/\s*\(\d+\)\s*$/, "").trim() || last,
    a: segs.length > 1 ? segs[0] : "",
    _offline: true,
  };
}

/**
 * SELECT a queued book from the "en curso" modal: promote it out of the 🔜 queue
 * into the open books and make it the active book — but DON'T auto-play. Nothing
 * in the en-curso modal ever starts audio; only the player's ▶ Play does (see
 * `shouldPlayOnActivate`). Removing it from the queue matches the old behaviour
 * (it has moved from "en cola" to "abiertos"); the sole change is that it no
 * longer starts reading on its own.
 */
export async function selectQueuedBook(bk) {
  // Unawaited as ever: the open waits on no store. The re-add below awaits it,
  // so the two writes cannot land out of order.
  const removal = removeFromQueue(bk.p);
  const opened = await loadBook(bk, false, true); // select-only: never auto-plays
  // A failed open must not SPEND the entry: the book would leave the cola for
  // good, its only trace the dialog naming the failure.
  if (!opened) {
    await removal;
    await addToQueue(bk.p, true);
  }
  // Returned so the en-curso ⏭️/✅ pair can await the swap before repainting.
  return opened;
}

/**
 * SELECT a catalog book from a synced progress entry (a book in progress on
 * another device that isn't in this device's local library) via the "en curso"
 * modal. Downloads it from the raspi library and resumes at the saved position,
 * makes it the active book, but does NOT auto-play — only ▶ Play starts audio.
 * `src` is the catalog path; `title` is only used for status text.
 */
export function openCatalogBook(src, title) {
  // Prefer the full catalog entry so its author threads onto the doc (item 3) —
  // the remote en-curso shelf only renders with the catalog loaded, so this
  // normally resolves and the author survives a later catalog-down/path-drift
  // reload, exactly like a biblioteca-opened book. Fall back to a minimal book.
  const bk = bookByPath(src) || { p: src, t: title || src };
  loadBook(bk, false, true); // select-only: never auto-plays
}

/**
 * The next book after `idx` in the filter list, wrapping. `allowed` — the paths
 * this advance may land on — restricts the walk; pass null to walk over every
 * match.
 *
 * That restriction is what keeps an offline binge going. Offline the buffered
 * books are the ONLY openable ones (every download below throws), so an
 * unrestricted walk hands back the immediate neighbour, its open fails, and the
 * night stops there — with the rest of the buffer still sitting in IndexedDB,
 * unread. Skipping to the next BUFFERED book keeps the series moving through the
 * volumes we actually hold. Null when the buffer holds none of them. Pure.
 */
export function nextInSeries(matches, idx, allowed) {
  for (let step = 1; step < matches.length; step++) {
    const bk = matches[(idx + step) % matches.length];
    if (!allowed || allowed.has(bk.p)) return bk;
  }
  return null;
}

/**
 * Which day/night cola an auto-advance draws from: the shelf of the book that
 * just ENDED, not the one the modal happens to be showing. Finishing a night
 * book at 2am with the modal left on día would otherwise pull the next book off
 * the DAY cola. The device's view only decides where a book is PUT (opened /
 * queued); what plays NEXT follows the book. A doc with no mode predates the
 * split ⇒ night (mode.js); no finished doc at all falls back to the view. Pure.
 */
export function advanceShelf(finishedDoc, view) {
  return finishedDoc ? normMode(finishedDoc.mode) : normMode(view);
}

/**
 * A book in the OTHER shelf's cola is held back for the other half of the day,
 * so no advance may take it. Pure.
 */
export function shelfAllows(entries, shelf, path) {
  const e = entries.find((x) => x.id === path);
  return !e || normMode(e.mode) === normMode(shelf);
}

/**
 * A book just finished under normal playback. Advance, in priority order:
 *  1. the next QUEUED book (🔜), if any;
 *  2. else the NEXT book after the finished one in the current filter list —
 *     since the catalog keeps books grouped by author/folder, that is usually
 *     the next volume of a series (`finishedSrc` is the finished book's catalog
 *     path; wraps at the end of the list);
 *  3. else — finished book not in the current filter set (or unknown) — a
 *     filtered random (prefetched buffer first: instant + offline).
 * Voice/speed/volume are global + persisted, so they carry across untouched.
 *
 * OFFLINE, every candidate above is filtered down to what the buffer holds: a
 * book with no downloaded file cannot be opened without a network, so offering it
 * would just dead-end the binge. And because `navigator.onLine` can only see the
 * local interface — not a dead tunnel or an unreachable pi — an open that FAILS
 * while we still believe we're online falls back to a buffered book too.
 */
export async function advanceAfterFinish(finishedSrc) {
  // The book that just ended, grabbed before the first await: the ↩ on the advance
  // toast goes back to it, and once its replacement loads it is no longer active.
  // Still loaded, guaranteed — evictOneFinished never evicts the active doc.
  const prev = state.docs[state.active] || null;
  const [hasCatalog] = await Promise.all([
    ensureCatalog(),
    ensureFavorites(),
    ensureCacheIndex(), // the buffered books are the offline advance path
  ]);
  if (!hasCatalog) {
    showToast("📚 Sin catálogo: no hay libro siguiente que buscar.");
    return;
  }
  // Auto-advance appends to state.docs; at MAX_DOCS a fresh load would silently
  // no-op and halt the binge. Free a slot first (oldest finished doc).
  await evictOneFinished();
  const offline = !navigator.onLine;
  // Play the first queued book (on the FINISHED book's shelf) still in the
  // catalog. ONLY
  // that book is removed from the queue — entries that don't resolve are skipped,
  // not deleted, so a transient catalog hiccup (paths briefly unresolvable) can't
  // silently drain the whole queue to zero. A genuinely-missing entry lingers at
  // worst; the operator can drop it by hand from the 📖 en-curso list. Offline, a
  // queued book this device can't open is skipped the same way — it STAYS queued
  // and plays once there's a network again, instead of being spent on a failed open.
  const shelf = advanceShelf(prev, currentMode());
  const modeQueue = queue.filter((e) => e.mode === shelf);
  const done = finishedSrcSet();
  for (const e of modeQueue) {
    // The book this device is reading, and any book already read to the end, both
    // reopen ON their last page: the advance stops at once and fires again, one
    // cola entry per step. Skipped, never dropped — the manual ⏭️ still starts it.
    if (e.id === prev?.src || done.has(e.id)) continue;
    const bk = bookByPath(e.id);
    if (!bk) continue;
    if (offline && !cachedPaths.has(e.id) && openDocIndex(e.id) < 0) continue;
    const removal = removeFromQueue(e.id); // unawaited: the open waits on no store
    setStatus(`🔜 Siguiente en la cola: "${bk.t}".`);
    // 3rd arg: the book to PUT BACK if the ↩ is tapped — this path spent a queue
    // entry to get here (the removeFromQueue above), the others spend nothing.
    if (await advanceTo(bk, prev, bk)) return;
    // Open failed (the network died under us). Put the entry back on ITS shelf,
    // or the book is gone from the cola.
    await removal;
    await addToQueue(e.id, true, e.mode);
    break;
  }
  const onShelf = (bk) => shelfAllows(queue, shelf, bk.p);
  const matches = filteredBooks().filter(onShelf);
  if (!matches.length) return nothingLeftToRead();
  // Nothing queued: play the NEXT book after the finished one in the filter
  // list (wrapping), so a series rolls on. Only when the finished book is in
  // the current filter set — otherwise fall through to a random pick.
  const idx = finishedSrc ? matches.findIndex((b) => b.p === finishedSrc) : -1;
  // Where the advance may LAND. A book read to the end re-speaks its last
  // paragraph and fires the finish again, marching down the shelf one EPUB per
  // step, so 📖 leídos exempts nothing here; the manual 🎲 serves them.
  // The just-ended book goes by path: a short listen leaves it unmarked.
  const canLand = (bk) =>
    bk.p !== finishedSrc && !done.has(bk.p) && (!offline || cachedPaths.has(bk.p));
  const landable = new Set(matches.filter(canLand).map((b) => b.p));
  if (idx >= 0 && matches.length > 1) {
    const bk = nextInSeries(matches, idx, landable);
    if (bk) {
      setStatus(`🔜 Siguiente: "${bk.t}".`);
      if (await advanceTo(bk, prev, null)) return;
    }
  }
  // Finished book not in these filters (or the only match) → a filtered random.
  // Prefer a buffered book (instant, and the only thing that works offline). This
  // is also the net under a failed open above: the pi can be unreachable while the
  // OS still calls itself online, and then the buffer is all we have.
  const buffered = bufferedPicks(pinnedPaths()).filter(onShelf).filter(canLand);
  if (buffered.length) {
    const bk = buffered[Math.floor(Math.random() * buffered.length)];
    setStatus(`🎲 Auto: "${bk.t}".`);
    if (await advanceTo(bk, prev, null)) return;
  }
  if (offline) {
    setStatus("📴 Sin conexión: no quedan libros precargados para seguir.");
    return;
  }
  const pool = randomPool().filter(onShelf).filter(canLand);
  if (!pool.length) return nothingLeftToRead();
  const bk = pool[Math.floor(Math.random() * pool.length)];
  setStatus(`🎲 Auto: "${bk.t}".`);
  await advanceTo(bk, prev, null);
}

/**
 * Every candidate is read or filtered out. Say it on the TOAST: #status sits
 * hidden behind the active-book card while reading, so an advance that finds
 * nothing goes quiet with no notice at all — which is the shape of a dead app,
 * not of a shelf you finished. The usual cause is a filter left on (📖 leídos
 * makes every match finished), so the message names the filters.
 */
function nothingLeftToRead() {
  showToast("📚 No queda ningún libro sin leer con estos filtros.");
}

/**
 * Load the auto-advance's pick and, if it opened, say so ON SCREEN with a way back.
 *
 * The advance force-plays a book the operator did not choose; until now it did so
 * silently (every notice above went into the hidden #status). This toast is the
 * only thing standing between them and "why is it reading me something else".
 * EVERY force-play nobody asked for goes through here — a new advance path that
 * calls loadBook(bk, true) directly loses its explanation and its ↩.
 *
 * `requeued` is the book the QUEUE path consumed: advanceAfterFinish dequeues
 * before it loads, so without putting it back the ↩ would quietly spend a queue
 * entry. null on the series / random paths — nothing was consumed there.
 */
async function advanceTo(bk, prev, requeued) {
  if (!(await loadBook(bk, true))) return false;
  const back = prev ? docToBook(prev) : null;
  showToast(`▶ Ahora: «${bk.t}»`, {
    ms: TOAST_UNDO_MS,
    undo: back
      ? {
          label: `↩ Volver a «${back.t}»`,
          onUndo: () => undoAdvance(prev, requeued),
        }
      : null,
  });
  return true;
}

/**
 * ↩ on the advance toast: back to the book that just ended, and the book the
 * advance opened goes back where it came from.
 *
 * Select-only — the ↩ MOVES you, it never starts speaking (only ▶ Play does), and
 * activateDoc's own stopAll cuts the audio the advance started. Order matters:
 * re-activate FIRST, then re-queue, because queueBook parks the book it queues
 * (unloading this device's copy) and parking the ACTIVE doc would bounce the
 * player onto a neighbour instead of onto `prev`.
 */
async function undoAdvance(prev, requeued) {
  const i = state.docs.indexOf(prev);
  if (i >= 0) {
    activateDoc(i, false, true);
  } else if (prev?.src) {
    // Evicted while the toast was up (a second advance hit the MAX_DOCS ceiling):
    // reopen it from the catalog rather than dead-end the ↩.
    const bk = bookByPath(prev.src);
    if (bk) await loadBook(bk, false, true);
  }
  // Back to the HEAD of its shelf: it was the next thing to be read.
  if (requeued) await queueBook(requeued, true);
}

/** The per-book ⭐ degree from the path map, else the catalog-baked `v`. */
function pathDegree(bk) {
  if (bk.p in favorites) return favorites[bk.p];
  return bk.v === "favorite" ? 1 : 0;
}

/** Effective author-favorite degree: live author map wins, else the seed. */
function authorDegree(bk) {
  const k = normName(bk.a);
  if (k in favAuthors) return favAuthors[k];
  return seedAuthorDegree(tokenSet(bk.a));
}

/**
 * Effective 👍/👎 reaction ("like" | "dislike" | null): a live per-book value
 * wins ("none" being an explicit neutral tombstone over a seed); otherwise the
 * static seed decides (see js/reactions.js).
 */
function bookReaction(bk) {
  const v = reactions[bk.p];
  if (v === "like" || v === "dislike") return v;
  if (v === "none") return null;
  return seedIndex ? seedReactionFor(seedIndex, bk) : null;
}

/** Set a book's OWN ⭐ favorite flag (0 = not favorite, 1 = favorite) and persist. */
function setFavorite(bk, degree) {
  if (degree === 0 && bk.v !== "favorite") {
    // Clean removal for a non-baked favorite (the flush PATCHes null → key
    // deleted); a baked one keeps a 0 tombstone so its baked default can't
    // re-assert.
    delete favorites[bk.p];
  } else {
    favorites[bk.p] = degree;
  }
  saveFavorites(bk.p);
  // ⭐ favorite, 👍 like and 👎 dislike are mutually exclusive: favoriting a book
  // clears any existing reaction (→ "none" tombstone, overriding even a seed
  // reaction). (setReaction(…, null) won't recurse back here: its unfavorite path
  // only fires for a non-null value.)
  if (degree > 0 && bookReaction(bk) != null) setReaction(bk, null);
}

/** Turn the whole author's favorite on/off (SEED_AUTHOR_DEGREE ↔ 0 tombstone). */
function setAuthorFav(bk, on) {
  const k = normName(bk.a);
  favAuthors[k] = on ? 2 : 0;
  saveFavAuthors(k);
}

/** Set a book's reaction ("like" | "dislike" | null); null → "none" tombstone. */
function setReaction(bk, val) {
  reactions[bk.p] = val === null ? "none" : val;
  saveReactions(bk.p);
  // ⭐ favorite, 👍 like and 👎 dislike are mutually exclusive: setting any
  // reaction clears a ⭐ favorite. (like/dislike share this one `reactions` map,
  // so the new value already overwrites the old; only the ⭐, on its own
  // `favorites` map, needs help. setFavorite(…, 0) won't recurse: its clear path
  // only fires for degree > 0.)
  if (val !== null && pathDegree(bk) > 0) setFavorite(bk, 0);
}

export async function openBiblioteca() {
  openModal("bibModal");
  // Opened before the catalog is in hand — the 📚 button is live from the first
  // frame now, so this is a normal thing to do, not an edge case. Say what is
  // happening: the modal used to open onto the empty markup index.html ships
  // (no rows, no count, no message) and stay that way for as long as the 14 MB
  // catalog took, up to the 30 s timeout. A blank sheet reads as a broken app.
  if (!catalog) {
    const list = $("bibList");
    list.innerHTML = "";
    if (libraryUp === false) {
      list.innerHTML =
        '<div class="bib-empty">La biblioteca del servidor no responde. ' +
        "Comprueba la conexión (o la VPN) y vuelve a intentarlo.</div>";
    } else {
      list.appendChild(spinnerLine("Cargando la biblioteca…", "bib-empty"));
    }
    $("bibCount").textContent = "";
    $("bibFilters").hidden = true;
    $("bibPager").hidden = true;
    $("bibLetters").hidden = true;
  }
  const [hasCatalog] = await Promise.all([ensureCatalog(), ensureFavorites()]);
  if (hasCatalog) await showCatalogMode();
  else await showFolderMode();
}

/** The 📚 the app is for: cards, the 🎛️ action bar, the remembered browse. */
async function showCatalogMode() {
  // The first render sorts 88 000 rows through an Intl.Collator and builds the
  // page's DOM — hundreds of ms with no frame in between. Give the browser one
  // now, so the spinner above is actually ON SCREEN for that wait instead of
  // being painted for the first time when it is already over.
  await nextPaint();
  $("bibFilters").hidden = false;
  $("bibPath").hidden = true;
  // The browse position survives the close: the page, the 🎛️ drawer, the 🎲
  // spotlight and the scroll are all where you left them, so opening a book
  // that turns out not to take costs you nothing. Only a change to the filter
  // SET rewinds them (rewindBrowse); renderCatalog clamps a page whose set has
  // since shrunk out from under it (clampPage). The ORDER is load-bearing: the
  // drawer sits above the body and changes its height, the 🎲 card sits inside
  // it above the list — both must be back in place before the pixel offset is
  // restored, or the restore lands somewhere else.
  setDrawer(drawerOpen);
  applyFilterUI(); // categories now populated → the persisted cat can be shown
  if (pickBook) renderPick(pickBook);
  else clearPick();
  renderCatalog();
  scrollListTo(bibScroll);
}

/**
 * Fallback: the raw folder browser — no catalog, so neither the action bar nor
 * the filter drawer has anything to act on, and there is no pick to hold.
 *
 * It is a DEGRADED view, and `render` now says so at the top of every level.
 * Silently swapping a card grid for a file manager is not a fallback, it is the
 * app appearing to break: the reader pressed the same 📚 they always press and
 * got somebody's folder tree, with nothing on screen connecting that to a
 * catalog that didn't load, and no way to ask for it again short of restarting
 * the app.
 */
async function showFolderMode() {
  setDrawer(false);
  clearPick();
  $("bibFilters").hidden = true;
  $("bibPath").hidden = false;
  $("bibPager").hidden = true;
  $("bibLetters").hidden = true; // no catalog ⇒ no author order to jump through
  $("bibCount").textContent = "";
  stack = [];
  await render();
}

/**
 * "The catalog didn't load — try again", as a row.
 *
 * Every surface gated on `catalog` degrades into something that looks like a
 * different, worse app (folder mode) or into nothing at all (the «Book and
 * author» sheet). The reader is owed the reason and one tap to fix it, because
 * the usual cause — a tunnel that hadn't come up yet — is over by the time they
 * read the line. `onRecovered` runs only when the retry actually lands.
 */
function catalogRetryLine(message, onRecovered) {
  const wrap = document.createElement("div");
  wrap.className = "bib-empty bib-catalog-retry";
  const text = document.createElement("div");
  text.textContent = message;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bib-retry-btn";
  btn.textContent = "🔄 Reintentar";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "🔄 Cargando…";
    // A retry is a fresh demand, so a `libraryUp: false` from a probe that ran
    // while the tunnel was down must not keep painting "no responde" after the
    // catalog has just proved otherwise.
    if (await ensureCatalog()) {
      libraryUp = true;
      onRecovered();
      return;
    }
    btn.disabled = false;
    btn.textContent = "🔄 Reintentar";
    text.textContent = "Sigue sin responder. Comprueba la conexión (o la VPN).";
  });
  wrap.appendChild(text);
  wrap.appendChild(btn);
  return wrap;
}

/* True while an open is in flight — the hard stop on a double press. The overlay
   below already swallows taps once it is up, but the WARM open (below) is a
   synchronous freeze with no overlay behind it, and this flag is what keeps a
   second tap during that freeze from queuing a second open. */
let bibOpening = false;

/**
 * The 📚 press. Acknowledged by the centered overlay — but only when the open is
 * the slow kind that earns it, and never twice at once.
 *
 * The two waits behind 📚 are different animals. When the catalog is already warm
 * the open is a PURE synchronous freeze: an 88k Intl.Collator sort plus the
 * page's DOM build, hundreds of ms with no frame in between, taps piling up
 * unanswered. That is exactly what the blocking overlay is for — it says "taken"
 * and stops the pile-up. When the catalog is NOT warm the open is instead a
 * network await: the thread is free, the modal shows its own "Cargando la
 * biblioteca…" line, and a full-page curtain would only lock the reader out for
 * the length of a fetch that can run to a 30 s timeout. So the overlay is gated
 * on `catalog`; either way `bibOpening` is the guard that a second press finds.
 */
async function openBibliotecaFromButton() {
  if (bibOpening) return;
  bibOpening = true;
  // Immediate reveal: a warm open is a synchronous 88k sort/render, and
  // openBiblioteca lets one frame through (its own `nextPaint`) before that
  // block — so the curtain is painted, and spinning, through the freeze rather
  // than scheduled to appear after it.
  const release = catalog
    ? showBusyOverlay({ label: "Abriendo la biblioteca…", revealDelayMs: 0 })
    : null;
  try {
    await openBiblioteca();
  } finally {
    if (release) release();
    bibOpening = false;
  }
}

/* ===================== catalog mode ===================== */

/** "fiction-romantica" -> "Ficción · Romántica"; nonfiction slugs -> "Historia". */
function prettyBucket(slug) {
  if (slug === "uncategorized") return "Sin categoría";
  let s = slug;
  let prefix = "";
  if (s.startsWith("fiction-")) {
    prefix = "Ficción · ";
    s = s.slice("fiction-".length);
  } else if (s.startsWith("nonfiction-")) {
    s = s.slice("nonfiction-".length);
  }
  s = s.replace(/[-_]+/g, " ");
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return prefix + s;
}

function populateCategories() {
  const sel = $("bibCat");
  // Keep the leading "Todas" option, drop any previously injected ones.
  sel.length = 1;
  // All fiction ("fiction-*") categories sink below the non-fiction ones; each
  // group keeps its catalog order (stable partition).
  const buckets = (catalog.buckets || [])
    .slice()
    .sort((a, b) => Number(a[0].startsWith("fiction-")) - Number(b[0].startsWith("fiction-")));
  buckets.forEach(([slug, count]) => {
    const o = document.createElement("option");
    o.value = slug;
    o.textContent = `${prettyBucket(slug)} (${count})`;
    sel.appendChild(o);
  });
}

/* ===================== ordering ===================== */

// Sorting 88k rows on every chip toggle would stutter, so each mode's ordering
// is built once, lazily, and reused: the FILTER runs over an already-sorted
// array (filter preserves order) instead of sorting the filtered set. Dropped
// whenever the catalog is (re)loaded — the only time the rows change.
let orderCache = {};
const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/** Author then title, accent- and case-insensitive. Also the tie-break of every date sort. */
function alphaCmp(a, b) {
  return collator.compare(a.a || "", b.a || "") || collator.compare(a.t || "", b.t || "");
}

/**
 * Compare on a numeric catalog field, undated books LAST in both directions
 * (they carry no information about where they belong, and a wall of them at the
 * top would bury the answer to "what's newest?"). Ties fall back to alphaCmp,
 * which matters a lot here: `y` is a year, so hundreds of books share one.
 */
function byNum(key, desc) {
  return (a, b) => {
    const x = a[key];
    const y = b[key];
    const xMissing = typeof x !== "number";
    const yMissing = typeof y !== "number";
    if (xMissing || yMissing) {
      if (xMissing && yMissing) return alphaCmp(a, b);
      return xMissing ? 1 : -1;
    }
    if (x === y) return alphaCmp(a, b);
    return desc ? y - x : x - y;
  };
}

/** A copy of `books` in one of the SORT_MODES orders. Unknown id → alphabetical. */
export function sortCatalogBooks(books, sortId) {
  const cmp =
    sortId === "newest"
      ? byNum("y", true)
      : sortId === "oldest"
        ? byNum("y", false)
        : sortId === "added"
          ? byNum("d", true)
          : alphaCmp;
  return books.slice().sort(cmp);
}

/** The catalog's books in the currently-selected 🔤/🆕/🏺/📥 order. */
function booksInOrder() {
  if (!catalog) return [];
  const id = filters.sort;
  if (!orderCache[id]) orderCache[id] = sortCatalogBooks(catalog.books, id);
  return orderCache[id];
}

/* --- 🔍 free-text search --- */
//
// What a reader types is the name of a THING — "geralt", "sapkowski andrzej",
// "torre golondrina" — not a prefix of one concatenated string. Two rules make
// those work, and both were missing:
//
//  1. **The saga counts.** A Witcher book's title says «La torre de la
//     golondrina» and its author says «Andrzej Sapkowski»; the word "Geralt" is
//     in NEITHER. Searching the saga — the most natural handle for a series —
//     returned "Ningún libro con estos filtros" over a library holding all seven.
//  2. **Order doesn't.** The query was a raw substring of `title + " " + author`,
//     so "sapkowski andrzej" and "geralt sapkowski" found nothing while
//     "andrzej sapkowski" found fourteen books.
//
// Each query token must now START A WORD in the book's folded haystack, in any
// order. Word-start rather than substring: it keeps live typing working
// ("sapkow" still matches) without matching a fragment buried mid-word.

// Folded haystack per book, memoised for the life of the catalog. The query
// runs over ~88 000 books on EVERY keystroke, and re-folding each one per
// stroke is the difference between typing and waiting.
let qHayCache = new Map();

/** " title author saga ", folded and space-padded so a token can match a word start. */
function searchHay(bk) {
  let hay = qHayCache.get(bk);
  if (hay === undefined) {
    hay = ` ${normName(`${bk.t} ${bk.a || ""} ${sagaName(bk)}`)} `;
    qHayCache.set(bk, hay);
  }
  return hay;
}

/** A query split into the tokens a book must ALL carry. Pure. */
export function queryTokens(q) {
  const n = normName(q);
  return n ? n.split(" ") : [];
}

/** Every token starts a word in `hay` (space-padded, folded). Pure. */
export function matchesQuery(hay, qTokens) {
  return qTokens.every((t) => hay.includes(` ${t}`));
}

function filteredBooks() {
  const gender = genderOf(filters); // male / female / all (⚥ = unconstrained)
  // The 📖 "leídos" filter matches books whose catalog path was ever finished —
  // the durable read record, unaffected by the en-curso "recientemente" triage.
  const finishedSet = filters.finished ? finishedSrcSet() : null;
  const qTokens = queryTokens(filters.q); // stored already folded; fold again is a no-op

  const matches = booksInOrder().filter((bk) => {
    if (filters.favBook && pathDegree(bk) <= 0) return false;
    if (filters.favAuth && authorDegree(bk) <= 0) return false;
    if (filters.like && bookReaction(bk) !== "like") return false;
    if (filters.dislike && bookReaction(bk) !== "dislike") return false;
    if (filters.prim && bk.v !== "primigenia") return false;
    if (finishedSet && !finishedSet.has(bk.p)) return false;
    if (gender !== "all" && bk.g !== gender) return false;
    if (filters.cat && bk.b !== filters.cat) return false;
    if (qTokens.length && !matchesQuery(searchHay(bk), qTokens)) return false;
    return true;
  });
  // The ONLY thing that orders the list is the 🔤 sort chip (booksInOrder,
  // above). Narrowing the set is the drawer's job (⭐/👤/👍/🏛️/✔/gender/
  // category) — favourites or reactions never float a book up or sink it down.
  return matches;
}

/**
 * The pool every random pick (🎲 spotlight, top-bar 🎲, auto-advance, prefetch)
 * draws from: the current filters MINUS books already finished — you don't want
 * a random re-serve of a book you've completed. (A 📖 leído book stays excluded
 * whether or not it's in the en-curso "recientemente" inbox — the `done` library
 * bit gates the pool, not the ✅ `recent` bit.) When the 📖 "leídos" filter is explicitly
 * on, though, the user is browsing finished books on purpose, so we leave that set
 * intact instead of hollowing it out to nothing.
 */
function randomPool() {
  const matches = filteredBooks();
  if (filters.finished) return matches;
  const done = finishedSrcSet();
  if (!done.size) return matches;
  return matches.filter((bk) => !done.has(bk.p));
}

/**
 * Keep a REMEMBERED page inside the current filtered set. The page survives a
 * close/reopen, but the set under it can shrink while the modal is shut (a book
 * gets ✔ terminado with the ✔ filter on; the catalog is rebuilt), so a stale
 * index must land on the LAST page that exists — never past the end, never
 * negative. Pure.
 */
export function clampPage(page, pageCount) {
  if (!Number.isInteger(page) || page < 0) return 0;
  return Math.min(page, Math.max(0, pageCount - 1));
}

/**
 * The "nothing here" line — and, when something is narrowing the list, the way
 * out of it.
 *
 * An empty list is a dead end on a phone: the chips that emptied it live behind
 * the 🎛️ drawer and the 🔍 query behind an input that collapses when you look
 * away, so the reader who searched a saga the search could not yet match got a
 * flat sentence and no thread to pull. The message IS the button now: one tap
 * drops every chip, the category and the query, and paints the whole library.
 *
 * With nothing on, that button would promise a change it cannot make, so the
 * line stays inert — an empty list then means an empty (or still-loading)
 * catalog, which is a different problem with its own notice.
 */
function emptyListNote() {
  if (!activeFilters(filters).length && !filters.q) {
    return Object.assign(document.createElement("div"), {
      className: "bib-empty",
      textContent: "Ningún libro con estos filtros.",
    });
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "bib-empty bib-empty-clear";
  btn.title = "Quitar los filtros y la búsqueda";
  btn.appendChild(
    Object.assign(document.createElement("span"), {
      textContent: "Ningún libro con estos filtros.",
    }),
  );
  btn.appendChild(
    Object.assign(document.createElement("span"), {
      className: "bib-empty-cta",
      textContent: "Click para quitar filtros",
    }),
  );
  btn.addEventListener("click", () => void clearAllNarrowing());
  return btn;
}

function renderCatalog() {
  dismissBookMenu(false); // any open popover is about to be torn out of the DOM
  const list = $("bibList");
  const body = bibBody();
  // Emptying the list collapses the scroll box, and the browser clamps its
  // scrollTop to 0 — so ANY in-place repaint (a ⭐, a 🔜, a ✅ from the long-press
  // menu) used to throw you back to the top of 88k rows. Put the box back where
  // it was; the callers that MEAN to rewind (a new filter set, a page turn) scroll
  // to the top themselves. Reads 0 while the modal is shut (the author list's rows
  // repaint this list too) — restoring 0 there is a no-op, and `bibScroll` is
  // untouched, so the next open still lands where the user was.
  const keep = body ? body.scrollTop : 0;
  const matches = filteredBooks();
  const pageCount = Math.max(1, Math.ceil(matches.length / RENDER_CAP));
  bibPage = clampPage(bibPage, pageCount);
  const start = bibPage * RENDER_CAP;
  const shown = matches.slice(start, start + RENDER_CAP);

  // The count line also NAMES the active order. The 🔤 chip is one emoji and its
  // label lives in a `title` — which a phone never shows — so cycling to 🏺 looked
  // like "the list moved and I can't tell what it did". Here it is words, on a line
  // that is already on screen, right under the chip that changed it.
  $("bibCount").textContent = !matches.length
    ? ""
    : pageCount > 1
      ? `${matches.length} libros — página ${bibPage + 1}/${pageCount} · ${sortNote()}`
      : `${matches.length} libro(s) · ${sortNote()}`;
  renderLetters(matches); // below the bibPage clamp above: it marks the current letter

  list.innerHTML = "";
  if (!matches.length) {
    list.appendChild(emptyListNote());
  } else {
    shown.forEach((bk) => list.appendChild(bookRow(bk)));
  }
  renderPager(pageCount);
  if (body) body.scrollTop = keep;
}

/**
 * THE single book-card builder used on every surface — the catalog list, the 🎲
 * spotlight, the active #bookCard, the author list AND both en-curso shelves
 * ("libros abiertos" + "en cola"). One DOM shape (div.bib-row > button.bib-item >
 * [icon] + .lbl[.bib-title[+.bib-year] + .bib-author + .bib-saga + .bib-bar] [+ chip]),
 * ONE status painter (favorite/author/like/dislike border+tint via
 * applyStatusClasses + the ✔ "terminado" cue via markFinishedCue) and ONE
 * right-click / long-press menu (attachBookMenu). Only the LEFT-CLICK differs per
 * surface, passed as `onClick`, so a book looks and behaves identically wherever
 * it appears — the whole point of the "one card everywhere" refactor. A surface
 * that needs extra controls appends them to the returned ROW, beside the card
 * (nothing does today: the cola's ▲▼🗑 moved into its multiselección bar).
 *
 * The author is the card's second line, a plain caption (see authorLine). It used
 * to double as a link to that writer's other books; that browse now lives on the
 * «Book and author» modal the card opens, so the whole card is one tap target — its own
 * onClick — with nothing inside it competing for the click.
 *
 * ONE card everywhere means the card carries NO per-surface decoration beyond
 * `icon`. Two markers were pulled for exactly that reason (operator directive,
 * 2026-07-25): the 🏛️ primigenia tag, which only ever showed on some surfaces and
 * is now stated once, on the «Book and author» modal's own title (see
 * `authorTitleFor`), and the ☁ "on another device" glyph on en-curso remote rows.
 *
 * opts:
 *   onClick()            left-click handler (select+load / play / open-author).
 *   icon                 leading glyph ("🎲", "📖", "▶", the saga's nº).
 *   title                the button's title attribute.
 *   finished             paint the ✔ "terminado" cue.
 *   pct                  0–100 → a reading-progress bar under the label lines.
 *   chip                 optional trailing element (e.g. the author-count chip).
 *   (the author line is NOT an opt: every card with an author gets one, as text.)
 *   rowClass/itemClass   extra classes for the row / button.
 *   menu                 ctx for attachBookMenu ({ src, docKey, onAfter }); omit to skip.
 */
export function buildBookCard(bk, opts = {}) {
  const row = document.createElement("div");
  row.className = opts.rowClass ? `bib-row ${opts.rowClass}` : "bib-row";

  const b = document.createElement("button");
  b.type = "button";
  b.className = opts.itemClass ? `bib-item ${opts.itemClass}` : "bib-item";
  b.title = opts.title || "Tocar para abrir · clic derecho para valorar";

  if (opts.icon) {
    const i = document.createElement("span");
    // `iconClass` styles the glyph slot as something else — the saga section
    // reuses it for the "nº in the series" chip.
    i.className = opts.iconClass ? `ico ${opts.iconClass}` : "ico";
    i.textContent = opts.icon;
    if (opts.iconTitle) i.title = opts.iconTitle;
    b.appendChild(i);
  }

  const l = document.createElement("span");
  l.className = "lbl";
  const t = document.createElement("span");
  t.className = "bib-title";
  const tt = document.createElement("span");
  tt.className = "bib-title-text";
  tt.textContent = bk.t;
  t.appendChild(tt);
  // The year the book was written, flush RIGHT on the title line (dark green, so
  // it reads as a date and not as another saga/author line). `y` comes from
  // Calibre's pubdate via export_catalog.py and is absent on ~undated books and
  // on a local drop — no year, no chip, and the title just fills the line.
  const year = typeof bk.y === "number" ? bk.y : bk._card?.y;
  if (typeof year === "number") {
    // `has-year` is what turns the title line into a flex row (see _modal.css).
    // Scoped to this case on purpose: three hand-built rows — the saga HOLES, the
    // 🌠 wishlist, and the no-book placeholder — set .bib-title's text directly,
    // with no .bib-title-text child to carry `min-width: 0`, and flexing those
    // would let a long unbroken title push past the row's edge.
    t.className = "bib-title has-year";
    const ye = document.createElement("span");
    ye.className = "bib-year";
    ye.textContent = String(year);
    ye.title = `Escrito en ${year}`;
    t.appendChild(ye);
  }
  l.appendChild(t);
  // Second line: the author, in the label column with the title and the saga —
  // one card, one box. A plain caption now (see authorLine): "more by this writer"
  // moved into the «Book and author» modal the card opens, so the line never navigates.
  if (bk && bk.a) l.appendChild(authorLine(bk));
  // Third line, saga books only: "📜 Arthor · nº 1". Which books belong to a saga
  // — and where in it they sit — is then legible from any card, without opening
  // anything. `opts.hideSaga` drops it where the surrounding section IS the saga.
  // `sagaName` needs the saga index, which needs the catalog; a cold card falls
  // back to the name stamped on the doc so the third line is there from the
  // first frame instead of appearing under the reader's eyes a moment later.
  const saga = opts.hideSaga ? "" : sagaName(bk) || bk._card?.sg || "";
  if (saga) {
    const s = document.createElement("span");
    s.className = "bib-saga";
    const n = typeof bk.n === "number" ? bk.n : bk._card?.n;
    const num = typeof n === "number" ? ` · nº ${n}` : "";
    s.textContent = `📜 ${saga}${num}`;
    s.title = num ? `Saga: ${saga} (libro ${n})` : `Saga: ${saga}`;
    l.appendChild(s);
  }
  // Reading-progress bar, last line of the label column (en-curso "libros
  // abiertos" rows). Lives INSIDE the card so the shelf's rows are the same
  // component as the biblioteca's, only with one extra line.
  if (typeof opts.pct === "number") {
    const bar = document.createElement("div");
    bar.className = "bib-bar";
    const fill = document.createElement("i");
    fill.style.width = `${opts.pct}%`;
    bar.appendChild(fill);
    l.appendChild(bar);
  }
  b.appendChild(l);
  if (opts.chip) b.appendChild(opts.chip);

  // Same status cue everywhere: favorite/author/reaction border+tint (catalog
  // books only — a local drop has no catalog identity to key on) plus the ✔ cue.
  // A COLD card (catalog still loading, appearance remembered from last time) is
  // decorated too: the alternative is a card that paints bare and then grows a
  // ring and a tint seconds later, which is the flicker this is here to remove.
  if (bk && bk.p && (!bk._local || bk._cold)) applyStatusClasses(b, bk);
  markFinishedCue(b, !!opts.finished);

  if (opts.onClick) b.addEventListener("click", opts.onClick);
  row.appendChild(b);
  if (opts.menu) attachBookMenu(row, bk, opts.menu);
  return row;
}

/**
 * The author line of a book card: a plain caption, sitting in the label column
 * with the title and saga (one card, one box). It used to be tappable — a
 * navigation target for "the other books by this writer" — but that browse now
 * is the body of the «Book and author» modal (openBookMenu), the ONE affordance, so
 * the same gesture opens it wherever a card appears. The line is inert text
 * again: no role="link", no › chevron, no click that has to be kept from bubbling
 * to the card underneath. Every card with an author gets one (buildBookCard is
 * the one builder); a card with no author has no line at all.
 *
 * It shows the LEAD author only. Calibre's author field bundles co-authors with
 * `&` ("Neil Gaiman & Terry Pratchett & Susanna Clarke"), and a four-hand credit
 * on one line pushed the card's other lines around; the line names who wrote it
 * and the rest stays one hover/long-press away, on the line's `title`. See
 * firstAuthor for why `&`/`;`/`|` split and a comma does not.
 */
function authorLine(bk) {
  const a = document.createElement("span");
  a.className = "bib-author";
  const all = splitAuthors(bk.a);
  a.textContent = all[0] || bk.a;
  // Only when something was actually dropped: a tooltip repeating the visible
  // text is noise, and on a phone it is a long-press that reveals nothing.
  if (all.length > 1) a.title = all.join(" · ");
  return a;
}

/**
 * A catalog list row: tap opens the «Book and author» modal (▶️ Abrir loads it,
 * the actions + the author's shelf are right there); right-click / long-press
 * opens the SAME modal. Reused by the author-books list. See buildBookCard.
 */
function bookRow(bk, opts = {}) {
  const menu = {
    src: bk.p,
    onAfter: () => {
      if (catalog) renderCatalog();
    },
    ...(opts.menu || {}),
  };
  return buildBookCard(bk, {
    finished: isSrcFinished(bk.p),
    title: "Tocar para abrir y opciones",
    onClick: () => openBookMenu(bk, menu),
    ...opts,
    menu,
  });
}

/**
 * Add / remove the ✔ "terminado" cue on a book button: a trailing green check
 * plus a dimming class, so finished books read as tracked-and-done at a glance
 * (in the list, the ✔ filter, the author menu, and the active-book card).
 */
function markFinishedCue(btn, done) {
  btn.classList.toggle("st-done", !!done);
  const old = btn.querySelector(".bib-check");
  if (old) old.remove();
  if (!done) return;
  const c = document.createElement("span");
  c.className = "bib-check";
  c.textContent = "📖";
  c.title = "Leído";
  btn.appendChild(c);
}

/**
 * True for the ONE book the player currently holds (the active doc), matched by
 * catalog path. The green ring marks THAT book and nothing else — it used to key
 * off `isSrcInProgress`, which lit up every book on the "libros abiertos" shelf
 * and so said nothing about where you are. A local drop (no `src`) never matches.
 */
function isPlayingSrc(src) {
  if (!src || state.active < 0) return false;
  const d = state.docs[state.active];
  return !!d && d.src === src;
}

/**
 * Encode a book's state on its load button. Two independent layers, both drawn as
 * inset rings that eat INWARD from the card edge so nothing ever reflows (see the
 * .st-* rules in _modal.css):
 *  - OUTER ring + tint (rating): favorite-author background tint, plus a wide
 *    coloured band — yellow when loved (own ⭐) OR liked (👍), red when disliked.
 *    Ring states are exclusive (loved > disliked > liked); the author tint stacks.
 *  - INNER ring (flight state): the CURRENTLY-PLAYING book (green) OR "en cola"
 *    (queued, blue), exclusive — a book can't be both, and playing wins.
 *    Nested just inside the rating ring so both show at once (operator request).
 */
function applyStatusClasses(item, bk) {
  item.classList.remove(
    "st-favauth", "st-loved", "st-disliked", "st-liked", "st-reading", "st-queued",
  );
  // Cold: the blobs the rating layer reads are empty because they haven't
  // ARRIVED, not because the book is unrated — computing from them would paint
  // a deliberate lie. Use what the last warm paint stamped onto the doc; the
  // catalog pass that follows recomputes and corrects it (usually to the same
  // thing, in which case paintActiveBookCard skips the repaint entirely).
  for (const c of bk._cold ? bk._card?.st || [] : ratingClasses(bk)) {
    item.classList.add(c);
  }
  if (isPlayingSrc(bk.p)) item.classList.add("st-reading");
  else if (isQueued(bk.p)) item.classList.add("st-queued");
}

/** The biblioteca's ONE scrolling box (.modal-body — see css/_modal.css). Null
 *  under the test shim, which has no layout: every caller no-ops there. */
function bibBody() {
  return $("bibList").closest(".modal-body");
}

/**
 * Scroll the list box to `px` and REMEMBER it. The memo is what a reopen
 * restores: `.modal[hidden]` is display:none, which destroys the box's layout and
 * zeroes its scrollTop, so where the user was has to be held outside the DOM.
 */
function scrollListTo(px) {
  bibScroll = Math.max(0, px);
  const body = bibBody();
  if (body) body.scrollTop = bibScroll;
}

/** Scroll the modal body back to the top (e.g. after turning a page). */
function scrollListTop() {
  scrollListTo(0);
}

/* ===================== A–Z jump strip ===================== */
//
// The pager moves 300 books at a time, so walking 88k rows down to the Z's is
// ~175 taps. The strip under the count is the shortcut: every author-initial the
// FILTERED set actually holds, in sorted order, one tap each. It is built from
// the very array the list pages over, so a letter can never point at a book the
// filters exclude. Non-destructive: it only turns the pager.

/**
 * The letter a book files under: its author's first character, accent-folded
 * (Á→A, Ñ→N, Č→C — the fold Intl.Collator("es") already sorts by), or "#" for
 * the authorless / digit- / symbol-led ones. ASCII initials skip the fold: this
 * runs once per book on every render, and NFD-ing 88k strings on each keystroke
 * of the 🔍 box is not free.
 */
export function authorInitial(bk) {
  const c = String((bk && bk.a) || "")
    .trim()
    .charAt(0)
    .toUpperCase();
  if (c >= "A" && c <= "Z") return c;
  const f = c.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return /^[A-Z]$/.test(f) ? f : "#";
}

/**
 * Everything the strip needs, decided WITHOUT a DOM: whether it shows at all,
 * the initials present (each with the index of its FIRST book and the page that
 * lands on), and which initial the page you are looking at opens with.
 *
 * `matches` must be the author-SORTED filtered array (filteredBooks preserves
 * booksInOrder's order). First occurrence wins, so the strip is monotonic in
 * index by construction and a stray book whose folded initial reappears far
 * later (an "Ωmega" in the "#" bucket, which the collator sorts after Z) never
 * moves an anchor.
 */
export function letterStripFor(matches, { sort, page, pageSize }) {
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  // Only 🔤 alfabético orders books by author; under a date sort the initials are
  // scattered and a jump would be a lie. One page ⇒ nothing to jump to. Both
  // gates return BEFORE the O(n) scan below, which renderCatalog runs on every
  // 🔍 keystroke.
  if (sort !== "alpha" || pageCount <= 1) return { show: false, jumps: [], current: "" };
  const jumps = [];
  const seen = new Set();
  matches.forEach((bk, i) => {
    const letter = authorInitial(bk);
    if (seen.has(letter)) return;
    seen.add(letter);
    jumps.push({ letter, index: i, page: Math.floor(i / pageSize) });
  });
  return { show: true, jumps, current: authorInitial(matches[page * pageSize]) };
}

/** Turn to the page holding `j.index` and bring that book to the top of the list. */
function jumpToLetter(j) {
  bibPage = j.page;
  renderCatalog(); // repaints the list AND the strip (the current letter moves)
  const row = $("bibList").children[j.index - bibPage * RENDER_CAP];
  // scrollIntoView, not scrollListTop: a page spans several initials, so the
  // letter's first book is usually NOT the first row — landing on the page top
  // would read as a no-op.
  if (row && row.scrollIntoView) row.scrollIntoView({ block: "start" });
  else scrollListTop();
}

/** Paint the strip under the count. Rebuilt on every render, like the pager. */
function renderLetters(matches) {
  const host = $("bibLetters");
  if (!host) return;
  host.innerHTML = "";
  const strip = letterStripFor(matches, {
    sort: filters.sort,
    page: bibPage,
    pageSize: RENDER_CAP,
  });
  host.hidden = !strip.show;
  if (!strip.show) return;
  for (const j of strip.jumps) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bib-letter";
    b.textContent = j.letter;
    b.title =
      j.letter === "#"
        ? `Otros autores (página ${j.page + 1})`
        : `Autores con ${j.letter} (página ${j.page + 1})`;
    // The initial THIS page opens with. Marked, never disabled: tapping it goes
    // back to where that letter's run starts, which is a jump, not a no-op.
    b.setAttribute("aria-current", String(j.letter === strip.current));
    b.addEventListener("click", () => jumpToLetter(j));
    host.appendChild(b);
  }
}

/** Prev/next pager under the list; hidden when everything fits on one page. */
function renderPager(pageCount) {
  const host = $("bibPager");
  if (!host) return;
  host.innerHTML = "";
  if (pageCount <= 1) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const mk = (label, disabled, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bib-page-btn";
    b.textContent = label;
    b.disabled = disabled;
    if (!disabled) b.addEventListener("click", onClick);
    host.appendChild(b);
  };
  mk("‹ Anterior", bibPage <= 0, () => {
    bibPage--;
    renderCatalog();
    scrollListTop();
  });
  const lbl = document.createElement("span");
  lbl.className = "bib-page-lbl";
  lbl.textContent = `${bibPage + 1} / ${pageCount}`;
  host.appendChild(lbl);
  mk("Siguiente ›", bibPage >= pageCount - 1, () => {
    bibPage++;
    renderCatalog();
    scrollListTop();
  });
}

/* ===================== 🎲 spotlight pick ===================== */
//
// The modal 🎲 does NOT play straight away (that is the top-bar 🎲's job). It
// spotlights ONE random book from the CURRENT filters into a separate row above
// the list — drawn from the FULL filtered set, not just the RENDER_CAP slice, so
// the pick can be a book the capped list never shows. Re-roll by tapping 🎲
// again; tap the card to actually play it. Nothing is interrupted until then.

/** Empty and hide the spotlight row, and forget the book it held. */
function clearPick() {
  pickBook = null;
  const host = $("bibPick");
  host.hidden = true;
  host.innerHTML = "";
}

/** Spotlight a fresh random book from the current filters (no play). */
function spinPick() {
  if (!catalog) return;
  const matches = randomPool();
  if (!matches.length) {
    clearPick();
    setStatus("🎲 Ningún libro sin terminar con estos filtros.");
    return;
  }
  // Offline we can only spotlight what was buffered for these filters; online
  // we spotlight from the full set (a buffered pick still plays instantly).
  if (!navigator.onLine) {
    const buf = bufferedPicks(pinnedPaths());
    if (!buf.length) {
      clearPick();
      setStatus("🎲 Sin conexión: no hay libros precargados con estos filtros.");
      return;
    }
    renderPick(buf[Math.floor(Math.random() * buf.length)]);
    return;
  }
  renderPick(matches[Math.floor(Math.random() * matches.length)]);
}

/** Render the spotlight card: same card as the list, a 🎲 icon; a tap opens the
 *  «Book and author» modal (▶️ Abrir loads it), like every other card. 🎲 re-rolls. */
function renderPick(bk) {
  pickBook = bk; // part of the browse position — repainted on the next open
  const host = $("bibPick");
  host.hidden = false;
  host.innerHTML = "";
  const row = buildBookCard(bk, {
    icon: "🎲",
    finished: isSrcFinished(bk.p),
    title: "Tocar para abrir y opciones · 🎲 para otro",
    rowClass: "bib-pick-row",
    itemClass: "bib-pick-item",
    onClick: () => openBookMenu(bk, {
      src: bk.p,
      onAfter: () => {
        renderPick(bk);
        if (catalog) renderCatalog();
      },
    }),
    menu: {
      src: bk.p,
      onAfter: () => {
        renderPick(bk); // refresh the spotlight card's own cue…
        if (catalog) renderCatalog(); // …and the list below it
      },
    },
  });
  host.appendChild(row);
}

/* ---- the «Book and author» modal (▶️ · ⭐/👤/👍/👎/✅/🧹 · 📖/🗑/🔝/⬇️) ---- */
//
// ONE modal for every book card: the biblioteca list, the 🎲 spotlight, the author
// + saga lists, and all three en-curso shelves ("libros abiertos", ☁ remote, the
// cola). A plain TAP opens it, and right-click / long-press opens the same thing —
// one gesture, one destination, wherever a card appears. The single exception is
// the active #bookCard in the main view, whose tap opens 📖 «En curso» instead
// (its actions are still one right-click away).
//
// The modal is the author modal: its TOP is this action header (the green
// .book-and-author-head — the book's card, ▶️ Abrir, the two action rows, the ❓
// legend) and its BODY is every other book by the same author, grouped by category,
// with the saga last. So "more by this writer" is a scroll, not another tap — the
// old 💬 hop is gone. The per-card rating emojis stay off the cards themselves: a
// card's state is its border/background (applyStatusClasses).
//
// ▶️ Abrir OPENS the book — it SELECTS it and never starts audio. The player's
// ▶ Play remains the one thing that begins reading (see shouldPlayOnActivate).
//
// TWO rows, split by what the control touches:
//   row 1 — the book's MARKS: ⭐ favorite · 👤 author-favorite · 👍 like · 👎
//     dislike (each tinted its signature colour, so the border/background cues on
//     the card are easy to recall) · ✅ terminado · 🧹 clear progress.
//   row 2 — the book's PLACE: 🗑 remove from "en curso" · 🔝 queue on top ·
//     ⬇️ queue at the bottom.
// The rows are separate elements (not one wrapping row) so the split survives any
// screen width.
//
// Which controls show depends on the book's state: the queue pair needs a catalog
// path, ✅/🧹/🗑 need a progress entry (a loaded doc, or one in progress on another
// device — ✅ used to live in the author modal's head, where it could only ever
// close out the ACTIVE book).
//
// CONFIRMS are spent on what MOVES or ERASES a book, never on what merely marks
// it: 🗑, 🔜 on a book that is currently in "en curso", 🧹 — and ✅, in BOTH
// directions, because "terminado" reaches past the card: it pulls the book out of
// the 🎲 random pool (randomPool) and stops the offline buffer from holding a copy
// of a ☁ book (pinnedPaths), and un-marking erases a positive mark. ⭐/👤/👍/👎 ask
// NOTHING — one-bit toggles that the very same tap undoes, and the card's own
// ring/tint is the receipt. The marks-row policy lives in markConfirm; the
// confirms it asks for are short by design: a title that names the action, the
// book underneath, Sí/No.

// The book the unified «Book and author» modal is currently open on (or null).
// A card's tap AND its right-click both open THIS modal (openBookMenu →
// openAuthorBooks); re-right-clicking the same book toggles it shut. The menu no
// longer lives in a bespoke overlay — it is the top section of the author modal.
let openMenuBook = null;

/**
 * Kept for the surfaces that used to tear a lingering popover out before they
 * repaint under it (renderCatalog, the en-curso list). The menu is now the
 * authorModal, an independent layer that does not sit on top of a re-rendering
 * card, so a plain repaint no longer needs to touch it — this is a no-op unless
 * `runAfter` explicitly asks to close the modal.
 */
function dismissBookMenu(runAfter) {
  if (runAfter) closeBookMenu();
}

/** Close the «Book and author» modal (the unified menu). */
export function closeBookMenu() {
  openMenuBook = null;
  closeModal("authorModal");
}

/**
 * Wire an element's right-click / long-press to open the shared «Book and author»
 * modal — the SAME modal a plain tap opens now (openBookMenu → openAuthorBooks),
 * kept as an alias so the desktop right-click / touch long-press still work. `bk`
 * is the catalog book (or a minimal `{p,t,a}` synthesised from a doc); `ctx`
 * carries the situation — `{ kind, src, docKey, onAfter, onOpen }` — so the menu
 * resolves which of 🧹/🗑 apply, how «▶️ Abrir» opens it, and what to repaint.
 * Re-right-clicking the same book toggles the modal shut.
 */
export function attachBookMenu(anchor, bk, ctx = {}) {
  anchor.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (openMenuBook === bk && !$("authorModal").hidden) {
      closeBookMenu();
      return;
    }
    openBookMenu(bk, ctx);
  });
}

/**
 * The confirm policy for the menu's MARKS row, in ONE place so the budget is
 * legible and testable. ⭐/👤/👍/👎 return null — instantly reversible one-bit
 * toggles whose feedback is the card's ring/tint (applyStatusClasses); asking
 * twice for a thing you undo with one tap is the confirm spent backwards. ✅ asks
 * either way: marking drops the book out of the 🎲 pool (randomPool) and unpins
 * its buffered copy (pinnedPaths), un-marking erases a positive mark. 🧹/🗑/🔜
 * keep their confirms at their own call sites below — they move or erase, they
 * don't mark; a new MARK belongs in this table, not in a fresh confirmDialog.
 * Returns the confirm's title + danger tint, or null for "just do it".
 */
export function markConfirm(_action, _on) {
  // Nothing in the marks row asks anymore. Every mark here — ⭐👤👍👎 rating, ✅
  // recientemente, 📖 leído — is a one-bit TOGGLE, and the «Book and author» menu
  // now stays open across the edit (it repaints in place instead of closing), so
  // an unwanted tap is undone by tapping again right where you are. ✅ and 📖
  // used to ask because the menu closed and a stray tap silently reshuffled the
  // inbox / dropped the book from the 🎲 pool; with the menu staying put, the
  // repainted button IS the receipt and the undo is one tap. The genuinely
  // destructive verbs (🗑 wipes cross-device progress, bulk-queue moves many
  // books) keep their OWN confirms at their call sites — they are not marks.
  return null;
}

/**
 * Run one marks-row edit: ask only when markConfirm says to, then mutate and let
 * the opener repaint. The confirm copy is a LABEL, not a sentence — the title
 * names the action, the message is the book, the buttons are Sí/No.
 */
async function applyMark(bk, action, on, mutate, onEdit) {
  const c = markConfirm(action, on);
  if (
    c &&
    !(await confirmDialog({
      title: c.title,
      message: `«${bk.t}»`,
      okLabel: "Sí",
      cancelLabel: "No",
      danger: c.danger,
    }))
  )
    return;
  mutate();
  onEdit();
}

/**
 * Build the four rating controls (⭐ favorite · 👤 author-favorite · 👍 like ·
 * 👎 dislike) for `bk`, fully painted and wired. Each control applies its change
 * IMMEDIATELY — none of them confirms (see markConfirm) — and then calls
 * `onEdit()`, whose card repaint is the whole receipt. Shared with the en-curso
 * "libros abiertos" shelf, which opens this same menu, so a book can be rated
 * from either shelf. `opts.hideAuthor` drops 👤 (author unknown, e.g. a local
 * file). Returns the buttons in display order.
 */
export function makeRatingButtons(bk, onEdit, opts = {}) {
  const mk = (cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `bib-pop-btn ${cls}`;
    return b;
  };
  const star = mk("star");
  const auth = mk("auth");
  const like = mk("like");
  const dis = mk("dislike");

  const paintStar = () => {
    const on = pathDegree(bk) > 0;
    star.textContent = on ? "⭐" : "☆";
    star.setAttribute("aria-pressed", String(on));
    star.title = on ? "Favorito ⭐ · toca para quitar" : "Marcar favorito ⭐";
  };
  const paintAuth = () => {
    const on = authorDegree(bk) > 0;
    auth.textContent = "👤";
    auth.setAttribute("aria-pressed", String(on));
    auth.title = on ? `Autor favorito: ${bk.a || "—"}` : `Marcar autor favorito: ${bk.a || "—"}`;
  };
  const paintLike = () => {
    const on = bookReaction(bk) === "like";
    like.textContent = "👍";
    like.setAttribute("aria-pressed", String(on));
    like.title = on ? "Quitar 👍" : "Me gusta 👍";
  };
  const paintDislike = () => {
    const on = bookReaction(bk) === "dislike";
    dis.textContent = "👎";
    dis.setAttribute("aria-pressed", String(on));
    dis.title = on ? "Quitar 👎" : "No me gusta 👎";
  };

  // No confirm on any of the four: they are one-bit marks (markConfirm), and the
  // card's border/tint repaints under the closing menu. ⭐ is a plain toggle —
  // favorite ↔ not, no degrees (the operator dropped the "raise the star"
  // feature; tap again just unfavorites). ⭐ and 👍/👎 are mutually exclusive (see
  // setFavorite/setReaction), so a 👎 on a favorite drops the ⭐: one tap on ⭐
  // puts it back, which is why neither needs to ask.
  star.addEventListener("click", () => {
    const on = pathDegree(bk) > 0;
    return applyMark(bk, "star", on, () => setFavorite(bk, on ? 0 : 1), onEdit);
  });
  // 👤 toggles the whole author (affects ALL their books).
  auth.addEventListener("click", () => {
    const on = authorDegree(bk) > 0;
    return applyMark(bk, "auth", on, () => setAuthorFav(bk, !on), onEdit);
  });
  like.addEventListener("click", () => {
    const on = bookReaction(bk) === "like";
    return applyMark(bk, "like", on, () => setReaction(bk, on ? null : "like"), onEdit);
  });
  dis.addEventListener("click", () => {
    const on = bookReaction(bk) === "dislike";
    return applyMark(bk, "dislike", on, () => setReaction(bk, on ? null : "dislike"), onEdit);
  });

  paintStar();
  paintAuth();
  paintLike();
  paintDislike();

  const out = [star];
  if (!opts.hideAuthor) out.push(auth);
  out.push(like, dis);
  return out;
}

/**
 * Human-readable legend for each control, keyed by its `.bib-pop-btn` variant
 * class. The ❓ help view reads this to spell out what every emoji does — built
 * off the SAME class the buttons carry, so it can never drift from the buttons
 * actually shown. `[emoji, description]`.
 */
const MENU_HELP = {
  star: ["⭐", "Favorito."],
  auth: ["👤", "Autor favorito."],
  like: ["👍", "Me gusta."],
  dislike: ["👎", "No me gusta."],
  done: ["✅", "Leído recientemente — buzón de «En curso»."],
  clear: ["🧹", "Limpiar progreso."],
  open: ["▶️", "Abrir el libro (pulsa ▶ Play para leer)."],
  leido: ["📖", "Leído — biblioteca, para siempre."],
  shelf: ["🌙☀️", "Mover entre día/noche de «En curso» (estantería o cola)."],
  trash: ["🗑", "Quitar de en curso."],
  "queue-top": ["🔝", "A la cola, al principio (si ya está: lo mueve ahí)."],
  "queue-bot": ["⬇️", "A la cola, al final (si ya está: lo mueve ahí)."],
};

/* ---- «Book and author» modal: a breadcrumb trail ---------------------------
 * The modal re-renders IN PLACE as you tap a book inside it — a saga sibling, an
 * author's other work — so each tap is a breadcrumb, not a new modal. Back walks
 * to the PREVIOUS book (restoring where its list was scrolled) crumb by crumb,
 * until the root: there back — and ✕ / Esc / backdrop anywhere — closes the modal
 * and forgets the trail, revealing whatever modal spawned it (the biblioteca or
 * «En curso» list underneath).
 *
 * The ROOT crumb rides modal.js's own back layer (openModal → closeModal). Every
 * DEEPER crumb pushes its own layer on the shared guard (pushBackLayer), whose
 * dismiss pops back one crumb. onModalClose releases any deeper layers still
 * stacked when the modal is dismissed by a non-back route, so the guard never
 * keeps a stale crumb after the modal is gone.
 */
let authorNav = []; // [{ bk, ctx, scroll, q, layer }] — root first, current last.

/**
 * What the reader typed into the author page's 🔍 box, RAW (the input's own value,
 * so restoring it shows what they typed, accents and all; `normName` folds it at
 * every use). It belongs to the CRUMB, not to a paint: openAuthorBooks re-runs
 * whole on every in-place edit (a ⭐, a ✅, a 🔜 bulk add), and a filter that
 * cleared itself on each of those would be unusable on the one page that needs it.
 * Walking to another book resets it — a query about one shelf means nothing on the
 * next — and walking BACK restores that crumb's own, like its scroll position.
 */
let authorFilterRaw = "";

/** Where this modal was opened FROM, so the chip at the root crumb can name the
 *  screen it goes back to instead of dead-ending. Set on every fresh open. */
let authorOrigin = "Inicio";

/** The screens a book can be tapped from, outermost last. The «Book and author»
 *  modal opens OVER whichever of these is up, so the one still open when a fresh
 *  trail starts is the screen closing the modal returns the reader to. */
const AUTHOR_ORIGINS = [
  ["progressModal", "En curso"],
  ["bibModal", "Biblioteca"],
  ["wishModal", "Lista de deseos"],
];

/** Name the screen underneath, or «Inicio» when the modal was opened straight
 *  from the main player screen (a book card there, or a right-click). */
function detectAuthorOrigin() {
  for (const [id, label] of AUTHOR_ORIGINS) {
    const m = $(id);
    if (m && m.hidden === false) return label;
  }
  return "Inicio";
}

/** The «Book and author» modal's ONE scrolling box, or null under the test shim
 *  (no layout there, so every scroll read/write no-ops). */
function authorBody() {
  const list = $("authorList");
  return (list && list.closest && list.closest(".modal-body")) || null;
}
function authorScrollTop() {
  const b = authorBody();
  return b ? b.scrollTop : 0;
}
function setAuthorScrollTop(px) {
  const b = authorBody();
  if (b) b.scrollTop = Math.max(0, px);
}

/**
 * Back from a deeper crumb: drop the current book, re-render the one beneath it
 * and put its list back where it was. The guard has ALREADY popped this crumb's
 * own layer before calling us, so we only drop our record of the crumb.
 */
function popAuthorCrumb() {
  if (authorNav.length <= 1) {
    // The root has no deeper layer, so back at the root never reaches here — but
    // if it somehow does, close rather than strand a half-open modal.
    closeBookMenu();
    return;
  }
  authorNav.pop(); // its layer is already gone from the guard.
  const crumb = authorNav[authorNav.length - 1];
  openMenuBook = crumb.bk;
  authorFilterRaw = crumb.q || ""; // this crumb's own 🔍 query, like its scroll
  syncAuthorBack();
  openAuthorBooks(crumb.bk, crumb.ctx).then(() => setAuthorScrollTop(crumb.scroll));
}

/**
 * The «← destino» chip floating at the bottom of the modal: the trail's own back
 * control, up for as long as the modal is. Deep in the trail it names the book
 * beneath; at the ROOT it names the screen the modal was opened from («En
 * curso», «Biblioteca», «Inicio») and closing it lands the reader back there —
 * so one control walks the whole way out, never dead-ending on the last crumb.
 *
 * It exists because the browser's back button cannot be trusted here. The back
 * guard keeps the app in place with sentinel history entries, and now re-pins
 * them from a real gesture so Chrome's history-manipulation intervention no
 * longer skips them — but a gesture-pinned cushion is still a cushion, not a
 * breadcrumb: back at best gets the reader OUT of a layer, it cannot be the
 * visible, labelled route through the trail. This chip is that route.
 */
function syncAuthorBack() {
  const btn = $("authorBack");
  if (!btn) return; // test shim / a page without the chip
  const open = authorNav.length > 0;
  const prev = authorNav.length > 1 ? authorNav[authorNav.length - 2] : null;
  const label = prev ? (prev.bk && prev.bk.t) || "Atrás" : authorOrigin;
  btn.hidden = !open;
  if (open) {
    btn.textContent = `← ${label}`;
    btn.title = `Volver a ${label}`;
  }
  const panel = btn.closest && btn.closest(".modal-panel");
  if (panel && panel.classList) panel.classList.toggle("with-back", open);
}

/**
 * Step back one crumb from the chip — or, at the root, out of the modal
 * entirely, revealing the screen it was opened over.
 *
 * The guard has NOT popped anything here (no popstate fired), so this crumb's
 * own guard layer has to be released by hand before popAuthorCrumb drops the
 * record — otherwise a later back gesture would spend that stale layer doing
 * nothing visible. At the root there is no such layer to release: the root rides
 * modal.js's own, which closeBookMenu releases.
 */
function stepBackAuthorCrumb() {
  if (!authorNav.length) return;
  if (authorNav.length === 1) {
    closeBookMenu();
    return;
  }
  const top = authorNav[authorNav.length - 1];
  if (top.layer) top.layer.release();
  popAuthorCrumb();
}

/**
 * The modal closed by a route other than walking back to the root (✕, Esc,
 * backdrop, or opening a book to read). Release every deeper crumb's layer so
 * the guard keeps none, and forget the trail. Idempotent — a plain root-only
 * close finds nothing to release.
 */
function clearAuthorNav() {
  for (const crumb of authorNav) if (crumb.layer) crumb.layer.release();
  authorNav = [];
  openMenuBook = null;
  authorFilterRaw = "";
  syncAuthorBack();
}
onModalClose("authorModal", clearAuthorNav);

/**
 * Open the unified «Book and author» modal for `bk`. This is the ONE modal a
 * book card opens now — on a plain tap AND on right-click / long-press (see
 * attachBookMenu) — replacing the old bespoke action popover. Its top is the
 * green action header (buildActionHeader: ▶️ open · ⭐👤👍👎✅🧹📖🗑🔜 · ❓ legend);
 * below it the same modal browses every other book by the author (openAuthorBooks).
 * `ctx` carries the situation — `{ kind, src, docKey, onAfter, onOpen }`.
 *
 * A tap on a card that is ALREADY inside this modal descends: it remembers where
 * the current list was scrolled, pushes a breadcrumb (see popAuthorCrumb), and
 * lands the new book at the top. A tap from anywhere else opens fresh, seeding a
 * new trail rooted on `bk`.
 */
export function openBookMenu(bk, ctx = {}) {
  const modal = $("authorModal");
  const deeper = !!modal && !modal.hidden && authorNav.length > 0;
  if (deeper) {
    authorNav[authorNav.length - 1].scroll = authorScrollTop();
    authorNav[authorNav.length - 1].q = authorFilterRaw;
    const layer = pushBackLayer(popAuthorCrumb);
    authorNav.push({ bk, ctx, scroll: 0, q: "", layer });
  } else {
    // Fresh open: the root crumb rides modal.js's own close layer (layer null),
    // and remembers which screen it was opened over so the chip can name it.
    authorNav = [{ bk, ctx, scroll: 0, q: "", layer: null }];
    authorOrigin = detectAuthorOrigin();
  }
  // A different book is a different shelf: the 🔍 query from the one we came from
  // must not silently narrow this one (back restores it — see popAuthorCrumb).
  authorFilterRaw = "";
  openMenuBook = bk;
  syncAuthorBack();
  // We navigated TO this book, so its list starts at the top (scroll 0). A back
  // to an earlier crumb restores its remembered scroll in popAuthorCrumb.
  openAuthorBooks(bk, ctx).then(() => setAuthorScrollTop(0));
}

/**
 * Resolve, from a book + its menu ctx, what the action buttons act on:
 *   src         the catalog path (ratings/queue key), or null for a local drop.
 *   isCatalog   has a catalog identity (rating/queue/status apply).
 *   doc         the loaded doc this book maps to (by explicit docKey, else src).
 *   progKey     the progress key (✅/🧹/📖 target), doc or cross-device entry.
 *   hasProgress a loaded doc OR a synced progress entry exists.
 * Same resolution the old popover did — pulled out so buildActionHeader can be
 * re-run in place after every edit without re-deriving it by hand.
 */
function resolveMenuCtx(bk, ctx) {
  const src = ctx.src || bk.p || null;
  const isCatalog = !!src && !bk._local;
  const doc = ctx.docKey
    ? state.docs.find((d) => d.docKey === ctx.docKey) || null
    : (src ? state.docs.find((d) => d.src === src) : null) || null;
  const progKey = ctx.docKey || (doc && doc.docKey) || progressKeyForSrc(src);
  const hasProgress = !!doc || (!!progKey && !!syncedProgressFor(progKey));
  return { src, isCatalog, doc, progKey, hasProgress };
}

/**
 * True when the book actually sits somewhere past the start, so 🧹 "limpiar
 * progreso" has something to rewind. A book at 0% (never read past the first
 * paragraph, or already cleared once) would get a button that spends a confirm to
 * do nothing — so the menu drops it instead. Reads the loaded doc when there is
 * one, else the cross-device progress entry; both carry the paragraph (`curChunk`
 * / `pos`) and the WORD within it (`chunkOffset` / `off`).
 */
/**
 * True when the book actually sits on the «En curso» "libros abiertos" shelf, so
 * 🗑 "quitar de en curso" has something to remove. Mirrors the shelf's own
 * membership rule (encurso.js#paintOpenBooks): a live progress entry that is not
 * tombstoned and not in the cola.
 *
 * The two exclusions are the whole point of the gate:
 *  - `isDropped` — already trashed (here or on another device); the row is gone,
 *    so the button would delete nothing.
 *  - `isQueued` — a queued book lives in the cola, NOT on abiertos, and the cola's
 *    multiselección 🗑 (encurso.js → removeQueueSelection) is the one way out of
 *    it. Offering this 🗑 too would be a second, different removal on the same
 *    book: this one drops the reading progress everywhere, that one just unqueues.
 * A book carrying only a 📖 leído bit and no shelf presence falls out the same way.
 */
function isOnOpenShelf(src, progKey) {
  if (!progKey || isDropped(progKey)) return false;
  return !(src && isQueued(src));
}

/** A book's current en-curso estantería: the LOADED doc's `mode` when it's held
 *  here, else the synced progress entry's. Missing ⇒ night (mode.js contract). */
function bookShelf(doc, progKey) {
  if (doc) return normMode(doc.mode);
  const sync = progKey && syncedProgressFor(progKey);
  return normMode(sync && sync.mode);
}

/**
 * Move a book to the OTHER día/noche estantería. Restamps BOTH sides so the move
 * is durable and cross-device: the loaded doc's `.mode` (persisted via storeDoc,
 * so the local row lands on the new shelf now AND after a reload) and the synced
 * progress entry (setDocMode, which carries it to every other device / a ☁ row).
 */
export async function setBookShelf(doc, progKey, mode) {
  const m = normMode(mode);
  if (doc) {
    doc.mode = m;
    try {
      await storeDoc(doc);
    } catch (_) {}
  }
  if (progKey) setDocMode(progKey, m);
}

function hasPlaceToClear(doc, progKey) {
  if (doc) return (doc.curChunk || 0) > 0 || (doc.chunkOffset || 0) > 0;
  const sync = progKey && syncedProgressFor(progKey);
  return !!sync && ((sync.pos || 0) > 0 || (sync.off || 0) > 0);
}

/**
 * Mount the green «Book and author» action header into `host` (the top of the
 * author modal's body) and keep it repaintable in place: every edit rebuilds
 * just this section (rings/queue-state refresh) without re-fetching the catalog
 * or losing the reader's scroll in the author list below.
 */
function mountActionHeader(host, bk, ctx) {
  const slot = document.createElement("div");
  slot.className = "book-and-author-head";
  host.appendChild(slot);
  const paint = () => {
    slot.innerHTML = "";
    buildActionHeader(slot, bk, ctx, paint);
  };
  paint();
}

/**
 * Fill `slot` with the action header for `bk`: the book card, the ▶️ Abrir button
 * (opens the book — SELECT only, never auto-plays; the player's ▶ Play is still
 * the one thing that starts audio), the two action rows, and the ❓ legend fold.
 * `rerender` rebuilds this same slot after an edit. Which controls show depends
 * on the book's state, exactly as the old popover decided:
 *  - ⭐/👤/👍/👎 rating — a catalog identity (👤 dropped when the author is unknown).
 *  - ✅ recientemente / 🧹 clear / 📖 leído / 🗑 remove — a loaded doc OR a synced
 *    progress entry.
 *  - 🌙⇄☀️ shelf move — a book on «En curso», either on the abiertos estantería
 *    or in the cola (día↔noche).
 *  - 🔝 / ⬇️ queue — any catalog book.
 * Row 1 takes the TOGGLES — the on/off marks (⭐👤👍👎 · ✅ · 📖). Row 2 takes the
 * ACTIONS — one-shot verbs that DO something / move the book (▶️🧹🗑🌙☀️🔝⬇️).
 * (🌙☀️ counts as an action: it moves the book to the other shelf.)
 */
function buildActionHeader(slot, bk, ctx, rerender) {
  // A cold/local stand-in (docToBook before the catalog was in hand — e.g. the
  // active-book card painted on a cold boot, whose right-click menu stays bound to
  // that frozen book) hides the rating toggles, because isCatalog gates on
  // !bk._local. If the catalog can resolve this book's path NOW, upgrade to the
  // real entry so ⭐👤👍👎 (and the queue controls) come back. Re-run on every
  // repaint, so a catalog that lands while the modal is open heals it too.
  const stubPath = ctx.src || bk.p;
  if (bk._local && catalog && stubPath) {
    const real = bookByPath(stubPath);
    if (real) bk = real;
  }
  const { src, isCatalog, doc, progKey, hasProgress } = resolveMenuCtx(bk, ctx);

  // Re-render this header in place AND repaint the surface underneath (the
  // biblioteca list / en-curso shelf behind the modal), so a rating/queue edit
  // is reflected both here and there. The modal stays open — you are browsing.
  const repaint = () => {
    rerender();
    if (ctx.onAfter) ctx.onAfter();
  };

  // ---- top: the book card, alone ----------------------------------------
  const top = document.createElement("div");
  top.className = "baah-top";
  // A display-only card (no onClick, no menu — this IS the menu): its ring/tint
  // and ✔ cue give the book's state at a glance. Every control lives in the two
  // rows below it, so the card is just the "which book am I looking at" line.
  const card = buildBookCard(bk, {
    finished: !!src && isSrcFinished(src),
    title: bk.t || "Libro",
  });
  top.append(card);
  slot.appendChild(top);

  // ---- row 1: toggles (⭐👤👍👎 · ✅ · 📖) --------------------------------
  const pop = document.createElement("div");
  pop.className = "bib-pop enc-pop";
  const pop2 = document.createElement("div");
  pop2.className = "bib-pop enc-pop";

  // ▶️ Abrir leads row 2 — the placement row, since opening IS where the book
  // goes. Open = SELECT the book (never auto-play — the player's ▶ Play does
  // that). The per-surface opener knows how (download a remote en-curso book,
  // promote a queued one, reposition a finished one). With no opener: if the book
  // is already a loaded doc, just re-select it — loadBook would re-download and
  // DUPLICATE it — otherwise load the catalog book fresh.
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "bib-pop-btn open";
  openBtn.textContent = "▶️";
  openBtn.title = "Abrir el libro (pulsa ▶ Play para leer)";
  openBtn.addEventListener("click", () => {
    if (ctx.onOpen) ctx.onOpen();
    else if (doc) activateDoc(state.docs.indexOf(doc), false, true);
    else loadBook(bk, false, true);
    closeBookMenu();
  });
  pop2.appendChild(openBtn);

  if (isCatalog) {
    makeRatingButtons(bk, repaint, { hideAuthor: !bk.a }).forEach((b) => pop.appendChild(b));
  }

  // ✅ mark / unmark "Leído recientemente" — the «En curso» inbox bit only.
  if (hasProgress && progKey) {
    const recentBtn = document.createElement("button");
    recentBtn.type = "button";
    recentBtn.className = "bib-pop-btn done";
    const on = isDocRecent(progKey);
    recentBtn.textContent = "✅";
    recentBtn.classList.toggle("is-done", on);
    recentBtn.setAttribute("aria-pressed", String(on));
    recentBtn.title = on
      ? "Leído recientemente ✅ · toca para quitar de recientes"
      : "Marcar leído recientemente ✅";
    recentBtn.addEventListener("click", () =>
      applyMark(
        bk,
        "recent",
        on,
        () => (on ? unmarkDocRecent(progKey) : markDocRecent(progKey)),
        repaint,
      ),
    );
    pop.appendChild(recentBtn);
  }

  // 🧹 clear progress → rewind to 0%, keep the book on the shelf.
  // …and only when there is somewhere to rewind FROM: a book already sitting at
  // 0% has nothing to clear, so 🧹 would be a no-op button asking for a confirm.
  if (hasProgress && hasPlaceToClear(doc, progKey)) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "bib-pop-btn clear";
    clear.textContent = "🧹";
    clear.title = "Limpiar progreso (rebobina a 0%)";
    // No confirm: the menu stays open, so a mistaken rewind is visible at once
    // and re-reading from where you were is the same as any other resume.
    clear.addEventListener("click", async () => {
      if (doc) {
        resetDocProgress(doc);
        if (state.docs.indexOf(doc) === state.active) {
          state.curChunk = doc.curChunk;
          state.chunkOffset = 0;
          updateProgress();
        }
      } else if (progKey) {
        resetProgressByKey(progKey);
      }
      repaint();
    });
    pop2.appendChild(clear); // 🧹 is an ACTION (rewind), not a mark → row 2
  }

  // ---- row 2: actions (🧹 limpiar · 🗑 quitar · 🌙☀️ estante · 🔝/⬇️ cola) ----------
  // 💬 "otros libros del autor" is GONE from here — the author's whole shelf is
  // rendered right below this header in the same modal now, so the browse is one
  // scroll away instead of one more tap.

  if (hasProgress && progKey) {
    const leido = document.createElement("button");
    leido.type = "button";
    leido.className = "bib-pop-btn leido";
    // Cue on entryFinished (done OR a genuine 100%), same truth as the card ring
    // and the biblioteca 📖 filter — so a book read to the end never shows grey 📖.
    const on = isDocReadish(progKey);
    leido.textContent = "📖";
    leido.classList.toggle("is-done", on);
    leido.setAttribute("aria-pressed", String(on));
    leido.title = on ? "Leído 📖 · toca para desmarcar" : "Marcar leído 📖";
    leido.addEventListener("click", () =>
      applyMark(
        bk,
        "leido",
        on,
        () => (on ? unmarkDocFinished(progKey) : markDocFinished(progKey)),
        repaint,
      ),
    );
    pop.appendChild(leido); // 📖 is a TOGGLE (leído on/off) → row 1
  }

  // 🗑 only for a book actually ON the abiertos shelf — this is the ONE way off it
  // (the rows there carry no 🗑 of their own). A queued book is excluded: the cola
  // row's 🗑 unqueues it, and that is the only removal the cola wants.
  if (hasProgress && isOnOpenShelf(src, progKey)) {
    const trash = document.createElement("button");
    trash.type = "button";
    trash.className = "bib-pop-btn trash";
    trash.textContent = "🗑";
    trash.title = doc
      ? "Quitar de en curso (de este dispositivo y de todos)"
      : "Quitar de en curso (en todos los dispositivos)";
    trash.addEventListener("click", async () => {
      if (doc) {
        const i = state.docs.indexOf(doc);
        if (i >= 0) await removeDoc(i); // confirms internally
      } else if (progKey) {
        if (
          !(await confirmDialog({
            title: "Quitar de en curso",
            message: `«${bk.t}»`,
            okLabel: "Sí",
            cancelLabel: "No",
            danger: true,
          }))
        )
          return;
        dropProgress(progKey);
      }
      // The book left the shelf — its header is stale (🗑/🌙☀️ no longer apply).
      // Don't close the menu out from under the reader: repaint the header in
      // place (resolveMenuCtx re-derives with the doc/progress now gone, so the
      // stale controls simply drop) and let the surface underneath repaint too.
      repaint();
    });
    pop2.appendChild(trash);
  }

  // 🌙⇄☀️ — move the book to the OTHER día/noche shelf. For a book that is ON one
  // of them, in EITHER of the two lists a shelf owns:
  //  - «libros abiertos» — a live progress entry, not queued/tombstoned (the same
  //    gate 🗑 uses); the move restamps the doc + the synced entry.
  //  - «en cola» — the queue entry carries its own `mode`, so a queued book moves
  //    between the two colas without touching its reading progress. Without this
  //    the only way to re-shelve a queued book was to unqueue it, toggle, requeue.
  // The two are exclusive by construction (isOnOpenShelf excludes queued paths).
  // The glyph is the shelf it moves the book TO (a night book offers ☀️; a day
  // book 🌙), so it reads as an action, not a status. The book leaves the current
  // view, but the menu stays open — repaint the header (the button now flips to
  // offer the return move) and the surface underneath, like 🗑.
  const queued = !!src && isQueued(src);
  if (queued || (hasProgress && isOnOpenShelf(src, progKey))) {
    const cur = queued ? queueModeOf(src) : bookShelf(doc, progKey);
    const target = cur === "day" ? "night" : "day";
    const shelfBtn = document.createElement("button");
    shelfBtn.type = "button";
    shelfBtn.className = "bib-pop-btn shelf";
    shelfBtn.textContent = target === "day" ? "☀️" : "🌙";
    shelfBtn.title = queued
      ? target === "day"
        ? "Mover a la cola de día ☀️"
        : "Mover a la cola de noche 🌙"
      : target === "day"
        ? "Mover a la estantería de día ☀️"
        : "Mover a la estantería de noche 🌙";
    shelfBtn.addEventListener("click", async () => {
      if (queued) await setQueueMode(src, target);
      else await setBookShelf(doc, progKey, target);
      repaint(); // header (flipped move) + the surface underneath; never close
    });
    pop2.appendChild(shelfBtn);
  }

  // 🔝 / ⬇️ — put this book first or last in the cola, from ANY card.
  //
  // The pair says WHERE the book goes; whether it is already queued only decides
  // whether that is an add or a re-seat (queueBook → moveQueueEnd), never whether
  // the control works. It used to be LOCKED for a queued book opened from
  // anywhere but its own cola row, and a tap only explained that moving lived on
  // that row — which sent a reader who could see both the book and the two
  // buttons off to «📖 En curso» to long-press for a move these same buttons
  // already knew how to do. There is no duplicate to fear: the re-seat path is
  // what a queued path takes.
  if (isCatalog) {
    const on = isQueued(src);
    const where = (top2) => (top2 ? "al principio" : "al final");
    const mkQueue = (glyph, cls, top2) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `bib-pop-btn ${cls}`;
      b.textContent = glyph;
      b.classList.toggle("is-queued", on);
      b.setAttribute("aria-pressed", String(on));
      b.title = on
        ? `Mover ${where(top2)} de la cola`
        : `A la cola, ${where(top2)}`;
      // No confirm on queueing a single book, even one in progress: the menu
      // stays open, the button repaints to "ya en la cola", and unqueueing is one
      // gesture on its cola row. (Bulk-queueing a whole section keeps its confirm
      // — that is the write whose SIZE is the risk, not a single tap.)
      b.addEventListener("click", async () => {
        const verdict = await queueBook(bk, top2);
        repaint();
        // A re-seat that never reached the store leaves the cola exactly as it
        // was, which reads as "the app ignored my tap". This surface IS a modal
        // and #toast sits under the card it covers, so — like the bulk add's
        // receipt — the only place it can report is a dialog.
        if (verdict !== "ok")
          confirmDialog({
            title: "No se pudo mover en la cola",
            message:
              verdict === "gone"
                ? `«${bk.t}» ya no está en la cola.`
                : `Sin conexión con el servidor: «${bk.t}» sigue donde estaba. Inténtalo de nuevo.`,
            okLabel: "Entendido",
            cancelLabel: "Cerrar",
          });
      });
      return b;
    };
    pop2.append(mkQueue("🔝", "queue-top", true), mkQueue("⬇️", "queue-bot", false));
  }

  // ---- ❓ legend fold ----------------------------------------------------
  // ❓ rides the END of row 2, after the placement controls: it is the row's last
  // stop, not a control of its own with a line to itself.
  const helpBtn = document.createElement("button");
  helpBtn.type = "button";
  helpBtn.className = "book-menu-help-btn";
  helpBtn.textContent = "❓";
  helpBtn.title = "¿Qué hace cada botón?";
  helpBtn.setAttribute("aria-pressed", "false");
  pop2.appendChild(helpBtn);

  // An empty row would still draw its gap — only append the ones that got buttons.
  if (pop.children.length) slot.appendChild(pop);
  if (pop2.children.length) slot.appendChild(pop2);

  const legend = document.createElement("div");
  legend.className = "book-menu-legend";
  legend.hidden = true;
  // Built from the buttons actually shown, keyed by their `.bib-pop-btn` variant
  // class, so the key can never drift from the controls. ❓ itself carries no
  // variant class, so it never lists itself.
  [...pop.children, ...pop2.children].forEach((btn) => {
    const variants = String(btn.className || "").split(/\s+/);
    const key = Object.keys(MENU_HELP).find((k) => variants.includes(k));
    if (!key) return;
    const [emoji, desc] = MENU_HELP[key];
    const row = document.createElement("div");
    row.className = "book-menu-legend-row";
    const em = document.createElement("span");
    em.className = "book-menu-legend-emoji";
    em.textContent = emoji;
    const tx = document.createElement("span");
    tx.className = "book-menu-legend-desc";
    tx.textContent = desc;
    row.append(em, tx);
    legend.appendChild(row);
  });
  slot.appendChild(legend);

  helpBtn.addEventListener("click", () => {
    const showHelp = legend.hidden;
    legend.hidden = !showHelp;
    helpBtn.setAttribute("aria-pressed", String(showHelp));
  });
}

/* ===================== active-book card + author browser ===================== */
//
// The source card no longer shows the raw "En pausa…"/"Documento activo…" status
// lines. While a book is loaded it shows a biblioteca-style card for that book —
// same look, same right-click rating popover — and tapping it opens every other
// book by the same author (grouped by category). library.js drives this via the
// `audiobooks:activated` / `audiobooks:cleared` events (no import cycle).

/**
 * Map an open doc to a catalog book. Prefers the real catalog entry (via the
 * doc's stored `src` path) so it carries author/category/rating. If the catalog
 * can't resolve it (rebuilt, momentarily down, or a local drop) it falls back to
 * a minimal book — but keeps the AUTHOR stashed on the doc at load time, so the
 * author page still works and the card still shows the writer. `_local` still
 * gates rating/queue/status (which need a live catalog identity); only a
 * genuinely author-less file (a user-dropped upload) ends up with a: "" → the
 * "Este libro no tiene autor" note. It still offers 🧹 clear / 🗑 remove via the
 * shared menu since it's a loaded doc.
 */
function docToBook(doc) {
  if (catalog) {
    // By `src`, then by filename — see bookForRow: a doc whose stored path no
    // longer resolves still gets its real title, author, saga and year.
    const bk = bookForRow(doc.src, doc.name);
    if (bk) return bk;
  }
  return {
    p: doc.src || null,
    // `t` is the catalog title stashed on the doc (see stampCatalogMeta); the
    // truncated filename is the last resort — a user-dropped file, or a catalog
    // book stored before we stamped titles and not yet healed.
    t: doc.t || shortName(doc.name || "Libro"),
    a: doc.a || "",
    _local: true,
    // COLD, not local: the doc HAS a catalog path, the catalog just isn't
    // loaded yet. `_local` still gates everything that needs a live catalog
    // identity (rating, queue, the author page), and this flag only unlocks the
    // part that needs no lookup at all — the appearance we stamped onto the doc
    // last time the catalog WAS in hand (see stampCatalogMeta / doc.card). That
    // is what lets a cold boot paint the finished card instead of an
    // undecorated one that visibly gains its ring and tint a few seconds later.
    _cold: !!doc.src,
    _card: doc.card || null,
  };
}

/**
 * The card's rating layer, as class names, from the live blobs.
 *
 * Split out of applyStatusClasses so the same rule both PAINTS a warm card and
 * is STAMPED onto the doc for the next cold boot — two copies of this ordering
 * would drift, and the drift would be a book that changes colour on reload.
 * Only the rating layer: the flight state (playing / queued) is answered from
 * local knowledge on every boot and must never be remembered.
 */
function ratingClasses(bk) {
  const out = [];
  if (authorDegree(bk) > 0) out.push("st-favauth");
  if (pathDegree(bk) > 0) out.push("st-loved");
  else if (bookReaction(bk) === "dislike") out.push("st-disliked");
  else if (bookReaction(bk) === "like") out.push("st-liked");
  return out;
}

/**
 * Copy the catalog's title + author onto the doc (and persist them) the first
 * time the catalog resolves this book. That's what makes the NEXT cold boot
 * paint the real card immediately: `docToBook` reads them straight off the doc,
 * with no catalog and no network. A no-op once stamped, so the IndexedDB write
 * happens at most once per book — and never for a local drop, which has no
 * catalog identity to copy.
 */
function stampCatalogMeta(doc, bk) {
  if (!doc || !bk || bk._local) return;
  const card = reactionsReady ? cardFacts(bk) : null;
  const same =
    doc.t === bk.t &&
    doc.a === bk.a &&
    (!card || JSON.stringify(doc.card) === JSON.stringify(card));
  if (same) return;
  doc.t = bk.t;
  if (bk.a) doc.a = bk.a;
  // Only overwrite the remembered appearance when we actually KNOW it: a boot
  // that reached the catalog but not the favorites blobs must keep the previous
  // stamp rather than replace it with "no rating".
  if (card) doc.card = card;
  // Fire-and-forget, and DEAF: the card is already painted, so a wedged upgrade
  // or a blocked IndexedDB costs us the next boot's head start and nothing else.
  // Unhandled, its rejection would surface inside whatever paint called us.
  try {
    storeDoc(doc)?.catch?.(() => {});
  } catch (_) {}
}

/**
 * Everything the active-book card shows that a cold boot cannot derive: the
 * rating classes, the saga line, the year, and the primigenia flag (`v`, which no
 * longer marks the card but still titles the «Book and author» modal it opens).
 * All of it comes from the catalog + the favorites blobs, i.e. from ~14 MB and
 * four json-store round-trips — so it is stamped onto the doc and read back
 * from IndexedDB next time, exactly as the title and author already are.
 */
function cardFacts(bk) {
  return {
    st: ratingClasses(bk),
    sg: sagaName(bk) || "",
    n: typeof bk.n === "number" ? bk.n : null,
    y: typeof bk.y === "number" ? bk.y : null,
    v: bk.v || null,
  };
}

/**
 * Render the active-book card into #bookCard; hide the raw status lines.
 *
 * Paints TWICE on a cold boot, deliberately. It used to await the catalog +
 * favorites round-trips before drawing anything, so a reload sat on the raw "N
 * documento(s) cargados desde el dispositivo" status line for as long as the
 * network took — the book you were actually reading appeared LAST, behind data
 * it does not need in order to be legible. Now it draws immediately from what
 * the doc itself carries (title + author, both stamped on at load time and read
 * back from IndexedDB), and redraws once the catalog resolves the full entry
 * (rating cue, saga line, year). With the catalog already in hand —
 * every activation after boot — the first paint IS the final card and there is
 * no second one, so switching books never flickers.
 *
 * It no longer FETCHES that upgrade itself. Firing `ensureCatalog` from here put
 * the ~14 MB catalog on the wire the instant the book activated — ahead of
 * `initBiblioteca`'s own probe, and alongside the voice model and the offline
 * buffer's EPUB downloads, all competing for one phone's bandwidth to decorate a
 * card that is already on screen and already legible. `initBiblioteca` loads the
 * catalog anyway, in its own turn; `refreshActiveBookCard` repaints when it
 * lands. Nothing visible waits for it, so nothing races for it.
 */
function renderActiveBookCard(doc) {
  const host = $("bookCard");
  if (!host || !doc) return;
  paintActiveBookCard(host, doc);
}

/**
 * The catalog (and the favorites blobs behind the rating cue) just landed —
 * upgrade the card that boot painted from the doc's own stamp. A no-op when
 * nothing is open, and `paintActiveBookCard` skips the DOM swap when the cold
 * paint was already byte-identical, which after a stamped boot it usually is.
 */
export function refreshActiveBookCard() {
  if (state.active < 0) return;
  renderActiveBookCard(state.docs[state.active]);
}

/** One paint of the active-book card from whatever data is in hand right now.
 *  Uses the shared buildBookCard so it looks/behaves like every other card — the
 *  ONE difference is its left-click opens the author's works instead of selecting. */
function paintActiveBookCard(host, doc) {
  const bk = docToBook(doc);
  stampCatalogMeta(doc, bk); // so the next boot needs no catalog to paint this

  // NO trailing chip. This card used to carry a «📚 N» author-count chip — the one
  // decoration that existed on THIS surface and nowhere else, which is exactly why
  // it went (operator directive, 2026-07-25: every book card looks the same). The
  // author's other books are still one tap away, in the «Book and author» modal.
  const row = buildBookCard(bk, {
    icon: "📖",
    finished: isDocFinished(doc.docKey),
    rowClass: "book-card-row",
    itemClass: "book-card-item",
    title: "Toca para «En curso» · clic derecho para opciones",
    // The ONE card whose left-click doesn't open the «Book and author» modal (it's
    // already the active book): it opens the 📖 "En curso" modal (progress + queue),
    // where this book heads the "Libro en progreso" section. Its own actions are
    // still one right-click away, so THIS tap is free to be the shelf. Fired as an
    // event — encurso.js owns the modal and imports FROM this file, so a direct
    // call would be a cycle.
    onClick: () =>
      document.dispatchEvent(new CustomEvent("audiobooks:open-encurso")),
    // Right-click → the same shared menu. onAfter repaints the card unless the
    // doc was just removed (its activated/cleared events already redrew this).
    menu: {
      docKey: doc.docKey,
      src: bk.p,
      onAfter: () => {
        if (state.docs.includes(doc)) renderActiveBookCard(doc);
      },
    },
  });

  // Nothing changed ⇒ change nothing. The catalog pass repaints this card on
  // every cold boot, and now that the cold paint is already decorated from the
  // doc's stamp the two are almost always byte-identical. Swapping the DOM
  // anyway would throw away the node the user may be touching (the open
  // right-click menu, a focus ring, a hover) to replace it with its own twin —
  // a flicker that carries no information.
  const cur = host.firstElementChild;
  // Both sides must actually BE markup: an environment without `outerHTML`
  // would otherwise compare undefined to undefined and skip every repaint,
  // freezing the card on its first paint forever.
  const same =
    typeof row.outerHTML === "string" &&
    cur &&
    typeof cur.outerHTML === "string" &&
    cur.outerHTML === row.outerHTML;
  if (same) {
    host.hidden = false;
    $("status").hidden = true;
    $("resumeNote").hidden = true;
    return;
  }
  host.innerHTML = "";
  host.appendChild(row);
  host.hidden = false;
  // The card supersedes the raw notes for a loaded book.
  $("status").hidden = true;
  $("resumeNote").hidden = true;
}

/**
 * No book loaded: paint a button in the card slot that opens the 📖 "En curso"
 * modal — the one place to pick what to read (open books, the queue, the library
 * is one 📚 away). Replaces the old "just bare the raw #status/#resumeNote lines"
 * behaviour: an empty screen offered no next step. The raw status lines stay
 * VISIBLE below the button (boot/recovery messages still need somewhere to land);
 * the button is an affordance, not a cover. Opens the modal via the same event
 * the active card fires (encurso.js owns it — a direct call would be a cycle).
 */
/**
 * Boot's placeholder for the card slot: "I am fetching your book", not "you
 * have no book".
 *
 * bindBiblioteca runs before the IndexedDB read that restores the library, so
 * `state.active` is always -1 at that moment — and seeding the slot with the
 * no-book call-to-action therefore told every returning reader, every single
 * boot, that they had nothing open, then swapped it for their book a second
 * later. The slot has to hold a THIRD state: not yet known.
 *
 * settleBootCard() is what ends it, from main.js, once the restore has had its
 * turn — so a genuinely empty library still lands on the real CTA.
 */
function paintBootPlaceholder() {
  const host = $("bookCard");
  if (!host) return;
  host.innerHTML = "";
  // A spinner, not the ⏳ glyph it used to be: boot's heavy stretch is on the
  // main thread, and an emoji cannot show movement there — the compositor-driven
  // ring in `.spin` keeps turning through the block that a static glyph would
  // sit frozen in. Same box either way, so the real card replaces it in place.
  const div = spinnerLine("Abriendo tu libro…", "book-card-empty book-card-loading");
  host.appendChild(div);
  host.hidden = false;
  // Same as a painted card: the raw lines stay out of the way. setStatus still
  // reaches the reader while they are hidden — it toasts instead (see dom.js).
  $("status").hidden = true;
  $("resumeNote").hidden = true;
}

/**
 * Boot is over: whatever the card slot holds now is the truth. Called once, from
 * main.js, after the library restore (and its catalog-recovery fallback) have
 * had their chance to activate a book.
 */
export function settleBootCard() {
  if (state.active < 0) clearActiveBookCard();
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

/**
 * Repaint everything a queue edit made stale: this modal (row cues + the bulk
 * buttons' own counts) AND — via `ctx.onAfter` — the surface that OPENED it.
 *
 * That second half is not optional. The «Book and author» modal opens ON TOP of
 * the 📖 «En curso» list, whose ctx.onAfter is renderEnCurso; the per-card 🔜
 * controls have always called it, which is the only reason a single-book add
 * appears in the cola straight away. A bulk add that repainted only the modal
 * left the cola underneath showing its pre-add paint until the page was
 * reloaded — the write had landed, the list just never asked again.
 */
function repaintAfterQueueEdit(bk, ctx = {}) {
  if (typeof ctx.onAfter === "function") ctx.onAfter();
  openAuthorBooks(bk, ctx);
}

/**
 * How many books a bulk-queue control may add WITHOUT asking. One book is the
 * plain 🔝/⬇️ tap the cards already offer, and that has never confirmed —
 * so a section that happens to hold one book must not start asking either.
 */
const BULK_QUEUE_CONFIRM_AT = 2;

/** True when adding `n` books in one tap should stop and ask first. */
export function bulkQueueNeedsConfirm(n) {
  return n >= BULK_QUEUE_CONFIRM_AT;
}

/**
 * The 🔝 / ⬇️ pair that sits hard right of a section header and queues the
 * WHOLE section. Books already queued are skipped (the append is not a reorder),
 * so the count on the button is what would actually move.
 *
 * The confirm budget: a bulk add is the one queue write whose SIZE is the risk —
 * "I meant to queue this book" vs "I just put 20 books ahead of everything I was
 * reading" look identical until the cola is opened. So it is fenced twice, and
 * BOTH fences are dialogs: this surface IS a modal, and the player's #toast slot
 * sits under the card the modal covers, so a toast here would report into a
 * region nobody can see.
 *   1. BEFORE — "¿Añadir N libros …?", the count in the question.
 *   2. AFTER — a receipt naming how many landed, with ↩ Deshacer, which takes
 *      back exactly the paths this tap added (removeManyFromQueue), not whatever
 *      the queue holds by then. Dismissing the receipt KEEPS them
 *      (dismissValue), so a stray Esc can never be the undo.
 * Both are skipped for a single book: that is the plain per-card tap, which has
 * never asked and must not start.
 */
function bulkQueueControls(books, label, onAfter) {
  const wrap = document.createElement("div");
  wrap.className = "cat-queue-controls";
  wrap.appendChild(bulkQueueButton(books, label, true, onAfter));
  wrap.appendChild(bulkQueueButton(books, label, false, onAfter));
  return wrap;
}

function bulkQueueButton(books, label, top, onAfter) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "saga-queue";
  b.textContent = top ? "🔝" : "⬇️";
  const where = top ? "al principio" : "al final";
  const pending = books.filter((x) => x.p && !isQueued(x.p));
  if (!pending.length) {
    b.disabled = true;
    b.title = `Todo «${label}» ya está en la cola`;
    return b;
  }
  b.title = `Añadir ${pending.length} libro(s) de «${label}» ${where} de la cola`;
  b.addEventListener("click", async () => {
    if (
      bulkQueueNeedsConfirm(pending.length) &&
      !(await confirmDialog({
        message: `¿Añadir ${pending.length} libro(s) de «${label}» ${where} de la cola?`,
        okLabel: "Añadir",
      }))
    )
      return;
    b.disabled = true;
    const added = await addManyToQueue(
      pending.map((x) => x.p),
      top,
    );
    onAfter(); // the rows' queue cues, these buttons, AND the list underneath
    if (!added.length || !bulkQueueNeedsConfirm(added.length)) return;
    const keep = await confirmDialog({
      title: `🔜 ${added.length} libro(s) en la cola`,
      message: `«${label}» — ${where} de la cola.`,
      okLabel: "Vale",
      cancelLabel: "↩ Deshacer",
      dismissValue: true, // walking away keeps them; only the button undoes
    });
    if (keep) return;
    await removeManyFromQueue(added);
    onAfter();
  });
  return b;
}

/**
 * The saga section: every book of `bk`'s Calibre series, in reading order, below
 * the author's other work. Absent for a standalone book (~57% of the library).
 *
 * Its head carries "🔜 Añadir saga a la cola", which appends the WHOLE saga in
 * order — finished books included. Deliberately: the saga is a sequence, and
 * silently skipping the ones you have read leaves gaps that are harder to reason
 * about than an over-full queue you can prune with one 🗑 per row. Books already
 * queued are the one exception (appending them again would duplicate, not
 * reorder). Rows keep their ✔ terminado cue so what you've read stays obvious.
 *
 * Its head also carries a completeness chip (✅ / ⚠️ faltan N), and the holes the
 * chip counts are rendered as rows IN PLACE — a missing nº 3 sits between 2 and
 * 4, where the eye already is. See sagaGaps + missingSagaRow.
 */
function renderSagaSection(bk, doc, listEl, ctx = {}) {
  const books = sagaBooks(bk);
  if (books.length < 2) return; // a saga of one is a standalone with a label

  const name = sagaName(bk);
  const gaps = sagaGaps(books);
  const head = document.createElement("div");
  head.className = "saga-head";
  const h = document.createElement("h3");
  h.className = "author-cat saga-title saga-toggle";
  // A disclosure caret leads the title: the saga is a long section (a dozen rows
  // plus the holes), so it ships COLLAPSED and the title toggles its row list.
  const caret = document.createElement("span");
  caret.className = "saga-caret";
  caret.textContent = "▸";
  h.appendChild(caret);
  const sagaLbl = document.createElement("span");
  sagaLbl.textContent = ` 📜 ${name} (${books.length})`;
  h.appendChild(sagaLbl);
  // Inside the title, not beside it: the head's flex row is title-then-button,
  // and the chip qualifies the title.
  if (sagaIsNumbered(books)) h.appendChild(sagaChip(gaps));
  head.appendChild(h);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "saga-queue";
  const pending = books.filter((b) => !isQueued(b.p));
  add.textContent = "🔜 Añadir saga a la cola";
  if (!pending.length) {
    add.disabled = true;
    add.title = "Toda la saga ya está en la cola";
  } else {
    add.title = `Añadir ${pending.length} libro(s) a la cola, en orden`;
    add.addEventListener("click", async () => {
      if (
        !(await confirmDialog({
          message: `¿Añadir ${pending.length} libro(s) de «${name}» a la cola, en orden?`,
          okLabel: "Añadir",
        }))
      )
        return;
      add.disabled = true;
      const added = await addManyToQueue(pending.map((b) => b.p));
      // Repaint: the rows' queue state, this button, and the list underneath.
      const repaint = () => repaintAfterQueueEdit(bk, { ...ctx, doc });
      repaint();
      if (!added.length) return;
      // Receipt as a DIALOG (setStatus would land on a line this modal covers),
      // with the same ↩ undo the category controls leave.
      const keep = await confirmDialog({
        title: `🔜 ${added.length} libro(s) en la cola`,
        message: `«${name}» — en orden.`,
        okLabel: "Vale",
        cancelLabel: "↩ Deshacer",
        dismissValue: true,
      });
      if (keep) return;
      await removeManyFromQueue(added);
      repaint();
    });
  }
  head.appendChild(add);
  listEl.appendChild(head);

  const wrap = document.createElement("div");
  wrap.className = "bib-list saga-list";
  wrap.hidden = true; // collapsed by default; the title caret expands it
  h.style.cursor = "pointer";
  h.addEventListener("click", () => {
    wrap.hidden = !wrap.hidden;
    caret.textContent = wrap.hidden ? "▸" : "▾";
  });
  const author = sagaAuthor(books);
  // Merge the holes into the reading order. A gap number never collides with a
  // book's (it is defined as the numbers no book has), and the unnumbered books
  // keep sinking to the bottom.
  // `books` arrives sorted; the sort is stable, so the unnumbered tail (all of it
  // ranked Infinity, hence equal) keeps the alphabetical order sagaBooks gave it.
  const rank = (s) => (s.book ? (typeof s.book.n === "number" ? s.book.n : Infinity) : s.gap);
  const slots = [...books.map((b) => ({ book: b })), ...gaps.map((n) => ({ gap: n }))].sort(
    (x, y) => {
      const xn = rank(x);
      const yn = rank(y);
      return xn === yn ? 0 : xn < yn ? -1 : 1; // Infinity - Infinity is NaN
    },
  );
  for (const slot of slots) {
    if (!slot.book) {
      wrap.appendChild(missingSagaRow(slot.gap, name, author));
      continue;
    }
    const b = slot.book;
    // hideSaga: inside the saga's own section the "📜 <name>" line on every card
    // would just repeat this header. The nº still shows, in a leading position chip.
    const row = bookRow(b, {
      hideSaga: true,
      // buildBookCard renders opts.icon as the card's leading glyph — reuse it for
      // the position chip so the saga reads as a numbered column.
      icon: typeof b.n === "number" ? String(b.n) : "·",
      iconClass: "saga-num",
      iconTitle: typeof b.n === "number" ? `Libro nº ${b.n}` : "Sin número en la saga",
    });
    // Mark where you are: the book whose card opened this modal. buildBookCard's
    // row wraps exactly one card button.
    const item = row.children[0];
    if (item && b.p && bk.p && b.p === bk.p) item.classList.add("saga-current");
    wrap.appendChild(row);
  }
  listEl.appendChild(wrap);
}

/** "✅ completa" / "⚠️ faltan N", titled with the numbers that are missing. */
function sagaChip(gaps) {
  const chip = document.createElement("span");
  chip.className = gaps.length ? "saga-chip saga-chip-miss" : "saga-chip saga-chip-full";
  chip.textContent = gaps.length ? `⚠️ faltan ${gaps.length}` : "✅ completa";
  chip.title = gaps.length
    ? `No están en la biblioteca: nº ${gaps.join(", ")}`
    : "La biblioteca tiene todos los números de la saga";
  return chip;
}

/**
 * A hole in the saga: a position the library has no book for. There is no path,
 * no title and nothing to open — only the slot — so it renders as a dead card
 * whose right-click (long-press) wishes for the book instead of opening the
 * rating menu every real card carries.
 *
 * The wish can only say what the gap knows: «Saga» nº 3, by the saga's author.
 * The catalog will never match that title when the real book lands, so unlike a
 * typed wish this one does not self-prune (see js/wishlist.js) — it is dropped
 * with the ✕ in the 🌠 modal, once the row here stops saying "falta".
 */
function missingSagaRow(n, name, author) {
  const row = document.createElement("div");
  row.className = "bib-row saga-miss-row";

  const card = document.createElement("span");
  card.className = "bib-item saga-miss";
  const ico = document.createElement("span");
  ico.className = "ico saga-num saga-num-miss";
  ico.textContent = String(n);
  ico.title = `Libro nº ${n}`;
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  const t = document.createElement("span");
  t.className = "bib-title";
  t.textContent = `Falta el libro nº ${n}`;
  const sub = document.createElement("span");
  sub.className = "bib-author";
  lbl.append(t, sub);
  card.append(ico, lbl);
  row.appendChild(card);

  const title = `${name} nº ${n}`;
  const wished = () => Boolean(author) && hasWish(wishKey(author, title));
  const paint = () => {
    const on = wished();
    sub.textContent = on ? "🌠 en la lista de deseos" : "No está en la biblioteca";
    card.classList.toggle("saga-miss-wished", on);
    card.title = on
      ? `«${title}» ya está en la lista de deseos`
      : "Clic derecho (o mantener pulsado) para añadir a la lista de deseos";
  };
  paint();

  card.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    closeBookMenu(); // a menu opened on a real card above must not linger
    if (!author) {
      setStatus("La saga no tiene autor: añade el libro a mano en 🌠.");
      return;
    }
    if (wished()) {
      setStatus(`🌠 «${title}» ya está en la lista de deseos.`);
      return;
    }
    if (
      !(await confirmDialog({
        message: `¿Añadir «${title}» de ${author} a la lista de deseos?`,
        okLabel: "Añadir",
      }))
    )
      return;
    const res = addWish(title, author);
    setStatus(
      res === "ok"
        ? `🌠 «${title}» en la lista de deseos.`
        : `📚 «${title}» ya está en la biblioteca.`,
    );
    paint();
  });
  return row;
}

/**
 * The «Book and author» modal's heading — the ONE place 🏛️ primigenia is stated.
 * It used to be a leading tag on the book card itself, which broke "every card
 * looks the same" (it showed on some surfaces and not others) for a fact that is
 * provenance, not state: it says where the file came from, and it never changes
 * what any control does. So it moved here, to the title of the modal the card
 * opens. `v` is baked into the catalog entry, and `_card.v` is the stamp a cold
 * boot reads back, so the heading is right on the first paint either way.
 */
function authorTitleFor(bk) {
  const prim = bk && (bk.v || bk._card?.v) === "primigenia";
  return prim ? "🏛️ Book and author" : "Book and author";
}

/**
 * Every catalog book by the same author, grouped into category sections
 * (non-fiction before fiction, mirroring the filter dropdown), each row a normal
 * biblioteca card — then, LAST, the book's saga (if any). Opened by tapping the
 * active-book card.
 *
 * The saga closes the modal rather than opening it: it is the long section (a
 * dozen rows plus the holes), and burying the author's other work under it meant
 * scrolling past a sequence you already know to reach the part you came to
 * browse. It is still painted on every exit path below — including the ones with
 * no author — since a saga can span hands.
 *
 * Past AUTHOR_FILTER_MIN books the sections ship collapsed and unbuilt behind a 🔍
 * box (renderAuthorSections). That is not cosmetic: «Varios autores» is ~1300 books
 * in this library, and building that many cards on the tap that opens the modal
 * froze the app with an empty panel on screen.
 */
export async function openAuthorBooks(bk, ctx = {}) {
  if (!ctx) ctx = {}; // a legacy `openAuthorBooks(bk, null)` still means "no ctx"
  // Back-compat: legacy callers passed the loaded doc as the 2nd arg. A ctx is a
  // plain options bag ({src,docKey,onAfter,onOpen,kind}); a doc carries chunks/
  // fullText and none of those keys — normalise it into ctx.doc.
  if (
    ctx &&
    (ctx.chunks || ctx.fullText) &&
    !("src" in ctx) &&
    !ctx.onAfter &&
    !ctx.onOpen &&
    !ctx.kind
  ) {
    ctx = { doc: ctx };
  }
  openMenuBook = bk;
  const titleEl = $("authorTitle");
  const listEl = $("authorList");
  listEl.innerHTML = "";
  titleEl.textContent = authorTitleFor(bk);
  openModal("authorModal");

  // The green «Book and author» action header for THIS book (▶️ open · ratings ·
  // ✅🧹📖🗑 · 🔜 cola · ❓ legend), painted up front so the actions are on screen
  // before the catalog resolves. The author's other books stream in below it.
  mountActionHeader(listEl, bk, ctx);

  let doc = ctx.doc || null;
  await Promise.all([ensureCatalog(), ensureFavorites()]);
  // Resolve the loaded doc from ctx (explicit doc, else by docKey / src) so the
  // author re-resolution + the saga "current book" cue still work.
  if (!doc) {
    const src = ctx.src || bk.p || null;
    doc = ctx.docKey
      ? state.docs.find((d) => d.docKey === ctx.docKey) || null
      : (src ? state.docs.find((d) => d.src === src) : null) || null;
  }
  // Re-resolve from the doc now the catalog is (re)loaded: a card painted before
  // the catalog was reachable comes in as a minimal _local book with no author.
  if (doc && (bk._local || !bk.a)) {
    const better = docToBook(doc);
    if (better && !better._local) bk = better;
  }
  // The catalog is in hand now, so `v` is knowable even for a card opened cold —
  // re-title, since 🏛️ is stated HERE and nowhere else.
  titleEl.textContent = authorTitleFor(bk);
  const author = bk.a || "";

  // The saga trails whatever the author lookup finds — including nothing, since
  // it is the sequence this book sits in and can span authors.
  const paintSaga = () => {
    if (catalog) renderSagaSection(bk, doc, listEl, ctx);
  };

  if (!catalog || !author) {
    listEl.appendChild(
      // Two different dead ends that used to read as one flat sentence. "No
      // author" is the book's own truth and there is nothing to do about it; "no
      // catalog" is a network state that is usually over already — and it is the
      // one that leaves this sheet as a header above nothing, which is the worst
      // any surface here looks. Only that one gets the retry.
      catalog
        ? Object.assign(document.createElement("div"), {
            className: "bib-empty",
            textContent: "Este libro no tiene autor.",
          })
        : catalogRetryLine(
            "No se pudo cargar el catálogo, así que no hay nada más de este autor que enseñar.",
            () => openAuthorBooks(bk, ctx),
          ),
    );
    paintSaga();
    return;
  }

  const books = authorBooks(author);
  if (!books.length) {
    listEl.appendChild(
      Object.assign(document.createElement("div"), {
        className: "bib-empty",
        textContent: "No hay libros de este autor en la biblioteca.",
      }),
    );
    paintSaga();
    return;
  }

  // The count line doubles as the WHOLE-author bulk-queue control: its 🔝 / ⬇️
  // pair adds every one of this author's books (across all category sections) at
  // once, the same append-skipping-queued semantics the per-category pair uses.
  // It counts the AUTHOR, not the 🔍-filtered view below it, and so does its
  // bulk-queue: "add everything by this writer" must not quietly become "add the
  // seven rows currently on screen".
  const collective = isCollectiveAuthor(author);
  const count = document.createElement("div");
  count.className = "bib-count author-count-head";
  const countLbl = document.createElement("span");
  countLbl.className = "saga-title";
  countLbl.textContent = `${books.length} ${books.length === 1 ? "libro" : "libros"} de ${author}.`;
  count.appendChild(countLbl);
  count.appendChild(bulkQueueControls(books, author, () => repaintAfterQueueEdit(bk, ctx)));
  listEl.appendChild(count);

  // «Varios autores» is not a writer, and saying so is the difference between a
  // page that looks broken (1300 "related" books) and one that reads as what it
  // is: a bucket of anthologies to search, not a bibliography to browse.
  if (collective) {
    listEl.appendChild(
      Object.assign(document.createElement("div"), {
        className: "bib-empty author-collective-note",
        textContent: `«${author}» no es un autor: es donde la biblioteca aparca las antologías y los libros sin autor conocido. Busca por título aquí abajo.`,
      }),
    );
  }

  // 🔍 filter over THIS author's books. Only from AUTHOR_FILTER_MIN up: on a
  // three-book author it is a control that can only ever hide two of them — and
  // below the threshold the remembered query must not narrow anything either.
  const results = document.createElement("div");
  results.className = "author-results";
  const paintResults = (q) => renderAuthorSections(results, bk, ctx, books, q);
  const big = books.length >= AUTHOR_FILTER_MIN;
  if (big) listEl.appendChild(authorFilterBox(books, paintResults));
  listEl.appendChild(results);
  paintResults(big ? normName(authorFilterRaw) : "");

  paintSaga();
}

/**
 * From this many books up, an author page stops being a list you read and becomes
 * one you search: the category sections ship COLLAPSED (and unbuilt — see
 * renderAuthorSections) and the 🔍 box appears. «Varios autores» (~1300 books) is
 * why, but the threshold is a COUNT and not that name on purpose — a genuinely
 * prolific writer chokes the modal exactly the same way, and gets the same cure.
 */
const AUTHOR_FILTER_MIN = 25;

/** Rows built per expand. A section past this grows by a «mostrar más» tap: 400
 *  cards in one frame is the freeze this whole section exists to avoid. */
const AUTHOR_SECTION_CAP = 100;

/**
 * The 🔍 row above the author's sections: filter this author's books by title (or
 * co-author, on a bundled "A & B" credit) with the same accent-folded matching the
 * biblioteca's own 🔍 uses. Not persisted — it is a way THROUGH one long page, not
 * a filter you leave on and then wonder about later.
 *
 * The box is built ONCE and kept out of the re-rendered results container: an
 * input that is torn out and rebuilt on every keystroke loses focus, and a filter
 * you must re-tap after every letter is not a filter.
 */
function authorFilterBox(books, paintResults) {
  const row = document.createElement("div");
  row.className = "author-filter";
  const input = document.createElement("input");
  input.type = "search";
  input.className = "bib-search";
  input.placeholder = "Filtrar estos libros por título…";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Filtrar los libros de este autor por título");
  const hits = document.createElement("span");
  hits.className = "author-filter-hits";
  const syncHits = (q) => {
    hits.textContent = q ? `${filterAuthorBooks(books, q).length} de ${books.length}` : "";
  };
  input.addEventListener("input", () => {
    // The query survives an in-place repaint of this modal (a 🔜 bulk add, a ⭐,
    // a ✅ all re-run openAuthorBooks): it belongs to the crumb, not to the paint.
    authorFilterRaw = input.value;
    const q = normName(authorFilterRaw);
    syncHits(q);
    paintResults(q);
  });
  input.value = authorFilterRaw;
  syncHits(normName(authorFilterRaw));
  row.appendChild(input);
  row.appendChild(hits);
  return row;
}

/** This author's books matching an already-folded 🔍 query — same rules as the main 🔍. */
function filterAuthorBooks(books, q) {
  const qTokens = queryTokens(q);
  if (!qTokens.length) return books;
  return books.filter((b) => matchesQuery(searchHay(b), qTokens));
}

/**
 * The author's books grouped into category sections (non-fiction before fiction,
 * mirroring the filter dropdown), each row a normal biblioteca card. Re-rendered
 * whole on every 🔍 keystroke, so it holds NOTHING the reader typed.
 *
 * Two rules keep a 1300-book author openable at all:
 *  - A section's rows are built LAZILY, on the first expand. `hidden` is not
 *    enough: the cost is building 1300 cards (each one status-classed and
 *    menu-wired), not showing them, and that cost lands on the tap that opens the
 *    modal — the app freezes with nothing on screen.
 *  - Sections ship collapsed once the set passes AUTHOR_FILTER_MIN, and expanded
 *    below it, so a normal author page still reads at a glance while a bucket like
 *    «Varios autores» opens as a table of contents. A 🔍 query that narrows the set
 *    under the threshold expands them again by the same rule — type three letters
 *    and the results are just there, with nothing to unfold.
 */
function renderAuthorSections(host, bk, ctx, books, q) {
  host.innerHTML = "";
  const shown = filterAuthorBooks(books, q);
  if (!shown.length) {
    host.appendChild(
      Object.assign(document.createElement("div"), {
        className: "bib-empty",
        textContent: "Ningún libro de este autor con ese texto.",
      }),
    );
    return;
  }

  // Group by catalog bucket; sort sections non-fiction first (fiction sinks).
  const groups = new Map();
  for (const b of shown) {
    const slug = b.b || "uncategorized";
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(b);
  }
  const slugs = [...groups.keys()].sort(
    (a, b) => Number(a.startsWith("fiction-")) - Number(b.startsWith("fiction-")),
  );

  // One rule for the whole page, not per section: a set this big is a set you
  // search, and a page where some sections are open and some are not just hides
  // the ones that happen to be small.
  const collapsed = shown.length >= AUTHOR_FILTER_MIN;

  for (const slug of slugs) {
    const arr = groups.get(slug);
    const label = prettyBucket(slug);
    // `cat-head`, NOT `saga-head`: the saga section is addressed by that class
    // (here and in the tests), and there is exactly one of it.
    const head = document.createElement("div");
    head.className = "cat-head";
    const h = document.createElement("h3");
    h.className = collapsed ? "author-cat saga-title saga-toggle" : "author-cat saga-title";
    // Same disclosure caret as the saga section — one collapse idiom in this modal.
    const caret = document.createElement("span");
    if (collapsed) {
      caret.className = "saga-caret";
      caret.textContent = "▸";
      h.appendChild(caret);
    }
    const lbl = document.createElement("span");
    lbl.textContent = collapsed ? ` ${label} (${arr.length})` : `${label} (${arr.length})`;
    h.appendChild(lbl);
    head.appendChild(h);
    // Hard right: 🔝 / ⬇️ for the WHOLE section — every book it counts, built
    // or not. Adding a category is adding up to a couple of dozen books at once,
    // so both directions confirm and both leave an ↩ undo behind
    // (bulkQueueButton) — the single-book controls on the cards below stay exactly
    // as they were.
    head.appendChild(bulkQueueControls(arr, label, () => repaintAfterQueueEdit(bk, ctx)));
    host.appendChild(head);

    const wrap = document.createElement("div");
    wrap.className = "bib-list";
    host.appendChild(wrap);
    // Append the next AUTHOR_SECTION_CAP rows, and re-hang the «mostrar más»
    // button after them until the section is fully built.
    let built = 0;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "saga-queue author-more";
    const grow = () => {
      more.remove();
      const next = arr.slice(built, built + AUTHOR_SECTION_CAP);
      next.forEach((b) => wrap.appendChild(bookRow(b)));
      built += next.length;
      const left = arr.length - built;
      if (!left) return;
      more.textContent = `▾ mostrar ${Math.min(left, AUTHOR_SECTION_CAP)} más (quedan ${left})`;
      // "Mostrar", never "Añadir": every other button in this modal that says
      // «Añadir» puts books in the cola. This one only paints more rows.
      more.title = `Mostrar ${Math.min(left, AUTHOR_SECTION_CAP)} fichas más de «${label}»`;
      wrap.appendChild(more);
    };
    more.addEventListener("click", grow);

    if (!collapsed) {
      grow();
      continue;
    }
    wrap.hidden = true;
    h.style.cursor = "pointer";
    h.addEventListener("click", () => {
      wrap.hidden = !wrap.hidden;
      caret.textContent = wrap.hidden ? "▸" : "▾";
      if (!wrap.hidden && !built) grow(); // build on the FIRST expand, once
    });
  }
}

/**
 * Index of the open doc holding this catalog path, or -1. A doc trashed on
 * another device is gone even before its eviction lands.
 */
export function openDocIndex(path) {
  return path ? state.docs.findIndex((d) => d.src === path && !isDropped(d.docKey)) : -1;
}

/**
 * Resolve the readable file inside a catalog book's folder, then load it, and
 * SELECT it (switch the active book to it). `forcePlay` (the 🎲 random / auto-
 * advance flows) also starts playback; a plain list click passes it through so
 * the book only keeps playing if something already was — but either way tapping
 * a book in the biblioteca now opens it, instead of silently adding it behind
 * the currently-loaded one. `select: true` (the en-curso modal) forces the
 * opposite: activate but NEVER auto-play, even if a book was mid-playback.
 */
async function loadBook(bk, forcePlay, select) {
  opening.add(bk.p);
  let opened = false;
  try {
    opened = await loadBookInner(bk, forcePlay, select);
  } finally {
    opening.delete(bk.p);
  }
  syncOfflineBuffer(); // the book left the queue / buffer — refill behind it
  return opened; // false ⇒ the caller (advanceAfterFinish) tries the next candidate
}

/** True if the book is now open and active; false if it could not be loaded. */
async function loadBookInner(bk, forcePlay, select) {
  // Already open here: `docs` holds the text, so pinnedFrom keeps no file for it
  // and the buffer has none. Re-shelve like handleFiles does, then activate.
  const openIdx = openDocIndex(bk.p);
  if (openIdx >= 0) {
    closeModal("bibModal");
    closeModal("authorModal");
    const doc = state.docs[openIdx];
    if (doc.mode !== currentMode()) {
      doc.mode = currentMode();
      storeDoc(doc);
    }
    setStatus(`"${bk.t}" ya estaba abierto en este dispositivo.`);
    activateDoc(openIdx, forcePlay, select);
    return true;
  }

  // Buffered? Open it straight from IndexedDB — instant, and the ONLY path that
  // works offline (the folder-list + download below both need the network). The
  // file is dropped once the book is open: `docs` now holds its extracted text,
  // and syncOfflineBuffer refills the slot with the next book we'll want.
  // Hydrate the index here rather than leaning on initBiblioteca having run: boot
  // now restores the open book BEFORE the biblioteca preload, so an open that
  // races it (restoreLastBookFromCatalog) would otherwise see an empty index and
  // re-download a file already sitting in the buffer.
  await ensureCacheIndex();
  const buffered = await cachedFile(bk.p);
  if (buffered) {
    closeModal("bibModal");
    closeModal("authorModal");
    setStatus(`"${bk.t}" (precargado).`);
    const idx = await handleFiles([buffered], bk.p, bk.a);
    // Only a book that actually OPENED gives its file back: a load that failed
    // (the MAX_DOCS ceiling, a corrupt EPUB) must not spend the download too —
    // offline, that copy is the only one there is.
    if (!(idx >= 0)) return false;
    await dropCached(bk.p);
    activateDoc(idx, forcePlay, select);
    return true;
  }

  const folderUrl = catalogFolderUrl(bk.p);
  setStatus(`Buscando "${bk.t}" en el servidor…`);
  let entries;
  try {
    entries = await listDir(folderUrl);
  } catch (e) {
    setStatus(`No se pudo abrir la carpeta de "${bk.t}": ${e.message}`);
    return false;
  }
  const readables = entries
    .filter((e) => e.type !== "directory" && READABLE.test(e.name))
    // Prefer EPUB, then PDF, then anything else readable.
    .sort((a, b) => rank(a.name) - rank(b.name));
  if (!readables.length) {
    setStatus(`"${bk.t}" no tiene archivo legible (EPUB/PDF).`);
    return false;
  }
  closeModal("bibModal");
  closeModal("authorModal"); // harmless if it wasn't the entry point
  const idx = await fetchInto(folderUrl, readables[0].name, bk.p, bk.a);
  if (!(idx >= 0)) return false;
  activateDoc(idx, forcePlay, select);
  return true;
}

function rank(name) {
  if (/\.epub$/i.test(name)) return 0;
  if (/\.pdf$/i.test(name)) return 1;
  return 2;
}

/* ===================== folder mode (fallback) ===================== */

function itemBtn({ icon, label, cls, onClick }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `bib-item${cls ? " " + cls : ""}`;
  const i = document.createElement("span");
  i.className = "ico";
  i.textContent = icon;
  const l = document.createElement("span");
  l.className = "lbl";
  l.textContent = label;
  b.appendChild(i);
  b.appendChild(l);
  b.addEventListener("click", onClick);
  return b;
}

async function render() {
  const list = $("bibList");
  const pathEl = $("bibPath");
  pathEl.textContent = "📁 /" + stack.join("/");
  list.innerHTML = '<div class="bib-empty">Cargando…</div>';

  let entries;
  try {
    entries = await listDir(currentUrl());
  } catch (e) {
    list.innerHTML = `<div class="bib-empty">No se pudo leer la carpeta (${e.message}).</div>`;
    return;
  }

  const dirs = entries
    .filter((e) => e.type === "directory")
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const files = entries
    .filter((e) => e.type !== "directory" && READABLE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  list.innerHTML = "";
  // Named, at every level, for as long as this view is on screen: folder mode is
  // what "📚 didn't work" looks like, and without this line it looks instead
  // like a feature nobody asked for. Re-added on every navigation because
  // `render` clears the list — walking into a folder must not lose the reason
  // you are in one.
  list.appendChild(
    catalogRetryLine(
      "No se pudo cargar el catálogo, así que estás viendo las carpetas del servidor: sin fichas, sin filtros y sin buscador.",
      () => showCatalogMode(),
    ),
  );
  if (stack.length) {
    list.appendChild(
      itemBtn({
        icon: "⬆",
        label: "..",
        cls: "up",
        onClick: () => {
          stack.pop();
          render();
        },
      }),
    );
  }
  dirs.forEach((d) =>
    list.appendChild(
      itemBtn({
        icon: "📁",
        label: d.name,
        onClick: () => {
          stack.push(d.name);
          render();
        },
      }),
    ),
  );
  files.forEach((f) =>
    list.appendChild(
      itemBtn({
        icon: /\.pdf$/i.test(f.name)
          ? "📕"
          : /\.epub$/i.test(f.name)
            ? "📗"
            : "📄",
        label: f.name,
        onClick: () =>
          // Pass the folder path as the catalog `src` (folder relative to ROOT,
          // matching a catalog `p`) + the author (top folder), so a book opened
          // through the raw folder browser still syncs to the cross-device shelf
          // instead of being stranded src-less. currentUrl() is ROOT + stack/…,
          // so the src is exactly stack.join("/").
          fetchInto(currentUrl(), f.name, stack.join("/"), stack[0]).then((idx) => {
            closeModal("bibModal");
            // Select the file just loaded (see loadBook) — don't leave the old
            // book active behind the newly-picked one.
            if (idx >= 0) activateDoc(idx);
          }),
      }),
    ),
  );

  if (!dirs.length && !files.length) {
    list.appendChild(
      Object.assign(document.createElement("div"), {
        className: "bib-empty",
        textContent: "Carpeta vacía (sin PDF/EPUB/TXT/MD).",
      }),
    );
  }
}

/**
 * Fetch <folderUrl><name> and feed it through the normal file-load path.
 * Returns the loaded doc's index (see handleFiles), or -1 on failure.
 */
async function fetchInto(folderUrl, name, srcPath, author) {
  const url = folderUrl + encodeURIComponent(name);
  setStatus(`Descargando "${name}" del servidor…`);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const file = new File([blob], name, { type: blob.type });
    return await handleFiles([file], srcPath, author);
  } catch (e) {
    setStatus(`Error al cargar "${name}" del servidor: ${e.message}`);
    return -1;
  }
}

/* ===================== wiring ===================== */

/**
 * A different SET of books is a different browse: back to page 1, back to the top
 * of the list, and no 🎲 spotlight left over from the old set. EVERYTHING that
 * changes the filters calls this — merely closing and reopening the modal does
 * NOT, which is the whole point of remembering the position (openBiblioteca).
 */
function rewindBrowse() {
  bibPage = 0;
  clearPick();
  scrollListTop();
}

/**
 * Everything a filter change must do besides flipping the flag: persist, rewind
 * the browse position, and repaint. The buffer is NOT resynced here: the user is
 * still flipping chips, and each pass would delete + re-download spares for a
 * filter set that's about to change again. It resyncs once, on modal close, when
 * the filter set has settled.
 *
 * `renderCatalog` re-filters up to 88 000 rows (and sorts them on the first visit
 * to an ordering) with no frame in between, so a chip tap used to look ignored
 * for as long as that took — the chip did not even repaint into its new pressed
 * state until the work was over, because the same task did both. `withBusyOverlay`
 * raises the centered curtain and lets one frame through BEFORE the work, so the
 * tap reads as taken and the list catches up. (No ring on the chip — every
 * spinner in this app is the one centered overlay.)
 */
function afterFilterChange() {
  saveFilters();
  applyBadge();
  rewindBrowse();
  if (catalog) return withBusyOverlay(renderCatalog);
  return Promise.resolve();
}

// ⭐ favorite / 👍 liked / 👎 disliked are mutually exclusive as filters, mirroring
// their exclusivity on a book — turning one on clears the other two chips.
const EXCL_CHIPS = { favBook: "bibFav", like: "bibLike", dislike: "bibDislike" };

function toggleChip(el, key) {
  filters[key] = !filters[key];
  el.setAttribute("aria-pressed", String(filters[key]));
  if (filters[key] && key in EXCL_CHIPS) {
    for (const other of Object.keys(EXCL_CHIPS)) {
      if (other === key || !filters[other]) continue;
      filters[other] = false;
      $(EXCL_CHIPS[other]).setAttribute("aria-pressed", "false");
    }
  }
  return afterFilterChange();
}

/* --- 🎛️ drawer + active-filter badge --- */

/** ♂ (male only) / ♀ (female only) / ⚥ (no gender constraint). Pure. */
export function genderOf(f) {
  if (f.male === f.female) return "all"; // both or neither → unconstrained
  return f.male ? "male" : "female";
}

function genderState() {
  return genderOf(filters);
}

const GENDER_CHIP = {
  male: { icon: "♂", title: "Solo autores hombre (tocar: mujeres)" },
  female: { icon: "♀", title: "Solo autoras mujer (tocar: todos)" },
  all: { icon: "⚥", title: "Autores de cualquier género (tocar: hombres)" },
};

function cycleGender() {
  const next = { male: "female", female: "all", all: "male" }[genderState()];
  filters.male = next === "male";
  filters.female = next === "female";
  applyGenderUI();
  return afterFilterChange();
}

function applyGenderUI() {
  const state = genderState();
  const chip = $("bibGender");
  chip.textContent = GENDER_CHIP[state].icon;
  chip.title = GENDER_CHIP[state].title;
  chip.setAttribute("aria-label", GENDER_CHIP[state].title);
  chip.setAttribute("aria-pressed", String(state !== "all"));
}

/**
 * The narrowing filters that are ON, in drawer order: the glyph the badge paints
 * and the Spanish name the 🎛️ tooltip spells out. 🔍 is excluded — its own chip
 * already shows it. `catLabel` is the chosen category's pretty name, so the
 * tooltip can say WHICH one; the badge only ever has room for 🏷️. Pure: takes
 * the filter object, so it can be asserted without a DOM.
 *
 * This is the ONLY place that knows the badge's vocabulary: a new narrowing chip
 * that is not listed here is a filter that hides books with no visible cue —
 * exactly the bug that made ⚥ the default.
 */
export function activeFilters(f, catLabel = "") {
  const on = [];
  if (f.favBook) on.push({ icon: "⭐", label: "favoritos" });
  if (f.favAuth) on.push({ icon: "👤", label: "autores favoritos" });
  if (f.like) on.push({ icon: "👍", label: "me gustan" });
  if (f.dislike) on.push({ icon: "👎", label: "no me gustan" });
  if (f.prim) on.push({ icon: "🏛️", label: "primigenia" });
  if (f.finished) on.push({ icon: "📖", label: "leídos" });
  const g = genderOf(f);
  if (g === "male") on.push({ icon: "♂", label: "autores hombre" });
  if (g === "female") on.push({ icon: "♀", label: "autoras mujer" });
  if (f.cat) on.push({ icon: "🏷️", label: catLabel || "una categoría" });
  return on;
}

/**
 * Paint the 🎛️ badge and show "Limpiar" only when there is something to clear.
 * The badge NAMES the filters that are on ("♂ ⭐") instead of counting them: a
 * bare "1" never said which one, and the one that used to be on by default (♂)
 * hid half the catalog behind a number that looked innocuous.
 */
function applyBadge() {
  const on = activeFilters(filters, filters.cat ? prettyBucket(filters.cat) : "");
  const badge = $("bibFiltersOn");
  badge.hidden = !on.length;
  badge.textContent = on.map((x) => x.icon).join(" ");
  $("bibFiltersBtn").title = on.length
    ? `Filtros activos: ${on.map((x) => `${x.icon} ${x.label}`).join(", ")}`
    : "Filtros";
  $("bibClear").hidden = !on.length;
}

function setDrawer(open) {
  drawerOpen = open;
  $("bibDrawer").hidden = !open;
  $("bibFiltersBtn").setAttribute("aria-expanded", String(open));
}

/**
 * Wipe the filters AND the 🔍 query — the empty list's "quitar filtros" promises
 * the whole library, and a surviving query would hand back another empty one.
 * The drawer's «Limpiar» keeps the query on purpose (it is about the drawer),
 * which is why this is a separate door and not a flag on `clearFilters`.
 */
function clearAllNarrowing() {
  filters.q = ""; // applyFilterUI, inside clearFilters, reflects it into the 🔍 input
  return clearFilters();
}

/** Wipe every narrowing filter (gender back to ⚥, category to "Todas"). Keeps 🔍. */
function clearFilters() {
  for (const k of ["favBook", "favAuth", "like", "dislike", "prim", "finished", "male", "female"]) {
    filters[k] = false;
  }
  filters.cat = "";
  applyFilterUI();
  return afterFilterChange();
}

/* --- 🔤 sort chip --- */

/**
 * The sort modes THIS catalog can actually honour. A date mode needs at least
 * one book carrying its field: `counts` says so directly on a catalog that has
 * them, and an older catalog (no such counts) is scanned once and memoised.
 */
export function availableSortModes(cat) {
  if (!cat || !Array.isArray(cat.books)) return SORT_MODES;
  const c = cat.counts || {};
  const has = (field, count) =>
    typeof count === "number"
      ? count > 0
      : cat.books.some((b) => typeof b[field] === "number");
  const hasY = has("y", c.pubyear);
  const hasD = has("d", c.added);
  return SORT_MODES.filter((m) => !m.needs || (m.needs === "y" ? hasY : hasD));
}

let sortModesCache = null;
function sortModes() {
  if (!sortModesCache) sortModesCache = availableSortModes(catalog);
  return sortModesCache;
}

function cycleSort() {
  const modes = sortModes();
  if (modes.length < 2) {
    // Only 🔤 survives: the catalog carries no dates, so 🆕/🏺/📥 would order
    // nothing. Say that instead of cycling through three chips that do nothing.
    setStatus("🔤 El catálogo no tiene fechas: solo orden alfabético.");
    return;
  }
  const i = modes.findIndex((m) => m.id === filters.sort);
  filters.sort = modes[(i + 1) % modes.length].id;
  saveFilters();
  applySortUI();
  // The SET is unchanged — only its order — so the 🎲 spotlight and the random
  // prefetch (which draw from the set, not the list) both stay valid. Only the
  // pager rewinds, since page 1 now holds different books; renderCatalog now
  // PRESERVES the scroll, so the trip back to the top has to be asked for.
  bibPage = 0;
  scrollListTop();
  // The heaviest chip in the bar: the first visit to an ordering sorts the whole
  // catalog through an Intl.Collator. Curtain first, sort second (see
  // afterFilterChange).
  if (catalog) return withBusyOverlay(renderCatalog);
  return Promise.resolve();
}

/**
 * The active order in words — "🏺 año ↑" — for the count line under the chips.
 * A dateless catalog says THAT instead: cycleSort's own explanation goes to
 * setStatus, and #status/#toast sit under the player card that this modal paints
 * straight over (see dom.js), so it was never readable from the one screen that
 * needed it. Both year directions are named here, which is also the only place the
 * app states that 🆕 and 🏺 are the descending/ascending pair.
 */
function sortNote() {
  const modes = sortModes();
  if (modes.length < 2) return "🔤 A–Z (el catálogo no tiene fechas)";
  const mode = modes.find((m) => m.id === filters.sort) || SORT_MODES[0];
  return `${mode.icon} ${mode.short}`;
}

function applySortUI() {
  const modes = sortModes();
  // A persisted mode this catalog can't honour (dates gone / never built) must
  // not stay selected: it would paint 🆕 over an alphabetical list.
  if (!modes.some((m) => m.id === filters.sort)) {
    filters.sort = SORT_MODES[0].id;
    saveFilters();
  }
  const mode = modes.find((m) => m.id === filters.sort) || SORT_MODES[0];
  const chip = $("bibSort");
  chip.textContent = mode.icon;
  chip.title =
    modes.length < 2
      ? "Orden: alfabético (el catálogo no tiene fechas)"
      : `Orden: ${mode.label} (tocar para cambiar)`;
  chip.setAttribute("aria-label", `Orden: ${mode.label}`);
  chip.setAttribute("aria-pressed", String(mode.id !== "alpha"));
  // Left clickable on purpose (a disabled button swallows the tap): pressing it
  // says WHY there is nothing to cycle through. See cycleSort.
  chip.setAttribute("aria-disabled", String(modes.length < 2));
}

/** Reflect the persisted filter state onto the chips + category select. */
function applyFilterUI() {
  $("bibFav").setAttribute("aria-pressed", String(filters.favBook));
  $("bibAuth").setAttribute("aria-pressed", String(filters.favAuth));
  $("bibLike").setAttribute("aria-pressed", String(filters.like));
  $("bibDislike").setAttribute("aria-pressed", String(filters.dislike));
  $("bibPrim").setAttribute("aria-pressed", String(filters.prim));
  $("bibDone").setAttribute("aria-pressed", String(filters.finished));
  applyGenderUI();
  applySortUI();
  // Reflect the persisted category. If the stored slug is no longer a real
  // <option> (catalog rebuilt / taxonomy changed since it was saved), the
  // <select> silently falls back to "Todas" while filters.cat would keep
  // narrowing the list — a dropdown that LIES about the active filter (you
  // see e.g. "358 libros" sitting under "Todas las categorías"). Reconcile:
  // adopt what the select can actually show so the dropdown and list agree.
  const cat = $("bibCat");
  cat.value = filters.cat;
  if (cat.value !== filters.cat) {
    filters.cat = ""; // unreachable category → honestly browse every category
    cat.value = ""; //   and re-select the leading "Todas" option
    saveFilters();
  }
  // Setting .value fires no `change` and mutates no observed attribute, so the
  // enhanced-select trigger's label (ui.js) wouldn't re-sync on its own — it would
  // stay on whatever it showed when the options were first populated ("Todas").
  // Nudge it so the dropdown face reflects the real active category.
  cat.dispatchEvent(new Event("dd:sync"));
  // 🔍 search: reflect the stored query, and reveal the input when it's non-empty
  // so a restored search is visible (empty → input stays collapsed behind 🔍).
  const s = $("bibSearch");
  s.value = filters.q || "";
  s.hidden = !filters.q;
  $("bibSearchBtn").setAttribute("aria-pressed", String(!!filters.q));
  // Last: the badge counts what the lines above just reconciled (an unreachable
  // category may have been dropped).
  applyBadge();
}

/** Re-run the filter set after a 🔍 query change: reset paging, drop stale picks. */
function applySearch() {
  saveFilters();
  rewindBrowse(); // new filter set → first page, top of the list, no stale spotlight
  if (catalog) renderCatalog(); // buffer resyncs on modal close (see afterFilterChange)
}

/* ===================== 🌠 wishlist modal + 📋 profile export ===================== */

/** Open the wishlist: only the books the library still doesn't hold. */
export async function openWishlist() {
  openModal("wishModal");
  await Promise.all([ensureCatalog(), ensureFavorites()]);
  $("wishTitle").value = "";
  $("wishAuthor").value = "";
  renderWishlist();
}

/** Paint the pending wishes; each row's ✕ forgets that wish. */
function renderWishlist() {
  const list = $("wishList");
  const items = openWishes();
  $("wishCount").textContent = items.length
    ? `${items.length} libro${items.length === 1 ? "" : "s"} por conseguir`
    : "";
  list.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "wish-empty";
    empty.textContent =
      "Nada pendiente. Añade aquí los libros que quieres y no están en la biblioteca; " +
      "cuando entren (📚 o por Telegram) desaparecen solos de esta lista.";
    list.appendChild(empty);
    return;
  }
  for (const w of items) {
    const row = document.createElement("div");
    row.className = "bib-row wish-row";

    // Same card shape as a biblioteca row (.bib-item > .lbl > title + author),
    // minus the button — a wished book has nothing to open.
    const card = document.createElement("span");
    card.className = "bib-item wish-item";
    // No 🏛️ leading tag here either — it used to mark a wish seeded from the
    // primigenia collection, and it went with the one on the book cards
    // (operator directive, 2026-07-25: 🏛️ is stated on the «Book and author» title
    // and nowhere else). A wished book has no such modal, so the provenance rides
    // the row's title attribute instead of a glyph.
    if (w.v === "primigenia") card.title = "Primigenia";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    const t = document.createElement("span");
    t.className = "bib-title";
    t.textContent = w.t;
    const a = document.createElement("span");
    a.className = "bib-author";
    a.textContent = w.a;
    lbl.append(t, a);
    card.appendChild(lbl);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "wish-del";
    del.textContent = "✕";
    del.title = "Quitar de la lista de deseos";
    del.addEventListener("click", async () => {
      if (
        !(await confirmDialog({
          message: `¿Quitar «${w.t}» de la lista de deseos?`,
          okLabel: "Quitar",
          danger: true,
        }))
      )
        return;
      removeWish(w.key);
      renderWishlist();
    });

    row.append(card, del);
    list.appendChild(row);
  }
}

/** Add the typed book, reporting the one refusal the operator can act on. */
function submitWish() {
  const t = $("wishTitle").value;
  const a = $("wishAuthor").value;
  const res = addWish(t, a);
  if (res === "blank") {
    setStatus("Escribe título y autor.");
    return;
  }
  if (res === "in-library") {
    setStatus(`📚 «${t.trim()}» ya está en la biblioteca.`);
    return;
  }
  $("wishTitle").value = "";
  $("wishAuthor").value = "";
  $("wishTitle").focus();
  renderWishlist();
}

/**
 * Every favorite author, as the operator would name them: the catalog authors
 * whose books carry a live-or-seeded 👤, plus the seed/live names the catalog has
 * NO book for — the ones worth telling an LLM about, since nothing on screen can
 * show them.
 */
function favAuthorNames() {
  const books = (catalog && catalog.books) || [];
  const out = new Map(); // normalised key -> display name
  for (const bk of books) {
    if (bk.a && authorDegree(bk) > 0) out.set(normName(bk.a), bk.a);
  }
  const covered = (name) => {
    const nt = tokens(name);
    for (const k of out.keys()) if (subsetMatch(nt, new Set(k.split(" ")))) return true;
    return false;
  };
  for (const name of FAV_AUTHOR_NAMES) {
    const k = normName(name);
    if (favAuthors[k] === 0) continue; // explicitly un-favorited
    if (!covered(name)) out.set(k, name);
  }
  for (const [k, deg] of Object.entries(favAuthors)) {
    if (deg > 0 && !out.has(k)) out.set(k, k);
  }
  return [...out.values()].sort((x, y) => x.localeCompare(y, "es"));
}

/** Resolve every taste signal against the catalog into the profile's arrays. */
function collectProfile() {
  const books = (catalog && catalog.books) || [];
  const favorites = [];
  const likes = [];
  const dislikes = [];
  for (const bk of books) {
    if (pathDegree(bk) > 0) favorites.push({ t: bk.t, a: bk.a });
    const r = bookReaction(bk);
    if (r === "like") likes.push({ t: bk.t, a: bk.a });
    else if (r === "dislike") dislikes.push({ t: bk.t, a: bk.a });
  }
  const byAuthor = (x, y) => x.a.localeCompare(y.a, "es") || x.t.localeCompare(y.t, "es");
  return {
    generated: new Date().toISOString().slice(0, 10),
    catalogCount: books.length,
    authors: favAuthorNames(),
    favorites: favorites.sort(byAuthor),
    likes: likes.sort(byAuthor),
    dislikes: dislikes.sort(byAuthor),
    wishes: openWishes().map((w) => ({ t: w.t, a: w.a })),
  };
}

/** 📋 — the whole taste profile as Markdown, on the clipboard, ready to paste. */
async function copyProfile() {
  await Promise.all([ensureCatalog(), ensureFavorites()]);
  const p = collectProfile();
  // The `await` above spends the click's user gesture, so over plain http even
  // the execCommand rung tends to fail — copyOrShow then shows the text to copy.
  const ok = await copyOrShow(buildProfileText(p), { title: "Perfil de lectura" });
  const n = p.favorites.length + p.likes.length + p.dislikes.length + p.wishes.length;
  setStatus(
    ok
      ? `📋 Perfil copiado: ${p.authors.length} autores, ${n} libros. Pégalo en el LLM.`
      : "No se pudo copiar al portapapeles.",
  );
}

/** Wire the modal close triggers, the open button, and the filter controls. */
export function bindBiblioteca() {
  wireModal("bibModal");
  wireModal("authorModal");
  wireModal("wishModal");
  // The «Book and author» trail's own back control (see syncAuthorBack).
  const backChip = $("authorBack");
  if (backChip) backChip.addEventListener("click", stepBackAuthorCrumb);
  loadFilters();
  const btn = $("bibliotecaBtn");
  if (btn) btn.addEventListener("click", openBibliotecaFromButton);

  // The source card mirrors the active book (rendered here so it can reuse the
  // catalog + rating popover); library.js only fires these events.
  document.addEventListener("audiobooks:activated", (e) =>
    renderActiveBookCard(e.detail?.doc),
  );
  document.addEventListener("audiobooks:cleared", clearActiveBookCard);
  // Boot may finish with no book loaded (empty IndexedDB, a local-only history, an
  // unreachable Pi during catalog recovery) and fire NO activation — so nothing
  // would paint the slot. Seed it with the LOADING state, not the no-book button:
  // at bind time the restore hasn't run yet, so "elige un libro" would be a claim
  // we cannot make, and for the common case (a reader with a book open) it was
  // simply wrong for a second. main.js#settleBootCard resolves it either way.
  if (state.active < 0) paintBootPlaceholder();

  // Resync the offline buffer when the modal CLOSES (any path: ✕/backdrop/Esc/
  // load-a-book), not on each chip toggle — by then the filter set has settled,
  // so we only download the spares for a category the user is committing to.
  const modal = $("bibModal");
  if (modal) {
    new MutationObserver(() => {
      if (modal.hidden && catalog) syncOfflineBuffer();
    }).observe(modal, { attributes: true, attributeFilter: ["hidden"] });
  }

  // Remember where the list was left. `.modal[hidden]` is display:none, which
  // destroys the box's layout and zeroes its scrollTop — so the offset has to be
  // captured LIVE, while the box still exists (by the time the observer above
  // fires, scrollTop already reads 0). Events fired while the modal is SHUT are
  // ignored: hiding it can clamp the box to 0, and that 0 is not where the user was.
  const body = bibBody();
  if (body) {
    body.addEventListener(
      "scroll",
      () => {
        if (!modal || !modal.hidden) bibScroll = body.scrollTop;
      },
      { passive: true },
    );
  }

  $("bibFav").addEventListener("click", (e) => toggleChip(e.currentTarget, "favBook"));
  $("bibAuth").addEventListener("click", (e) => toggleChip(e.currentTarget, "favAuth"));
  $("bibLike").addEventListener("click", (e) => toggleChip(e.currentTarget, "like"));
  $("bibDislike").addEventListener("click", (e) => toggleChip(e.currentTarget, "dislike"));
  $("bibPrim").addEventListener("click", (e) => toggleChip(e.currentTarget, "prim"));
  $("bibDone").addEventListener("click", (e) => toggleChip(e.currentTarget, "finished"));
  $("bibGender").addEventListener("click", cycleGender);
  $("bibFiltersBtn").addEventListener("click", () => setDrawer(!drawerOpen));
  $("bibClear").addEventListener("click", clearFilters);
  $("bibSort").addEventListener("click", cycleSort);
  $("bibRandom").addEventListener("click", spinPick);
  $("bibWish").addEventListener("click", openWishlist);
  $("bibCopy").addEventListener("click", copyProfile);
  $("wishAdd").addEventListener("click", submitWish);
  $("wishAuthor").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitWish();
  });
  $("wishTitle").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("wishAuthor").focus();
  });
  // 🔍 toggles the search input: reveal + focus when hidden; hiding clears the
  // query. Typing filters live (title + author, accent-insensitive).
  $("bibSearchBtn").addEventListener("click", () => {
    const s = $("bibSearch");
    const show = s.hidden;
    s.hidden = !show;
    $("bibSearchBtn").setAttribute("aria-pressed", String(show));
    if (show) {
      s.focus();
    } else if (filters.q) {
      filters.q = "";
      s.value = "";
      applySearch();
    }
  });
  $("bibSearch").addEventListener("input", (e) => {
    filters.q = normName(e.target.value);
    applySearch();
  });
  $("bibCat").addEventListener("change", (e) => {
    filters.cat = e.target.value;
    // The ring goes on the 🎛️ trigger, not the hidden native <select>: the
    // dropdown sheet has already closed by the time the repaint runs, so the
    // trigger is the control the user is still looking at.
    afterFilterChange();
  });
}
