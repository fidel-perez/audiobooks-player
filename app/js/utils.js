/**
 * Pure, side-effect-free helpers.
 */

/** Escape for insertion into HTML text nodes. */
export function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

/** Escape for insertion into an XML/SSML attribute or body. */
export function escapeXml(s) {
  return s.replace(
    /[&<>'"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[c],
  );
}

/** Seconds → "HH:MM:SS". */
export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** Seconds → "1h:05m" — the coarse clock the 📍 Posición head reads in. */
export function fmtHm(sec) {
  const total = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h:${String(m).padStart(2, "0")}m`;
}

/** Trim ".pdf" and ellipsize a document name for tabs / media metadata. */
export function shortName(n) {
  n = n.replace(/\.pdf$/i, "");
  return n.length > 22 ? `${n.slice(0, 21)}…` : n;
}

/* ===================== word positions inside a paragraph ===================== */

/**
 * Char offset of every word start in `text`.
 *
 * `text` here is always a chunk's SPOKEN text (whitespace already collapsed by
 * buildChunks), so these offsets live in the chunk-local coordinate space that
 * `state.chunkOffset` uses — NOT the absolute `fullText` one behind
 * `chunk.start` / `chunk.end`. The two must never be added together.
 */
export function wordStarts(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m.index);
  return out;
}

/**
 * Snap `i` BACK to the first character of the word it falls inside.
 *
 * A resume offset must land on a word start, and where it is wrong it must only
 * ever be wrong BACKWARDS: re-speaking a word you already heard is invisible,
 * skipping one you never heard is not. Engines also disagree on what a
 * `boundary` charIndex points at (the word about to be spoken, or the one just
 * finished), so every offset is normalised to the start of the word holding it.
 */
export function snapToWordStart(text, i) {
  let s = Math.max(0, Math.min(Math.floor(i) || 0, text.length));
  while (s > 0 && !/\s/.test(text[s - 1])) s--;
  return s;
}

/**
 * Where `words` words of speech, starting from char `base`, get you in `text`.
 *
 * The fallback for voices that never fire `boundary` (see player.js): we know
 * how long the voice has been speaking and roughly how many words per minute it
 * manages, so we count the words it was never willing to announce. Deliberately
 * conservative — it lands a word short, and never walks past the final word —
 * because an over-estimate silently skips text the listener never heard, while
 * an under-estimate merely repeats a word. Ending the chunk stays the real
 * `onend` event's job, never this guess.
 */
export function offsetAfterWords(text, base, words) {
  const starts = wordStarts(text);
  if (!starts.length) return 0;
  let from = starts.findIndex((s) => s >= base);
  if (from < 0) from = starts.length - 1;
  const idx = from + Math.floor(words) - 1; // −1: land a word short, never long
  if (idx <= from) return starts[from];
  return starts[Math.min(idx, starts.length - 1)];
}

/**
 * Random hex UUID (no dashes) for Edge TTS request ids.
 *
 * The `[1e7]+-1e3+…` seed relies on string concatenation (array→string then
 * `+` with negatives) to build "10000000-1000-4000-8000-100000000000"; the
 * digits 0/1/8 are then replaced with crypto-random hex and dashes stripped.
 */
export function uuidHex() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11)
    .replace(/[018]/g, (c) =>
      (
        c ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
      ).toString(16),
    )
    .replace(/-/g, "");
}
