/**
 * 📋 Taste profile — the whole "what I like" picture as one block of Markdown,
 * built to be pasted straight into an LLM chat for recommendations.
 *
 * The signals already exist, but each lives in its own place: ⭐ favorites and
 * 👍/👎 reactions in json-store blobs merged over a static seed (js/reactions.js),
 * 👤 favorite authors likewise, and 🌠 wishes in a blob of books the library does
 * NOT hold (js/wishlist.js). Reading them off the screen means paging an 88k-book
 * catalog through six filter chips. This module flattens all of it into text.
 *
 * Wishes are the point of including the list at all: they say "recommend around
 * these, and don't recommend these back to me — I already know I want them."
 *
 * Pure: js/biblioteca.js resolves the live maps against the catalog and hands
 * the result here. No DOM, no fetch, no clock (the caller stamps the date).
 */

/** `- Título — Autor`, or just the title when the author is unknown. */
function bookLine(b) {
  return b.a ? `- ${b.t} — ${b.a}` : `- ${b.t}`;
}

/** A `## heading` + its lines, or a one-line "(ninguno)" when the set is empty. */
function section(heading, lines) {
  return [`## ${heading} (${lines.length})`, "", ...(lines.length ? lines : ["_(ninguno)_"]), ""];
}

/**
 * Render the profile. `p` carries already-resolved arrays:
 *   generated     ISO stamp for the header (the caller owns the clock).
 *   catalogCount  books in the library, so the LLM knows the corpus size.
 *   authors       favorite author display names.
 *   favorites     ⭐ books `[{t, a}]`.
 *   likes         👍 books `[{t, a}]`.
 *   dislikes      👎 books `[{t, a}]`.
 *   wishes        🌠 books NOT in the library `[{t, a}]`.
 */
export function buildProfileText(p) {
  const {
    generated = "",
    catalogCount = 0,
    authors = [],
    favorites = [],
    likes = [],
    dislikes = [],
    wishes = [],
  } = p || {};

  return [
    "# Perfil de lectura — audiolibros",
    "",
    `Generado: ${generated} · biblioteca: ${catalogCount} libros.`,
    "",
    "Estas son mis preferencias de lectura. Los 👎 son libros que me disgustaron:",
    "no me los recomiendes ni recomiendes libros parecidos. La lista de deseos 🌠",
    "son libros que YA quiero y que aún no tengo — no hace falta que me los",
    "sugieras, pero úsalos para entender mi gusto.",
    "",
    ...section("⭐ Autores favoritos", authors.map((a) => `- ${a}`)),
    ...section("📗 Libros favoritos", favorites.map(bookLine)),
    ...section("👍 Me gustan", likes.map(bookLine)),
    ...section("👎 No me gustan", dislikes.map(bookLine)),
    ...section("🌠 Lista de deseos (no están en la biblioteca)", wishes.map(bookLine)),
  ].join("\n");
}
