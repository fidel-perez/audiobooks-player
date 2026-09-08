/**
 * Plain-text (.txt) and Markdown (.md) ingestion.
 *
 * Produces the exact same doc shape as pdf.js's `processPdf`, so the player,
 * progress tracker, library, and IndexedDB treat a text file identically to an
 * extracted PDF. Text files have no real pages, so we synthesise fixed-size
 * "pages" (CHARS_PER_PAGE) to keep the page readout and "go to page" control
 * meaningful; for Markdown, headings (`#`…`######`) become the chapter outline.
 */

import { CHARS_PER_PAGE } from "./config.js";
import { buildChunks } from "./pdf.js";
import { chunkAtCharIn, clampOffset, loadSavedPlace } from "./progress.js";

/** True for files we should read as plain text / Markdown rather than as PDF. */
export function isTextFile(file) {
  if (/\.(txt|md|markdown|mdown|mkd|text)$/i.test(file.name)) return true;
  const t = (file.type || "").toLowerCase();
  return t.startsWith("text/");
}

function isMarkdown(file) {
  return (
    /\.(md|markdown|mdown|mkd)$/i.test(file.name) ||
    /^text\/(x-)?markdown$/i.test(file.type || "")
  );
}

/** Strip common inline Markdown so the voice reads words, not punctuation. */
function stripInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // link -> label
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // reference link -> label
    .replace(/`+([^`]+)`+/g, "$1") // inline code
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(\*|_)(.+?)\1/g, "$2") // italic
    .replace(/~~(.+?)~~/g, "$2") // strikethrough
    .replace(/<\/?[a-z][^>]*>/gi, "") // inline HTML tags
    .trim();
}

/**
 * Convert Markdown to reading text and collect its headings as chapters.
 * Returns { text, chapters } where each chapter's charIndex points into text.
 */
function parseMarkdown(raw) {
  const chapters = [];
  const lines = raw.split(/\r?\n/);
  let out = "";
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence; // drop the fence markers themselves
      continue;
    }
    if (inFence) {
      out += `${line}\n`; // read code-block contents verbatim
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // horizontal rule
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const depth = h[1].length;
      const title = stripInline(h[2]) || "Sección";
      chapters.push({
        title: "— ".repeat(Math.max(0, depth - 1)) + title,
        charIndex: out.length,
      });
      out += `${title}. \n`; // read the heading, and force a sentence break
      continue;
    }
    let l = line.replace(/^\s{0,3}>\s?/, ""); // blockquote marker
    l = l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""); // list bullet / number
    out += `${stripInline(l)}\n`;
  }
  return { text: out, chapters };
}

/** Parse a .txt/.md File into the same hydrated doc shape as `processPdf`. */
export async function processTextFile(file, key) {
  const raw = await file.text();
  const { text, chapters } = isMarkdown(file)
    ? parseMarkdown(raw)
    : { text: raw, chapters: [] };

  const charTotal = text.length;
  const numPages = Math.max(1, Math.ceil(charTotal / CHARS_PER_PAGE));
  const pageCharStarts = [];
  for (let p = 1; p <= numPages; p++) pageCharStarts[p] = (p - 1) * CHARS_PER_PAGE;

  const ch = buildChunks(text);
  let cc = 0;
  let off = 0;
  const place = loadSavedPlace(key);
  if (place && place.pos > 0 && place.pos < charTotal) {
    cc = chunkAtCharIn(ch.chunks, place.pos);
    off = clampOffset(ch.chunks[cc], place.off);
  }
  return {
    name: file.name,
    size: file.size,
    docKey: key,
    fullText: text,
    charTotal,
    pageCharStarts,
    numPages,
    chunks: ch.chunks,
    wordsBefore: ch.wordsBefore,
    totalWords: ch.totalWords,
    chapters,
    curChunk: cc,
    chunkOffset: off,
  };
}
