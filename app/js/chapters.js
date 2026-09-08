/**
 * Front/back-matter chapter classification.
 *
 * Spanish EPUBs bracket the real text with non-narrative apparatus: covers,
 * credits, dedications, blurbs and a prologue up front; notes, author bios,
 * acknowledgements, appendices and an epilogue at the back. The reader should
 * start at the first real chapter and stop at the last, treating the apparatus
 * as if it weren't there.
 *
 * The vocabulary below is not guessed — it comes from a frequency scan of the
 * table of contents of ~88k Spanish EPUBs (88198 with a TOC), tallying each
 * normalized title's count and whether it sits in the head / middle / tail of
 * the TOC. The head/tail split separates front ("Cubierta", 47k), back
 * ("Notas", 27k) and body ("Capítulo N", "1", "II") cleanly. See the project
 * memory `audiobooks-chapter-skip` for the raw data.
 *
 * We only trim the *leading run* of front-matter and the *trailing run* of
 * back-matter, so a "Notas" or "Mapa" that appears between real chapters
 * survives. Owner-tuned edge calls:
 *   prólogo/prefacio/introducción/sinopsis/presentación → skip (front),
 *   a numeric year half-title ("1914", "1914. El año…") → skip (front),
 *   epílogo → skip (back), conclusión → KEEP (body).
 * The operator's rule is "prefer no trash to occasional gold": front-matter
 * apparatus — an Introducción included — is trimmed aggressively; the only hard
 * line is that a real numbered/labelled chapter is NEVER skipped (proven by a
 * whole-library A/B on every re-tune).
 */

