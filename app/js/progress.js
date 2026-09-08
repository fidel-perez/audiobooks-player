/**
 * Reading position, persistence, and progress metrics.
 *
 * Position is tracked by character offset into the extracted text and mapped
 * to the nearest chunk, so a saved position survives re-chunking.
 */

import {
  BASE_WPM,
  LS_POS_PREFIX,
  LS_PROGRESS_MAP,
  META_PROGRESS_KEY,
} from "./config.js";
import { state } from "./state.js";
import { normMode } from "./mode.js";
import { $, showSyncBanner, hideSyncBanner } from "./dom.js";
import { noteRead } from "./progresslog.js";
import { idbGetMeta, idbSetMeta } from "./db.js";
import { mergeServerMap, sanitizeMap, isTombstone } from "./progress-merge.js";
import { apiFetch } from "./storage.js";

/* ===================== sync-server mirror =====================
 * Besides the per-device localStorage position, mirror each doc's progress
 * through storage.js's `/kv/audiobooks-progress` seam as one KV blob
 * `{ "<docKey>": {title,pct,pos,total,ts} }`.
 * The "en curso" modal reads this to list/manage in-progress books.
 *
 * OFFLINE MODE. The typical session is: read online, then flip the phone to
 * airplane mode at bedtime — every push then fails. So the whole map is ALSO
 * mirrored to localStorage (LS_PROGRESS_MAP) on every edit, surviving a tab
 * close. On the next open (or when connectivity returns) we merge the local map
 * with the server's — newer `ts` wins per book — and immediately push, so last
 * night's offline progress uploads before anything else. Single-device use, so
 * this last-write-wins merge is safe.
 */
const API_BASE = "/kv/";
const PROGRESS_KEY = "audiobooks-progress";
const PROGRESS_DEBOUNCE_MS = 2000;
// Browsers cap total in-flight `keepalive` request bodies at ~64 KB and SILENTLY
// DROP anything over — so the pagehide flush sends the whole map only while it's
// under this; above it, just the active book (the rest stays durable and rides
// up on the next full flush / boot / Background Sync). See flushNow.
const KEEPALIVE_MAX = 60000;

let progressMap = loadLocalMap(); // docKey -> {title,pct,pos,total,ts,done?,recent?,played?,openedTs?}
migrateRecentEntries(progressMap); // stamp legacy entries with an explicit `recent`
let progressReady = false; // server GET merged in (map safe to push)
let progressTimer = null;

// Unsynced-progress banner + auto-retry. `unsynced` is true whenever the local
// map holds edits not yet CONFIRMED on the server (a local map loaded at boot is
// treated as pending until the first flush confirms). A failed flush — offline,
// or a 5xx mid-deploy — shows a persistent banner and retries on a timer until a
// PUT succeeds. This is the hands-free replacement for the old 🌅 push button:
// last night's offline reading uploads the moment you enable data in the morning.
let unsynced = Object.keys(progressMap).length > 0;
let syncRetryTimer = null;
const SYNC_RETRY_MS = 6000;
// Bumped on every local edit; a PUT clears `unsynced` ONLY if no edit landed
// after it serialized its body — otherwise a stale-but-200 flush of an OLD
// snapshot could hide the banner while newer progress still can't reach the
// server (a newer edit's own flush must confirm it, or fail → nag).
let dirtyVersion = 0;

/** Read the persisted map from localStorage (so offline progress isn't lost). */
function loadLocalMap() {
  try {
    const raw = localStorage.getItem(LS_PROGRESS_MAP);
    if (raw) {
      const j = JSON.parse(raw);
      // sanitizeMap strips any `_op`/`entries` pollution a legacy raw-stored
      // progress_merge body left behind, so junk can never enter the shelf logic
      // or ride back up on a push.
      if (j && typeof j === "object" && !Array.isArray(j)) return sanitizeMap(j);
    }
  } catch (_) {}
  return {};
}

/** Persist the whole map locally — the offline-durable copy. localStorage is the
 *  fast, synchronous main-thread mirror; IndexedDB is the copy the SERVICE WORKER
 *  can read (localStorage isn't reachable from a SW) for Background Sync. */
function persistLocalMap() {
  try {
    localStorage.setItem(LS_PROGRESS_MAP, JSON.stringify(progressMap));
  } catch (_) {}
  persistIdbMap();
}

/** Mirror the map to IndexedDB with the current dirty state (`unsynced`), so the
 *  SW's background-sync handler can push it while the page is closed and only
 *  when there are genuinely unconfirmed edits. Fire-and-forget (async). */
function persistIdbMap() {
  idbSetMeta(META_PROGRESS_KEY, { map: progressMap, dirty: unsynced }).catch(
    () => {},
  );
}

// mergeServerMap (newer-ts-per-book wins) lives in ./progress-merge.js so the
// service worker's Background Sync handler shares the exact same logic.

/**
 * Pull the server blob and merge it in (local offline edits win by ts). Returns
 * true only when the server's copy was actually READ (an absent key answers
 * `{}` with 200, which still counts). The push is now a ts-aware MERGE (never a
 * destructive whole-blob PUT), so it can no longer wipe the store even if it ran
 * before a read — but we still gate the full push on a confirmed read so a fresh
 * device doesn't redundantly upload its half-loaded localStorage map before
 * folding in what the server already holds. So `progressReady` is set ONLY here.
 */
// A legacy raw-stored `progress_merge` body (or a still-running OLD client that
// re-pushes its unsanitized in-memory map) leaves `_op`/`entries` as top-level
// server keys — non-books that `progress_merge` (additive) never removes. Sanitize
// keeps them out of THIS client's logic, but they'd linger on the server forever;
// so whenever we pull and see one, actively delete it with a null-PATCH (the
// deep-merge in storage.js drops exactly that key). Self-healing: any up-to-date client that
// opens the store scrubs it, and no up-to-date client ever re-adds it.
function cleanReservedKeys(serverBlob) {
  const junk = Object.keys(serverBlob).filter((k) => k === "_op" || k === "entries");
  if (!junk.length) return;
  const body = {};
  for (const k of junk) body[k] = null;
  apiFetch(API_BASE + PROGRESS_KEY, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  }).catch(() => {
    /* best-effort; the next pull retries the scrub */
  });
}

