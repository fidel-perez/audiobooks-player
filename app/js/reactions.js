/**
 * Book reactions layered on top of the biblioteca catalog.
 *
 * Three independent, progressively-merged signals decide how a catalog book is
 * ranked and badged — mirroring the existing favorites design, where a live
 * json-store edit always wins over a baked default:
 *
 *  - ⭐ favorite degree (0..3): per-book (js/biblioteca.js `favorites` map) OR
 *    lifted by an AUTHOR favorite (favouriting an author raises every book by
 *    that author). `bookDegree = max(pathDegree, authorDegree)`.
 *  - 👍/👎 reaction: a per-book like or dislike. Dislikes sink to the bottom.
 *
 * A static SEED (below) carries the operator's initial picks so a fresh deploy
 * already reflects them WITHOUT any books.db rebuild or json-store write — the
 * one channel we can ship in the repo. It is authored from folder slugs / plain
 * author names and matched to the catalog's display strings by NORMALISED name
 * (accent-folded, alnum tokens). Live edits (author-fav / reaction maps in
 * json-store) override the seed, including explicit "off" tombstones.
 *
 * Everything here is pure and catalog-agnostic so it unit-tests without a DOM
 * or a network; js/biblioteca.js wires it to the live maps and the catalog.
 */

/** Accent-fold + lowercase + collapse to a single-space alnum string. */
export function normName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalised token list ([] for empty input). */
export function tokens(s) {
  const n = normName(s);
  return n ? n.split(" ") : [];
}

/** Normalised token Set. */
export function tokenSet(s) {
  return new Set(tokens(s));
}

/** True when every needle token is present in the hay Set (needle ⊆ hay). */
export function subsetMatch(needleTokens, haySet) {
  return needleTokens.length > 0 && needleTokens.every((t) => haySet.has(t));
}

// --- Seed: favorite authors --------------------------------------------------
// Free-text names; a book matches when ALL of a seed author's tokens appear in
// the book's (normalised) author, so "Roger Penrose" hits "Penrose, Roger" and
// "Richard Feynman" hits "Richard P. Feynman". Full names avoid over-matching.
export const FAV_AUTHOR_NAMES = [
  "Stephen Hawking",
  "Roger Penrose",
  "Carl Sagan",
  "Frans de Waal",
  "Desmond Morris",
  "Bill Bryson",
  "Yuval Noah Harari",
  "Brian Greene",
  "Robert Sapolsky",
  "Colleen McCullough",
  "Richard Feynman",
  "Juan Luis Arsuaga",
  "Richard Leakey",
  "Ed Yong",
  "Steven Johnson",
  "Kip Thorne",
  "Peter Wohlleben",
  "George Smoot",
  "Paul de Kruif",
  "David Eagleman",
  "Dean Burnett",
  "Marc Bekoff",
  "Jessica Pierce",
];

/** Degree granted to a seed-favorited author's books (a strong ⭐, refinable). */
export const SEED_AUTHOR_DEGREE = 2;

// Precomputed token lists for the fav-author seed.
export const SEED_FAV_AUTHORS = FAV_AUTHOR_NAMES.map((n) => tokens(n));

/** Seed favorite degree for an author, given its normalised token Set. */
export function seedAuthorDegree(authorSet) {
  for (const toks of SEED_FAV_AUTHORS) {
    if (subsetMatch(toks, authorSet)) return SEED_AUTHOR_DEGREE;
  }
  return 0;
}

