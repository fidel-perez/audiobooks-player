/**
 * Speech text cleaning for EPUB body text.
 *
 * A focused, Spanish-first port of the audiobook cleaner in
 * `raspberry_pi/services/document_to_txt_or_opus/clean.py`, adapted for the
 * in-browser reader. Because the EPUBs are already structured, the heavy PDF-era
 * passes (repeated running-head removal, PDF de-hyphenation) are NOT needed —
 * epub.js already drops `<head>`/`<nav>`/page chrome. What survives and still
 * trips the voice are inline artifacts:
 *
 *   - footnote / index markers read aloud  → `[3]` → (removed)
 *   - a book that numbers its lines → the series is dropped, the lone figure on
 *     its own line is kept (numberScaleIn / setNumberScale)
 *   - roman-numeral chapter headings read letter-by-letter → `XXVII`, `M`, `VI`
 *     (dropped — the operator does not want chapter numbers spoken)
 *   - scene-break rules  → `* * *` → `.`  (a bare dot; the reader hears a pause)
 *   - abbreviations  → `Sr.` → `Señor`
 *   - symbols  → `%` → ` por ciento `
 *   - punctuation glued to the next word  → `hola.Adiós` → `hola. Adiós`
 *   - big numbers recited in full → `123 333 000` → `123 millones` (see the
 *     "numbers" block below — this is a BEDTIME reader; long figures are noise)
 *   - a repeated letter → `graaaaaaan` → `graan`
 *   - scholarly apparatus read as letters → `pp. 12-14` ("pepe doce catorce"),
 *     `op. cit.`, `ibíd.` → (removed)
 *   - onomatopoeia spelled out → `Mmm` ("eme eme eme") → (removed)
 *   - a clock or a range read wrong → `6:00 p. m.` ("seis cero cero pe eme") →
 *     `6 de la tarde`; `662-664` (two numbers, no connector) → `662 a 664`
 *   - a slash read as "barra" → `km/h`, `amor/odio`, `3/4`
 *   - a footnote marker flattened into its word → `cumplidos1` → `cumplidos`
 *
 * THE RULE WHEN THE TWO CONFLICT: easier listening beats accuracy. A page
 * citation, a postal code, an ISBN and a catalog id are all DROPPED rather than
 * spoken — they exist for a reader with the book open, never for someone
 * falling asleep. Nothing that carries story is ever dropped on that argument.
 *
 * Applied by epub.js to each spine document *after* htmlToText and *before*
 * concatenation, so chapter char-offsets, saved reading positions, and the
 * browser voice's word-boundary highlight all stay consistent (the cleaned text
 * is the single source the player reads AND displays).
 *
 * Deliberately NOT done, to protect science books: no NFKC and no superscript
 * stripping — either would turn `m²` / `km²` / `m³` into `m` / `m2`, silently
 * corrupting units. Bracket footnotes (`[3]`) are the far more common form here.
 */

import { CHARS_PER_PAGE } from "./config.js";
import { deDoublet } from "./deDoublet.js";

/**
 * Rewrite the heavy internal pause punctuation as commas. Applied LAST in
 * `speechTextFrom`, so it only ever touches the AUDIO string — the stored text
 * and every char offset (progress, chapters, page marks) are untouched.
 *
 * Formerly the opt-in "🧪 Pausas suaves" mode; now baked in permanently because
 * it works. It fights the neural voice's occasional near-full-stop MID-phrase:
 * Piper renders `;`/`:` and a parenthetical dash as a sentence break — which is
 * a falling intonation contour and a lengthened phone before it, not only the
 * silence, and only the silence is something `capSilence` can take back out
 * afterwards (piper-trim.js). This keeps the phrase sounding unfinished, which
 * is what it is.
 *
 * `;` and `:` render like a sentence break; an em/en dash is ALWAYS punctuation
 * in Spanish (the raya de inciso — spaced on the OUTside, tight on the inside:
 * "Ella —la mayor— entró"), never part of a word, so any of them becomes a comma
 * beat. A hyphen-minus is only a pause when SPACED on both sides; tight, it is a
 * compound ("político-social") and is left alone. Sentence-final `.?` and plain
 * commas are never touched, so the line stays intelligible.
 */
export function softenPauses(s) {
  if (!s) return s;
  return s
    // An exclamation reads excited, which is wrong at bedtime. A question mark
    // in the same cluster survives: the phrase is still a question.
    .replace(/¡+\s*/g, "")
    .replace(/\s*[.?!]*!+[.?!]*/g, (m) => (m.includes("?") ? "?" : "."))
    .replace(/\s*[;:]\s*/g, ", ") // semicolon / colon → comma beat
    .replace(/\s*[—–]\s*/g, ", ") // em/en dash (raya de inciso) → comma beat
    .replace(/\s+-\s+/g, ", ") // hyphen-minus ONLY when spaced → comma beat
    .replace(/\s+([,.])/g, "$1") // drop any space we opened before a comma/stop
    .replace(/,\s*,/g, ",") // collapse a doubled comma the passes can create
    .replace(/,\s*([.!?])/g, "$1") // a dash hard against a full stop → just the stop
    .replace(/\s{2,}/g, " ")
    .trim();
}

// A valid roman numeral 1–3999 (uppercase only — headings are uppercased, and
// requiring caps keeps Spanish words like "vi"/"di"/"mi" safe). Empty is not a
// numeral, so callers gate on a non-empty `[IVXLCDM]+` first.
const ROMAN_BODY = "M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})";
const ROMAN_RE = new RegExp(`^${ROMAN_BODY}$`);

/** True iff `s` is a well-formed uppercase roman numeral (e.g. "XXVII", "M"). */
export function isRoman(s) {
  return /^[IVXLCDM]+$/.test(s) && ROMAN_RE.test(s);
}