async function pullServerMap() {
  try {
    const r = await apiFetch(API_BASE + PROGRESS_KEY, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    // js/storage.js never answers from a stale cache — IndexedDB and a
    // sync-server fetch are both live reads, so this is always false.
    const stale = false;
    lastFailWasNetwork = stale;
    if (!r.ok) return false; // 5xx / transient — must NOT authorise an overwrite
    const j = await r.json();
    if (j && typeof j === "object" && !Array.isArray(j)) {
      cleanReservedKeys(j); // scrub `_op`/`entries` pollution off the server blob
      mergeServerMap(progressMap, j);
      migrateRecentEntries(progressMap); // normalise entries from an un-upgraded device
      const firstReady = !progressReady; // the boot false→true transition
      progressReady = true;
      reconcileDroppedDocs(); // a book trashed elsewhere may be LOADED here → evict
      reconcileAheadDocs(); // another device read further → move the reader there
      // Boot's own restore (main.js) reads localStorage-only sources — the active
      // key and its saved position — both wiped by a FULL site-data clear, which
      // is why the shelf then showed "elige un libro" though the server held a
      // 24-book progress map. Announce the merge so main.js can re-derive the last
      // book straight from the now-loaded map. One-shot: only the boot transition,
      // never a later re-pull (which must not hijack a book the user has opened).
      if (firstReady) {
        try {
          document.dispatchEvent(new CustomEvent("audiobooks:progressready"));
        } catch (_) {}
      }
      // MERGED, BUT NOT A SUCCESSFUL PULL. The caller's contract is "true means
      // the server was reached, so it is safe to push" — and a cached blob is
      // this device's own last copy, so merging it is free and pushing on the
      // strength of it is a write nobody can deliver. `progressReady` still goes
      // true: the map is as complete as it can be, which is what gates the local
      // paths. The push waits for a face.
      return !stale;
    }
    return false; // malformed body — safer not to push over it
  } catch (_) {
    /* store unreachable — localStorage still carries the position */
    lastFailWasNetwork = true; // fetch rejected → sync server unreachable (or no network)
    return false;
  }
}

// On load: reconcile the IndexedDB mirror (which the service worker may have
// advanced via Background Sync while the page was closed), THEN pull the server
// blob and merge (local offline edits win by ts). The IDB reconcile runs first
// and synchronously feeds progressReady=false paths so a background push isn't
// lost on reopen. Only flush once the pull SUCCEEDED, so a transient GET failure
// can never PUT an empty/partial map over the server's good data. A failed pull
// leaves progressReady false; the map stays durable and the `online` handler /
// next modal refresh re-pulls before anything is pushed.
(async () => {
  try {
    const meta = await idbGetMeta(META_PROGRESS_KEY);
    if (meta && meta.map && typeof meta.map === "object") {
      mergeServerMap(progressMap, meta.map); // newer ts per book wins over the LS copy
      migrateRecentEntries(progressMap); // normalise the IDB copy's legacy entries too
      if (meta.dirty) unsynced = true; // IDB still holds unconfirmed edits → nag/push
      persistLocalMap();
    }
  } catch (_) {
    /* IDB unavailable — localStorage copy still carries the map */
  }
  const ok = await pullServerMap();
  persistLocalMap();
  if (ok) flushProgressStore(); // push last session's (maybe offline) progress
  else if (unsynced) scheduleSyncRetry(); // booted offline holding progress → nag
})();

/**
 * Re-sync from the server (used when the 📖 en-curso modal opens) so the shared
 * "libros abiertos" shelf reflects progress made on other devices. Returns the
 * live map.
 */
export async function refreshProgress() {
  await pullServerMap();
  persistLocalMap();
  return progressMap;
}

/**
 * Force a full round-trip with the json store (the morning 🌅 button): pull +
 * merge the server blob, persist locally, then push our (possibly offline-
 * advanced) map back up. Returns true only when the server was actually reached
 * — i.e. the pull succeeded, which is also the precondition for the push — so a
 * caller can gate a "sync ok" action on a genuine sync rather than a silent
 * offline no-op.
 */
export async function syncNow() {
  const ok = await pullServerMap();
  persistLocalMap();
  if (ok) flushProgressStore();
  else if (unsynced) scheduleSyncRetry();
  return ok;
}

/**
 * Immediate, non-debounced push of the current position — for the app being
 * backgrounded or closed (`pagehide` / `visibilitychange`→hidden). Captures the
 * live position into the map, cancels the pending debounce, and pushes NOW as a
 * keepalive ts-merge PATCH so the last delta reaches the server before the tab is
 * frozen/killed. No-op offline — the map stays durable in localStorage +
 * IndexedDB and the boot / visible / online / Background-Sync paths re-push. This
 * is the reliable stand-in for the `online`-event + background-timer retry, which
 * Chromium suspends once the browser is closed (last night's progress was lost
 * because that retry never ran).
 */
export function flushNow() {
  saveProgress(); // fold the live position into the map (no-op if no active doc)
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  if (!progressReady) return; // nothing safe to push before the server GET merged
  // ts-merge PATCH (never regresses a book, unlike a blind PUT) with keepalive so
  // it survives the tab being torn down. Prefer the whole map; if it has grown
  // past the keepalive size cap, send just the active book — the rest stays
  // durable and rides up on the next full flush / boot / Background Sync.
  let entries = progressMap;
  if (JSON.stringify(progressMap).length > KEEPALIVE_MAX) {
    entries =
      state.docKey && progressMap[state.docKey]
        ? { [state.docKey]: progressMap[state.docKey] }
        : {};
  }
  patchProgressDelta(entries, true);
}

/**
 * Push `entries` as a ts-merge DELTA (PATCH `_op:progress_merge`). The server
 * keeps the newer `ts` per book, so this never regresses another book and can't
 * clobber the store the way a whole-blob PUT could. Best-effort / fire-and-forget
 * (used on pagehide): the durable localStorage + IndexedDB copy (dirty flag) plus
 * Background Sync / the next boot pull are the safety net, so we deliberately
 * don't touch the banner / dirtyVersion bookkeeping here. No-op before the GET
 * merged (same gate as flushProgressStore).
 */
function patchProgressDelta(entries, keepalive) {
  if (!progressReady) return;
  return apiFetch(API_BASE + PROGRESS_KEY, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    keepalive: !!keepalive,
    body: JSON.stringify({ _op: "progress_merge", entries }),
  }).catch(() => {
    /* offline — durable copy + Background Sync / next boot pull will push it */
  });
}

/* ===================== `openedTs`: the shelf's sort key =====================
 * "Libros abiertos" is ordered by WHEN EACH BOOK WAS LAST OPENED, and by nothing
 * else. It used to be ordered by `ts` — the last-edit stamp — so 🧹 limpiar, ✅
 * terminado, a position save, even another device's push, all yanked a row to the
 * top: the list reshuffled under your finger every time you touched a book.
 *
 * So the open time is its own field. `registerOpenBook` (activateDoc → every real
 * open) is the ONLY thing that advances it; every other edit must PRESERVE it,
 * which is what `pinOpened` guarantees for entries written before this field
 * existed (they'd otherwise fall back to `ts` and drift on the next edit).
 */

/** Freeze a legacy entry's place on the shelf BEFORE an edit bumps its `ts`:
 *  with no `openedTs` its order falls back to `ts`, so the edit itself would move
 *  the row. Pinning the CURRENT `ts` as the open time keeps it where it is.
 *  No-op once the entry carries a real `openedTs`. */
function pinOpened(e) {
  if (e && typeof e === "object" && !e.openedTs) e.openedTs = e.ts || Date.now();
}

/** When a book was last opened (0 if never tracked). The "libros abiertos" sort
 *  key — the shelf is cross-device, so this is the last open on ANY device (the
 *  merge keeps the larger). Falls back to `ts` for entries written before the
 *  field existed, so an untouched shelf still reads sensibly after the upgrade. */
export function openedTsFor(docKey) {
  const v = docKey && progressMap[docKey];
  if (!v || typeof v !== "object") return 0;
  return v.openedTs || v.ts || 0;
}

/**
 * Register a just-OPENED catalog book on the shared "en curso" shelf right away,
 * so another device/instance sees it the moment you open it — not only after the
 * first playback saveProgress fires. Creates a progress entry (carrying its
 * `src`) ONLY when none exists yet, so a further-along position already pushed by
 * another device is never regressed. Local uploads (no `src`) don't sync — the
 * rare exception.
 *
 * An ALREADY-tracked book is a RE-open: restamp `openedTs` (which is what moves
 * it to the top of the shelf) and touch nothing else. That is safe even before
 * the server GET has merged — `openedTs` is max-merged, not ts-merged, so it can
 * never win the entry and clobber a position this device hasn't seen yet.
 *
 * A TOMBSTONE (the book was trashed) is NOT a re-open of a live entry: fall
 * through to CREATE a fresh live entry, whose fresh `ts` beats the tombstone in
 * the merge and resurrects the book on every device — trashing then re-opening
 * brings the book back, as it should.
 */
export function registerOpenBook(doc) {
  if (!doc || !doc.docKey || !doc.src) return;
  const prev = progressMap[doc.docKey];
  if (prev && !prev.deleted) {
    prev.openedTs = Date.now(); // top of the shelf; pos/pct/ts/done all stand
    // A re-open ASSIGNS the book to the shelf it was opened from (handleFiles
    // already restamped `doc.mode`), so carry that onto the synced entry HERE
    // rather than waiting for the first position save — until this ran, the two
    // shelves disagreed across devices for as long as the book sat unplayed.
    //
    // `mode` rides the whole entry in the ts-merge, so a shelf move must bump
    // `ts` to win it — and bumping `ts` is only safe once the server GET has
    // merged, or this device's older position would ride up with it and clobber
    // a further-along one it hasn't seen. Not ready ⇒ leave it; the first
    // saveProgress carries `doc.mode` up anyway.
    const want = normMode(doc.mode);
    if (progressReady && doc.mode && want !== normMode(prev.mode)) {
      prev.mode = want;
      prev.ts = Date.now();
    }
    pushProgressStore();
    return;
  }
  // Wait for the server GET to merge before CREATING an entry. Before that,
  // progressMap holds only this device's localStorage, so a new entry (with a
  // fresh ts) could WIN the ts-based merge and clobber a further-along position
  // another device pushed. A book opened during this brief pre-merge window is
  // still registered by the 5 s saveProgress once the map is ready.
  if (!progressReady) return;
  const chunks = doc.chunks || [];
  const pos = chunks.length
    ? chunks[Math.min(doc.curChunk || 0, chunks.length - 1)].start
    : 0;
  const ts = Date.now();
  progressMap[doc.docKey] = {
    title: doc.name || doc.docKey,
    src: doc.src,
    pct: docPct(doc),
    pos,
    total: doc.charTotal || 0,
    ts,
    openedTs: ts, // first open — and the only stamp that orders the shelf
    // The DOC's shelf, never this device's current view: handleFiles stamps
    // `doc.mode` at every real open, so the only docs reaching here without one
    // are pre-feature ones, and those are night by contract (see mode.js).
    mode: normMode(doc.mode),
  };
  pushProgressStore();
}