/** Normalize a TOC title to a comparison key (mirrors the pi scan's norm()). */
export function normTitle(s) {
  let t = (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^[¡¿!?"'«»“”().\-–—:\s]+|[¡¿!?"'«»“”().\-–—:\s]+$/g, ""); // edge punct
  t = t.replace(/^[\divxlcdm]+[.)\-\s]+/, ""); // leading "1. " / "IV) "
  t = t.replace(/[\s\-–—:]+[\divxlcdm]+$/, ""); // trailing " - 3" / " IV"
  t = t.replace(/^[\s.\-–—:]+|[\s.\-–—:]+$/g, "");
  return t;
}

// Exact normalized titles that are front matter (non-narrative, book start).
const FRONT_EXACT = new Set([
  "cubierta", "cubiertas", "portada", "portadilla",
  "falsa portada", "guarda", "guardas", "cortesia",
  "derechos", "derechos de autor",
  "pagina de derechos", "pagina legal", "pagina de titulo",
  "titulo", "titulo pagina", "datos del libro", "ficha", "ficha del libro",
  "dedicatoria", "cita", "citas", "epigrafe", "lema",
  "sinopsis", "argumento", "resumen", "sumario", "contenido", "contenidos",
  "indice", "indice general", "indice de contenido", "indice de contenidos",
  "tabla de contenido", "tabla de contenidos", "tabla de materias",
  "presentacion", "informacion",
  "mapa", "mapas", "arbol genealogico", "dramatis personae",
  "personajes", "personajes principales", "lista de personajes", "los personajes",
  "nota previa", "nota preliminar", "nota del editor", "nota del editor digital",
  "nota al texto", "nota editorial", "nota de la edicion",
  "advertencia", "noticia", "al lector", "guia del lector", "guia de lectura",
  "aviso",
]);

// Front-matter stems (prefix match) — prologue family + covers. "introduccion"
// lives here now: the operator trims it as front matter rather than keeping it.
const FRONT_RE =
  /^(prologo|prefacio|preludio|preambulo|proemio|introduccion|sinopsis|dedicatoria|cubierta|portad|epigrafe|dramatis personae|arbol genealogico)\b/;

// Exact normalized titles that are back matter (apparatus after the text).
const BACK_EXACT = new Set([
  "autor", "autora", "autores", "autoras", "el autor", "la autora",
  "sobre este libro", "otros titulos", "otros titulos del autor",
  "fin", "final", "el final", "f i n", "fin de la obra",
  "este es el final", "gracias", "resena bibliografica",
  "publicidad", "nota de prensa", "grupo santillana",
  "indice onomastico", "indice de nombres", "indice tematico", "indice analitico",
  "abreviaturas", "cronologia", "imagenes", "fotografias", "fotos",
]);

// Back-matter stems (prefix / phrase match).
const BACK_RE =
  /^(notas?|nota final|nota del|nota de la|notas del|notas de la|notas a|agradecimiento|reconocimiento|epilogo|bibliografia|glosario|apendice|anexo|cronologia|abreviatura|laminas?|ilustracion|referencias?|fuentes|biografia|otros titulos|publicidad|este es el final|si te ha gustado|encuentra aqui|para ir mas alla|lecturas recomendadas)/;

// Author bio at the end: "sobre el autor", "acerca del autor", "sobre la autora"…
const AUTHOR_RE = /^(sobre|acerca)\b.*\bautor/;

// Figure/plate indexes — "Lista de ilustraciones", "Índice de figuras",
// "Relación de mapas"… These are apparatus that sit at either edge (usually
// front, sometimes back). Not to be confused with the FRONT_EXACT
// "indice/tabla de contenido(s)/materias", which are checked before this.
const LIST_RE =
  /^(?:lista|indice|relacion|tabla|nomina) de (?:ilustraciones|imagenes|figuras|mapas|laminas|graficos|graficas|cuadros|tablas|siglas|abreviaturas|acronimos|fotografias|fotos)\b/;

// Apparatus that can sit at EITHER edge — covers/credits/colophon appear both
// as the first pages and as the last. Trimmed in the leading OR trailing run.
const EITHER_EXACT = new Set([
  "creditos", "credito", "creditos y derechos", "copyright", "contraportada",
  "colofon", "pagina de creditos",
]);
const EITHER_RE = /^(creditos?|copyright|colofon|contraportada)\b/;

/**
 * Classify one TOC title as "front" | "back" | "either" | "body".
 * Front is checked before back so "nota previa" (front) beats the /^notas?/
 * back stem. Anything unmatched — numbered/titled chapters — is body.
 */
export function classifyTitle(title) {
  const t = normTitle(title);
  if (!t) return "body";
  if (EITHER_EXACT.has(t) || EITHER_RE.test(t)) return "either";
  if (FRONT_EXACT.has(t) || FRONT_RE.test(t)) return "front";
  if (BACK_EXACT.has(t) || BACK_RE.test(t) || AUTHOR_RE.test(t) || LIST_RE.test(t))
    return "back";
  return "body";
}

// A genuine body chapter whose presence stops the *trailing* edge scan — a
// numbered or labelled real chapter, or the owner-keep "conclusión" (a book's
// closing content, kept at the tail). Only titles that classifyTitle already
// deemed "body" are tested here; a match halts the edge run so narrative is
// never swallowed. Bias is to keep: over-matching a stopper only ever hides
// *less*. (Introducción used to live here; the operator now trims it as front
// matter — see FRONT_RE — and the leading walk uses isLeadingStopper instead.)
const STOP_NORM = new Set(["conclusion", "conclusiones"]);
const STOP_RAW_RE =
  /^\s*(cap[ií]tulo|parte|libro|secci[oó]n|acto|escena|canto|\d{1,4}|[ivxlcdm]+)\b/i;
function isBodyStopper(rawTitle) {
  if (STOP_NORM.has(normTitle(rawTitle))) return true;
  return STOP_RAW_RE.test((rawTitle || "").trim());
}

// A *precise* "this is a real numbered/labelled chapter" test, used only to
// anchor the terminal-cut below. Unlike STOP_RAW_RE (deliberately loose — a
// false stopper only ever keeps *more*), this must not fire on ordinary titles:
// a chapter-word prefix, or a STANDALONE number/roman (followed by a delimiter
// or the end). STOP_RAW_RE matches "Cámara" because its non-Unicode `\b` treats
// the accented "á" as a boundary right after the roman letter "C"; requiring a
// delimiter/end after the numeral avoids that. "tomo" is intentionally absent —
// a "Tomo VIII" half-title is a volume label, not a chapter, and sits up front.
const STRUCT_RE =
  /^\s*(cap[ií]tulos?|partes?|libros?|secci[oó]n|acto|escena|canto)\b|^\s*(\d{1,4}|[ivxlcdm]+)\s*([.):\-–—»]|$)/i;