// Chapter/section head-words that may precede a roman number in a heading line.
const CHAPTER_WORD = "(?:Cap[ií]tulo|Parte|Libro|Secci[óo]n|Tomo|Acto|Escena|Canto|Volumen)";
// "Capítulo XII" / "Parte VI: …" at the START of a line → the numeral is dropped,
// the head-word kept. Anchored to line start (with the `m` flag) so mid-sentence
// prose like "en el capítulo XII se explica" is never touched. The numeral must
// be followed by end-of-line or a separator (`: . — -`), not another title word,
// so "Capítulo MI amigo" stays intact.
const CHAPTER_ROMAN_RE = new RegExp(
  `^(\\s*${CHAPTER_WORD})\\s+([IVXLCDM]+)(?=\\s*(?:[:.\\-\\u2013\\u2014]|$))`,
  "gm",
);

// A whole line that is nothing but a roman numeral, optionally wrapped in
// heading punctuation/space ("XXVII", "— VI —", "M."). The number part is
// captured so it can be validated before the line is dropped.
const STANDALONE_ROMAN_LINE_RE =
  /^[\s.:·•\-–—]*([IVXLCDM]+)[\s.:·•\-–—]*$/gm;

// A line that is only an arabic number. One such line is a figure the book
// meant; a long climbing series of them is print chrome — the numbering the
// operator hears as page numbers. See `numberScaleIn`.
const NUMBER_LINE_RE = /^[ \t.:·•\-–—]*(\d{1,4})[ \t.:·•\-–—]*$/gm;
// The same line, but only where a chunk opens. See `dropChapterOpeningNumbers`.
const LEADING_NUMBER_LINE_RE = /^[ \t.:·•\-–—]*\d{1,4}[ \t.:·•\-–—]*(?:\r?\n|$)/;
// A real numbering runs the length of the book; odd-only and even-only series
// exist, so the step is bounded, not fixed at one.
const MIN_SCALE = 20;
const MAX_STEP = 4;

// A book that prints a number on every page is numbering something — verses,
// laws, paragraphs, notes — and a count read aloud belongs to nobody.
//
// The Corán is the case: its verse number sits INSIDE the line, often glued to
// the word after it ("33A aquellos").
//
// WHICH numbers go is a POSITION test: a line head, or glue to the capital
// opening the next word. A number inside a sentence stays.
//
// A physics book trips the verdict on figure numbering alone, and dropping
// every digit turned "(ver Fig. 5.3c)" into "(ver Fig. c)".
const ANY_NUMBER_RE = /\d+/g;
// The whole figure and its glue, so "15/12/2009", "662-664" and "5 %" leave
// nothing for the voice to trip on.
const DROP_NUMBER_RE =
  /\d+(?:(?:[.,:/–—-]|\s+[oay]\s+)\d+)*\.?[ºªao°]?(?:\s*%)?/g;
// Only blanks pad a line head. A stop must not: "en 1918. 20 años después"
// puts a real quantity right after one.
const HEAD_PAD_RE = /[ \t]/;
// A verse, a page and a law number sit under this; past it, a number opening
// a line is a year.
const CHROME_MAX = 1000;
// What a dropped number leaves standing.
const EMPTY_PAREN_RE = /\(\s*\)|\[\s*\]/g;

// A "visual break" line — only asterisks / dashes / bullets / spaces. Replaced
// by a single "." so the chunker makes a sentence boundary (a heard pause) with
// no extra spacing or spoken words.
const SCENE_BREAK_RE = /^[ \t]*[*_·•\-–—](?:[ \t]*[*_·•\-–—])*[ \t]*$/gm;

// Bracketed footnote / index markers ("[3]", "[12]") anywhere in the line.
//
// 455 "[8.3]" and 101 "[*1]" in *El tejido del cosmos*: read "ocho punto
// tres", or left as a bare "[ ]".
const BRACKET_INDEX_RE = /\[\*?\d+(?:\.\d+)?\]/g;

// The same marker in parentheses ("una nota(1) al pie"). espeak reads it as a
// pause and a number: "una nota, uno, al pie". Only when GLUED to the previous
// word — a list item at the start of a line ("(1) Primero") is real structure
// and keeps its number. Written as a capture group rather than a lookbehind,
// which older mobile Safari cannot parse at all.
const PAREN_INDEX_RE = /([\p{L}.,;:!?])\(\d{1,3}\)/gu;

// --- numbers -------------------------------------------------------------
//
// THIS IS A BEDTIME READER. A big number is a problem even when the voice says
// it correctly: "123 333 000" spelled digit-by-digit is useless, and the fully
// correct "ciento veintitrés millones trescientos treinta y tres mil" is six
// seconds of arithmetic recited at someone trying to fall asleep. Both fail.
//
// So big numbers are ROUNDED to a two-or-three-word approximation instead:
// "123 millones". No hedge word ("unos") — a book's figures are understood to
// be approximate and the hedge is one more syllable. Two shapes feed it:
//
//   1. Space-grouped thousands — "123 333 000" is three separate 3-digit tokens
//      to espeak-ng (Piper's phonemizer), and the SI thin/no-break variants are
//      worse. Glued into one run first, so the value can be read at all.
//   2. Spanish dot/comma thousands — "1.234.567". Only groups of exactly three
//      count, so a decimal ("3.14", "3,5") is never mistaken for grouping.
//
// Small numbers are left exactly as written: years (1918), page and chapter
// numbers, small counts. Nothing under five digits is worth rounding.

// Thousands groups separated by any space flavour: "12 000", "123 333 000".
// `\b` at the front cannot match between two digits, so the "914 400" inside
// "1914 400" is never picked up; `(?!\d)` stops a 4-digit group being eaten.
// Real thousands grouping runs to the END of the number, so a trailing group
// of one or two digits means this was never a thousands group at all: phone
// numbers ("91 702 19 70") are written exactly like this and must be left for
// the voice to read as the digit pairs they are.
const GROUPED_NUMBER_RE = /\b\d{1,3}(?:[ \u00a0\u202f\u2009]\d{3})+(?![ \u00a0\u202f\u2009]?\d)/g;
const GROUP_SEP_RE = /[ \u00a0\u202f\u2009]/g;
// The same grouping written with dots or commas. Every group must be exactly
// three digits, so a decimal ("3.14", "3,5") is never mistaken for grouping.
const DOT_GROUPED_RE = /\b\d{1,3}(?:[.,]\d{3})+(?![.,]?\d)/g;
const DOT_SEP_RE = /[.,]/g;

