/**
 * PDF text extraction, sentence chunking, chapter outline, and (re)hydration.
 *
 * pdf.js is loaded as a global (`window.pdfjsLib`) from the CDN <script> in
 * index.html; we only wire its worker here.
 */

import { bodyBounds } from "./chapters.js";
import { MAX_CHUNK } from "./config.js";
import { setStatus } from "./dom.js";
import { chunkAtCharIn, clampOffset, loadSavedPlace } from "./progress.js";

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

/**
 * Extract clean reading text from a PDF.
 *
 * Groups text items into visual lines (by Y position), de-hyphenates
 * line-break splits, and records the character offset where each page starts
 * so we can map positions back to pages and chapters.
 */
export async function extractText(pdf) {
  let text = "";
  const starts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    starts[p] = text.length;
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();

    const lines = [];
    let cur = null;
    for (const item of tc.items) {
      const y = item.transform[5];
      if (cur && Math.abs(y - cur.y) <= 3) {
        cur.text += item.str;
      } else {
        if (cur) lines.push(cur);
        cur = { y, text: item.str };
      }
      if (item.hasEOL) cur.text += " ";
    }
    if (cur) lines.push(cur);

    const lineStrs = lines
      .map((l) => l.text.replace(/\s+/g, " ").trim())
      .filter((s) => s.length);

    let pageText = "";
    for (let i = 0; i < lineStrs.length; i++) {
      const line = lineStrs[i];
      if (i === 0) {
        pageText = line;
        continue;
      }
      if (/[-­‐]$/.test(pageText)) {
        pageText = pageText.replace(/[-­‐]\s*$/, "") + line;
      } else {
        pageText += ` ${line}`;
      }
    }
    text += `${pageText} `;
    setStatus(`Extrayendo texto… página ${p}/${pdf.numPages}`);
  }
  return {
    fullText: text,
    charTotal: text.length,
    pageCharStarts: starts,
    numPages: pdf.numPages,
  };
}

/**
 * Split text into speakable chunks, breaking at every sentence boundary — one
 * sentence per chunk (the baked-in "frases cortas" behaviour; see `minChunk`
 * below). Returns chunks plus a cumulative word count (for time estimates).
 *
 * `boundaries` (optional) is a list of character offsets — the chapter starts —
 * at which a chunk MUST begin. Without them a jump to a chapter lands on the
 * chunk that merely *contains* the chapter's first char, and that chunk usually
 * STARTS in the previous chapter (a sentence straddles the boundary) or, when
 * the front matter has no sentence punctuation, swallows the whole title/TOC
 * page into one giant chunk — so "select Capítulo 1" read the tail of the
 * previous chapter / the front matter instead ("Lo sabía" bug). Forcing a chunk
 * break at every chapter start makes `chunkAtChar(chapter.charIndex)` return a
 * chunk whose `start === charIndex`, so playback begins exactly at the chapter.
 */
/**
 * Where to cut a too-long chunk, as close to `ideal` as a readable break allows.
 *
 * PROSODY IS THE WHOLE CONSTRAINT. Splitting mid-clause makes the voice stop on a
 * word that has no business ending a phrase, so a clause mark (`,` `;` `:` `—` a
 * closing bracket or quote) wins over a plain word gap whenever one is in reach,
 * and among equals the one nearest `ideal` wins so the pieces stay even.
 *
 * The window is ±half a piece: wide enough that natural prose almost always
 * offers a comma, narrow enough that the pieces cannot drift back over the cap.
 * A stretch with no whitespace at all in that window is a runaway token (a URL, a
 * formula), and `ideal` itself is returned — a mid-word cut is ugly, whereas the
 * uncapped chunk it replaces is a minute of silence.
 *
 * Returns the offset the NEXT piece starts at, always in `(cur, end)`.
 */
function cutPoint(text, cur, ideal, end, target) {
  const slack = Math.max(1, Math.floor(target / 2));
  const lo = Math.max(cur + 1, ideal - slack);
  const hi = Math.min(end - 1, ideal + slack);
  const nearer = (a, b) => (a === -1 || Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a);
  let clause = -1;
  let space = -1;
  for (let j = lo; j <= hi; j++) {
    if (!/\s/.test(text[j])) continue;
    if (/[,;:—–…)\]"»'’]/.test(text[j - 1])) clause = nearer(clause, j);
    else space = nearer(space, j);
  }
  const at = clause !== -1 ? clause : space;
  return at === -1 ? ideal : at + 1;
}