function isStructuralChapter(rawTitle) {
  return STRUCT_RE.test((rawTitle || "").trim());
}

// A numeric-looking title whose leading token is a 4-digit year ("1914",
// "1914. El año de la catástrofe"). STRUCT_RE matches it (the "1914." trips the
// standalone-number branch), but it is a half-title / date page, not chapter
// 1914 — so it must NOT stop the leading trim. The range is restricted to
// plausible printed-book years, leaving ordinary "1." / "23." chapters untouched.
const YEAR_RE = /^\s*[12]\d{3}(\D|$)/;
function isYearTitle(rawTitle) {
  return YEAR_RE.test((rawTitle || "").trim());
}

// The stopper for the LEADING trim (distinct from isBodyStopper, which the
// trailing walk still uses): halt at genuine narrative — a chapter-word prefix,
// or a standalone leading number/roman — but never at a year half-title. It sits
// between STOP_RAW_RE (too loose: its bare `\b` fires on "Cámara" because the
// accented "á" is a boundary after the roman letter "C") and STRUCT_RE (too
// strict: it demands a delimiter after the numeral, so it MISSES a space-
// separated "1 La llegada" / "IV La casa" — a real chapter). Here the numeral
// must be followed by whitespace, a delimiter, or the end: that accepts the
// space form yet still rejects "Cámara" ("C" is followed by "á"). Front-matter
// forms (cubierta, prólogo, prefacio, introducción, sinopsis…) are classified
// `front` and trimmed before this test is reached, so a false non-stopper only
// ever trims more front matter — a numbered/labelled chapter is never skipped.
const LEAD_STOP_RE =
  /^\s*(cap[ií]tulos?|partes?|libros?|secci[oó]n|acto|escena|canto)\b|^\s*(\d{1,4}|[ivxlcdm]+)(?=[\s.):\-–—»]|$)/i;
function isLeadingStopper(rawTitle) {
  const t = (rawTitle || "").trim();
  return LEAD_STOP_RE.test(t) && !isYearTitle(t);
}

// The leading front-matter boundary: index of the last apparatus chapter
// reachable from the start, tolerating single sandwiched unrecognized titles,
// scanning only indices [0, limit). `back`-classified titles count as apparatus
// here (front-positioned acknowledgements / figure-lists queue before the first
// chapter). Factored out so the degenerate-fallback path in bodyBounds can re-run
// it bounded by the trailing boundary. Returns -1 when nothing leads.
function leadingBoundary(kinds, chapters, limit) {
  let lead = -1;
  for (let i = 0, gap = 0; i < limit; i++) {
    if (kinds[i] === "front" || kinds[i] === "either" || kinds[i] === "back") {
      lead = i; gap = 0; continue;
    }
    if (isLeadingStopper(chapters[i].title) || ++gap >= 2) break;
  }
  return lead;
}

// The terminal-cut never trims more than this fraction of the book's text — a
// backstop against compound/omnibus files (multiple works in one EPUB) whose
// first work's back matter precedes a later work in spine order. Real trailing
// apparatus (appendices, plate galleries, notes, bibliography) is a small tail;
// a swallowed second work is not. Tuned on a scan of the whole library: genuine
// apparatus cuts sit ≤0.25, the compound-work false positives ≥0.6.
const TAIL_CUT_MAX_FRACTION = 0.5;

// A duplicate-detection key that, unlike normTitle, KEEPS the chapter number —
// normTitle folds "Capítulo 1" and "Capítulo 16" both to "capitulo", which would
// make every numbered chapter look like a repeat. Here "capitulo 1" ≠
// "capitulo 16", so only a genuinely repeated title (per-chapter endnotes that
// echo the whole chapter list) collides with an earlier one.
function contentKey(s) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents (keep the base letter)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // fold punctuation, KEEP digits
    .trim();
}