// One numeric token: digits with an *internal* decimal mark only, so a
// sentence-final period stays outside the match and is still heard as a pause.
const NUMBER_TOKEN_RE = /\d+(?:[.,]\d+)?/g;
// Guards the token above against identifiers — see normalizeNumbers.
const LETTER_RE = /\p{L}/u;
// A leading zero means the digits are a code, not a count: postal codes
// ("08034 Barcelona"), phone prefixes, document numbers. Nobody writes a
// quantity that way.
const LEADING_ZERO_RE = /^0\d/;
// Ten or more digits with no grouping at all is a registration/catalog number,
// not a figure — a real quantity that long is always written with separators.
// Rounding these produced "Código de registro: 2 billones".
const UNGROUPED_ID_DIGITS = 10;
// Phone numbers are written exactly like grouped thousands and cannot be told
// apart by shape ("948 703 934" vs the book's "123 333 000"), so the label in
// front of them is the only signal available.
// Only digits and punctuation may sit between the label and the number, so the
// reach can be long ("Tel./fax (595 21) 213 294 y …") without a stray
// "el teléfono sonó y 40 000 personas" ever being taken for a phone number.
const PHONE_CONTEXT_RE =
  /(?:tel[eé]fonos?|tel[ée]f?|tfnos?a?|fax[ao]?|m[oó]vil|whatsapp)[\s\d().,:;/+y-]{0,40}$/i;
// Up to this many integer digits a number is spoken as written (1918, 9999).
const EXACT_MAX_DIGITS = 4;

// Spanish long-scale magnitudes, largest first. 10^9 and 10^15 have no single
// spoken word here ("millardo" is not used), so they are built as "mil
// millones" / "mil billones" from the scale below — see approxSpanish.
const SCALES = [
  { v: 1e18, one: "un trillón", many: "trillones", milGap: true },
  { v: 1e12, one: "un billón", many: "billones", milGap: true },
  { v: 1e6, one: "un millón", many: "millones", milGap: true },
  { v: 1e3, one: "mil", many: "mil", milGap: false },
];
// Past "mil trillones" (10^21) there is no phrase left to round into, and no
// real prose figure is this big — such a token is an id, so it is dropped.
const MAX_APPROX = 1e21;

// "8 500 000 soldados" rounds to "9 millones soldados", which is not Spanish:
// the magnitude nouns take "de" before the thing counted ("9 millones DE
// soldados"), while "mil" is an adjective and takes none ("25 mil ejemplares").
// Only added when a word actually follows and it is not already "de"/"y".
const NEEDS_DE_RE = /(?:mill[óo]n|millones|bill[óo]n|billones|trill[óo]n|trillones)$/;
// ...and only before the thing being counted. These are the words that follow
// a figure without being that thing — function words, plus the adverbs and
// adjectives that idiomatically trail one ("2 millones exactos", "9 millones
// más"). Anything outside this list is taken for the noun.
const NOT_A_NOUN =
  "de|del|y|e|o|u|m[áa]s|menos|casi|apenas|aproximadamente|exact[oa]s?|just[oa]s?|" +
  "largos?|escas[oa]s?|en|a|al|por|con|para|que|como|seg[úu]n|entre|sin|sobre|" +
  "desde|hasta|cuando|si|no|ni|pero|aunque|mientras|donde|fueron|eran|era|" +
  "hab[íi]a|son|es|est[áa]n|se|le|les|lo|la|los|las";
const FOLLOWING_NOUN_RE = new RegExp(`^[ \\t]+(?!(?:${NOT_A_NOUN})\\b)\\p{L}`, "u");

// --- unspeakable references ------------------------------------------------
//
// Verified with `espeak-ng -v es -x`, which is exactly what Piper phonemizes
// with. These are not guesses about what sounds bad — this is what it says:
//
//   "www.ejemplo.com"  → "uve doble uve doble uve doble punto ejemplo punto com"
//   "https://x.es/y"   → "achetetepe ese barra barra … punto es barra …"
//   "©"                → "símbolo de copyright"
//   "&"                → "ampersant"
//   "ISBN 978-84-376…" → "isbn" then a minute of digits
//   "n.º 5"            → "ene o cinco"
//   "15/12/2009"       → "quince barra doce barra dos mil nueve"
//   "476 d. C."        → "cuatrocientos setenta y seis de ce"
//
// A URL or ISBN carries nothing to a listener even read perfectly, so it goes.
// The rest are said as words instead.
const DROP_REFS = [
  /\b(?:https?:\/\/|www\.)\S+/gi, // full URLs
  /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, // e-mail addresses
  /\bdoi:\s*\S+/gi, // DOIs — a digit-and-slash storm
  /\b[\w-]+\.(?:com|org|net|edu|info|gov)(?:\/\S*)?/gi, // bare domains
  /\bISBN\b[^\n:]{0,12}:?\s*[\dXx][\dXx\s-]{8,}/gi, // ISBN and its number
  /@[\w.]{2,}/g, // social handles — "@io_leen" is read "arroba io leen"
];

// Scholarly apparatus. espeak spells these out as the letters they are, and
// none of them carries anything to a listener:
//
//   "p. 34"      → "pe treinta y cuatro"     "pp. 12-14" → "pepe doce catorce"
//   "op. cit."   → "op cit"                  "cf."       → "ce efe"
//   "vv. aa."    → "ube ube a a"             "loc. cit." → "lok cit"
//
// EASIER LISTENING BEATS ACCURACY here: a page reference is for a reader with
// the book open, never for someone falling asleep, so the whole citation goes
// rather than being spoken as words.
const DROP_CITATIONS = [
  /\bp(?:p|[áa]gs?)?\.\s*\d+(?:\s*[-–—]\s*\d+)?/gi, // "p. 34", "pp. 12-14", "págs. 61-71"
  /\b(?:op\.\s*cit|loc\.\s*cit|ib[íi]d|cf|vid|et\s+al)\b\.?/gi,
  /\b(?:vv\.?\s*aa|aa\.?\s*vv)\.?/gi,
];