// --- Seed: liked / disliked books --------------------------------------------
// Authored from the operator's audiobook listening history: "category/
// author_slug-title_slug" (the trailing "#seconds#" markers are dropped). We
// parse each into {author, title} token lists and match a catalog book when the
// author matches (⊆) AND enough of the — often truncated — title tokens land.
const LIKE_SLUGS = [
  "autoayuda_desarrollo_personal/daniel_goleman-inteligencia_emocional_2-la_practica_de_la_inteligencia",
  "autoayuda_desarrollo_personal/james_o'heare-neuropsicologia_canina",
  "carl_zimmer-parasitos",
  "ciencias_fisicas_matematicas/a_i_kitaigorodski-fisica_para_todos_3-electrones",
  "ciencias_fisicas_matematicas/alfred_wegener-el_origen_de_los_continentes_y",
  "ciencias_fisicas_matematicas/andres_navas-un_viaje_a_las_ideas",
  "ciencias_fisicas_matematicas/bruce_rosenblum-metatemas_111-el_enigma_cuantico",
  "ciencias_fisicas_matematicas/carlo_rovelli-siete_breves_lecciones_de_fisi",
  "ciencias_fisicas_matematicas/erwin_schrodinger-la_nueva_mecanica_ondulatoria",
  "ciencias_fisicas_matematicas/erwin_schrodinger-metatemas_1-_que_es_la_vida",
  "ciencias_fisicas_matematicas/erwin_schrodinger-metatemas_2-mente_y_materia",
  "ciencias_fisicas_matematicas/erwin_schrodinger-metatemas_48-la_naturaleza_y_los_griegos",
  "ciencias_fisicas_matematicas/feynman_richard_p-esta_usted_de_broma_sr_feynman",
  "ciencias_fisicas_matematicas/freeman_dyson-el_cientifico_rebelde",
  "ciencias_fisicas_matematicas/g_b_shulpin-quimica_para_todos",
  "ciencias_fisicas_matematicas/g_j_whitrow-el_tiempo_en_la_historia",
  "ciencias_fisicas_matematicas/george_smoot-arrugas_en_el_tiempo",
  "ciencias_fisicas_matematicas/gerald_feinberg-claves_ciertas",
  "ciencias_fisicas_matematicas/ilya_prigogine-metatemas_23-el_nacimiento_del_tiempo",
  "ciencias_fisicas_matematicas/ilya_prigogine-metatemas_3-_tan_solo_una_ilusion",
  "ciencias_fisicas_matematicas/imre_lakatos-pruebas_y_refutaciones",
  "ciencias_fisicas_matematicas/joao_magueijo-mas_rapido_que_la_velocidad_de",
  "ciencias_fisicas_matematicas/john_boslough-el_universo_de_stephen_hawking",
  "ciencias_fisicas_matematicas/kip_s_thorne-agujeros_negros_y_tiempo_curvo",
  "ciencias_fisicas_matematicas/leonard_susskind-el_paisaje_cosmico",
  "ciencias_fisicas_matematicas/martin_bojowald-antes_del_big_bang",
  "ciencias_fisicas_matematicas/michael_white-biblioteca_cientifica_salvat_1-stephen_hawking_una_vida_para",
  "ciencias_fisicas_matematicas/penrose_roger-ciclos_del_tiempo",
  "ciencias_fisicas_matematicas/penrose_roger-la_mente_nueva_del_emperador",
  "ciencias_fisicas_matematicas/rene_fester_kratz-biologia_para_dummies",
  "ciencias_fisicas_matematicas/rene_thom-metatemas_11-parabolas_y_catastrofes",
  "ciencias_fisicas_matematicas/reuben_hersh-matematicas_una_historia_de_am",
  "ciencias_fisicas_matematicas/reviel_netz-el_codigo_de_arquimedes",
  "ciencias_fisicas_matematicas/richard_p_feynman-electrodinamica_cuantica",
  "ciencias_fisicas_matematicas/richard_p_feynman-esta_usted_de_broma_sr_feynma",
  "ciencias_fisicas_matematicas/richard_p_feynman-metatemas_65-el_caracter_de_la_ley_fisica",
  "ciencias_fisicas_matematicas/richard_p_feynman-seis_piezas_faciles",
  "ciencias_fisicas_matematicas/robert_boyle-el_quimico_esceptico",
  "ciencias_fisicas_matematicas/robert_gilmore-alicia_en_el_pais_de_los_cuant",
  "ciencias_fisicas_matematicas/roger_penrose-el_camino_a_la_realidad",
  "ciencias_fisicas_matematicas/rudolf_kippenhahn-cien_mil_millones_de_soles",
  "ciencias_fisicas_matematicas/rudolf_kippenhahn-luz_del_confin_del_universo",
  "ciencias_fisicas_matematicas/s_j_abarca-el_universo_que_somos",
  "ciencias_fisicas_matematicas/samir_okasha-una_brevisima_introduccion_a_l",
  "ciencias_fisicas_matematicas/schrodinger_erwin-la_naturaleza_y_los_griegos",
  "ciencias_fisicas_matematicas/stephen_hawking-agujeros_negros_y_pequenos_uni",
  "ciencias_fisicas_matematicas/stephen_hawking-breves_respuestas_a_las_grande",
  "ciencias_fisicas_matematicas/stephen_hawking-brevisima_historia_del_tiempo",
  "ciencias_fisicas_matematicas/stephen_hawking-el_gran_diseno",
  "ciencias_fisicas_matematicas/stephen_hawking-el_universo_en_una_cascara_de",
  "ciencias_fisicas_matematicas/stephen_hawking-historia_del_tiempo",
  "ciencias_fisicas_matematicas/stephen_hawking-hombros_de_gigantes_ed_ilustr",
  "ciencias_fisicas_matematicas/stephen_hawking-la_teoria_del_todo",
  "ciencias_fisicas_matematicas/steven_strogatz-el_placer_de_la_x",
  "ciencias_naturales/arsuaga-claves_de_la_evolucion_humana",
  "ciencias_naturales/filiberto_de_oliveir-leyendas_de_los_indios_guarani",
  "ciencias_naturales/juan_luis_arsuaga-la_especie_elegida",
  "ciencias_naturales/kruif_paul_de-cazadores_de_microbios",
  "ciencias_naturales/leakey_richard-nuestros_origenes",
  "ciencias_psicologia_cerebro_evolucion/agustin_fuentes-la_chispa_creativa",
  "ciencias_psicologia_cerebro_evolucion/antonio_damasio-sentir_lo_que_sucede",
  "ciencias_psicologia_cerebro_evolucion/antonio_damasio-y_el_cerebro_creo_al_hombre",
  "ciencias_psicologia_cerebro_evolucion/caleb_everett-los_numeros_nos_hicieron_como",
  "ciencias_psicologia_cerebro_evolucion/david_eagleman-incognito",
  "ciencias_psicologia_cerebro_evolucion/david_icke-hijos_de_matrix",
  "ciencias_psicologia_cerebro_evolucion/david_le_breton-antropologia_del_cuerpo_y_mode",
  "ciencias_psicologia_cerebro_evolucion/de_waal_frans-bonobo_and_the_atheist_the",
  "ciencias_psicologia_cerebro_evolucion/dean_burnett-el_cerebro_idiota",
  "ciencias_psicologia_cerebro_evolucion/desmond_morris-comportamiento_intimo",
  "ciencias_psicologia_cerebro_evolucion/desmond_morris-el_mono_desnudo",
  "ciencias_psicologia_cerebro_evolucion/desmond_morris-el_mundo_de_los_animales",
  "ciencias_psicologia_cerebro_evolucion/desmond_morris-el_zoo_humano",
  "ciencias_psicologia_cerebro_evolucion/desmond_morris-observe_a_su_perro",
  "ciencias_psicologia_cerebro_evolucion/dick_swaab-somos_nuestro_cerebro",
  "ciencias_psicologia_cerebro_evolucion/diego_golombek-el_cocinero_cientifico",
  "ciencias_psicologia_cerebro_evolucion/edward_osborne_wilso-consilience_la_unidad_del_cono",
  "ciencias_psicologia_cerebro_evolucion/edward_osborne_wilso-el_sentido_de_la_existencia_hu",
  "ciencias_psicologia_cerebro_evolucion/eric_r_kandel-en_busca_de_la_memoria",
  "ciencias_psicologia_cerebro_evolucion/erich_fromm-agresion_y_violencia_humanas_1-anatomia_de_la_destructividad",
  "ciencias_psicologia_cerebro_evolucion/erich_fromm-el_dogma_de_cristo",
  "ciencias_psicologia_cerebro_evolucion/erich_fromm-marx_y_su_concepto_del_hombre",
  "ciencias_psicologia_cerebro_evolucion/estanislao_bachrach-agilmente",
  "ciencias_psicologia_cerebro_evolucion/facundo_manes-el_cerebro_del_futuro",
  "ciencias_psicologia_cerebro_evolucion/facundo_manes-usar_el_cerebro",
  "ciencias_psicologia_cerebro_evolucion/francisco_mora-el_yo_clonado",
  "ciencias_psicologia_cerebro_evolucion/frans_de_waal-metatemas_136-_tenemos_suficiente_inteligenc",
  "ciencias_psicologia_cerebro_evolucion/frans_de_waal-metatemas_96-el_mono_que_llevamos_dentro",
  "ciencias_psicologia_cerebro_evolucion/frans_de_waal-primates_y_filosofos",
  "ciencias_psicologia_cerebro_evolucion/giorgio_vallortigara-cerebro_de_gallina",
  "ciencias_psicologia_cerebro_evolucion/gustave_le_bon-psicologia_de_las_masas",
  "ciencias_psicologia_cerebro_evolucion/howard_gardner-estructuras_de_la_mente",
  "ciencias_psicologia_cerebro_evolucion/howard_gardner-la_inteligencia_reformulada",
  "ciencias_psicologia_cerebro_evolucion/howard_gardner-las_cinco_mentes_del_futuro",
  "ciencias_psicologia_cerebro_evolucion/howard_gardner-verdad_belleza_y_bondad_reform",
  "ciencias_psicologia_cerebro_evolucion/humberto_maturana-de_maquinas_y_seres_vivos_auto",
  "ciencias_psicologia_cerebro_evolucion/irenaus_eibl_eibesfe-amor_y_odio",
  "ciencias_psicologia_cerebro_evolucion/stanislas_dehaene-la_conciencia_en_el_cerebro",
  "divulgacion_cientifica/al_oliver_sacks_et-historias_de_la_ciencia_y_del",
  "divulgacion_cientifica/alan_charig-la_verdadera_historia_de_los_d",
  "divulgacion_cientifica/bill_bryson-1927_un_verano_que_cambio_el_m",
  "divulgacion_cientifica/brian_cox-el_universo_cuantico",
  "divulgacion_cientifica/carl_sagan-cosmos",
  "divulgacion_cientifica/carl_sagan-sombras_de_antepasados_olvidad",
  "divulgacion_cientifica/david_blanco_laserna-las_paradojas_cuanticas",
  "divulgacion_cientifica/gerald_durrell-atrapame_ese_mono",
  "divulgacion_cientifica/ian_stewart-17_ecuaciones_que_cambiaron_el",
  "divulgacion_cientifica/j_m_mulet-vaya_timo_15-los_productos_naturales",
  "divulgacion_cientifica/jose_manuel_roldan-caligula",
  "divulgacion_cientifica/jose_manuel_roldan-cesares",
  "divulgacion_otros/alberto_casas-que_sabemos_de_1-el_boson_de_higgs",
  "ensayos/ryszard_kapuscinski-la_jungla_polaca",
  "ensayos/thomas_nagel-la_mente_y_el_cosmos",
];