/**
 * Cut `[s, e)` into pieces no longer than `MAX_CHUNK`, or leave it alone.
 *
 * EVEN PIECES, NOT GREEDY ONES. Taking MAX_CHUNK off the front until the text
 * runs out leaves whatever is left as the last piece — a 370-char sentence would
 * become 360 + 10, and a 10-char chunk is a hiccup in the middle of a paragraph.
 * Dividing into `ceil(len / MAX_CHUNK)` equal targets gives 185 + 185 instead.
 *
 * The pieces TILE `[s, e)` with no gaps: `start`/`end` are character offsets into
 * the document and the reader's saved position is a character offset too, so a
 * hole here would be a place the book cannot resume from. Re-chunking is safe for
 * a book already in progress precisely because of that — position is stored as
 * `pos`, not as a chunk index, and `clampOffset` (progress.js) already exists for
 * the case where a rebuild hands the same `pos` a shorter paragraph.
 */
function capLength(text, s, e) {
  const len = e - s;
  if (len <= MAX_CHUNK) return [{ start: s, end: e }];
  const parts = Math.ceil(len / MAX_CHUNK);
  const target = len / parts;
  const out = [];
  let cur = s;
  for (let k = 1; k < parts; k++) {
    const cut = cutPoint(text, cur, s + Math.round(target * k), e, target);
    if (cut > cur && cut < e) {
      out.push({ start: cur, end: cut });
      cur = cut;
    }
  }
  out.push({ start: cur, end: e });
  return out;
}