// An alphanumeric code — an ASIN, a catalog or product reference. espeak spells
// it letter by letter: "B08HM3KDBV" → "Be Tero ocho ache eme tres ka de be
// ube". Requires SIX characters, two digits, and a letter AFTER a digit, which
// is what a code has and a real word-plus-number does not: "COVID-19", "MP3",
// "R2D2", "A4", "Boeing 747" and "blanco75" all fail one of the three and stay.
const ALNUM_ID_RE = /\b(?=[A-Za-z\d]{6,}\b)[A-Za-z]*\d[A-Za-z\d]*[A-Za-z][A-Za-z\d]*\b/g;
const DIGIT_COUNT_RE = /\d/g;

// "©" is said, absurdly, as "símbolo de copyright"; the word is not wanted at
// all. "&" is said as "ampersant" — in Spanish it is simply "y".
const COPYRIGHT_RE = /©/g;
const AMPERSAND_RE = /\s*&\s*/g;

// espeak reads a leading currency symbol in place: "$60 mil" comes out as
// "dólar sesenta mil". Spanish says the unit after the amount. Applied AFTER
// the rounding pass so the magnitude word travels with it.
// The magnitude words are listed LONGEST FIRST: with "mil" first, the
// alternation matches the opening of "millones" and leaves "lones" behind.
const MAGNITUDE = "(?:\\s(?:millones|mill[oó]n|billones|bill[oó]n|mil)){0,2}";
// The unit is a counted noun like any other, so it needs the same "de" the
// rounding pass adds: "2 millones DE euros", but "60 mil euros".
const CURRENCY = [
  [new RegExp(`\\$\\s?(\\d[\\d.,]*${MAGNITUDE})`, "g"), "dólares"],
  [new RegExp(`€\\s?(\\d[\\d.,]*${MAGNITUDE})`, "g"), "euros"],
  [new RegExp(`£\\s?(\\d[\\d.,]*${MAGNITUDE})`, "g"), "libras"],
];

// "n.º 5" / "N° 5" → "número 5". Only before a digit, so a sentence-ending
// "n." is never rewritten.
const NUMERO_RE = /\b(?:n\.?[ºo°]|n[úu]m\.|nro\.)\s*(?=\d)/gi;

// "476 d. C." → "476 después de Cristo". Anchored to a PRECEDING NUMBER, which
// is what makes it safe: "Washington D. C." has a name in front, not a year,
// and must never become "Washington después de Cristo".
// The anchor is a digit OR a roman numeral, because centuries are written both
// ways ("476 d. C.", "siglo III a. C.").
// The era letter is matched in EITHER case — books write "476 a. C." and
// "476 A. C." in equal measure, and the uppercase form is read "a ce" just as
// badly. The ANCHOR stays uppercase-only on purpose: making the whole pattern
// case-insensitive would let a word ending in "d" ("Ciudad D. C.") play the
// part of the year.
const ERA_RE = /([\dIVXLCDM])\s*([aAdD])\.\s?(?:de\s?)?[Cc]\.(?!\p{L})/gu;

// "15/12/2009" → "15 de diciembre de 2009". Both other orders are ambiguous,
// so only a valid day/month/year in Spanish order is rewritten.
const DATE_SLASH_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g;
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

// A slash between letters is read as the word "barra": "y/o" → "i barra o",
// "km/h" → "ka eme barra ache". The common units become their spoken form; a
// small fraction becomes its Spanish name; anything else left of a slash is an
// alternative, which is "o".
const SLASH_UNITS = [
  [/\bkm\s?\/\s?h\b/gi, "kilómetros por hora"],
  [/\bm\s?\/\s?s\b/gi, "metros por segundo"],
  [/\bkm\s?\/\s?s\b/gi, "kilómetros por segundo"],
];
// Only halves/thirds/quarters — past those the name is longer than the digits
// are worth ("7/8" → "siete octavos" is not easier to hear than "7 entre 8").
const FRACTION_NAMES = { 2: ["medio", "medios"], 3: ["tercio", "tercios"], 4: ["cuarto", "cuartos"] };
const FRACTION_RE = /\b(\d{1,2})\s?\/\s?([234])\b/g;
// What is left: "y/o", "M/F", "s/c". The slash means "or".
const SLASH_ALT_RE = /(\p{L})\s?\/\s?(\p{L})/gu;

// A digit range — "662-664", "1775-1854" — is read as two bare numbers with no
// connector at all ("seiscientos sesenta y dos seiscientos sesenta y cuatro").
// A range ASCENDS, which is what tells it apart from a date fragment ("14-07")
// or a phone number, both of which are left alone.
const NUM_RANGE_RE = /\b(\d{1,4})\s?[-–—]\s?(\d{1,4})\b/g;

// A chain — "1-2-3", "M/F/M" — needs more than one pass. Both regexes above
// CONSUME the separator's right-hand side, so a single sweep leaves every other
// link untouched ("1-2-3" → "1 a 2-3") and the voice reads the leftover dash.
// Re-running to a fixed point finishes the chain, and is also what makes these
// two rules idempotent — which `speechTextFrom` depends on to re-clean a stored
// paragraph without changing it. Capped so a pathological input cannot spin.
const MAX_CHAIN_PASSES = 5;
function untilStable(s, apply) {
  for (let i = 0; i < MAX_CHAIN_PASSES; i++) {
    const next = apply(s);
    if (next === s) return s;
    s = next;
  }
  return s;
}

// "1.ª parte" is read "uno punto a"; the dot is the whole problem — "1ª" on its
// own is correctly read "primera". Same for "2.º" → "segundo".
const ORDINAL_DOT_RE = /\b(\d{1,3})\.([ºªo°])/g;

// "EE. UU." → "ee u-u". Said as the words it stands for.
const EEUU_RE = /\bEE\.?\s?UU\.?/g;

