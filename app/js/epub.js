/**
 * EPUB ingestion — dependency-free, in-browser.
 *
 * An EPUB is a ZIP of XHTML documents. We read it with a tiny ZIP reader
 * (stored + deflate via the platform `DecompressionStream`, no library, no
 * CDN — so it works offline, unlike the CDN-loaded pdf.js path), concatenate
 * the spine documents into clean reading text, and lift the table of contents
 * (EPUB3 `nav` or EPUB2 `.ncx`) into a char-indexed chapter list.
 *
 * Produces the exact same doc shape as `processPdf` / `processTextFile`, so the
 * player, progress tracker, library, and IndexedDB treat an EPUB identically.
 * Like text files, EPUBs have no real pages, so we synthesise fixed-size
 * "pages" (CHARS_PER_PAGE) to keep the page readout and "go to page" working.
 *
 * The XHTML→text pass strips `<head>`, `<script>`/`<style>`, and `<nav>`
 * blocks (running heads / page-list noise) and decodes entities, so no page
 * numbers or chapter-header chrome leak into what the voice reads. Each spine
 * document is then run through `cleanForSpeech` (footnote markers, roman-numeral
 * headings, scene breaks, abbreviations) before being concatenated, so the
 * cleaning happens per-document and chapter offsets stay consistent.
 *
 * Browser-only APIs (DecompressionStream, TextDecoder, Blob, Response) are
 * referenced inside functions only, so the module imports cleanly under Node.
 */

import { bodyBounds } from "./chapters.js";
import {
  cleanForSpeech,
  numberDenseIn,
  setDoubletEdit,
  setNumberDense,
} from "./cleanForSpeech.js";
import { doubletEditIn } from "./deDoublet.js";
import { CHARS_PER_PAGE } from "./config.js";
import { buildChunks } from "./pdf.js";
import { chunkAtCharIn, clampOffset, loadSavedPlace } from "./progress.js";

/** True for files we should read as EPUB. */
export function isEpubFile(file) {
  return (
    /\.epub$/i.test(file.name || "") ||
    /application\/epub\+zip/i.test(file.type || "")
  );
}

/* ===================== ZIP reader (stored + deflate) ===================== */

const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;

function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function utf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse a ZIP into a { name -> { method, comp } } map by walking its central
 * directory. Handles standard (non-zip64, unencrypted) archives — enough for
 * every real EPUB.
 */
function readCentralDirectory(bytes) {
  let eocd = -1;
  const min = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("EPUB no válido (no es un ZIP)");

  const count = u16(bytes, eocd + 10);
  let off = u32(bytes, eocd + 16);
  const entries = {};
  for (let n = 0; n < count && off + 46 <= bytes.length; n++) {
    if (u32(bytes, off) !== SIG_CD) break;
    const method = u16(bytes, off + 10);
    const compSize = u32(bytes, off + 20);
    const nameLen = u16(bytes, off + 28);
    const extraLen = u16(bytes, off + 30);
    const commentLen = u16(bytes, off + 32);
    const lhOff = u32(bytes, off + 42);
    const name = utf8(bytes.subarray(off + 46, off + 46 + nameLen));
    // The local header repeats name/extra lengths, which can differ from the
    // central copy — recompute the data start from it.
    const lhNameLen = u16(bytes, lhOff + 26);
    const lhExtraLen = u16(bytes, lhOff + 28);
    const dataStart = lhOff + 30 + lhNameLen + lhExtraLen;
    entries[name] = {
      method,
      comp: bytes.subarray(dataStart, dataStart + compSize),
    };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(entry) {
  if (!entry) return null;
  if (entry.method === 0) return entry.comp; // stored
  if (entry.method === 8) return await inflateRaw(entry.comp); // deflate
  throw new Error(`método de compresión ZIP no soportado (${entry.method})`);
}

async function readText(entry) {
  const bytes = await readEntry(entry);
  return bytes ? utf8(bytes) : "";
}

/* ===================== path helpers ===================== */

function dirName(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** Resolve an href (relative, may contain ../, #anchor, %20) against a dir. */
function resolvePath(baseDir, href) {
  let h = href.split("#")[0].split("?")[0];
  try {
    h = decodeURIComponent(h);
  } catch (_) {}
  if (!h) return null;
  const parts = baseDir ? baseDir.split("/").filter(Boolean) : [];
  for (const seg of h.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/* ===================== XHTML → text ===================== */

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®",
  deg: "°", eacute: "é", aacute: "á", iacute: "í", oacute: "ó", uacute: "ú",
  ntilde: "ñ", uuml: "ü", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó",
  Uacute: "Ú", Ntilde: "Ñ", iexcl: "¡", iquest: "¿",
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e)) {
      return NAMED_ENTITIES[e];
    }
    const lower = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)
      ? NAMED_ENTITIES[lower]
      : m;
  });
}