/**
 * Catalog books in progress on ANY device: synced entries that carry a `src`
 * catalog path and aren't already loaded locally (whose docKeys are passed in
 * `localKeys`). The en-curso modal renders these as "reopen from the library"
 * rows. LAST-OPENED first — never last-EDITED (see the `openedTs` block above):
 * sorting on `ts` meant a 🧹 / ✅ / auto-save jumped the row it touched to the
 * top and the shelf reshuffled itself as you used it.
 *
 * FINISHED books are INCLUDED, flagged `done`. ✅ marks a book read; it does not
 * take it off the shelf (it used to, so ticking ✅ made the row vanish — while a
 * LOCAL row stayed, greyed. The two shelves must read the same). Only 🗑 removes
 * a book from "abiertos". Callers that want just the live ones — the offline
 * buffer's pin list — filter on `done` themselves.
 */
export function getSyncedOpenBooks(localKeys) {
  const skip = localKeys instanceof Set ? localKeys : new Set(localKeys || []);
  return Object.entries(progressMap)
    .filter(([k, v]) => v && typeof v === "object" && !v.deleted && v.src && !skip.has(k))
    .map(([docKey, v]) => ({
      docKey,
      src: v.src,
      title: v.title || docKey,
      pct: Math.round(v.pct || 0),
      mode: normMode(v.mode), // day/night shelf (missing ⇒ night)
      done: entryFinished(v), // 📖 leído (or read to 100%) → greyed, still listed
      recent: entryRecent(v), // ✅ in the "Terminados recientemente" inbox
      openedTs: openedTsFor(docKey), // shelf order — see encurso.js#sortByLastOpened
    }))
    .sort((a, b) => b.openedTs - a.openedTs);
}

/**
 * Progress entries that carry no catalog `src` — the books that CAN'T sync to
 * another device's "libros abiertos" shelf (a remote row needs a src to know
 * which library file to re-download). catalog.js matches each `title` (the
 * stored filename) back to the catalog and heals the ones it can via
 * `backfillSrcs`. Returns `{docKey, title}` for every src-less entry (finished or
 * not — healing the identity is always safe and also fixes the terminados set).
 */
/**
 * Every live progress entry as `{docKey, title, pct, mode, ts}`, MOST RECENTLY
 * READ first (`ts` is stamped by saveProgress, so it means "last position
 * change", not "last opened" — which is exactly "the book I'm on now, then the
 * one before it").
 *
 * Unlike `getSyncedOpenBooks` this does NOT require a catalog `src`: the 📈
 * reading log cares about what you have been reading, including a book
 * side-loaded from the phone, and it never has to re-download anything.
 */
export function recentlyReadBooks() {
  return Object.entries(progressMap)
    .filter(([, v]) => v && typeof v === "object" && !v.deleted)
    .map(([docKey, v]) => ({
      docKey,
      title: v.title || docKey,
      pct: Math.round(v.pct || 0),
      mode: normMode(v.mode),
      ts: v.ts || 0,
    }))
    .sort((a, b) => b.ts - a.ts);
}

export function openBookKeysMissingSrc() {
  return Object.entries(progressMap)
    .filter(([, v]) => v && typeof v === "object" && !v.deleted && !v.src)
    .map(([docKey, v]) => ({ docKey, title: v.title || docKey }));
}

/**
 * Deposit a recovered catalog `src` onto existing entries and push the delta, so
 * a book stranded without a src (opened before src-stamping, via the folder-
 * browse fallback, or dropped by the old asymmetric merge) finally syncs as a
 * cross-device open-book row. `pairs` is `[{docKey, src}]`.
 *
 * Deliberately does NOT bump `ts`: this adds an identity field, not a newer
 * reading edit, so it must never win the ts merge over another device's fresher
 * position. The symmetric-src merges (client `mergeServerMap` + the server
 * `progress_merge`) adopt a missing `src` regardless of which side's `ts` wins,
 * so an equal-ts (or even older) push still deposits the path without regressing
 * anyone's position.
 */
export function backfillSrcs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return;
  const delta = {};
  for (const { docKey, src } of pairs) {
    const e = docKey && progressMap[docKey];
    if (!e || typeof e !== "object" || e.src || !src) continue;
    e.src = src;
    delta[docKey] = e;
  }
  if (!Object.keys(delta).length) return;
  persistLocalMap();
  patchProgressDelta(delta, false); // best-effort; no-op until the GET merged
}

/**
 * Forget a book's progress everywhere — the 🗑 "trash" action: closing a book
 * for good. Drops the cross-device entry (synced shelf + server) AND this
 * device's local reading position, so reopening the book from the library starts
 * genuinely fresh instead of silently resuming where it was. The per-device
 * position purge matters for the NOT-loaded path (a ☁ remote row, or a catalog
 * card whose doc was evicted): removeDocSilent already clears the position for a
 * loaded doc, but a book trashed without being loaded used to keep its stale
 * `LS_POS_PREFIX` offset and resume on the next open.
 */
export function dropProgress(docKey) {
  if (!docKey) return;
  try {
    localStorage.removeItem(LS_POS_PREFIX + docKey);
  } catch (_) {}
  // Write a TOMBSTONE, don't hard-delete. A key simply MISSING from this device's
  // map is indistinguishable from "not uploaded yet", so any OTHER device still
  // holding the book would re-push it (the additive progress_merge never removes
  // a key) and resurrect it on the next refresh. A `{deleted:true}` marker with a
  // fresh `ts` instead rides the SAME ts-merge as every edit: the newer tombstone
  // wins on every device that pulls it — dropping the book from the shelf — and no
  // device re-adds it. Re-opening the book later stamps a newer `ts` and brings it
  // back, which is exactly what a re-open should do. (See progress-merge.js.)
  progressMap[docKey] = { deleted: true, ts: Date.now() };
  unsynced = true; // the tombstone is a pending edit until the server confirms it
  dirtyVersion++; // so an in-flight PUT of an older snapshot can't clear the banner
  persistLocalMap(); // AFTER the flag: it mirrors `unsynced` into IndexedDB (see pushProgressStore)
  // Flush NOW rather than on the 2 s debounce: a delete is a discrete action, and
  // the sooner its tombstone lands the sooner it removes the book on every device.
  // Rides the normal additive merge (no special delete path); durable offline and
  // re-pushed on the next flush / boot / Background Sync if this attempt can't land.
  flushProgressStore();
}

/** True if a docKey has been trashed (a tombstone in the synced map). The
 *  en-curso shelf hides a locally-LOADED doc whose book was trashed on another
 *  device with this: the tombstone alone hides the ☁ remote rows (they're built
 *  from the map), but a doc still in `state.docs` renders from that list, so it
 *  needs the same gate until `reconcileDroppedDocs` evicts it. */
export function isDropped(docKey) {
  return isTombstone(docKey && progressMap[docKey]);
}

/** After a server merge, a book LOADED here may have been trashed on another
 *  device (now a tombstone). The shelf already hides it (isDropped), but the doc
 *  still sits in `state.docs` holding a MAX_DOCS slot + its IndexedDB text, so ask
 *  the library to evict it — except the one currently PLAYING (yanking a book
 *  mid-listen would be hostile; a live save resurrects it with a newer `ts`
 *  instead). Fired as an event so progress.js needn't import library.js, which
 *  imports us (main.js wires it to `evictDroppedDoc`). */
function reconcileDroppedDocs() {
  try {
    const keys = (state.docs || [])
      .filter((d, i) => i !== state.active && isTombstone(progressMap[d.docKey]))
      .map((d) => d.docKey);
    if (keys.length) {
      document.dispatchEvent(
        new CustomEvent("audiobooks:dropped", { detail: { keys } }),
      );
    }
  } catch (_) {}
}