// A trailing "h" on a clock time is read as the letter: "20:30 h" → "veinte
// treinta ache".
const CLOCK_H_RE = /\b(\d{1,2}:\d{2})\s*h\b/g;
// "p. m." is read "pe eme". Said as the words Spanish actually uses. Must run
// BEFORE the o'clock rule so "6:00 p. m." has both halves fixed.
//
// Two passes, because "A. M. Homes" is an author and turning her into "de la
// mañana Homes" is worse than the problem. Uppercase is only accepted with a
// CLOCK IN FRONT of it; the lowercase form is unambiguous on its own and needs
// no anchor ("a las dos p. m.").
// With a clock in front the dots are optional too — books write "12:00 PM".
const MERIDIEM_CLOCK_RE = /(\d)\s*([apAP])\.?\s?[mM]\b\.?(?!\p{L})/gu;
const MERIDIEM_RE = /\b([ap])\.\s?m\.(?!\p{L})/gu;
// On the hour, "6:00" is read "seis cero cero". The minutes carry nothing.
const OCLOCK_RE = /\b(\d{1,2}):00\b/g;

// A footnote marker flattened into the word it hung off: "sesenta y dos años
// cumplidos1. De adolescente…", "la cinta de vídeo8". htmlToText drops the
// superscript markup, and espeak dutifully reads the number. Only a LOWERCASE
// word of 3+ letters takes the drop — "NYCGirls2001" and "Bukowsky18" are
// names, and "E350"/"A4"/"Q7" are product codes. A decimal is exempt
// ("agua0,10 litros" is a quantity that lost its space, not a marker).
const FOOTNOTE_DIGIT_RE = /\b([a-záéíóúüñ]{3,})\d{1,2}\b(?![.,]\d)/g;

// The marker BEFORE the word: "14Dios", "17sordos" — how the Corán numbers
// its verses. Runs ahead of ALNUM_ID_RE, whose shape it fits exactly.
//
// That rule deleted the whole token: 883 first words gone in 20 files.
//
// The lowercase word left behind then blocked the split, orphaning the dot,
// which espeak reads "punto".
//
// A capital, or four lowercase letters, is what a marker glues to. A unit is
// lowercase and short ("12min", "20kg", "500ml"), so it survives both.
const LEADING_MARKER_RE = /\b\d{1,3}(?=\p{Lu}\p{L}{2,}|\p{Ll}{4,})/gu;

