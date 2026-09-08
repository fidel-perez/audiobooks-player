/**
 * Pure, dependency-free progress-map merge — the single source of truth for how
 * two copies of the `{docKey: {title,src,pct,pos,off?,total,ts,done?,played?,openedTs?}}`
 * map are reconciled (`pos` = the paragraph, `off` = the word inside it).
 * Imported by BOTH the main thread (js/progress.js) and the
 * service worker (sw.js, Background Sync), so the highest-stakes logic can't
 * drift between the two contexts. No DOM / no globals — safe in a worker.
 *
 * DELETIONS are TOMBSTONES, not missing keys. The additive `progress_merge` push
 * can only add/advance books — a key simply ABSENT from a device's map is
 * indistinguishable from "not uploaded yet", so a hard delete on one device is
 * silently re-added by any other device that still holds the book. So 🗑 writes a
 * `{deleted:true, ts}` marker instead: it is a normal ts-merged entry, so a newer
 * tombstone removes the book on every device that pulls it, and a newer real edit
 * (a RE-open) wins back and resurrects it — deletion travelling on the SAME
 * channel as every other edit, with no destructive path the merge can't express.
 */

// Keys that are NOT books. A `progress_merge` PATCH body ({_op, entries}) that
// ever gets stored raw (deep-merged as a plain dict instead of processed) leaves
// these as top-level keys, each masquerading as a book. They must never enter the
// map's logic (or be re-pushed). Real docKeys are `filename_size`, so they can't
// collide with these.
const RESERVED_KEYS = new Set(["_op", "entries"]);

/** True for a plausible progress entry: a string docKey (not a reserved marker)
 *  mapping to a plain object. Deliberately loose — a server-only book may carry
 *  only {pos,ts} — but tight enough to drop `_op`/`entries` pollution and any
 *  non-object value. A tombstone ({deleted:true,ts}) passes: it MUST merge and
 *  propagate like any entry; the read-side `isTombstone` filter hides it. */
export function isValidEntry(k, v) {
  return (
    typeof k === "string" &&
    !RESERVED_KEYS.has(k) &&
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v)
  );
}

/** A deletion tombstone — a `{deleted:true, ts}` entry left by 🗑 in place of a
 *  hard delete (see the module header). Merges + propagates like any entry, but
 *  every READ site (the shelf, the finished set, the src-heal list, resume) must
 *  treat it as absent — this is that guard. */
export function isTombstone(v) {
  return !!(v && typeof v === "object" && v.deleted);
}

/** A shallow copy of `m` keeping only valid book entries — strips `_op`/`entries`
 *  pollution and junk values so it can't leak into the shelf, the finished set,
 *  or a re-push. Applied wherever a map is ingested (localStorage, server GET,
 *  IndexedDB mirror). */
export function sanitizeMap(m) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  for (const [k, v] of Object.entries(m)) {
    if (isValidEntry(k, v)) out[k] = v;
  }
  return out;
}

/**
 * Merge `server` into `target` in place (newer `ts` per book wins) and return
 * `target`. Used both to fold the server blob into the local map and to fold the
 * IndexedDB mirror in at boot.
 *
 * - Cumulative listened chars (`played`) only ever grow, so keep the larger
 *   across devices regardless of which side's `ts` wins the rest of the entry.
 * - `openedTs` (when the book was last OPENED — the "libros abiertos" sort key)
 *   is monotonic too: the shelf shows the last open on ANY device, so keep the
 *   larger, whichever side wins the entry. It must NOT ride on `ts`, or a 🧹 /
 *   ✅ / position save pushed from one device would reshuffle the other's shelf.
 * - Newer `ts` wins the WHOLE entry — including the `done` flag. (An earlier
 *   version OR-preserved `done`, which made it permanent; but "desmarcar
 *   terminado" bumps `ts` so it must be able to clear a stale server `done`.
 *   markDocFinished/unmarkDocFinished both stamp a fresh `ts` so latest intent
 *   wins.)
 * - `src` is a stable IDENTITY fact (which catalog file this book is), not a
 *   position — so it is preserved SYMMETRICALLY: whichever side wins the entry,
 *   if the kept copy has no `src` but EITHER side does, adopt it. (The old code
 *   only covered the server-wins direction; a newer *local* edit that predated
 *   the `src` field silently dropped the path, which is what left in-progress
 *   library books unsyncable across devices — a null-src entry never renders as a
 *   cross-device "libros abiertos" row.)
 * - A TOMBSTONE wins/loses by `ts` like any entry (a newer 🗑 removes the book, a
 *   newer re-open resurrects it). When the winner IS a tombstone, none of the
 *   book fields (src / played / openedTs) are carried onto it — a deletion marker
 *   must not accrete a catalog path or play time and start looking like a book.
 */
export function mergeServerMap(target, server) {
  if (!target || !server || typeof server !== "object") return target;
  for (const [k, sv] of Object.entries(server)) {
    if (!isValidEntry(k, sv)) continue;
    const lv = target[k];
    const maxPlayed = Math.max(lv?.played || 0, sv.played || 0);
    const maxOpened = Math.max(lv?.openedTs || 0, sv.openedTs || 0);
    if (!lv || (sv.ts || 0) > (lv.ts || 0)) {
      target[k] = sv;
    }
    if (isTombstone(target[k])) continue; // a deletion marker carries no book fields
    if (!target[k].src && (lv?.src || sv.src)) {
      target[k].src = lv?.src || sv.src;
    }
    if (maxPlayed) target[k].played = maxPlayed;
    if (maxOpened) target[k].openedTs = maxOpened;
  }
  return target;
}