const DISLIKE_SLUGS = [
  "cultura_popular/gomaespuma-grandes_disgustos_de_la_histor",
  "will_cuppy-ocaso_y_caida_de_practicamente",
];

/** "cat/author_slug-title_slug" -> {author:[toks], title:[toks]}. */
export function parseSlug(slug) {
  const base = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : slug;
  const dash = base.indexOf("-");
  const authorPart = dash >= 0 ? base.slice(0, dash) : "";
  const titlePart = dash >= 0 ? base.slice(dash + 1) : base;
  return { author: tokens(authorPart), title: tokens(titlePart) };
}

export const SEED_LIKES = LIKE_SLUGS.map(parseSlug);
export const SEED_DISLIKES = DISLIKE_SLUGS.map(parseSlug);

/**
 * A like/dislike hint matches a book when its author is a subset of the book's
 * author AND enough of the (often truncated) title tokens are present. A short
 * seed title (≤2 tokens, e.g. "parasitos") must match in full; a longer one
 * needs ≥60% (and ≥2) of its tokens, so we don't fire on a lone common word.
 */
export function hintMatches(hint, authorSet, titleSet) {
  if (!subsetMatch(hint.author, authorSet)) return false;
  const t = hint.title;
  if (!t.length) return false;
  const hit = t.filter((w) => titleSet.has(w)).length;
  if (t.length <= 2) return hit === t.length;
  return hit >= Math.max(2, Math.ceil(t.length * 0.6));
}