// "10<sup>195</sup>" fuses to "10195" and is read "10 mil". A span needs "sup"
// in its class: "200<span class="ts4">2</span>" is a split 2002, no exponent.
const SUP_EXPONENT_RE =
  /(\d)\s*<(?:sup\b[^>]*|span\b[^>]*class="[^"]*sup[^"]*"[^>]*)>\s*([-−–]?)\s*(\d{1,4})\s*<\/(?:sup|span)>/gi;

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * Convert an XHTML document to clean reading text: drop metadata/scripts/nav,
 * turn block-element boundaries into newlines so sentences don't fuse, strip
 * remaining tags, and decode entities.
 *
 * Exported for testing.
 */
export function htmlToText(html) {
  let s = html;
  s = s.replace(/<\?[\s\S]*?\?>/g, " "); // XML declaration / processing instrs
  s = s.replace(/<!--[\s\S]*?-->/g, " "); // comments
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); // unwrap CDATA
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, " "); // metadata / title
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<nav\b[\s\S]*?<\/nav>/gi, " "); // toc / page-list chrome
  s = s.replace(SUP_EXPONENT_RE, (m, base, sign, exp) =>
    `${base} elevado a ${sign ? "menos " : ""}${exp}`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(
    /<\/(p|div|h[1-6]|li|section|article|blockquote|tr|figcaption|pre|ul|ol|table|figure|header|footer|dd|dt)\s*>/gi,
    "\n",
  );
  s = s.replace(/<[^>]+>/g, ""); // remaining tags
  s = decodeEntities(s);
  s = s.replace(/[^\S\n]+/g, " "); // collapse spaces/tabs, keep newlines
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/* ===================== OPF / TOC parsing ===================== */

function attr(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', "i");
  const m = tag.match(re);
  return m ? (m[1] != null ? m[1] : m[2]) : null;
}

async function findOpfPath(zip) {
  const container = zip["META-INF/container.xml"];
  if (container) {
    const xml = await readText(container);
    const m = xml.match(
      /<rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]+)"|'([^']+)')/i,
    );
    if (m) {
      const p = m[1] || m[2];
      try {
        return decodeURIComponent(p);
      } catch (_) {
        return p;
      }
    }
  }
  const opf = Object.keys(zip).find((k) => /\.opf$/i.test(k));
  if (!opf) throw new Error("EPUB sin archivo OPF");
  return opf;
}

/** Parse the OPF: linear spine hrefs, plus the toc href (nav or ncx). */
function parseOpf(xml) {
  const items = {};
  const itemRe = /<item\b([^>]*?)\/?>/gi;
  let m;
  while ((m = itemRe.exec(xml))) {
    const id = attr(m[1], "id");
    if (!id) continue;
    items[id] = {
      href: attr(m[1], "href"),
      props: attr(m[1], "properties") || "",
      media: attr(m[1], "media-type") || "",
    };
  }

  const spineM = xml.match(/<spine\b([^>]*)>([\s\S]*?)<\/spine>/i);
  const spineAttrs = spineM ? spineM[1] : "";
  const spineBody = spineM ? spineM[2] : "";
  const spineHrefs = [];
  const refRe = /<itemref\b([^>]*?)\/?>/gi;
  while ((m = refRe.exec(spineBody))) {
    const linear = attr(m[1], "linear");
    if (linear && linear.toLowerCase() === "no") continue;
    const idref = attr(m[1], "idref");
    const it = idref && items[idref];
    if (it && it.href) spineHrefs.push(it.href);
  }

  let tocHref = null;
  let tocIsNcx = false;
  const nav = Object.values(items).find((it) => /(^|\s)nav(\s|$)/.test(it.props));
  if (nav && nav.href) {
    tocHref = nav.href;
  } else {
    const tocId = attr(spineAttrs, "toc");
    const ncx =
      (tocId && items[tocId]) ||
      Object.values(items).find((it) =>
        /application\/x-dtbncx\+xml/i.test(it.media),
      );
    if (ncx && ncx.href) {
      tocHref = ncx.href;
      tocIsNcx = true;
    }
  }
  const titleM = xml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)
    || xml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const bookTitle = titleM ? stripTags(titleM[1]).replace(/\s+/g, " ").trim() : "";

  return { spineHrefs, tocHref, tocIsNcx, bookTitle };
}