/** After a server merge, a book LOADED here may sit BEHIND the place another
 *  device has already read to. The en-curso row has always adopted that furthest
 *  point when you tap it; the BOOT restore never did — it opened the book at this
 *  device's own (older) offset, which is how a reopened laptop used to sit at 25%
 *  while the phone had read on to 60%. So ask the library to adopt it, on the same
 *  event channel as `audiobooks:dropped` (fired as an event so progress.js needn't
 *  import library.js, which imports us — main.js wires it to `adoptAheadDocs`).
 *
 *  The book playback is ENGAGED on — playing or paused — is excluded: yanking the
 *  reader mid-sentence would be hostile, and its own next save legitimately wins
 *  the merge anyway. The boot case has never started, so it always applies there.
 *
 *  Runs on every successful pull, because the pull and the library restore race
 *  at boot — `activateDoc` adopts too, for the pull-lands-first ordering. Both are
 *  idempotent: they only ever move a book FORWARD, and only when the synced place
 *  is genuinely ahead. */
function reconcileAheadDocs() {
  try {
    // PLAYING *or* PAUSED. The playing case was always excluded — yanking the
    // reader mid-sentence is hostile — but a PAUSED book is the same book with
    // the same ▶ under the same thumb, and a pull that lands during the pause
    // moved it anyway: the progress bar jumped, the resume point moved, and
    // nothing on screen said why. `state.speaking` stays true across a pause, so
    // it is exactly "playback is engaged on this book"; a book that was never
    // started (the boot restore, which is what this reconcile is FOR) still
    // adopts, and so does one that has been stopped outright.
    const engaged = state.speaking;
    const keys = (state.docs || [])
      .filter((d, i) => {
        if (engaged && i === state.active) return false;
        const e = progressMap[d.docKey];
        if (!e || typeof e !== "object" || e.deleted || entryFinished(e)) return false;
        const chunks = d.chunks || [];
        if (!chunks.length) return false;
        const at = chunks[Math.min(d.curChunk || 0, chunks.length - 1)].start;
        return (e.pos || 0) > at;
      })
      .map((d) => d.docKey);
    if (keys.length) {
      document.dispatchEvent(
        new CustomEvent("audiobooks:ahead", { detail: { keys } }),
      );
    }
  } catch (_) {}
}

/**
 * 🧹 "Limpiar progreso" on a LOADED doc: rewind ONLY the reading position — back
 * to the start of the body, 0% — and nothing else. Deliberately KEEPS every other
 * fact about the book: its ✅ finished mark (`done`/`doneTs`) and its hours-played
 * tally (`played`) all stand. Clearing progress is just "rewind"; unmarking
 * finished is the ✅ toggle's job and removing the book entirely is 🗑's. Writes
 * through to localStorage + the json-store mirror with a fresh `ts` so the rewind
 * wins the cross-device merge instead of a stale position resurrecting.
 */
export function resetDocProgress(doc) {
  if (!doc || !doc.docKey) return;
  const key = doc.docKey;
  const pos = doc.bodyStartChar || 0;
  doc.curChunk = chunkAtCharIn(doc.chunks || [], pos);
  doc.chunkOffset = 0; // rewind lands on the paragraph's first word, not mid-word
  const ts = Date.now();
  try {
    localStorage.setItem(
      LS_POS_PREFIX + key,
      JSON.stringify({ pos, off: 0, total: doc.charTotal, ts }),
    );
  } catch (_) {}
  const prev = progressMap[key];
  pinOpened(prev); // 🧹 rewinds the book; it does not re-open it — hold its place
  // Spread `prev` so done/doneTs/played/openedTs survive; only pos/pct/ts change.
  // Drop `deleted`: acting on a loaded doc means the book is alive here, so a
  // rewind resurrects it rather than writing a positioned half-tombstone.
  const { deleted: _wasDropped, ...prevLive } = prev || {};
  progressMap[key] = {
    ...prevLive,
    title: doc.name || prev?.title || key,
    src: doc.src || prev?.src || null,
    pct: 0,
    pos,
    off: 0,
    total: doc.charTotal,
    ts,
    openedTs: prev?.openedTs || ts,
  };
  pushProgressStore();
}

/**
 * 🧹 "Limpiar progreso" on a book that is NOT loaded here (a ☁ cross-device row,
 * or a catalog card whose doc was evicted): rewind ONLY the position to 0% and
 * KEEP everything else — the entry stays on the en-curso shelf, and its ✅ finished
 * mark + hours-played tally all survive (see `resetDocProgress`). 🧹 is rewind-only;
 * 🗑 (`dropProgress`) removes the book, ✅ unmarks finished. (Before, 🧹 on this
 * path called `dropProgress` and yanked the book off the shelf — the operator wants
 * clear to stay put.) Fresh `ts` wins the cross-device merge; the per-device saved
 * position is purged so this device also opens at the first page.
 */
export function resetProgressByKey(key) {
  if (!key) return;
  const prev = progressMap[key];
  if (!prev || typeof prev !== "object") return;
  if (prev.deleted) return; // trashed book: 🧹 is off its (hidden) menu — never un-trash
  const ts = Date.now();
  try {
    localStorage.removeItem(LS_POS_PREFIX + key);
  } catch (_) {}
  pinOpened(prev); // 🧹 rewinds the book; it does not re-open it — hold its place
  // Spread `prev` so done/doneTs/played/openedTs survive; only pos/off/pct/ts change.
  progressMap[key] = { ...prev, pct: 0, pos: 0, off: 0, ts };
  pushProgressStore();
}

/**
 * The cross-device progress entry for a docKey (as merged from the json store),
 * or null. The en-curso shelf uses it so a LOCAL row reflects a position that
 * ANOTHER device pushed further along — the merge already keeps the newer-`ts`
 * side, so `pos` here is the furthest point reached on any device.
 */
export function syncedProgressFor(docKey) {
  const v = docKey && progressMap[docKey];
  if (!v || typeof v !== "object" || v.deleted) return null;
  return {
    pos: v.pos || 0,
    // The WORD inside that paragraph. Callers that adopt another device's place
    // (encurso's ahead-row, library's adoptAheadPlace) want the word too, not
    // just the paragraph — without it they silently resumed at the paragraph's
    // first word, re-reading whatever the other device had already spoken.
    off: typeof v.off === "number" ? v.off : 0,
    pct: Math.round(v.pct || 0),
    total: v.total || 0,
    ts: v.ts || 0,
  };
}

// Connectivity returned mid-session → re-pull (merge the server's copy first),
// then push. Pulling before pushing lets a session that BOOTED offline
// (progressReady still false) start syncing safely instead of overwriting
// entries it never read.
try {
  window.addEventListener("online", async () => {
    const ok = await pullServerMap();
    persistLocalMap();
    if (ok) flushProgressStore();
    else if (unsynced) scheduleSyncRetry();
  });
} catch (_) {}

// Tapping the banner forces an immediate pull-then-push instead of waiting out
// the SYNC_RETRY_MS tick — for "I'm back online but the banner is still up and I
// want to poke it". `navigator.onLine` flipping true is not enough to prove the
// sync server is reachable, so we don't auto-fire on that; the tap is the user
// asserting the network is back. Same round-trip as the `online` handler; the
// fetch outcome re-derives lastFailWasNetwork, so the banner text self-corrects.
export function retrySyncNow() {
  if (!unsynced) {
    syncConfirmed();
    return;
  }
  showSyncBanner("🔄 Reintentando…");
  // Same one-at-a-time rule as the timer, and for the same reason: a banner that
  // sits there saying "reintentando" invites a second and a third tap, and each
  // one used to stack another ~19 s round-trip onto the pile that wedges the
  // shell's request pool. The tap that lands while one is running is answered by
  // the one already running.
  if (syncRetryInFlight) return;
  syncRetryInFlight = true;
  pullServerMap()
    .then((ok) => {
      persistLocalMap();
      if (ok) flushProgressStore();
      else showSyncBanner(syncBannerText()); // still stuck — restore the cause text
    })
    .finally(() => {
      syncRetryInFlight = false;
    });
}
try {
  const banner =
    typeof document !== "undefined" && document.getElementById("syncBanner");
  if (banner) banner.addEventListener("click", retrySyncNow);
} catch (_) {}