/**
 * Build an author-token → hints index so a book is only tested against hints
 * that share an author token (cheap over an 88k catalog). Dislikes are indexed
 * so they can be preferred over likes at lookup time.
 */
export function buildSeedIndex() {
  const idx = new Map();
  const add = (hint, kind) => {
    for (const tok of hint.author) {
      let arr = idx.get(tok);
      if (!arr) idx.set(tok, (arr = []));
      arr.push({ hint, kind });
    }
  };
  SEED_DISLIKES.forEach((h) => add(h, "dislike"));
  SEED_LIKES.forEach((h) => add(h, "like"));
  return idx;
}

/**
 * Seed reaction for a catalog book ("like" | "dislike" | null) using an index
 * from buildSeedIndex(). Dislike wins if both somehow match.
 */
export function seedReactionFor(idx, book) {
  const aToks = tokens(book.a);
  if (!aToks.length) return null;
  const aSet = new Set(aToks);
  const tSet = tokenSet(book.t);
  let like = false;
  const seen = new Set();
  for (const tok of aToks) {
    const cands = idx.get(tok);
    if (!cands) continue;
    for (const c of cands) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (hintMatches(c.hint, aSet, tSet)) {
        if (c.kind === "dislike") return "dislike";
        like = true;
      }
    }
  }
  return like ? "like" : null;
}
