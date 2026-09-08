/**
 * 📈 «Registro de progreso» — the morning readout for the per-night reading log.
 *
 * You fall asleep listening, so you cannot know what happened: did the sleep
 * auto-stop fire, did it rewind, did the book actually advance? This view answers
 * it in one glance — per night, per book: minutes advanced, minutes rewound, and
 * the net. The numbers come from js/progresslog.js; everything here is painting.
 *
 * TWO BOOKS, by deliberate design (BOOKS_SHOWN): the one you're on and the one
 * before it. The question this answers is "is tonight working", not "give me my
 * reading history", and a list of ten books buries the two rows that matter.
 *
 * The 🌙/☀️ toggle is a VIEW filter over the two shelves (see js/mode.js), and it
 * is LOCAL to this modal — it deliberately does NOT touch the device-global
 * `currentMode()`. Opening a read-only log must not silently change which shelf
 * newly-opened books join, which is what writing through to the global would do.
 * It opens on 🌙 night every time: the night shelf is the one you were asleep for
 * and therefore the one you cannot check any other way.
 */

import { $ } from "./dom.js";
import { MODE_META, normMode } from "./mode.js";
import { recentlyReadBooks } from "./progress.js";
import { daysFor, recentDayKeys, refreshLog, totalListenedMin } from "./progresslog.js";

/** Books listed per shelf — "the one I'm on and the one before it". */
const BOOKS_SHOWN = 2;
/** Nights per book — "the last few days", one screenful without scrolling. */
const NIGHTS_SHOWN = 7;

const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Which shelf this modal is showing. Reset to night on every open. */
let viewMode = "night";

/** Test seam / open hook: which shelf the view is on. */
export function logViewMode() {
  return viewMode;
}

/**
 * Human label for a night bucket. The two most recent get relative names — those
 * are the ones being checked — and they are shelf-aware: a night-shelf bucket is
 * a night ("Anoche"), a day-shelf one is a day ("Ayer"). Older ones get
 * "mié 22 jul", which is unambiguous without a year.
 */
function dayLabel(key, index, mode) {
  if (index === 0) return mode === "day" ? "Hoy" : "Esta noche";
  if (index === 1) return mode === "day" ? "Ayer" : "Anoche";
  // Parse as LOCAL midnight — `new Date("2026-07-22")` is parsed as UTC and
  // would name the wrong weekday for anyone west of Greenwich.
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS[dt.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** "45" / "45,5" — minutes, Spanish decimal comma, tenths only when they exist. */
function fmtMin(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : String(r).replace(".", ",");
}

/** The accumulated total, as "N min" under an hour and "12,5 h" past it. */
function fmtHours(min) {
  if (!(min > 0)) return "0 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.round((min / 60) * 10) / 10;
  return `${Number.isInteger(h) ? String(h) : String(h).replace(".", ",")} h`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One night's row: label, +advanced, −rewound, net. Only called for nights that
    had reading — empty nights are dropped by the caller, not rendered greyed. */
function nightRow(key, index, entry, mode) {
  const f = entry.f;
  const b = entry.b;
  const row = el("div", "plog-row");
  row.appendChild(el("span", "plog-day", dayLabel(key, index, mode)));
  row.appendChild(el("span", "plog-fwd", `+${fmtMin(f)} min`));
  row.appendChild(el("span", "plog-back", b ? `−${fmtMin(b)} min` : ""));
  const net = f - b;
  row.appendChild(el("span", "plog-net", `${net < 0 ? "−" : ""}${fmtMin(Math.abs(net))} min`));
  return row;
}

/**
 * One book's card: title + only the nights (of the last NIGHTS_SHOWN) that were
 * ACTUALLY listened to. Empty "sin lectura" nights are dropped — this log is a
 * sleep-mode sanity check, so a column of blanks was noise. No window total row:
 * the accumulated hours live on the ⚙️ Registro badge instead; here the question
 * is night-by-night whether sleep mode behaved.
 */
function bookCard(book, nowTs) {
  const card = el("section", "plog-book");
  const head = el("div", "plog-book-head");
  head.appendChild(el("h3", "plog-title", book.title));
  head.appendChild(el("span", "bib-pct", `${book.pct}%`));
  card.appendChild(head);

  const days = daysFor(book.docKey);
  const keys = recentDayKeys(NIGHTS_SHOWN, nowTs);
  let shown = 0;
  keys.forEach((key, i) => {
    const entry = days[key];
    if (!entry || !(entry.f || entry.b)) return; // sin lectura → not a row
    card.appendChild(nightRow(key, i, entry, book.mode));
    shown++;
  });
  if (!shown) card.appendChild(el("div", "plog-none-book", "Sin lectura estos días."));
  return card;
}

/** Repaint the modal body for the current `viewMode`. */
export function renderProgressLog(nowTs) {
  const body = $("progressLogBody");
  if (!body) return;
  const now = nowTs || Date.now();
  body.innerHTML = ""; // the repaint convention across this app's list views

  // The accumulated total — the headline the operator asked to SEE in the section
  // (the summary badge repeats it for the folded view). Always first, always shown,
  // even before any book card, so "cuánto llevo" is answered at a glance.
  const grand = el("div", "plog-grand");
  grand.appendChild(el("span", "plog-grand-lbl", "Total escuchado"));
  grand.appendChild(el("span", "plog-grand-val", fmtHours(totalListenedMin())));
  body.appendChild(grand);

  const books = recentlyReadBooks()
    .filter((b) => normMode(b.mode) === viewMode)
    .slice(0, BOOKS_SHOWN);

  if (!books.length) {
    const meta = MODE_META[viewMode];
    body.appendChild(
      el("div", "bib-empty", `No hay libros leídos en modo ${meta.label.toLowerCase()} ${meta.glyph}.`),
    );
    return;
  }
  for (const book of books) body.appendChild(bookCard(book, now));

  body.appendChild(
    el(
      "div",
      "hint",
      "Cada fila es una noche, que empieza a las 06:00 (lo leído a la 1 de la " +
        "madrugada cuenta en la noche anterior). «+» son minutos de escucha " +
        "avanzados y «−» los que rebobina el modo dormir al pararse.",
    ),
  );
}

/** Paint the shelf cue on this modal's own toggle. */
function applyToggleCue() {
  const meta = MODE_META[viewMode];
  const tog = $("logModeToggle");
  if (!tog) return;
  tog.textContent = `${meta.glyph} ${meta.label}`;
  tog.setAttribute("aria-label", `Registro del modo ${meta.label} — toca para cambiar de estantería`);
  tog.classList.toggle("mode-night", viewMode === "night");
  tog.classList.toggle("mode-day", viewMode === "day");
}

/**
 * Open the log: reset to the night shelf, paint from what we already hold (so
 * the modal is never blank), then re-pull the server blob and repaint — another
 * device may have read a chapter that this one has not seen yet.
 */
export function openProgressLog(onData) {
  viewMode = "night";
  applyToggleCue();
  renderProgressLog();
  if (typeof onData === "function") onData();
  refreshLog().then((ok) => {
    if (ok) renderProgressLog();
    // Repaint the caller's summary badge too: the server pull may have grown the
    // accumulated total past what localStorage alone held.
    if (typeof onData === "function") onData();
  });
}

/** Wire the shelf toggle once, at startup. */
export function wireProgressLog() {
  const tog = $("logModeToggle");
  if (!tog) return;
  tog.addEventListener("click", () => {
    viewMode = viewMode === "night" ? "day" : "night";
    applyToggleCue();
    renderProgressLog();
  });
}
