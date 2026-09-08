/**
 * Collapse an inserted gendered doublet back to the epicene masculine Spanish
 * already has: "ellos y ellas" → "ellos", "niños/as" → "niños".
 *
 * Telling a doublet from an idiom is the hard part, not the regex.
 *
 * A corpus scan (doublet_scan.py) finds most stem-matched pairs older than the
 * politics: "hermanos y hermanas" in 245 books, "dioses y diosas" in 59.
 *
 * Frequency cannot separate them: "compañeros y compañeras" is common and
 * inserted, "brujos y brujas" is rare and idiom.
 *
 * The BOOK separates them. "niños/as", "todxs" and "los y las" have no
 * pre-convention reading, and the hand that writes one wrote the rest.
 *
 * Measured: 6% of books carry a marker. "trabajadores y trabajadoras" shares a
 * book with one 54% of the time, "hermanos y hermanas" 5%, under base.
 *
 * So the verdict is per book, recorded on open the way setNumberScale is.
 *
 * "él y ella" is left alone: unlike the plural it names two people. So is every
 * singular pair joined by "y".
 *
 * A singular pair joined by "o"/"u" is the exception: "otro u otra" offers one
 * thing under two spellings.
 */

const L = "a-záéíóúñü";
const C = "b-df-hj-np-tv-zñ";
const FEM_DET = "l|un|est|aquell|nuestr|vuestr|tod|much|alguno?|otr|vari|amb";
const MASC_DET = FEM_DET;

// "todos y todas las cosas" needs the FEMININE half to keep agreeing with
// "cosas", so a pair heading a feminine noun is left whole.
const NOT_FEM_HEAD = "(?!\\s+(?:las|unas|estas|esas|aquellas)\\b)";
const NOT_FEM_HEAD_S = "(?!\\s+(?:la|una|esta|esa|aquella)\\b)";

// Spanish turns "o" into "u" before an o- word, which is exactly where a
// doublet lands: "otro u otra", "obreros u obreras".
const CONJ = "\\s+[yeou]\\s+";
// Only the disjunctive joins a SINGULAR pair — see the header.
const OR = "\\s+[ou]\\s+";

// The second half repeats whatever the first half was introduced with: "a los
// ciudadanos y A LAS ciudadanas", "todos los autores y TODAS LAS autoras".
const PREP = "a|de|en|con|para|por|entre|sobre|desde|hasta|hacia|tras|contra|sin";
const restated = (det) => `((?:${PREP})\\s+)?((?:(?:${det})\\s+){1,2})`;

// Every determiner that can head one of these turns masculine on its last two
// letters, "Las" included.
const masc = (det) =>
  det.replace(/as\b/gi, (m) => (m === "AS" ? "OS" : m[0] === "A" ? "Os" : "os"));

// The feminine half often opens the sentence, so the half that survives has to
// inherit its capital.
const matchCase = (was, now) =>
  /^\p{Lu}/u.test(was) ? now[0].toUpperCase() + now.slice(1) : now;

// Spellings with no pre-convention reading: the marker and a rewrite at once.
const MARKERS = [
  [new RegExp(`\\b([${L}]{2,})(os|es)/(?:as?)\\b`, "gi"), "$1$2"],
  [new RegExp(`\\b([${L}]{2,})o/a\\b`, "gi"), "$1o"],
  [new RegExp(`\\b((?:${FEM_DET})os)/(?:${FEM_DET})?as?\\b`, "gi"), "$1"],
  [new RegExp(`\\b([${L}]{2,})\\((?:as?|es)\\)`, "gi"), "$1"],
  // The glyph stands in for the vowel it replaced: l@s, niñ@s, todxs, lobxs.
  //
  // An `x` only ever lands on a consonant, which is what keeps a sci-fi noun
  // ("neuratoxs") out.
  [new RegExp(`\\b([${L}]+)@s\\b`, "gi"), "$1os"],
  [new RegExp(`\\b([${L}]*[${C}])xs\\b`, "gi"), "$1os"],
  // Irregular stems, which no backreference can pair up.
  [new RegExp(`\\b(ellos|nosotros|vosotros|aquellos|todos|unos|los)${CONJ}(?:ellas|nosotras|vosotras|aquellas|todas|unas|las)\\b${NOT_FEM_HEAD}`, "gi"), "$1"],
  [new RegExp(`\\b(?:ellas|nosotras|vosotras|aquellas|todas|unas|las)${CONJ}(ellos|nosotros|vosotros|aquellos|todos|unos|los)\\b${NOT_FEM_HEAD}`, "gi"),
    (m, kept) => matchCase(m, kept)],
];

