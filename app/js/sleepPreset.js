/**
 * WHICH SLEEP PRESET IS RUNNING TONIGHT — one seam, two answers.
 *
 * Sleep mode has three numbers (how long a still phone keeps reading, how far back
 * it steps when it stops, and how fast it reads) and they are not three settings:
 * they only make sense together. The long preset is the settings themselves —
 * #sleepMin / #rewindMin / #rate, 40 · ↺15 · 200% by default and synced
 * cross-device. The short trio lives HERE, starting from SLEEP_SHORT_MIN /
 * SLEEP_SHORT_REWIND / SLEEP_SHORT_RATE.
 *
 * SPEED JOINED THEM ON 2026-08-06, by the argument that had already made the pair
 * editable: a 3 a.m. run wants a slower read than bedtime does, and a speed you
 * have to set by hand around every short run is one nobody sets. Moving the ⚡
 * slider now writes into the ARMED preset — so a speed chosen for tonight stays
 * put for the run and is handed back when the run is spent, and a speed chosen
 * with «🌙 Normal» on is the global one it has always been.
 *
 * THE SHORT PAIR IS EDITABLE (2026-08-04), and that is why it is state and not
 * two constants any more. The ⚙️ dropdowns used to show the long pair whatever
 * was armed: with «⏱️ Corto» on, the panel read 40 · ↺15 over a night that would
 * actually stop at 30 and step back 8, and no screen anywhere could change those
 * two numbers. The dropdowns now follow the ARMED preset — showing what tonight
 * will do IS how you tune it — so main.js writes back through `setShortMinutes` /
 * `setShortRewindMinutes` while the chip is pressed. The arming stays one-shot;
 * only the numbers persist, which is the whole difference between "tonight is
 * short" and "a short night is 20 minutes for me".
 *
 * STILL NO DOM HERE, deliberately (see WHY A MODULE OF ITS OWN below): the pair
 * is passed in as numbers and read back as numbers, so the module both consumers
 * can safely reach does not acquire an opinion about which <select> exists.
 *
 * WHY THE SHORT ONE IS ONE-SHOT. It is for waking at three and wanting a small
 * run, which is by definition not what the next bedtime wants. A preset that
 * stayed on would make the following night stop at 30 min with no visible cause
 * — the reader would have to remember, at 3 a.m., to put it back. So the arming
 * is SPENT by the stop it was armed for (`consumeShortRun`, called from the one
 * place a night can end: `sleepRewind`), and the mode is back on the long preset
 * without anyone doing anything.
 *
 * WHY THE SHORT REWIND IS SMALLER, and not just the same −15. The rewind exists
 * to re-cover the stretch you were no longer taking in. On a 30-min run, −15
 * would step back over half of everything the run played — the night would end
 * roughly where it began. −8 is the same idea scaled to the shorter window.
 *
 * WHY A MODULE OF ITS OWN, and not a flag inside sleep.js: the two consumers sit
 * on opposite sides of an existing import cycle. sleep.js owns the interval and
 * player.js#sleepRewind owns the rewind, and they already call each other; a flag
 * living in either would make the other's read depend on which module the graph
 * was entered through. This imports nothing but config, so both can ask it.
 *
 * The subscription (`onSleepPresetChange`) exists because SPENDING the preset is
 * not a user action: nobody is looking at the ⚙️ panel when the book stops at
 * 4 a.m., and the watchdog's live interval has to go back to 40 there and then —
 * not at the next reload. sleep.js re-reads its interval on it; main.js repaints.
 */

import {
  LS_SLEEP_SHORT,
  LS_SLEEP_SHORT_MIN,
  LS_SLEEP_SHORT_RATE,
  LS_SLEEP_SHORT_REWIND,
  SLEEP_SHORT_MIN,
  SLEEP_SHORT_RATE,
  SLEEP_SHORT_REWIND,
} from "./config.js";

/** Armed for the next stop? The long preset is the absence of this. */
let short = false;

/** The short pair itself, factory values until the store or the reader says. */
let shortMin = SLEEP_SHORT_MIN;
let shortRewind = SLEEP_SHORT_REWIND;

/** Its speed, the third number of the preset. See SLEEP_SHORT_RATE. */
let shortSpeed = SLEEP_SHORT_RATE;

const listeners = new Set();

/**
 * Be told when the preset changes — including when it is SPENT, which is the
 * change nobody is present for. A throwing listener must not take the others (or
 * the stop that is mid-flight) down with it.
 */
export function onSleepPresetChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of listeners) {
    try {
      fn(short);
    } catch (_) {}
  }
}

/** Is the short run armed? Drives the ⚙️ chip, the badge and both overrides. */
export function isShortRun() {
  return short;
}

/**
 * The interval the watchdog should use, or null to mean "whatever #sleepMin
 * says". Null rather than the control's value because this module deliberately
 * does not read the DOM — the long preset is the settings, and the settings have
 * one owner each.
 */
export function sleepMinutesOverride() {
  return short ? shortMin : null;
}

/** Same, for the step-back on stopping (null → whatever #rewindMin says). */
export function rewindMinutesOverride() {
  return short ? shortRewind : null;
}

/**
 * Same again for the reading speed (null → whatever #rate says, which IS the long
 * preset's speed). Unlike the two above there is no consumer that reads this at
 * the moment it acts: the speed in force is the ⚡ slider, live, so what main.js
 * does with this is PUT IT ON the slider while the preset is armed and put the
 * long value back when it is spent. The override still belongs here rather than in
 * main.js, because "which numbers is tonight running" has one owner.
 */
