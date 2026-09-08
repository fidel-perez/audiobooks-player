/**
 * IndexedDB persistence for extracted-text documents.
 *
 * We store the *extracted text* (not the PDF bytes) plus page offsets and
 * chapters, keyed by `docKey`. Re-opening the app rehydrates the library
 * without re-parsing the PDFs.
 */

import { DB_NAME, DB_VERSION, STORE, META_STORE, FILE_STORE } from "./config.js";

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      // Guard-create both stores. An upgrade transaction never drops a store you
      // don't explicitly delete, so existing `docs` (extracted text) survive the
      // v1→v2 bump. Whichever connection wins the upgrade (page OR service
      // worker) must be able to create both — hence both guards here.
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "docKey" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: "path" });
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      // If another tab/worker later opens a higher version, close this
      // connection so its upgrade isn't blocked (avoids a wedged onblocked).
      db.onversionchange = () => db.close();
      res(db);
    };
    r.onerror = () => rej(r.error);
  });
}

export async function idbPut(obj) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(obj);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function idbGetAll() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const rq = tx.objectStore(STORE).getAll();
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  });
}

export async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function idbClear() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Read a value from the small key/value META_STORE (or undefined). Used for
 *  the SW-readable progress mirror (localStorage isn't reachable from a SW). */
export async function idbGetMeta(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(META_STORE, "readonly");
    const rq = tx.objectStore(META_STORE).get(k);
    rq.onsuccess = () => res(rq.result ? rq.result.v : undefined);
    rq.onerror = () => rej(rq.error);
  });
}

/** Write a value into the META_STORE under key `k` (stored as `{k, v}`). */
export async function idbSetMeta(k, v) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ k, v });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---- FILE_STORE: the offline book buffer (raw EPUB/PDF bytes) ---- */

/** Store a downloaded book file under its catalog path. `rec` is {path,name,blob,ts}. */
export async function idbPutFile(rec) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).put(rec);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** The stored record for a catalog path, or undefined. */
export async function idbGetFile(path) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(FILE_STORE, "readonly");
    const rq = tx.objectStore(FILE_STORE).get(path);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

/** Every buffered catalog path (keys only — the blobs stay on disk). */
export async function idbFileKeys() {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(FILE_STORE, "readonly");
    const rq = tx.objectStore(FILE_STORE).getAllKeys();
    rq.onsuccess = () => res(rq.result || []);
    rq.onerror = () => rej(rq.error);
  });
}

/** Drop one buffered file (it was opened, unqueued, or filtered out). */
export async function idbDeleteFile(path) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(FILE_STORE, "readwrite");
    tx.objectStore(FILE_STORE).delete(path);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/**
 * Persist the durable slice of a hydrated doc (chunks are rebuilt on load).
 *
 * A doc restored at boot stays COLD until something opens it (pdf.js#hydrateStub),
 * and a cold doc's `curChunk`/`chunkOffset` are placeholders, not a position.
 * Writing those would rewind the record to paragraph 0 — so when the doc is cold
 * the stored position passes straight through from the record it came from.
 */
export function storeDoc(d) {
  const cold = d.hydrated === false && d._raw;
  const at = cold ? d._raw : d;
  return idbPut({
    docKey: d.docKey,
    name: d.name,
    size: d.size,
    fullText: d.fullText,
    charTotal: d.charTotal,
    pageCharStarts: d.pageCharStarts,
    numPages: d.numPages,
    chapters: d.chapters,
    curChunk: at.curChunk,
    // The word reached inside that paragraph (see state.chunkOffset): without it
    // a reload resumes at the paragraph's first word. Absent on records written
    // before this existed — they simply read 0, i.e. the old behaviour.
    chunkOffset: at.chunkOffset || 0,
    order: d.order || 0,
    // Catalog path this doc was loaded from (biblioteca books only; null for
    // user-dropped local files). Lets the cross-device "en curso" list reopen
    // it from the raspi library on a device that never had it in IndexedDB.
    src: d.src || null,
    // Author, stashed from the catalog entry at load time, so the author page
    // still resolves after a reload even if the catalog is momentarily
    // unreachable or its paths drifted (see docToBook in biblioteca.js).
    a: d.a || null,
    // Title, same deal — and it's what lets the active-book card paint the REAL
    // title on a cold boot, before (or without) the catalog. Absent it the card
    // falls back to the truncated filename and visibly rewrites itself when the
    // catalog lands. Stamped by the card's catalog pass, so docs stored before
    // this existed heal on their first boot with a reachable catalog.
    t: d.t || null,
    // How this book's card LOOKED the last time the catalog and the favorites
    // blobs were both in hand: {st: rating classes, ac: author count, sg/n:
    // saga, v: provenance}. Same trick as `t`/`a` one line up, for the rest of
    // the card — without it a cold boot paints an undecorated card and then
    // grows the ring, tint, 📚 chip and saga line a few seconds later, when the
    // 14 MB catalog and the four json-store blobs finally answer. Absent on
    // records written before this existed; they heal on the first boot that
    // reaches the catalog. See biblioteca.js#cardFacts.
    card: d.card || null,
    // Day/night shelf this book belongs to (set at open time; null ⇒ night).
    // Persisted so a reload keeps it on the right en-curso shelf (see mode.js).
    mode: d.mode || null,
  });
}