/** Immediate (non-debounced) push of the whole map as a ts-aware MERGE — never a
 *  destructive whole-blob PUT. The server folds each book in keeping the newer
 *  `ts` (storage.js's `progress_merge` op), so a stale or half-loaded in-memory map can
 *  only ADD or advance books; it can NEVER shrink the store. This is the fix for
 *  "a page refresh overwrote my open books with a smaller set" — a live device
 *  that re-pushed its partial map used to wipe every book it hadn't loaded.
 *  Deletions ride this SAME merge as `{deleted:true}` tombstones (a newer one
 *  removes the book everywhere; there is no destructive delete path). No-op
 *  until the GET merged. On a confirmed 200 the map is reconciled on the server →
 *  clear the banner; on a failure (offline / 5xx) nag + retry until it lands. */
function flushProgressStore() {
  if (!progressReady) return;
  const sentVersion = dirtyVersion; // the edit-version this push will carry
  apiFetch(API_BASE + PROGRESS_KEY, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    keepalive: document.visibilityState === "hidden",
    body: JSON.stringify({ _op: "progress_merge", entries: progressMap }),
  })
    .then((r) => {
      lastFailWasNetwork = false; // the server answered — it's reachable
      // Clear the flag only if nothing was edited after this push serialized —
      // else a newer edit is still pending and its own flush must confirm it.
      if (r && r.ok) {
        if (sentVersion === dirtyVersion) syncConfirmed();
      } else scheduleSyncRetry();
    })
    .catch(() => {
      /* offline — localStorage holds it; nag + retry until data returns */
      lastFailWasNetwork = true; // fetch rejected → sync server unreachable (or no network)
      scheduleSyncRetry();
    });
}

// One-shot listeners fired by syncConfirmed(). The reload gate uses this to wait
// out an in-flight push instead of killing it mid-flight.
const syncConfirmedCbs = new Set();

/** A PUT confirmed the whole map is on the server: clear the banner + retry. */
function syncConfirmed() {
  unsynced = false;
  persistIdbMap(); // record dirty=false so the SW won't re-push a synced map
  if (syncRetryTimer) {
    clearInterval(syncRetryTimer);
    syncRetryTimer = null;
  }
  hideSyncBanner();
  const cbs = [...syncConfirmedCbs];
  syncConfirmedCbs.clear();
  for (const cb of cbs) {
    try {
      cb();
    } catch (_) {}
  }
}

/** True while the local map holds edits the server hasn't confirmed — i.e. an
 *  upload is in flight or waiting on connectivity. Callers that are about to
 *  tear the page down (js/reload.js) check this first. */
export function hasUnsyncedProgress() {
  return unsynced;
}

/** Run `cb` once, the next time a push confirms the whole map is on the server.
 *  Never fires if the device stays offline — by design: the caller (a deferred
 *  reload) must not proceed until the upload lands. */
export function onSyncConfirmed(cb) {
  syncConfirmedCbs.add(cb);
}

/**
 * Ask the service worker to push the map when connectivity returns. Chromium
 * fires the SW's `sync` event even while the browser/tab is fully CLOSED, so
 * last night's offline progress can upload BEFORE the app is reopened — the
 * fix for "close Vivaldi, reopen next morning, progress gone". Feature-detected
 * and idempotent (re-registering the same tag coalesces); a graceful no-op where
 * Background Sync is unavailable, since the boot reconcile + visible/pagehide
 * flushes still recover the map on next open. Opportunistic, not a guarantee:
 * an OEM battery manager or a swipe-kill can defer the event until next launch.
 */
function registerBackgroundSync() {
  try {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.sync && reg.sync.register("flush-progress"))
      .catch(() => {});
  } catch (_) {}
}

/**
 * What to tell the user about a push that can't land — "can't sync" has
 * three causes needing three different messages, not one flat "go online":
 *
 *   - `navigator.onLine === false`: the OS says it has no interface, trust
 *     it (the reverse, `=== true`, proves nothing) → enable Internet.
 *   - the fetch REJECTED: the sync-server URL is unreachable though the
 *     device has a network → check the address in Settings.
 *   - the server ANSWERED with a non-ok status (5xx, a sick backend): the
 *     network is fine and there is nothing for the user to reconnect.
 */
// Which of those two the last failed round-trip was. Network (reject) is the
// common case and the one we assume before any evidence lands.
let lastFailWasNetwork = true;

// Every cause text ends with the same tap hint: the banner is clickable and a
// tap forces an immediate retry (retrySyncNow), so a user who knows the network
// is back doesn't have to wait out the timer.
const TAP_HINT = " (toca para reintentar)";
function syncBannerText() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "🔄 Guardando progreso… activa Internet para sincronizar." + TAP_HINT;
  }
  if (!lastFailWasNetwork) {
    return (
      "🔄 Guardando progreso… el servidor no acepta la sincronización; reintentando." +
      TAP_HINT
    );
  }
  return (
    "🔄 Guardando progreso… no se alcanza el servidor de sincronización." +
    TAP_HINT
  );
}

/**
 * ONE ROUND-TRIP AT A TIME. The tick is 6 s and a round-trip against a Pi that
 * is not answering costs far more than that — under the shell an /api call is
 * budgeted 8 s, plus a face re-race and one retry, so about 19 s. The interval
 * fired anyway, so every tick added a pull AND a push to a pile that never
 * drained: measured on the phone, the shell's whole origin stopped answering —
 * not just /api, but the app's own assets and the launcher chip's `/__pihome`,
 * because Android hands `shouldInterceptRequest` a bounded pool of threads and
 * every one of them was parked in `connect`. The reader was left in an app that
 * could not load a file and had no way out.
 *
 * So a tick that finds the previous one still in flight does nothing but re-render
 * the banner. That is not a rate limit bolted on — it is what "retry" meant all
 * along: there is one thing to say to the server and no reason to say it twice at
 * once. Cleared in a `finally`, so a rejection cannot wedge the retry loop shut.
 */
let syncRetryInFlight = false;

/**
 * We still hold progress the server hasn't accepted. Show the persistent banner
 * (Internet vs. sync server, see syncBannerText) and keep retrying (pull-then-push)
 * on a timer until a PUT confirms — the automatic stand-in for the removed 🌅 push
 * button. Each tick re-renders the text, so it follows the device flipping between
 * offline and online-but-unsynced without waiting for a sync. No-op once
 * everything is synced.
 */
function scheduleSyncRetry() {
  if (!unsynced) return;
  registerBackgroundSync(); // also let the SW push while the app is closed
  showSyncBanner(syncBannerText());
  if (syncRetryTimer) return;
  syncRetryTimer = setInterval(() => {
    if (!unsynced) {
      syncConfirmed();
      return;
    }
    showSyncBanner(syncBannerText()); // connectivity may have flipped since last tick
    if (syncRetryInFlight) return; // the last tick has not come back yet
    syncRetryInFlight = true;
    pullServerMap()
      .then((ok) => {
        persistLocalMap();
        if (ok) flushProgressStore();
      })
      .finally(() => {
        syncRetryInFlight = false;
      });
  }, SYNC_RETRY_MS);
}

function pushProgressStore() {
  // ORDER IS LOAD-BEARING: the flag first, the persist second. `persistLocalMap`
  // mirrors the map to IndexedDB *together with* `unsynced` (as `dirty`), and the
  // service worker's Background Sync handler pushes ONLY when it reads
  // `dirty:true` (sw.js flushProgressOnSync). Persisting first wrote the freshly
  // edited map under a STALE `dirty:false`, so the first edit after a synced state
  // — go offline, jump a chapter, close the tab — left the SW with edits it
  // believed were already confirmed and it never pushed them. (A second edit
  // papered over it, since `unsynced` was true by then; the single-edit-then-close
  // case did not.) Nothing was lost — the next open re-pushes — but the whole
  // point of the SW sync is to upload BEFORE the app is reopened.
  unsynced = true; // an edit is pending server confirmation (drives the banner)
  dirtyVersion++; // so an in-flight PUT of an older snapshot won't clear it
  persistLocalMap(); // durable regardless of network
  if (!progressReady) return; // wait for the GET so we don't drop other entries
  if (progressTimer) clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    progressTimer = null;
    flushProgressStore();
  }, PROGRESS_DEBOUNCE_MS);
}

/** Character offset of the current chunk's start. */
export function curCharPos() {
  if (!state.chunks.length) return 0;
  return state.chunks[Math.min(state.curChunk, state.chunks.length - 1)].start;
}