// A leading half-title page whose title merely echoes the book's OWN title —
// e.g. a chapter literally named "It (eso)" inside the book "It (eso)", or "Eso"
// / "It" alone. These are title pages, carry no narrative, and must be trimmed
// as front matter. Matched on the punctuation-folded contentKey: an exact match,
// or a whitespace-bounded prefix in EITHER direction so that a book "It" ~ a
// chapter "It (eso)" (and the reverse, when the EPUB metadata title carries the
// translation but the half-title doesn't). The shorter key must be ≥4 chars so a
// generic 2–3 char title ("Yo", "El") can't collide with an unrelated chapter,
// and structural chapters ("1984", "Capítulo 3") are never echoes even when the
// book title is numeric — that guard lives at the call site.
function isTitleEcho(rawTitle, bookKey) {
  if (!bookKey) return false;
  const k = contentKey(rawTitle);
  if (!k) return false;
  if (k === bookKey) return true;
  const [short, long] = k.length <= bookKey.length ? [k, bookKey] : [bookKey, k];
  return short.length >= 4 && long.startsWith(short + " ");
}

/**
 * Given the char-indexed chapter list, return the body span and a per-chapter
 * "skipped" flag.
 *
 * The apparatus at each edge does not always classify cleanly — a half-title
 * page (often just the book's own title), a "Prefacio", an "Índice de
 * contenido" and a part-divider can queue in any order before the first real
 * chapter. A single unrecognized item between recognized matter must not break
 * the run (that was the "Índice + Prefacio leaked into Seis piezas fáciles"
 * bug). So we walk each edge *tolerantly*: we keep advancing the trim boundary
 * to the last front/back/either chapter we see, stepping over unrecognized
 * chapters in between, and only stop when we hit a genuine body chapter
 * (isBodyStopper) or two unrecognized chapters in a row — two real chapters
 * back-to-back means we are inside the narrative, not the apparatus.
 *
 * Mid-book apparatus (a "Notas" or "Mapa" between real chapters) is still kept,
 * and the whole document is returned if the trim would be degenerate.
 *
 * @returns {{startChar:number, endChar:number, skipped:boolean[]}}
 */