/** EPUB3 nav document → [{ title, href }] in document order. */
function parseNav(xml) {
  let block = xml.match(
    /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i,
  );
  if (!block) block = xml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  const body = block ? block[1] : xml;
  const out = [];
  const aRe = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(body))) {
    const title = stripTags(m[3]);
    if (title) out.push({ href: m[1] || m[2], title });
  }
  return out;
}

/** EPUB2 NCX → [{ title, href }]. navPoints nest, so scan label/content pairs. */
function parseNcx(xml) {
  const out = [];
  const re =
    /<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m;
  while ((m = re.exec(xml))) {
    const title = stripTags(m[1]);
    const href = m[2] || m[3];
    if (title && href) out.push({ href, title });
  }
  return out;
}

/* ===================== assembly ===================== */

async function epubToDoc(bytes) {
  const zip = readCentralDirectory(bytes);
  const opfPath = await findOpfPath(zip);
  const opfXml = await readText(zip[opfPath]);
  const opfDir = dirName(opfPath);
  const { spineHrefs, tocHref, tocIsNcx, bookTitle } = parseOpf(opfXml);
  if (!spineHrefs.length) throw new Error("EPUB sin contenido legible (spine vacío)");

  // Read every document before cleaning any: the doublet verdict is taken over
  // the whole book, and cleanForSpeech sees one document.
  const docs = [];
  for (const href of spineHrefs) {
    const path = resolvePath(opfDir, href);
    const entry = path && zip[path];
    if (!entry) continue;
    docs.push([path, htmlToText(await readText(entry))]);
  }
  // The number verdict is the whole book's too, and set here it also stops the
  // book opened BEFORE this one deciding for this one.
  const whole = docs.map(([, t]) => t).join("\n");
  setDoubletEdit(doubletEditIn(whole));
  setNumberDense(numberDenseIn(whole));

  // Concatenate the spine documents; remember where each one starts so TOC
  // entries can be mapped back to character offsets.
  let out = "";
  const spineStart = {};
  for (const [path, text] of docs) {
    spineStart[path] = out.length;
    const t = cleanForSpeech(text);
    if (t) out += t + "\n\n";
  }
  const fullText = out.replace(/\n+$/, "");

  // Chapters from the TOC, mapped to spine-document start offsets.
  let chapters = [];
  const tocPath = tocHref ? resolvePath(opfDir, tocHref) : null;
  if (tocPath && zip[tocPath]) {
    const tocXml = await readText(zip[tocPath]);
    const tocDir = dirName(tocPath);
    const raw = tocIsNcx ? parseNcx(tocXml) : parseNav(tocXml);
    for (const { title, href } of raw) {
      const path = resolvePath(tocDir, href);
      if (path != null && path in spineStart) {
        chapters.push({ title, charIndex: spineStart[path] });
      }
    }
    chapters.sort((a, b) => a.charIndex - b.charIndex);
    chapters = chapters.filter(
      (c, i) => i === 0 || c.charIndex !== chapters[i - 1].charIndex,
    );
  }

  const charTotal = fullText.length;
  const numPages = Math.max(1, Math.ceil(charTotal / CHARS_PER_PAGE));
  const pageCharStarts = [];
  for (let p = 1; p <= numPages; p++) pageCharStarts[p] = (p - 1) * CHARS_PER_PAGE;

  return { fullText, charTotal, numPages, pageCharStarts, chapters, bookTitle };
}

/** Parse an EPUB File into the same hydrated doc shape as `processPdf`. */
export async function processEpub(file, key) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { fullText, charTotal, numPages, pageCharStarts, chapters, bookTitle } =
    await epubToDoc(bytes);

  const { startChar, endChar, skipped } = bodyBounds(chapters, charTotal, bookTitle);
  // Force a chunk break at every chapter start (incl. the body start) so a jump
  // to a chapter begins exactly there, never mid-chunk in the previous chapter.
  const ch = buildChunks(fullText, [startChar, ...chapters.map((c) => c.charIndex)]);
  let cc;
  let off = 0;
  const place = loadSavedPlace(key);
  if (place && place.pos > 0 && place.pos < charTotal) {
    cc = chunkAtCharIn(ch.chunks, place.pos);
    off = clampOffset(ch.chunks[cc], place.off);
  } else {
    // Fresh book: skip the front matter, start at the first real chapter.
    cc = chunkAtCharIn(ch.chunks, startChar);
  }
  return {
    name: file.name,
    size: file.size,
    docKey: key,
    fullText,
    charTotal,
    pageCharStarts,
    numPages,
    chunks: ch.chunks,
    wordsBefore: ch.wordsBefore,
    totalWords: ch.totalWords,
    chapters,
    chapterSkipped: skipped,
    bodyStartChar: startChar,
    bodyEndChar: endChar,
    curChunk: cc,
    chunkOffset: off,
  };
}