export function buildChunks(text, boundaries = []) {
  const out = [];
  let sentences = [];
  let start = 0;
  const re = /[.!?]+(?:["'»”’)\]]+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const endPos = m.index + m[0].length;
    const rest = text.slice(endPos);
    if (rest === "" || /^\s/.test(rest)) {
      const nm = rest.match(/^\s*(\S)/);
      const nextCh = nm ? nm[1] : "";
      // A raya opens dialogue, so a stop before one ends a sentence: 1841
      // unsplit stops in *El último deseo*, all of that shape.
      if (nextCh === "" || /[A-ZÁÉÍÓÚÜÑ¡¿"«(—–0-9]/.test(nextCh)) {
        sentences.push({ start, end: endPos });
        start = endPos;
      }
    }
  }
  if (start < text.length) sentences.push({ start, end: text.length });
  if (sentences.length === 0 && text.trim()) {
    sentences.push({ start: 0, end: text.length });
  }

  // Cut sentences at every chapter boundary and remember those offsets so the
  // merge below never fuses across one. Sentences tile [0, len) contiguously, so
  // each in-range boundary falls inside exactly one sentence (or already on an
  // edge) — splitting there makes it a sentence start we can guard on.
  const boundarySet = new Set();
  const bs = [...new Set(boundaries || [])]
    .filter((b) => Number.isFinite(b) && b > 0 && b < text.length)
    .sort((a, b) => a - b);
  if (bs.length) {
    const split = [];
    for (const sen of sentences) {
      let cur = sen.start;
      for (const b of bs) {
        if (b > cur && b < sen.end) {
          split.push({ start: cur, end: b });
          cur = b;
        }
      }
      split.push({ start: cur, end: sen.end });
    }
    sentences = split;
    bs.forEach((b) => boundarySet.add(b));
  }

  // "Frases cortas", baked in: never merge short sentences, so each is a chunk of
  // its own and gets a fresh prosody contour — which kills the breath the neural
  // voice used to take partway through a long merged paragraph. A min of 0 makes
  // the merge condition below false on the first look every time. (Formerly an
  // opt-in 🧪 mode; MIN_CHUNK is retired now that this is permanent.)
  //
  // ...WHICH ALSO MADE `MAX_CHUNK` DEAD, and that is what `capLength` is for. The
  // cap only ever appeared in the merge condition, so with `minChunk` at 0 the
  // loop below never looked at it and a chunk was exactly one sentence, at
  // whatever length the author wrote. Measured on the moto g34 against *El
  // universo elegante*: 6329 chunks, mean 177 chars but a 1143-char maximum and
  // 319 over the nominal 360. A chunk is the unit of synthesis and `pump` cannot
  // preempt one, so its length is the seam wait — and on one WASM thread (Android
  // WebView cannot be cross-origin isolated) 615 chars is already the 30 s
  // `WORKER_STALL_TIMEOUT_MS`, past which piper.js declares the worker hung and
  // demotes the WHOLE session to the main-thread fallback. 29 chunks of that book
  // were over that line. The cap is what keeps a long sentence from being one.
  const minChunk = 0;

  let i = 0;
  while (i < sentences.length) {
    const s = sentences[i].start;
    let e = sentences[i].end;
    i++;
    while (
      i < sentences.length &&
      e - s < minChunk &&
      sentences[i].end - s <= MAX_CHUNK &&
      !boundarySet.has(sentences[i].start) // never merge across a chapter start
    ) {
      e = sentences[i].end;
      i++;
    }
    for (const piece of capLength(text, s, e)) {
      const t = text.slice(piece.start, piece.end).replace(/\s+/g, " ").trim();
      if (t) out.push({ text: t, start: piece.start, end: piece.end });
    }
  }
  if (out.length === 0 && text.trim()) {
    out.push({ text: text.replace(/\s+/g, " ").trim(), start: 0, end: text.length });
  }

  const wb = new Array(out.length + 1);
  wb[0] = 0;
  for (let k = 0; k < out.length; k++) {
    const w = out[k].text.split(/\s+/).filter(Boolean).length;
    wb[k + 1] = wb[k] + w;
  }
  return { chunks: out, wordsBefore: wb, totalWords: wb[out.length] || 0 };
}

/** Read the PDF outline into a flat, char-indexed list of chapters. */
export async function extractChapters(pdf, starts) {
  const chaps = [];
  try {
    const outline = await pdf.getOutline();
    if (!outline || !outline.length) return chaps;
    async function walk(items, depth) {
      for (const it of items) {
        let pageIndex = null;
        try {
          let dest = it.dest;
          if (typeof dest === "string") dest = await pdf.getDestination(dest);
          if (dest && dest[0]) pageIndex = await pdf.getPageIndex(dest[0]);
        } catch (_) {}
        if (pageIndex !== null) {
          const charIndex = starts[pageIndex + 1] ?? 0;
          chaps.push({
            title: "— ".repeat(depth) + (it.title || "Capítulo"),
            charIndex,
          });
        }
        if (it.items && it.items.length) await walk(it.items, depth + 1);
      }
    }
    await walk(outline, 0);
    chaps.sort((a, b) => a.charIndex - b.charIndex);
  } catch (_) {}
  return chaps;
}

/** Parse a File into a fully hydrated doc, resuming any saved position. */
export async function processPdf(file, key) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const ext = await extractText(pdf);
  // Extract chapters first so their page-start offsets can align the chunks (see
  // buildChunks) — a chapter jump then begins exactly at the chapter.
  const chaps = await extractChapters(pdf, ext.pageCharStarts);
  const ch = buildChunks(ext.fullText, chaps.map((c) => c.charIndex));
  let cc = 0;
  let off = 0;
  const place = loadSavedPlace(key);
  if (place && place.pos > 0 && place.pos < ext.charTotal) {
    cc = chunkAtCharIn(ch.chunks, place.pos);
    off = clampOffset(ch.chunks[cc], place.off);
  }
  return {
    name: file.name,
    size: file.size,
    docKey: key,
    fullText: ext.fullText,
    charTotal: ext.charTotal,
    pageCharStarts: ext.pageCharStarts,
    numPages: ext.numPages,
    chunks: ch.chunks,
    wordsBefore: ch.wordsBefore,
    totalWords: ch.totalWords,
    chapters: chaps,
    curChunk: cc,
    chunkOffset: off,
  };
}

/**
 * Hydrate a batch of stored records, isolating each one: a record that throws
 * (a half-written / corrupt IndexedDB row) is skipped rather than aborting the
 * batch. Boot used to hydrate them inside one shared `try`, so a single bad
 * record left the app with NO book open — the whole library gone on a refresh.
 * Returns the docs that survived plus how many were dropped.
 *
 * The docs come back COLD (see `hydrateStub`): the expensive half — re-chunking
 * `fullText` into sentences — is deferred. Boot used to do that work for up to
 * MAX_DOCS books, synchronously, on the main thread, BEFORE anything painted;
 * only the ONE book about to open needs it, and the reader is staring at a blank
 * screen for the other nineteen. `ensureHydrated` fills a doc in on demand and
 * main.js warms the rest across yields once the book is up.
 */
export function hydrateAll(records) {
  const docs = [];
  let skipped = 0;
  for (const r of records || []) {
    try {
      docs.push(hydrateStub(r));
    } catch (_) {
      skipped++;
    }
  }
  return { docs, skipped };
}

/**
 * The cheap half of hydration: everything that does NOT need the text re-chunked
 * — identity, catalog metadata, remembered card appearance, and the chapter/body
 * bounds (`bodyBounds` is O(chapters), not O(text)).
 *
 * `chunks` is empty and `curChunk`/`chunkOffset` are unresolved until
 * `ensureHydrated` runs. The two consumers that can meet a cold doc handle it:
 * `docPct` falls back to the saved char position, and `adoptAheadPlace` /
 * `activateDoc` hydrate before they touch chunks. `_raw` is the record they
 * hydrate FROM; it is the same string reference as `fullText`, so keeping it
 * costs nothing.
 */
export function hydrateStub(s) {
  const chapters = s.chapters || [];
  const { startChar, endChar, skipped } = bodyBounds(chapters, s.charTotal);
  return {
    name: s.name,
    size: s.size,
    docKey: s.docKey,
    fullText: s.fullText,
    charTotal: s.charTotal,
    pageCharStarts: s.pageCharStarts,
    numPages: s.numPages,
    chunks: [],
    wordsBefore: [0],
    totalWords: 0,
    chapters,
    chapterSkipped: skipped,
    bodyStartChar: startChar,
    bodyEndChar: endChar,
    curChunk: 0,
    chunkOffset: 0,
    order: s.order || 0,
    src: s.src || null,
    a: s.a || null,
    t: s.t || null, // catalog title — the boot card paints it before the catalog
    // Remembered card appearance (rating ring/tint, 📚 count, saga, provenance)
    // — same reason as `t`, for everything on the card that isn't the title.
    card: s.card || null,
    mode: s.mode || null, // day/night shelf; null ⇒ night (see mode.js)
    _raw: s,
    hydrated: false,
  };
}

/**
 * Finish a cold doc IN PLACE and return it. In place, not a fresh object, so
 * every `state.docs.indexOf(d)` / `=== state.docs[i]` identity check in the app
 * keeps holding. Idempotent and cheap to call on an already-warm doc, so callers
 * can guard unconditionally.
 */
export function ensureHydrated(doc) {
  if (!doc || doc.hydrated) return doc;
  // A doc built by processPdf/processEpub/processText is born warm but has no
  // `_raw`; mark it and leave it alone rather than re-chunking from nothing.
  const s = doc._raw;
  if (!s) {
    doc.hydrated = true;
    return doc;
  }
  const startChar = doc.bodyStartChar || 0;
  // Align chunk starts to chapter starts (see buildChunks) so the chapter picker
  // lands exactly on the chapter after a reload, not in the previous one.
  const ch = buildChunks(s.fullText, [
    startChar,
    ...(doc.chapters || []).map((c) => c.charIndex),
  ]);
  let cc = 0;
  // The saved WORD inside the paragraph — only carried when the position itself
  // came from a saved place; the `s.curChunk` / front-matter branches below are
  // paragraph-granular by construction, so they start at its first word.
  let off = 0;
  const place = loadSavedPlace(s.docKey);
  if (place && place.pos > 0 && place.pos < s.charTotal) {
    cc = chunkAtCharIn(ch.chunks, place.pos);
    off = clampOffset(ch.chunks[cc], place.off);
  } else if (typeof s.curChunk === "number" && s.curChunk > 0) {
    cc = Math.min(s.curChunk, ch.chunks.length - 1);
    off = clampOffset(ch.chunks[cc], s.chunkOffset);
  } else {
    // Never opened / at the very start: skip front matter to the real text.
    cc = chunkAtCharIn(ch.chunks, startChar);
  }
  doc.chunks = ch.chunks;
  doc.wordsBefore = ch.wordsBefore;
  doc.totalWords = ch.totalWords;
  doc.curChunk = Math.max(0, cc);
  doc.chunkOffset = off;
  doc.hydrated = true;
  return doc;
}

/** Rebuild a runtime doc from an IndexedDB record (chunks are recomputed). */
export function hydrate(s) {
  return ensureHydrated(hydrateStub(s));
}