export function rateOverride() {
  return short ? shortSpeed : null;
}

/** The short pair, armed or not — what the ⚙️ dropdowns show while it is on. */
export function shortMinutes() {
  return shortMin;
}

export function shortRewindMinutes() {
  return shortRewind;
}

/** Its speed, armed or not — what the ⚡ slider shows while it is on. */
export function shortRate() {
  return shortSpeed;
}

/**
 * A stored/synced/typed number, or null if it cannot be one.
 *
 * `zeroOk` is the whole reason this is a function: «No rebobinar» is a real
 * choice for the step-back and nonsense for the interval — a 0-minute run would
 * stop the book the instant it started. Everything unusable (a NaN from a
 * half-written store, a negative, an absurd 9000) is REFUSED rather than clamped:
 * a refused write leaves the working pair in place, while a clamped one would
 * silently give the reader a night they never chose.
 */
function clean(v, zeroOk) {
  // `Number("")` and `Number(null)` are both 0, and for the step-back 0 is a
  // MEANING («No rebobinar»). An absent store key and a reader who chose not to
  // rewind must not arrive here as the same number.
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r > 600) return null;
  if (zeroOk ? r < 0 : r < 1) return null;
  return r;
}

/**
 * The speed's own cleaner: a multiplier, not a count of minutes, so it keeps its
 * decimals (1.5 is the factory value) and is bounded by the ⚡ slider's own range
 * rather than by `clean`'s 1..600. The bounds are restated here because this
 * module deliberately never reads the DOM; the test pins them against #rate's
 * `min`/`max`, so a slider that moves takes this with it.
 */
const RATE_MIN = 0.8;
const RATE_MAX = 3;
function cleanRate(v) {
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < RATE_MIN || n > RATE_MAX) return null;
  return Math.round(n * 100) / 100;
}

function persist(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (_) {}
}

/**
 * Set how long the SHORT run reads for, and remember it on this device.
 *
 * Announces only while the preset is ARMED, because that is the only case where
 * anything changed for the night in progress — and the announcement restarts the
 * watchdog's idle countdown (`applySleepMinutes`), which must not happen because
 * a background pull adopted a number for a preset nobody is running.
 */
export function setShortMinutes(mins) {
  const n = clean(mins, false);
  if (n == null || n === shortMin) return shortMin;
  shortMin = n;
  persist(LS_SLEEP_SHORT_MIN, n);
  if (short) announce();
  return shortMin;
}

/** Same for the step-back. 0 is «No rebobinar», a choice and not a missing value. */
export function setShortRewindMinutes(mins) {
  const n = clean(mins, true);
  if (n == null || n === shortRewind) return shortRewind;
  shortRewind = n;
  persist(LS_SLEEP_SHORT_REWIND, n);
  if (short) announce();
  return shortRewind;
}

/**
 * Set the speed the SHORT run reads at, and remember it on this device.
 *
 * DELIBERATELY SILENT, unlike the two setters above: they announce because the
 * watchdog has to re-read an interval nobody is going to touch again, while the
 * speed's live consumer is the ⚡ slider — which, when the reader is the one
 * setting this, is already showing the value being stored. The other caller is
 * the synced pull, which repaints the panel itself once, for all four numbers.
 * Announcing here would restart the running night's idle countdown (every
 * subscriber, `applySleepMinutes` included) because somebody moved the speed.
 */
export function setShortRate(rate) {
  const n = cleanRate(rate);
  if (n == null || n === shortSpeed) return shortSpeed;
  shortSpeed = n;
  persist(LS_SLEEP_SHORT_RATE, n);
  return shortSpeed;
}

/**
 * Arm or disarm the short run and remember it on this device. Idempotent: a
 * repeat of the current state announces nothing, so a repaint is not a change.
 */
export function setShortRun(on) {
  const want = !!on;
  if (want === short) return;
  short = want;
  try {
    if (want) localStorage.setItem(LS_SLEEP_SHORT, "1");
    else localStorage.removeItem(LS_SLEEP_SHORT);
  } catch (_) {}
  announce();
}

/**
 * The night ended: spend the arming if there was one. Returns whether it was
 * armed, so a caller can say so. Called from `sleepRewind` — the single point
 * both ways of noticing a night ended (the watchdog stopping the book, and the
 * morning finding it stalled) already share.
 */
export function consumeShortRun() {
  if (!short) return false;
  setShortRun(false);
  return true;
}

/**
 * Restore the arming AND the short pair at boot. Local storage, like the 😴
 * switch: a page reloaded between arming the short run and falling asleep must
 * not quietly go back to the long preset — the reader armed it and then put the
 * phone down.
 *
 * The pair is read here too, before the arming is announced, so the first thing
 * anyone reads back (the watchdog's interval, the ⚙️ dropdowns) is the reader's
 * own numbers and never a factory 30 · ↺8 that gets corrected a beat later. A
 * stored value that fails `clean` leaves the factory pair standing.
 */
export function initSleepPreset() {
  let saved = null;
  try {
    saved = localStorage.getItem(LS_SLEEP_SHORT);
    shortMin = clean(localStorage.getItem(LS_SLEEP_SHORT_MIN), false) ?? SLEEP_SHORT_MIN;
    shortRewind =
      clean(localStorage.getItem(LS_SLEEP_SHORT_REWIND), true) ?? SLEEP_SHORT_REWIND;
    shortSpeed = cleanRate(localStorage.getItem(LS_SLEEP_SHORT_RATE)) ?? SLEEP_SHORT_RATE;
  } catch (_) {}
  short = saved === "1";
  announce();
  return short;
}