/** First chunk in `arr` whose text extends past `pos`. */
export function chunkAtCharIn(arr, pos) {
  let idx = arr.findIndex((c) => c.end > pos);
  if (idx === -1) idx = arr.length - 1;
  return Math.max(0, idx);
}

export function chunkAtChar(pos) {
  return chunkAtCharIn(state.chunks, pos);
}

/**
 * A saved word offset (`off`), clamped to the chunk it will actually be spoken
 * from.
 *
 * `off` was only ever valid for the chunk its `pos` named, and chunking is
 * REBUILT on every load — a retuned MIN_CHUNK/MAX_CHUNK, or a chapter boundary
 * that wasn't there before, can hand the same `pos` a shorter paragraph. Clamp
 * rather than trust: the worst case is resuming a little early in the right
 * paragraph, never mid-way through the wrong one.
 */
export function clampOffset(chunk, off) {
  const len = chunk?.text?.length || 0;
  return Math.max(0, Math.min(Math.floor(off) || 0, len));
}

/** Persist the active doc's position to localStorage (+ mirror to docs[]). */
/**
 * Minutes of listening a span of `chars` represents in the CURRENT book at the
 * CURRENT speed — the same model the player's ⏱ readout uses (BASE_WPM × rate,
 * through the book's own average chars-per-word), so a night logged as "+45 min"
 * is 45 minutes of that clock. No book loaded / no word count yet ⇒ the 6
 * chars-per-word fallback shared with player.js#rewindMinutes.
 */
function minutesForChars(chars) {
  const rateEl = $("rate");
  const rate = Number.parseFloat(rateEl?.value) || 1;
  const cpw = state.totalWords > 0 ? state.charTotal / state.totalWords : 6;
  return chars / cpw / (BASE_WPM * rate);
}

export function saveProgress() {
  if (!state.docKey) return;
  if (state.active >= 0) {
    state.docs[state.active].curChunk = state.curChunk;
    state.docs[state.active].chunkOffset = state.chunkOffset;
  }
  const pos = curCharPos();
  // The WORD inside that paragraph (see state.chunkOffset). `pos` alone only
  // ever names a paragraph start, so saving it alone is what made a pause resume
  // from the top of the paragraph. Kept as its OWN field rather than folded into
  // `pos`: `pos` indexes `fullText`, while `off` indexes the chunk's collapsed
  // spoken text — different coordinate spaces, not addable. `off` is only
  // meaningful for the chunk `pos` resolves to, and is re-clamped on load.
  const off = state.chunkOffset || 0;

  // Feed the per-night reading log (js/progresslog.js) with how far we moved
  // since the last save — `prev.pos` below is the only record of where we were,
  // and it is about to be overwritten.
  //
  // This runs BEFORE the "nothing moved" guard, and hands over the RAW delta
  // (negative included), on purpose. A jump's own save is the one `noteSeek`
  // suppresses, so that save has to reach `noteRead` to consume the suppression
  // — otherwise a backward jump (or one that lands where we already were, which
  // returns at the guard) would leave it pending and swallow the next genuine
  // step of reading instead. `noteRead` itself ignores anything that isn't
  // plausible playback drift, so a negative or zero delta costs nothing.
  //
  // The live playback state rides along because that is what decides whether
  // these minutes were LISTENED to at all: a save taken while stopped or paused
  // is someone moving through the book, not hearing it. `state.speaking` stays
  // true across a pause (see reconcileAheadDocs), so "playing" is the pair.
  //
  // A tombstone carries no usable baseline, so a resurrect starts fresh.
  const prev = progressMap[state.docKey];
  if (prev && typeof prev === "object" && !prev.deleted && typeof prev.pos === "number") {
    const playing = state.speaking && !state.paused;
    noteRead(state.docKey, minutesForChars(pos - prev.pos), Date.now(), playing);
  }

  // NOTHING MOVED ⇒ NOTHING TO SAY. This guard is what stops an open-but-idle
  // app from destroying another device's reading.
  //
  // `saveProgress` runs every 5 s off a watchdog (main.js), whether or not the
  // reader is playing. It used to stamp a FRESH `ts` every time — even when the
  // position was identical — and push it. Since every merge (client
  // `mergeServerMap` AND the server's `progress_merge`) keeps the newer `ts` per
  // book, an idle tab re-crowned itself the newest writer every 5 seconds and so
  // permanently outranked a device that was ACTUALLY READING. Measured live: a
  // laptop left open at 25% wiped a phone that had read on to 60% within a second
  // of being reopened, and kept overwriting it every 5 s while it sat there.
  //
  // A position that has not changed carries no news, so it must not win a merge.
  // Note `played` (addPlayed) and `openedTs` (registerOpenBook) are merged
  // monotonically, independent of `ts`, so neither needs this save to fire.
  if (
    prev &&
    typeof prev === "object" &&
    !prev.deleted && // a tombstone MUST be overwritten by a live save (resurrect)
    prev.pos === pos &&
    (prev.off || 0) === off
  ) {
    return;
  }

  const ts = Date.now();
  try {
    localStorage.setItem(
      LS_POS_PREFIX + state.docKey,
      JSON.stringify({ pos, off, total: state.charTotal, ts }),
    );
  } catch (_) {}
  // Mirror to json-store so the "en curso" modal syncs across devices. Preserve
  // any prior `done`/`src`; stamp `src` (catalog path) when this doc came from
  // the raspi library so other devices can reopen it.
  const doc = state.active >= 0 ? state.docs[state.active] : null;
  pinOpened(prev); // reading a book doesn't RE-open it — the shelf order stands
  // Drop `deleted` off the spread: if the book was trashed on another device
  // while this device kept it active, a genuine position save (fresh `ts`) means
  // it's alive here — resurrect it rather than write a half-tombstone.
  const { deleted: _wasDropped, ...prevLive } = prev || {};
  progressMap[state.docKey] = {
    ...prevLive,
    title: doc ? doc.name : prev?.title || state.docKey,
    src: doc?.src || prev?.src || null,
    pct: Math.round(curPct()),
    pos,
    off,
    total: state.charTotal,
    ts,
    // No entry yet (the book was opened before the server GET merged, so
    // registerOpenBook stood down): this save is its first record, so it also
    // carries the open time.
    openedTs: prev?.openedTs || ts,
    // The live doc's shelf wins (an open re-stamps it); else keep the existing
    // one; else NIGHT — never this device's current view.
    //
    // It used to fall back to `currentMode()`, which silently MOVED books
    // between shelves: every doc stored before the day/night split carries
    // `mode: null` (db.js) and nothing migrates them, so reading one — this save
    // runs off a 5 s watchdog — while the modal happened to be toggled to día
    // reassigned it to the day shelf on every device, silently migrating the very
    // book in front of you. The shelf is moved deliberately now (the 🌙⇄☀️ button →
    // setDocMode), never as a side effect of a save. No mode ⇒ night (mode.js).
    mode: normMode(doc?.mode || prev?.mode),
  };
  pushProgressStore();
}

/* ===================== two independent "read" bits =====================
 * A book carries TWO separate, independently-togglable flags — they must never be
 * conflated (a mistake on one is un-doable without touching the other):
 *
 *  - `done`  = 📖 "Leído" — the durable library record. Powers the catalog 📖
 *              Leídos filter (isSrcFinished / entryFinished, which also counts a
 *              genuine 100%) and keeps the book out of the 🎲 random pool. Forever,
 *              until un-marked. Toggle: markDocFinished / unmarkDocFinished.
 *  - `recent`= ✅ "Leído recientemente" — the transient en-curso inbox ("Terminados
 *              recientemente" fold). Toggle: markDocRecent / unmarkDocRecent.
 *
 * Manual marks touch ONE bit each. Only the AUTOMATIC finish (playing a book to the
 * end, `markDocRead`) sets BOTH: you've read it (library) AND just closed it out
 * (inbox). Legacy entries predate `recent` — `migrateRecentEntries` (run on load
 * and after every server merge) derives it once from the old `done && !triaged`
 * inbox rule and drops the retired `triaged` bit, so from then on `recent` is an
 * explicit boolean on every entry and nothing falls back to guessing.
 */

/**
 * 📖 Leído — flag a doc read in the library. The fresh `ts` lets it win the
 * cross-device merge (see mergeServerMap). Touches ONLY `done`, never `recent`.
 *
 * We DON'T pin `pct` to 100 here: `done` is the explicit-finish signal on its
 * own, and a forced 100 made a mid-book manual mark read "100%" then open where
 * it really was (the same lie 588b4d926 fixed for the list). Leaving `pct` as
 * the real position also lets `unmarkDocFinished` cleanly revert — a book you
 * never actually read to the end stops counting as finished the moment the flag
 * is cleared (see `entryFinished`, which treats a genuine 100% as finished too).
 */