// The same marker AFTER the stop: "estúpidos.2" is read "punto dos".
//
// 380 in de Waal, 0 across 30 random books, so no gate. Decimals are safe: a
// digit precedes their dot.
const FOOTNOTE_AFTER_STOP_RE =
  /((?:[a-záéíóúüñ]{3,}|[»”"'\)\]])[.,;:!?])\d{1,3}(?=\s|$)/g;

// An uppercase letter repeated ("MMMMMMMMMMMMM", "XXXXXX") is the artifact its
// lowercase cousin is, but the lowercase collapse cannot be reused: it would
// eat roman numerals. Five is the floor because "MMMM" (4000) is a real one.
const CAPS_RUN_RE = /([A-ZÑ])\1{4,}/g;

// A letter repeated 3+ times ("graaaaaaan", "Zzzzz") is an OCR artifact or
// stretched speech, and espeak drones every copy. Collapsed to two rather than
// deleted: deleting turned "graaaaaaan" into "grn", which is not a word either.
// LOWERCASE ONLY. An uppercase run is a roman numeral far more often than it is
// an artifact — collapsing "III" gave "II", quietly moving "siglo III" a
// century. Roman numerals have their own pass (stripRomanHeadings).
const LETTER_RUN_RE = /([a-záéíóúüñ])\1{2,}/g;
// What collapsing cannot save: a vowel-less run is spelled out letter by letter
// ("Zzz" → "zeta zeta zeta"). Three is the floor — Spanish has no vowel-less
// word that long, and the collapse above leaves onomatopoeia exactly that
// length. All-caps is exempt: spelling out "PDF" or "ONU" is exactly right.
// "y" counts as a VOWEL here: it is one in the transliterated names that reach
// Spanish books, and treating it as a consonant ate the "nnyj" of
// "Ukradënnyj".
//
// `\b` knows only ASCII word chars, so an accented vowel reads as a boundary:
// "Schrödinger" lost "Schr".
const EDGE = "(?![\\p{L}\\d])";
const NO_VOWEL_RE = new RegExp(
  `(^|[^\\p{L}\\d])(?![B-DF-HJ-NP-TV-XZÑ]+${EDGE})[b-df-hj-np-tv-xzñB-DF-HJ-NP-TV-XZÑ]{3,}${EDGE}`,
  "gu",
);

// Symbol → spoken words. Kept tiny and unambiguous (mirrors clean.py's inline
// substitutions). No NFKC, so this is the only place symbols become words.
const SYMBOLS = [
  [/%/g, " por ciento "],
  [/Δ/g, " incremento "], // Δ
  [/×/g, " por "], // espeak drops it silently: "3 × 4" → "tres cuatro"
];

// Symbols espeak either names absurdly ("♥" → "palo de corazones") or swallows
// without a trace. Neither is worth hearing, so they are removed outright. "§"
// is deliberately absent: it is correctly read "sección".
const DROP_SYMBOLS_RE =
  /[♥♦♣♠♪♫†‡•▪◦►▶→←↑↓¶®™✓✔※]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
// A stray asterisk is read aloud as the word "asterisco"; an underscore glues
// the words on either side of it together.
const STRAY_MARK_RE = /[*_]/g;

// Zero-width marks split what the number passes must read whole: Greene's
// 2504-digit number is grouped with them, and the voice read all 626 groups.
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;

// Numbers one after another are a recital, however well each is said. Six is
// the ceiling, and this backstop holds under every pass above.
const MAX_NUMBER_RUN = 6;

// A separator counts only with digits on both sides, so the comma in "1, 2"
// stays glue and the cut lands on a digit.
const RUN_TOKEN = "\\d+(?:[.,:]\\d+)*";
const RUN_TOKEN_RE = new RegExp(RUN_TOKEN, "g");

// Seven or more numbers glued by punctuation alone. Newlines are out: a chunk
// reaches the voice with its own already collapsed.
const NUMBER_RUN_RE = new RegExp(`${RUN_TOKEN}(?:[^\\p{L}\\d\\n]{1,4}${RUN_TOKEN}){6,}`, "gu");

// Past this many decimals espeak spells them one by one: "149,99999…" is the
// same recital inside a single token.
const LONG_FRACTION_RE = new RegExp(`([.,]\\d{${MAX_NUMBER_RUN}})\\d+`, "g");

/**
 * Cut every run of numbers, and every fractional tail, back to
 * `MAX_NUMBER_RUN`. Exported for testing.
 */
export function capNumberRuns(s) {
  return s
    .replace(NUMBER_RUN_RE, (m) => {
      let n = 0;
      let end = 0;
      for (const t of m.matchAll(RUN_TOKEN_RE)) {
        if (++n > MAX_NUMBER_RUN) break;
        end = t.index + t[0].length;
      }
      return m.slice(0, end);
    })
    .replace(LONG_FRACTION_RE, "$1");
}

// Spanish abbreviations → full words. The ambiguous ones from clean.py are
// intentionally omitted: `no.`/`num.` (collides with the word "No") and `D.`
// (collides with a name initial like "D. H. Lawrence"). Case-insensitive: these
// read the same whatever their case, and the risky collisions are already gone.
const ABBREVIATIONS = [
  [/\bSr\./gi, "Señor"],
  [/\bSra\./gi, "Señora"],
  [/\bSrta\./gi, "Señorita"],
  [/\bDr\./gi, "Doctor"],
  [/\bDra\./gi, "Doctora"],
  [/\bDña\./gi, "Doña"],
  [/\bUd\./gi, "Usted"],
  [/\bUds\./gi, "Ustedes"],
  [/\bp\. ej\./gi, "por ejemplo"],
  // A translated science book keeps the Latin, and espeak spells the letters.
  // Lowercase only: "E. G. Marshall" is a name, not an example.
  [/\be\.\s*g\./g, "por ejemplo"],
  [/\bi\.\s*e\./g, "es decir"],
  [/\baprox\./gi, "aproximadamente"],
  [/\bpág\./gi, "página"],
  [/\bcap\./gi, "capítulo"],
  [/\betc\./gi, "etcétera"],
  [/\bvol\./gi, "volumen"],
  // Read "art" as a word. Gated on a following number, which is what an article
  // reference always has and a name or the English word never does.
  [/\bart\.(?=\s*\d)/gi, "artículo"],
];

// Punctuation glued to the next word → add a space. Letters only in the
// lookahead (not digits) so decimals/thousands like "3.14" or "1.000" are safe.
const GLUED_PUNCT_RE = /([.,;:!?])(?=[A-Za-zÁÉÍÓÚÜÑáéíóúüñ¿¡])/g;

/**
 * Drop roman-numeral chapter numbering: standalone-numeral heading lines are
 * removed entirely; "Capítulo XII"-style lines keep the word, lose the number.
 * Exported for testing.
 */
export function stripRomanHeadings(text) {
  return text
    .replace(CHAPTER_ROMAN_RE, (m, head, num) => (isRoman(num) ? head : m))
    .replace(STANDALONE_ROMAN_LINE_RE, (m, num) => (isRoman(num) ? "" : m));
}

/**
 * True when `text` — a WHOLE book — carries a numbering series: at least
 * MIN_SCALE number-only lines that climb, each within MAX_STEP of the last.
 *
 * This is the guard that keeps `stripNumberLines` from eating a lone figure
 * that stands on its own line as content. A book numbers every page or every
 * note, so its series is long; a book without one has a handful at most, and
 * they do not climb.
 */
export function numberScaleIn(text) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const m of (text || "").matchAll(NUMBER_LINE_RE)) {
    const v = Number(m[1]);
    run = prev !== null && v > prev && v - prev <= MAX_STEP ? run + 1 : 1;
    if (run > best) best = run;
    prev = v;
  }
  return best >= MIN_SCALE;
}

/**
 * True when the WHOLE book carries a number per printed page. The page is the
 * app's own, so an EPUB's mini-pages never inflate the count.
 */
export function numberDenseIn(text) {
  const s = text || "";
  if (s.length < CHARS_PER_PAGE) return false;
  let n = 0;
  for (const m of s.matchAll(ANY_NUMBER_RE)) if (isPrintChrome(s, m.index, m[0])) n++;
  return n * CHARS_PER_PAGE >= s.length;
}

/**
 * True when the PRINTER put this number there, not the sentence. Counting and
 * dropping both ask it, so a book loses what convicted it.
 */
function isPrintChrome(text, offset, match) {
  const next = text[offset + match.length] || "";
  if (LETTER_RE.test(next) && next !== next.toLowerCase()) return true;
  if (Number(match.match(ANY_NUMBER_RE)[0]) >= CHROME_MAX) return false;
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === "\n") return true;
    if (!HEAD_PAD_RE.test(text[i])) return false;
  }
  return true;
}

/** Drop every number-only line. Only sound once `numberScaleIn` says yes. */
export function stripNumberLines(text) {
  return text.replace(NUMBER_LINE_RE, "");
}

/** Drop what the PRINTER numbered, in text that still has its newlines. Only
 * sound once `numberDenseIn` says yes. */
export function stripPrintChrome(text) {
  return text
    .replace(DROP_NUMBER_RE, (m, at, whole) => (isPrintChrome(whole, at, m) ? "" : m))
    .replace(EMPTY_PAREN_RE, "");
}

/**
 * `buildChunks` collapsed the newline `isPrintChrome` reads, so the Corán's
 * marker reaches the voice fused to the sentence before it
 * ("Misericordioso, 2."): 6289 chunks of 15708.
 *
 * Re-cut from the book text, offsets untouched.
 *
 * `stripNumberLines` runs here too when the book numbers whole lines: a second
 * re-cut from `fullText` would undo the first.
 */