export function bodyBounds(chapters, charTotal, bookTitle) {
  const n = chapters ? chapters.length : 0;
  const whole = { startChar: 0, endChar: charTotal, skipped: new Array(n).fill(false) };
  if (n < 2) return whole;

  const kinds = chapters.map((c) => classifyTitle(c.title));

  // A leading half-title page that just repeats the book's own title (Stephen
  // King's "It (eso)" opens with a chapter literally named "It (eso)") is not
  // caught by the front-matter vocabulary — it looks like an ordinary "body"
  // title. Reclassify any book-title echo as `front` so the leading walk trims
  // it. Guarded by !isStructuralChapter so a numbered chapter can never be an
  // echo even when the book title is numeric ("1984" the book vs chapter 1984).
  // The mark is inert in the trailing walk (it keys off back/either) and the
  // leading walk never reaches a mid-book echo, so this only ever trims a true
  // leading title page.
  const bookKey = contentKey(bookTitle);
  if (bookKey) {
    for (let i = 0; i < n; i++) {
      if (
        kinds[i] === "body" &&
        !isStructuralChapter(chapters[i].title) &&
        isTitleEcho(chapters[i].title, bookKey)
      ) {
        kinds[i] = "front";
      }
    }
  }

  // Leading run: last apparatus index reachable from the start, tolerating
  // sandwiched unrecognized items. `gap` counts consecutive unrecognized
  // (body-ish) chapters; two in a row means the narrative has begun. Note that
  // `back`-classified titles count as apparatus HERE too: acknowledgements,
  // figure-lists and the like are back-matter vocabulary, but when they queue
  // *before* the first real chapter they are front matter by position — e.g.
  // "El efecto Lucifer" opens Prólogo → Agradecimientos → Lista de ilustraciones
  // before Capítulo 1, and all three must be trimmed. The run stops only at a
  // genuine structural chapter (isLeadingStopper) or two unrecognized titles in a
  // row, so real narrative is never swallowed — while a numeric year half-title
  // ("1914. El año de la catástrofe") is NOT a stopper and is trimmed as front.
  let lead = leadingBoundary(kinds, chapters, n);

  // Trailing run: mirror from the end for back/either.
  let trail = n;
  for (let j = n - 1, gap = 0; j >= 0; j--) {
    if (kinds[j] === "back" || kinds[j] === "either") { trail = j; gap = 0; continue; }
    if (isBodyStopper(chapters[j].title) || ++gap >= 2) break;
  }

  // Repeated per-chapter back matter: a "Notas" (or other back marker) followed
  // by a run of titles that merely *echo earlier chapter titles* — many books
  // append endnotes as a second copy of the whole chapter list ("Capítulo 1" …
  // "Capítulo 16" again). The repeats classify as body, so the plain trailing
  // walk above stops dead at the first one; detect the marker directly instead.
  // The block only qualifies when every chapter after the marker is either a
  // duplicate or more back matter (no first-occurrence body chapter — that would
  // be real text, i.e. an ordinary mid-book "Notas" between chapters, which we
  // keep). This never fires without an explicit back marker, so a lone repeated
  // title at the end is left alone.
  const firstSeen = new Map();
  chapters.forEach((c, i) => {
    const k = contentKey(c.title);
    if (k && !firstSeen.has(k)) firstSeen.set(k, i);
  });
  const isRepeat = (i) => {
    const k = contentKey(chapters[i].title);
    return k && firstSeen.get(k) < i;
  };
  for (let b = 0; b < trail; b++) {
    if (kinds[b] !== "back") continue;
    let dups = 0, bodyFirst = 0;
    for (let k = b + 1; k < n; k++) {
      if (isRepeat(k)) dups++;
      else if (kinds[k] === "body" && isBodyStopper(chapters[k].title)) bodyFirst++;
    }
    if (dups >= 2 && bodyFirst === 0) { trail = b; break; }
  }

  // Terminal back-matter cut. Non-fiction often closes with an "Anexos" /
  // "Apéndice" / "Cronología" section whose own sub-entries carry plain,
  // body-looking titles ("Lugares de interés", "Los protagonistas"), so the
  // tolerant trailing walk stalls two-plain-titles-in and strands the whole
  // tail in the body ("Breve historia de la Segunda Guerra Mundial" kept its
  // Anexos block this way). When the book has a genuine numbered/labelled
  // chapter we can trust a stronger rule: from the earliest recognized back
  // marker that (a) sits after the last such chapter and (b) has no real
  // chapter after it, everything to the end is apparatus. The length cap keeps
  // a compound/omnibus file's first-work apparatus from swallowing a later
  // work; the loop then falls through to a smaller, safe marker if the first is
  // too greedy (so the sonnets survive but "Ediciones consultadas" still goes).
  let lastStruct = -1;
  for (let i = 0; i < n; i++) if (isStructuralChapter(chapters[i].title)) lastStruct = i;
  if (lastStruct >= 0) {
    const stopFrom = new Array(n + 1).fill(false); // is there a body-stopper at index >= k?
    for (let k = n - 1; k >= 0; k--)
      stopFrom[k] = stopFrom[k + 1] || isBodyStopper(chapters[k].title);
    for (let m = Math.max(lead + 1, lastStruct + 1); m < trail; m++) {
      if (kinds[m] !== "back" || stopFrom[m]) continue;
      if (charTotal - chapters[m].charIndex <= charTotal * TAIL_CUT_MAX_FRACTION) {
        trail = m;
        break;
      }
    }
  }

  // If the leading run sailed INTO the trailing back-matter, the body collapses.
  // This happens when a lone real chapter is wedged between front matter and a
  // trailing back run: the single chapter is only one `gap`, so the back run
  // resets it and advances `lead` to the end. Rather than bail to the whole
  // (untrimmed) book, re-clip the leading run to stop at the trailing boundary so
  // the front AND back apparatus are still trimmed. Only the degenerate case is
  // re-clipped, so well-formed books are untouched.
  if (lead + 1 > trail - 1) lead = leadingBoundary(kinds, chapters, trail);
  if (lead + 1 > trail - 1) return whole; // genuinely nothing but matter — show it all

  const startChar = lead < 0 ? 0 : chapters[lead + 1].charIndex;
  const endChar = trail >= n ? charTotal : chapters[trail].charIndex;
  if (!(startChar < endChar)) return whole;

  const skipped = chapters.map((_, k) => k <= lead || k >= trail);
  return { startChar, endChar, skipped };
}