export function markDocFinished(docKey) {
  if (!docKey) return;
  if (progressMap[docKey]?.deleted) return; // trashed: don't finish a tombstone
  const e = progressMap[docKey] || (progressMap[docKey] = { title: docKey, recent: false });
  pinOpened(e); // 📖 closes the book out; it doesn't re-open it — hold its place
  e.done = true;
  e.doneTs = Date.now();
  e.ts = e.doneTs;
  pushProgressStore();
}

/**
 * Clear the 📖 library flag ("desmarcar leído"). Stamps a fresh `ts` so the
 * un-mark wins the merge instead of a stale server `done` resurrecting it. Leaves
 * the reading position AND the ✅ `recent` bit untouched (the two are independent).
 */
export function unmarkDocFinished(docKey) {
  const e = docKey && progressMap[docKey];
  if (!e || !e.done) return;
  pinOpened(e); // un-📖 is a mark, not an open — hold the row's place on the shelf
  delete e.done;
  delete e.doneTs;
  e.ts = Date.now();
  pushProgressStore();
}

/** True if `docKey` is 📖 leído in the library (best-effort; false until GET). */
export function isDocFinished(docKey) {
  return !!(docKey && progressMap[docKey] && progressMap[docKey].done);
}

/** True if `docKey` reads as finished for the 📖 CUE — the explicit `done` flag OR
 *  a genuine 100% (same truth as `entryFinished`, the catalog 📖 Leídos filter
 *  and the card's ✔ ring). Keeps the 📖 button's green in step with the shelf, so a
 *  book read to the end never shows a grey 📖. The click still toggles `done`. */
export function isDocReadish(docKey) {
  return entryFinished(docKey && progressMap[docKey]);
}

/**
 * The AUTOMATIC finish (player reaches the end past the listened-enough guard):
 * the one path that sets BOTH bits — read in the library AND into the en-curso
 * "recientemente" inbox for triage. Manual ✅/📖 stay one-bit toggles.
 */
export function markDocRead(docKey) {
  if (!docKey) return;
  if (progressMap[docKey]?.deleted) return;
  const e = progressMap[docKey] || (progressMap[docKey] = { title: docKey });
  pinOpened(e);
  e.done = true;
  e.doneTs = Date.now();
  e.recent = true;
  e.ts = e.doneTs;
  pushProgressStore();
}

/** True if `docKey` sits in the en-curso "Terminados recientemente" inbox. */
export function isDocRecent(docKey) {
  return entryRecent(progressMap[docKey]);
}

/** ✅ Leído recientemente — drop a doc into the en-curso inbox. Touches ONLY
 *  `recent`, never `done`; fresh `ts` so it wins the merge. */
export function markDocRecent(docKey) {
  if (!docKey) return;
  if (progressMap[docKey]?.deleted) return;
  const e = progressMap[docKey] || (progressMap[docKey] = { title: docKey, done: false });
  pinOpened(e); // a mark, not an open — hold the row's place on the shelf
  e.recent = true;
  delete e.triaged; // retired legacy bit — never write it again
  e.ts = Date.now();
  pushProgressStore();
}

/** Take a doc OUT of the "Terminados recientemente" inbox (✅ off / 📤 quitar de
 *  recientes — now the same action). Leaves `done` untouched: still 📖 leído. */
export function unmarkDocRecent(docKey) {
  const e = docKey && progressMap[docKey];
  if (!e || !entryRecent(e)) return;
  pinOpened(e);
  e.recent = false;
  delete e.triaged;
  e.ts = Date.now();
  pushProgressStore();
}

/**
 * 🌙⇄☀️ Move a book to the OTHER en-curso estantería (day↔night). Sets the
 * synced entry's `mode` and bumps `ts` so the reassignment WINS the cross-device
 * ts-merge — otherwise a stale server `mode` would ride back up and pull the book
 * onto its old shelf. Touches only `mode` (same one-bit discipline as the ✅/📖
 * marks). The caller also restamps the LOADED doc's `.mode` + `storeDoc`s it, so
 * the local row lands on the new shelf immediately AND survives a reload; this
 * only carries the move to every OTHER device (and to a ☁ remote row with no doc
 * here). Moving is NOT re-opening — `pinOpened` holds the row's place on the new
 * shelf instead of jumping it to the top. See mode.js for the shelf model.
 */
export function setDocMode(docKey, mode) {
  if (!docKey) return;
  if (progressMap[docKey]?.deleted) return; // trashed: don't reshelve a tombstone
  const want = normMode(mode);
  const e = progressMap[docKey] || (progressMap[docKey] = { title: docKey });
  if (normMode(e.mode) === want && e.mode != null) return; // already there
  pinOpened(e); // a shelf move, not an open — hold the row's place
  e.mode = want;
  e.ts = Date.now();
  pushProgressStore();
}

/* ===================== "hours played" finish guard =====================
 * A book counts as genuinely finished only when enough of it was ACTUALLY
 * played — reaching the last paragraph by jumping to the final chapter must not
 * mark it done. So we accumulate the body chars spoken to completion (across
 * every session, since the map is persisted) and gate the auto-mark on that
 * total covering most of the body span. Manual marking bypasses this guard.
 */

/** Fraction of the body span that must have been played for an auto-finish. */
export const FINISH_MIN_FRACTION = 0.7;

/** Add `chars` to a doc's cumulative "actually listened" total. */
export function addPlayed(docKey, chars) {
  if (!docKey || !(chars > 0)) return;
  if (progressMap[docKey]?.deleted) return; // trashed: don't accrue play onto a tombstone
  const e = progressMap[docKey] || (progressMap[docKey] = { title: docKey });
  pinOpened(e); // listening isn't re-opening — hold the row's place on the shelf
  e.played = (e.played || 0) + chars;
  pushProgressStore();
}

/** Cumulative body chars a doc has actually played (0 if never tracked). */
export function getPlayed(docKey) {
  const e = docKey && progressMap[docKey];
  return e && typeof e.played === "number" ? e.played : 0;
}

/**
 * True when the accumulated play time covers enough of `bodySpan` (chars in the
 * real text) to treat an end-of-text as a genuine finish. An unknown/zero span
 * doesn't block the mark (preserves the pre-guard behaviour for odd docs).
 */
export function listenedEnough(docKey, bodySpan) {
  if (!(bodySpan > 0)) return true;
  return getPlayed(docKey) >= FINISH_MIN_FRACTION * bodySpan;
}

/**
 * A progress entry counts as "finished" when it was explicitly marked done OR it
 * reached 100% of the body span (read to the end without the manual mark). The
 * catalog ✔ filter and the random-pick exclusion both use this, so a book you
 * simply read to the end is treated the same as one you ticked "terminado".
 */
export function entryFinished(v) {
  return !!(v && typeof v === "object" && !v.deleted && (v.done || (v.pct || 0) >= 100));
}

/** True if the entry sits in the en-curso "Terminados recientemente" inbox. After
 *  migration every live entry carries an explicit `recent` boolean, so this is a
 *  plain read — no fallback guessing, which is what keeps ✅ and 📖 independent. */
export function entryRecent(v) {
  return !!(v && typeof v === "object" && !v.deleted && v.recent === true);
}

/** One-time, idempotent: give every legacy entry an explicit `recent` bit derived
 *  from the OLD inbox rule (`done && !triaged` — a finished, not-yet-dismissed
 *  book), then drop the retired `triaged`. Runs on load and after each server
 *  merge, so entries arriving from a not-yet-upgraded device are normalised too.
 *  Skips entries that already carry `recent` (the common, post-upgrade case). */
function migrateRecentEntries(map) {
  if (!map || typeof map !== "object") return;
  for (const v of Object.values(map)) {
    if (!v || typeof v !== "object" || v.deleted) continue;
    if (typeof v.recent !== "boolean") v.recent = entryFinished(v) && !v.triaged;
    if ("triaged" in v) delete v.triaged;
  }
}

/**
 * Catalog `src` paths that have been finished — powers the catalog
 * "terminados" ✔ filter and keeps finished books out of the random picks.
 */