export function dropPrintChromeFromChunks(chunks, fullText) {
  for (const c of chunks) {
    const raw = fullText.slice(c.start, c.end);
    const said = stripPrintChrome(numberScale ? stripNumberLines(raw) : raw)
      .replace(/\s+/g, " ")
      .trim();
    // A chunk that WAS the numbering keeps a dot: "" stalls the engine.
    c.text = said || ".";
  }
}

/**
 * Re-cut every chunk from the book text, where the numbering still stands on a
 * line of its own. `buildChunks` collapses newlines, so by the time a chunk
 * reaches the voice the number is fused to the paragraph after it ("270 Esta
 * puede…") and no line-anchored pass can see it. Offsets are untouched.
 */
export function dropNumberLinesFromChunks(chunks, fullText) {
  for (const c of chunks) {
    const said = stripNumberLines(fullText.slice(c.start, c.end))
      .replace(/\s+/g, " ")
      .trim();
    // A chunk that WAS the numbering keeps a dot: "" stalls the engine.
    c.text = said || ".";
  }
}

/**
 * Nine chapter-opening digits sit far under the `numberScaleIn` floor that
 * protects a lone `1918`. A chapter start says heading, so no book verdict.
 */
export function dropChapterOpeningNumbers(chunks, fullText, chapters) {
  for (const ch of chapters || []) {
    const c = chunks.find((k) => k.start === ch.charIndex);
    if (!c) continue;
    const said = fullText
      .slice(c.start, c.end)
      .replace(LEADING_NUMBER_LINE_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    if (said) c.text = said;
  }
}

// Stripping is per book, deciding is per book, but the speak-time pass sees one
// chunk. The verdict travels here, set when a book is opened.
let numberScale = false;

/** Record whether the open book numbers its lines. Called on activation. */
export function setNumberScale(on) {
  numberScale = !!on;
}

// Same shape, same reason: the verdict is the book's, the pass sees one chunk.
let numberDense = false;

/** Record whether the open book prints a number on every page. */
export function setNumberDense(on) {
  numberDense = !!on;
}

// Same shape, same reason: doubletEditIn asks the whole book, cleanForSpeech
// sees one document.
let doubletEdit = false;

/** Record whether the open book was written in gendered doublets. */
export function setDoubletEdit(on) {
  doubletEdit = !!on;
}

/**
 * Round `v` (>= 10^4) to the shortest Spanish phrase that keeps its scale:
 * 47300 → "47 mil", 123333000 → "123 millones", 1.23e9 → "mil millones".
 * Returns "" past 10^21, where no phrase is left. Exported for testing.
 */
export function approxSpanish(v) {
  if (!Number.isFinite(v) || v >= MAX_APPROX) return "";
  for (const sc of SCALES) {
    if (v < sc.v) continue;
    const n = Math.round(v / sc.v);
    if (n < 1000) return n === 1 ? sc.one : `${n} ${sc.many}`;
    // Rounding pushed it over its own scale. For "mil"/"millón" the next scale
    // is a plain 1000x away, so promote into it; for the 10^9 and 10^15 gaps
    // Spanish has no word, and the phrase is built as "N mil <scale>".
    if (!sc.milGap) return "un millón";
    const hi = Math.round(n / 1000);
    return hi === 1 ? `mil ${sc.many}` : `${hi} mil ${sc.many}`;
  }
  return "";
}

/**
 * Make numbers sleepable: undo thousands grouping (which espeak-ng cannot read
 * and would spell digit by digit), then round anything past four digits to a
 * short spoken magnitude. Small numbers pass through untouched.
 * Exported for testing.
 */
export function normalizeNumbers(text) {
  return text
    .replace(GROUPED_NUMBER_RE, (m, offset, whole_text) =>
      PHONE_CONTEXT_RE.test(whole_text.slice(Math.max(0, offset - 60), offset))
        ? m
        : m.replace(GROUP_SEP_RE, ""),
    )
    .replace(DOT_GROUPED_RE, (m) => m.replace(DOT_SEP_RE, ""))
    .replace(NUMBER_TOKEN_RE, (m, offset, whole_text) => {
      // A digit run touching a letter is an identifier, not a quantity: a DNI
      // ("07123432P"), a reference ("s1550-8579"), a URL fragment. Rounding one
      // produces "7 millonesP". Checked here rather than with a lookbehind,
      // which older mobile Safari cannot parse at all.
      const prev = whole_text[offset - 1] || "";
      const next = whole_text[offset + m.length] || "";
      if (LETTER_RE.test(prev) || LETTER_RE.test(next)) return m;
      // A decimal is already short ("1,5 millones") — only its integer part
      // decides, and a rounded value has no use for the fractional digits.
      const whole = m.split(/[.,]/)[0];
      if (whole.length <= EXACT_MAX_DIGITS) return m;
      // A long code is not a quantity and is not worth spelling either: espeak
      // reads "08034" as "cero ocho punto cero tres cuatro". Dropped, like the
      // ungrouped ids below — a postal code carries nothing to a listener.
      if (LEADING_ZERO_RE.test(whole)) return whole === m ? "" : m;
      // An id this long is not worth a phrase and not worth spelling: drop it.
      if (whole.length >= UNGROUPED_ID_DIGITS && whole === m) return "";
      const phrase = approxSpanish(Number(whole));
      const rest = whole_text.slice(offset + m.length);
      if (NEEDS_DE_RE.test(phrase) && FOLLOWING_NOUN_RE.test(rest)) return `${phrase} de`;
      return phrase;
    });
}

/** Clean one document of EPUB body text for speech + display. */
export function cleanForSpeech(text) {
  if (!text) return text;
  let s = text.replace(ZERO_WIDTH_RE, "");

  s = s.replace(BRACKET_INDEX_RE, "");
  s = s.replace(PAREN_INDEX_RE, "$1");
  // References go first: they are dropped whole, which also keeps their digits
  // away from the number pass (a DOI's "10.1016/s1550-8579" is not a quantity).
  for (const re of DROP_REFS) s = s.replace(re, "");
  // Citations before the range pass, so "pp. 12-14" goes as one citation
  // instead of leaving "12 a 14" behind.
  for (const re of DROP_CITATIONS) s = s.replace(re, "");
  s = s.replace(LEADING_MARKER_RE, "");
  s = s.replace(ALNUM_ID_RE, (m) => ((m.match(DIGIT_COUNT_RE) || []).length >= 2 ? "" : m));
  // After the citations, which take their own digits away whole, and ahead of
  // every pass that would turn a digit into a word.
  if (numberDense) s = stripPrintChrome(s);
  s = s.replace(COPYRIGHT_RE, "").replace(AMPERSAND_RE, " y ");
  s = s.replace(EEUU_RE, "Estados Unidos");
  s = s.replace(NUMERO_RE, "número ");
  // After DROP_REFS, which takes the URL whose "/a" a slash rule would eat, and
  // before the slash passes, which would say "niños o as".
  if (doubletEdit) s = deDoublet(s);
  // Units before fractions before the generic "or": "km/h" must not be seen as
  // one letter slashed against another.
  for (const [re, rep] of SLASH_UNITS) s = s.replace(re, rep);
  s = s.replace(FRACTION_RE, (m, n, d) => {
    const [one, many] = FRACTION_NAMES[d];
    return `${n} ${Number(n) === 1 ? one : many}`;
  });
  s = untilStable(s, (t) => t.replace(SLASH_ALT_RE, "$1 o $2"));
  s = s.replace(ORDINAL_DOT_RE, "$1$2");
  s = s.replace(CLOCK_H_RE, "$1 horas");
  const meridiem = (half) => (half.toLowerCase() === "a" ? "de la mañana" : "de la tarde");
  s = s.replace(MERIDIEM_CLOCK_RE, (m, d, half) => `${d} ${meridiem(half)}`);
  s = s.replace(MERIDIEM_RE, (m, half) => meridiem(half));
  s = s.replace(OCLOCK_RE, "$1");
  s = s.replace(FOOTNOTE_DIGIT_RE, "$1");
  s = s.replace(FOOTNOTE_AFTER_STOP_RE, "$1");
  // A range reads as two unconnected numbers; ascending is what makes it a
  // range and not a date fragment or a phone number.
  s = untilStable(s, (t) =>
    t.replace(NUM_RANGE_RE, (m, a, b) => (Number(b) > Number(a) ? `${a} a ${b}` : m)),
  );
  s = s.replace(ERA_RE, (m, d, ad) => `${d} ${ad.toLowerCase() === "a" ? "antes" : "después"} de Cristo`);
  s = s.replace(DATE_SLASH_RE, (m, d, mo, y) => {
    const month = MONTHS[Number(mo) - 1];
    if (!month || Number(d) < 1 || Number(d) > 31) return m;
    return `${Number(d)} de ${month} de ${y}`;
  });
  s = normalizeNumbers(s);
  for (const [re, unit] of CURRENCY)
    s = s.replace(re, (m, amount) => `${amount}${NEEDS_DE_RE.test(amount) ? " de" : ""} ${unit}`);
  // Last of the number passes: what it counts is what the voice would say.
  s = capNumberRuns(s);

  // Collapse first, then drop: "sshhhhh" becomes "sshh", which the vowel-less
  // rule then recognises as the onomatopoeia it is.
  s = s.replace(LETTER_RUN_RE, "$1$1");
  s = s.replace(CAPS_RUN_RE, "");
  s = s.replace(NO_VOWEL_RE, "$1");
  s = s.replace(SCENE_BREAK_RE, ".");
  s = stripRomanHeadings(s);
  s = s.replace(DROP_SYMBOLS_RE, "");
  s = s.replace(STRAY_MARK_RE, " ");

  for (const [re, rep] of SYMBOLS) s = s.replace(re, rep);
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);

  s = s.replace(GLUED_PUNCT_RE, "$1 ");

  // Tidy the seams the passes above open up, keeping paragraph newlines.
  s = s.replace(/[^\S\n]{2,}/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * The exact string handed to the voice for one paragraph, resuming at `base`.
 *
 * The cleaning above runs at IMPORT, once, and its result is what IndexedDB
 * holds — so a book imported before a rule existed keeps the text that rule was
 * written to fix, forever. That is how "27 000" survived the space-grouped
 * number pass and reached the ear as "veintisiete cero cero cero": the pass
 * shipped, the stored paragraph did not change, and nothing re-ran it.
 *
 * So the engine gets a SECOND pass, at speak time. The passes are idempotent, so
 * this is free for a freshly-imported book and a retrofit for every older one —
 * with no migration, no re-parse, and no shift in the character offsets that
 * progress, chapters and page marks are all expressed in. Those keep pointing
 * into the stored text; only the audio is built from the re-cleaned copy.
 *
 * Measured over 60 EPUBs / 92,845 paragraphs, a second pass changed 7. Six were
 * two fixable causes: chained ranges and slashed alternatives (now run to a
 * fixed point above), and a paragraph that is nothing but a roman numeral —
 * alone it reads as the heading it is and cleans to "", which is not a thing to
 * hand an engine, hence the fallback below. Both are gone; ONE remains.
 *
 * That one: a chunk that JOINED two lines each ending in a 3-digit number reads
 * as space-grouped thousands once the newline between them is gone ("665" +
 * "713" → "666 mil"). It was a bibliography, and the newline needed to tell the
 * two apart is not in the stored chunk to recover. 1 in 92,845 is the price of
 * retrofitting every book already on every device.
 */
export function speechTextFrom(text, base = 0) {
  const raw = (text || "").slice(base);
  // A chunk is too small to tell a numbering series from a lone figure; the
  // verdict is taken per book, by `setNumberScale`.
  const body = numberScale ? stripNumberLines(raw) : raw;
  // Alone, a paragraph can clean to nothing — a heading only its neighbours
  // explain. Silence is worse than the numeral.
  const said = cleanForSpeech(body) || body.trim();
  // A chunk that WAS the numbering has nothing to say; a dot is a pause the
  // engine renders, where "" stalls it.
  return softenPauses(said || (raw.trim() ? "." : ""));
}
