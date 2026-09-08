/**
 * 🌠 Wishlist — books the operator wants that the pi library does NOT have.
 *
 * The biblioteca only knows books it holds; a liked author's missing title has
 * nowhere to live. This module is that gap: a json-store blob (`audiobooks-
 * wishlist`) of `{ "<key>": {t, a} }` records keyed by NORMALISED "author|title",
 * so the same book typed twice (accents, case, punctuation) collapses to one
 * entry.
 *
 * The wishlist is defined by absence: an entry stops being a wish the moment the
 * book lands in the catalog. So nothing "un-wishes" a book by hand — every
 * surface that loads the list first PRUNES the entries the catalog now answers
 * for (see fulfilledKeys) and PATCHes those keys to null. The Telegram EPUB
 * ingest does the same server-side (services/webhooks_and_serverbot/
 * biblioteca_ingest.py), so dropping a wished .epub on the bot clears its brand
 * without the app ever being opened.
 *
 * Matching a free-typed wish against an 88k-book catalog is fuzzy by necessity
 * (a wish says "Frans de Waal", the catalog says "Waal, Frans de"; a wish drops
 * the subtitle the catalog keeps). Rules, deliberately asymmetric:
 *  - AUTHOR: either side's token set may contain the other. "Marc Bekoff &
 *    Jessica Pierce" (wish) matches the catalog's "Marc Bekoff", and "Frans de
 *    Waal" (wish) matches "Frans de Waal" however it is ordered.
 *  - TITLE: every wish token must be in the catalog title, OR — for a wish of 3+
 *    tokens — at least 75% of them, which lets a dropped subtitle through
 *    without letting a lone common word ("El", "La") fire.
 *
 * Pure and DOM-free: js/biblioteca.js wires it to the live blob and the catalog.
 */

import { normName, tokens } from "./reactions.js";

/** Stable identity for a wish: normalised "author|title". */
export function wishKey(author, title) {
  return `${normName(author)}|${normName(title)}`;
}

/** True when every needle token appears in the hay Set. */
function covers(needle, haySet) {
  return needle.length > 0 && needle.every((t) => haySet.has(t));
}

/** Either author names it — one token set contains the other. */
export function authorMatches(wishAuthor, bookAuthor) {
  const w = tokens(wishAuthor);
  const b = tokens(bookAuthor);
  if (!w.length || !b.length) return false;
  return covers(w, new Set(b)) || covers(b, new Set(w));
}

/** Full title, or ≥75% of a 3+-token wish title (a dropped subtitle). */
export function titleMatches(wishTitle, bookTitle) {
  const w = tokens(wishTitle);
  if (!w.length) return false;
  const set = new Set(tokens(bookTitle));
  const hit = w.filter((t) => set.has(t)).length;
  if (hit === w.length) return true;
  return w.length >= 3 && hit >= Math.ceil(w.length * 0.75);
}

/**
 * Author-token → catalog books index, so a wish is only tested against books
 * that share at least one author token (cheap over the whole catalog).
 */
export function buildWishIndex(books) {
  const idx = new Map();
  for (const bk of books || []) {
    for (const tok of new Set(tokens(bk.a))) {
      let arr = idx.get(tok);
      if (!arr) idx.set(tok, (arr = []));
      arr.push(bk);
    }
  }
  return idx;
}

/** The catalog book satisfying this wish, or null. */
export function findInCatalog(idx, wish) {
  if (!idx || !wish) return null;
  const seen = new Set();
  for (const tok of new Set(tokens(wish.a))) {
    for (const bk of idx.get(tok) || []) {
      if (seen.has(bk)) continue;
      seen.add(bk);
      if (authorMatches(wish.a, bk.a) && titleMatches(wish.t, bk.t)) return bk;
    }
  }
  return null;
}

/**
 * Keep only `{t, a}` records with both fields — a hand-edited blob may hold junk.
 * An optional `v:"primigenia"` provenance survives (the 🏛️ tag marking a wish
 * seeded from the primigenia collection, not typed by hand); any other `v` is
 * dropped so the field can only ever mean that one thing.
 */
export function sanitizeWishes(blob) {
  const out = {};
  for (const [k, v] of Object.entries(blob || {})) {
    if (!v || typeof v !== "object") continue;
    const t = typeof v.t === "string" ? v.t.trim() : "";
    const a = typeof v.a === "string" ? v.a.trim() : "";
    if (t && a) out[k] = v.v === "primigenia" ? { t, a, v: "primigenia" } : { t, a };
  }
  return out;
}

/** Wish keys the catalog now answers for — these have stopped being wishes. */
export function fulfilledKeys(wishes, idx) {
  return Object.entries(wishes || {})
    .filter(([, w]) => findInCatalog(idx, w))
    .map(([k]) => k);
}

/** The still-missing wishes, author then title, as `[{ key, t, a }]`. */
export function pendingWishes(wishes, idx) {
  return Object.entries(wishes || {})
    .filter(([, w]) => !findInCatalog(idx, w))
    .map(([key, w]) => ({ key, ...w }))
    .sort((x, y) => x.a.localeCompare(y.a, "es") || x.t.localeCompare(y.t, "es"));
}