export function finishedSrcSet() {
  const s = new Set();
  for (const v of Object.values(progressMap)) {
    if (v && v.src && entryFinished(v)) s.add(v.src);
  }
  return s;
}

/** True if a finished progress entry points at this catalog `src` path. */
export function isSrcFinished(src) {
  if (!src) return false;
  for (const v of Object.values(progressMap)) {
    if (v && v.src === src && entryFinished(v)) return true;
  }
  return false;
}

/**
 * The catalog book behind a docKey — `{src, title}` — or null when the entry is
 * absent or is a local upload (no `src`, so nothing to re-download). Boot uses
 * it to reopen the last-active book when its IndexedDB copy is gone: browsers
 * evict a PWA's IndexedDB under storage pressure (and a fresh device never had
 * it), while this map is mirrored to localStorage AND the server, so the book
 * you were reading survives where its extracted text does not.
 */
export function catalogEntryFor(docKey) {
  const v = docKey && progressMap[docKey];
  if (!v || typeof v !== "object" || v.deleted || !v.src) return null;
  return { src: v.src, title: v.title || docKey };
}

/** Whether the server GET has merged — i.e. the map is safe to derive a boot
 *  restore from (before it, the map holds only this device's localStorage). */
export function isProgressReady() {
  return progressReady;
}

/**
 * The most-recently-touched in-progress catalog book on ANY device —
 * `{docKey, src, title}` — the boot restore's fallback when this device's own
 * localStorage sources (the active key + its saved position) were wiped by a
 * full site-data clear. Largest `ts` wins (the last book read/saved anywhere).
 * Needs a catalog `src` — a local upload can't be re-fetched — and skips finished
 * books (reopening one you already read should START it, not park you on its last
 * paragraph) and tombstones. Null when the map holds nothing reopenable.
 */
export function mostRecentSyncedBook() {
  let best = null;
  let bestTs = -1;
  for (const [docKey, v] of Object.entries(progressMap)) {
    if (!v || typeof v !== "object" || v.deleted || !v.src) continue;
    if (entryFinished(v)) continue;
    const ts = v.ts || 0;
    if (ts > bestTs) {
      bestTs = ts;
      best = { docKey, src: v.src, title: v.title || docKey };
    }
  }
  return best;
}

/**
 * The docKey of the progress entry that points at this catalog `src` path, or
 * null. Most-recent (largest `ts`) wins when several devices' entries share a
 * path. Lets the unified book menu clear/remove the progress of a book shown in
 * the catalog list that is in progress on ANOTHER device (so not loaded here,
 * hence no local doc to act on).
 */
export function progressKeyForSrc(src) {
  if (!src) return null;
  let best = null;
  let bestTs = -1;
  for (const [k, v] of Object.entries(progressMap)) {
    if (v && !v.deleted && v.src === src && (v.ts || 0) > bestTs) {
      best = k;
      bestTs = v.ts || 0;
    }
  }
  return best;
}

/**
 * Load a saved reading place for `key` — `{pos, off}` — or null.
 *
 * `pos` is the paragraph (a char index into `fullText`); `off` is the WORD
 * inside it (a char index into that chunk's collapsed spoken text). Both come
 * from ONE source, never mixed: an `off` only means anything next to the `pos`
 * it was saved with.
 *
 * Two sources, in order: this device's own `LS_POS_PREFIX` offset, then — when
 * this device has none — the SYNCED entry's `pos`. The fallback is what makes a
 * book keep its place across an unload: queueing a book drops the local copy
 * (and with it the localStorage offset) but no longer touches the progress
 * entry, so the position has to come from the map when it's reopened. Same for a
 * ☁ book first downloaded here: it now opens where the other device left it,
 * instead of at page one.
 *
 * A pre-`off` record (or another device's) simply reads `off: 0` — the old
 * behaviour, resuming at the top of the paragraph. Nothing needs migrating.
 *
 * A FINISHED entry is deliberately not used as a fallback: reopening a book you
 * already read should start it, not park you on its last paragraph (a device
 * that read it itself still has its own offset, and keeps resuming at the end).
 */
export function loadSavedPlace(key) {
  let local = null;
  try {
    const raw = localStorage.getItem(LS_POS_PREFIX + key);
    if (raw) {
      const d = JSON.parse(raw);
      if (typeof d.pos === "number") {
        local = {
          pos: d.pos,
          off: typeof d.off === "number" ? d.off : 0,
          ts: d.ts || 0,
        };
      }
    }
  } catch (_) {}
  const e = key && progressMap[key];
  const synced =
    e && typeof e === "object" && !e.deleted && !entryFinished(e) && e.pos > 0
      ? { pos: e.pos, off: typeof e.off === "number" ? e.off : 0, ts: e.ts || 0 }
      : null;
  // Both sides exist ⇒ take the NEWER one, don't blindly prefer this device's.
  // The local offset used to win unconditionally, so a device that had been
  // closed while another read on resumed at its OWN stale place — and (before the
  // `saveProgress` no-op guard above) then re-stamped it as newest and pushed it
  // over the fresher position. The stored record carries its own `ts`, so a
  // straight comparison settles it; a tie keeps the local copy (same device,
  // same write — `saveProgress` stamps both with one `ts`).
  if (local && synced) return synced.ts > local.ts ? synced : local;
  return local || synced;
}

/** Just the character position (the paragraph), for callers that want no word. */
export function loadSavedPos(key) {
  const p = loadSavedPlace(key);
  return p ? p.pos : null;
}

/** Current reading progress as a 0–100 percentage, measured over the body span
 * (front/back matter excluded), so 0% = first real chapter, 100% = book end. */
export function curPct() {
  if (!state.charTotal || !state.chunks.length) return 0;
  const start = state.bodyStartChar || 0;
  const end = state.bodyEndChar || state.charTotal;
  const span = end - start;
  if (span <= 0) return (curCharPos() / state.charTotal) * 100;
  return Math.max(0, Math.min(100, ((curCharPos() - start) / span) * 100));
}

/** 1-based page number (over the WHOLE document) containing char `pos`. */
export function pageOfChar(pos) {
  let pg = 1;
  for (let p = 1; p <= state.numPages; p++) {
    if (state.pageCharStarts[p] <= pos) pg = p;
  }
  return pg;
}

/** 1-based page number containing the current position, whole-document. */
export function curPageNum() {
  return pageOfChar(curCharPos());
}

/**
 * The page span of the body, whole-document 1-based and inclusive. The pages
 * that hold only skipped front/back matter are not part of it, so a book whose
 * first real chapter starts on page 9 has `first: 9`.
 */
export function bodyPageSpan() {
  const end = state.bodyEndChar || state.charTotal;
  const start = Math.min(state.bodyStartChar || 0, Math.max(0, end - 1));
  const first = pageOfChar(start);
  const last = Math.max(first, pageOfChar(Math.max(start, end - 1)));
  return { first, last, count: last - first + 1 };
}

/** How many pages the reader is told the book has: body pages only. */
export function bodyNumPages() {
  return bodyPageSpan().count;
}

/** Current page numbered within the body, so page 1 = first real chapter. */
export function curBodyPageNum() {
  const { first, count } = bodyPageSpan();
  return Math.max(1, Math.min(count, curPageNum() - first + 1));
}

/**
 * A stored doc's progress percentage (for the library tabs), body-span based.
 *
 * A doc restored at boot is COLD until something opens it (pdf.js#hydrateStub):
 * no chunks, so no paragraph start to measure from. Rather than force the whole
 * re-chunk just to draw a number — which is exactly the boot work laziness
 * exists to avoid — read the saved char position straight out of localStorage.
 * It is the same offset the chunk start would round down from, so the percentage
 * matches the warm one to within a paragraph.
 */
export function docPct(d) {
  if (!d.charTotal) return 0;
  if (!d.chunks.length) {
    const place = loadSavedPlace(d.docKey);
    return pctAt(d, place && place.pos > 0 ? place.pos : d.bodyStartChar || 0);
  }
  return pctAt(d, d.chunks[Math.min(d.curChunk, d.chunks.length - 1)].start);
}

/** Shared body-span maths for `docPct`, warm or cold. */
function pctAt(d, pos) {
  const start = d.bodyStartChar || 0;
  const end = d.bodyEndChar || d.charTotal;
  const span = end - start;
  if (span <= 0) return Math.round((pos / d.charTotal) * 100);
  return Math.max(0, Math.min(100, Math.round(((pos - start) / span) * 100)));
}