// The backreference is what makes this a doublet and not an enumeration: "el rey
// y la reina" has two stems. Plural only.
const STEM_MF = new RegExp(
  `\\b([${L}]{3,}?)(os|es)${CONJ}(?:${restated(`(?:${FEM_DET})as`)})?\\1as\\b${NOT_FEM_HEAD}`,
  "gi",
);
const STEM_FM = new RegExp(
  `\\b${restated(`(?:${FEM_DET})as`).replace("{1,2}", "{0,2}")}([${L}]{3,}?)as${CONJ}`
  + `(?:${restated(`(?:${MASC_DET})os`)})?\\3(os|es)\\b`,
  "gi",
);

// A singular determiner is irregular where its plural is not: "el"/"un" against
// "los"/"unos", so the stem list above cannot build it.
const FEM_DET_S = "la|una|esta|esa|aquella|toda|otra|mucha|alguna|nuestra|vuestra";
const MASC_DET_S = "el|un|este|ese|aquel|todo|otro|mucho|alg[úu]n|nuestro|vuestro";

// The same backreference, singular: "otro u otra", "un alumno o una alumna".
//
// A feminine noun after the pair still needs the feminine half, so "todo o toda
// la casa" is left whole.
const SING_MF = new RegExp(
  `\\b([${L}]{3,}?)o${OR}(?:(?:${PREP})\\s+)?(?:(?:${FEM_DET_S})\\s+)?\\1a\\b${NOT_FEM_HEAD_S}`,
  "gi",
);
const SING_FM = new RegExp(
  `\\b(?:(?:${PREP})\\s+)?(?:(?:${FEM_DET_S})\\s+)?([${L}]{3,}?)a${OR}`
  + `((?:(?:${PREP})\\s+)?(?:(?:${MASC_DET_S})\\s+)?\\1o)\\b`,
  "gi",
);

/**
 * Does this book carry a spelling only the inclusive convention writes? Two of
 * them, so one quoted line or one grammar example convicts nothing.
 */
export function doubletEditIn(text) {
  let n = 0;
  for (const [re] of MARKERS) {
    for (const _ of (text || "").matchAll(re)) if (++n >= 2) return true;
  }
  return false;
}

/** Collapse every doublet in `text`. Only sound once `doubletEditIn` says yes. */
export function deDoublet(text) {
  if (!text) return text;
  let s = text;
  for (const [re, rep] of MARKERS) s = s.replace(re, rep);
  s = s.replace(STEM_MF, "$1$2");
  // The preposition survives from whichever half restated it, the determiners
  // from the masculine half.
  s = s.replace(STEM_FM, (m, femPrep, femDet, stem, mascPrep, mascDet, suffix) => {
    const head = [(femPrep || mascPrep || "").trim(),
                  (mascDet || masc(femDet || "")).trim()].filter(Boolean).join(" ");
    return `${head ? matchCase(m, head) + " " : ""}${matchCase(head ? stem : m, stem)}${suffix}`;
  });
  s = s.replace(SING_MF, "$1o");
  s = s.replace(SING_FM, (m, _stem, kept) => matchCase(m, kept));
  return s.replace(/[^\S\n]{2,}/g, " ");
}
