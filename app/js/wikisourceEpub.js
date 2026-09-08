/**
 * Build a one-chapter EPUB, in the browser, from a Wikisource article.
 *
 * Neither gutenberg.org (no CORS header) nor Standard Ebooks (no Spanish
 * titles) can supply the Spanish half of the catalog.
 *
 * Wikisource's REST endpoint sends `Access-Control-Allow-Origin: *` and
 * returns article HTML whose only chrome is a `.ws-noexport` box —
 * Wikisource's own export tooling already marks it for removal.
 */

const WS_NOEXPORT_SELECTOR = ".ws-noexport, .noprint, style, link";

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[c]);
}

/** Fetch a Wikisource article's body HTML, minus its export-excluded chrome. */
async function fetchArticleHtml(lang, wsTitle) {
  const norm = wsTitle.replace(/ /g, "_");
  const url = `https://${lang}.wikisource.org/w/rest.php/v1/page/${encodeURIComponent(norm)}/html`;
  const r = await fetch(url, { headers: { Accept: "text/html" } });
  if (!r.ok) throw new Error(`Wikisource HTTP ${r.status}`);
  const html = await r.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(WS_NOEXPORT_SELECTOR).forEach((el) => el.remove());
  return doc.body ? doc.body.innerHTML : "";
}

// ── minimal ZIP writer: stored (uncompressed) entries only, epub.js reads those too ──

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16le(n) {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32le(n) {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/** entries: [{name, text}] → Blob (application/epub+zip), stored (uncompressed). */
function buildZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, text } of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = [
      ...u32le(0x04034b50),
      ...u16le(20), // version needed
      ...u16le(0), // flags
      ...u16le(0), // method: stored
      ...u16le(0), ...u16le(0), // mod time/date
      ...u32le(crc),
      ...u32le(data.length), // compressed size
      ...u32le(data.length), // uncompressed size
      ...u16le(nameBytes.length),
      ...u16le(0), // extra length
    ];
    chunks.push(new Uint8Array(local), nameBytes, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + nameBytes.length + data.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const rec = [
      ...u32le(0x02014b50),
      ...u16le(20), ...u16le(20),
      ...u16le(0), ...u16le(0),
      ...u16le(0), ...u16le(0),
      ...u32le(e.crc),
      ...u32le(e.size), ...u32le(e.size),
      ...u16le(e.nameBytes.length),
      ...u16le(0), ...u16le(0), ...u16le(0), ...u16le(0),
      ...u32le(0),
      ...u32le(e.offset),
    ];
    chunks.push(new Uint8Array(rec), e.nameBytes);
    offset += rec.length + e.nameBytes.length;
  }
  const cdSize = offset - cdStart;

  const eocd = [
    ...u32le(0x06054b50),
    ...u16le(0), ...u16le(0),
    ...u16le(central.length), ...u16le(central.length),
    ...u32le(cdSize),
    ...u32le(cdStart),
    ...u16le(0),
  ];
  chunks.push(new Uint8Array(eocd));

  return new Blob(chunks, { type: "application/epub+zip" });
}

/** Build a one-chapter EPUB Blob from a Wikisource article. */
export async function buildWikisourceEpub({ title, author, wsTitle, lang }) {
  const body = await fetchArticleHtml(lang, wsTitle);
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">wikisource:${xmlEscape(lang)}:${xmlEscape(wsTitle)}</dc:identifier>
    <dc:title>${xmlEscape(title)}</dc:title>
    <dc:creator>${xmlEscape(author)}</dc:creator>
    <dc:language>${xmlEscape(lang)}</dc:language>
  </metadata>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`;
  const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="utf-8"/><title>${xmlEscape(title)}</title></head>
<body>${body}</body>
</html>`;
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  return buildZip([
    { name: "mimetype", text: "application/epub+zip" },
    { name: "META-INF/container.xml", text: container },
    { name: "OEBPS/content.opf", text: opf },
    { name: "OEBPS/chapter.xhtml", text: chapter },
  ]);
}
