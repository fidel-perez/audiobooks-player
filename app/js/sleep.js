/**
 * Sleep mode ("modo dormir") — fall asleep to the reader without it playing
 * all night.
 *
 * WHAT IT DOES: a playing phone left still for the interval plays five soft
 * beeps, then stops and rewinds `#rewindMin` unless moved.
 *
 * WHAT IT NO LONGER DOES: touch the screen. There used to be a fullscreen
 * pure-black overlay with a faint 😴 on it and a two-drag unlock, and none of
 * that was decoration — it was scaffolding for ONE fact: `devicemotion` events
 * only fire while the page is VISIBLE, so the only way to keep reading the
 * accelerometer was to keep the screen on, and a screen kept on all night in bed
 * has to be black and has to refuse a stray touch from a cheek or a duvet.
 * Measured on the phone (moto g34, pi-shell, 2026-07-29): ~62 events/s while
 * visible, the last one 1.0 s after the screen goes off, then nothing for 45 s,
 * and delivery resumes the instant the screen comes back. Chromium gates device
 * sensors on page visibility — the foreground service that keeps audio and
 * timers alive with the screen off does not open that gate.
 *
 * So the sensor is now read from BELOW the page instead, and the screen is left
 * alone:
 *
 *   - IN THE PI-SHELL (Android): the shell's own accelerometer listener runs
 *     natively under the playback wake lock and calls into the page — see
 *     `window.__PI_MOTION__` (pi-shell `bootstrap.js` / `MotionWatch.kt`). This
 *     works with the screen off, which is the point.
 *   - IN A BROWSER TAB: `devicemotion` while the page is visible. With the screen
 *     off, waking the screen during the beeps is the move (`noteInteraction`).
 *
 * The 30-min-of-stillness rule therefore reads, in a browser, as "beeps 30 min
 * after you last touched the phone" — a plain sleep timer, honestly labelled.
 *
 * AND THE WATCHDOG ITSELF CANNOT BE TRUSTED TO RUN. `tick` is a `setInterval`
 * inside the page it is meant to outlive, so the state it exists for — a page
 * frozen by Android once its audio stopped — is the state that kills it. The
 * deadline is therefore held as a WALL-CLOCK fact (`lastMotionAt` + the interval)
 * and settled retroactively by `reconcileSleepDeadline` when the page runs again,
 * rather than as a countdown that quietly stops with the process.
 *
 * Which leaves ONE question no test in this repo can answer: with the screen off,
 * on this phone, does a hand moving it actually clear SLEEP_MOTION_THRESHOLD?
 * That is what `testBlip` is for (⚙️ → "Pitar al mover", off by default): a blip
 * on every counted move, so the sensor can be checked by shaking the phone rather
 * than by waiting out a whole 40-min interval per attempt.
 */

import {
  REWIND_MIN_DEFAULT,
  SLEEP_FROZEN_MS,
  SLEEP_GRACE_MS,
  SLEEP_MOTION_THRESHOLD,
  SLEEP_MIN_DEFAULT,
  SLEEP_TEST_BEEP_MS,
  SLEEP_WARN_BEEPS,
  SLEEP_WARN_EVERY_MS,
  SLEEP_WARN_GAIN,
} from "./config.js";
import { $, setStatus } from "./dom.js";
import { saveProgress } from "./progress.js";
import { sleepRewind, stopAll } from "./player.js";
import { isShortRun, onSleepPresetChange, sleepMinutesOverride } from "./sleepPreset.js";
import { state } from "./state.js";

const sleep = {
  on: false, // the setting: is the watchdog armed at all
  checkMs: SLEEP_MIN_DEFAULT * 60000, // stillness allowed before the check
  lastMotionAt: 0,
  graceUntil: 0, // >0 while the warning beeps play
  beeps: [], // gain nodes of the warning beeps, cut when a move answers them
  tick: null,
  // When `tick` last actually ran, or null while nothing is armed. This is the
  // only evidence the page has that it was STOPPED rather than merely idle — see
  // `reconcileSleepDeadline`. `null` and not 0, for the same reason
  // `lastTestBeepAt` is not 0: 0 is a real `Date.now()` under a mocked clock, and
  // a falsy check would read a legitimate stamp as "never ran".
  lastTickAt: null,
  prevAccel: null, // last includingGravity sample (delta fallback)
  audioCtx: null,
  testBeep: false, // ⚙️ diagnostic: blip on every counted move
  // -Infinity, not 0: 0 is a real Date.now() (mocked clocks start there) and the
  // throttle would swallow the very first blip.
  lastTestBeepAt: -Infinity,
};

export function isSleepOn() {
  return sleep.on;
}

/* ===================== motion maths (pure, unit-tested) ===================== */

/** Euclidean magnitude of an acceleration vector ({x,y,z} or null → 0). */
export function accelMagnitude(a) {
  if (!a) return 0;
  const x = a.x || 0;
  const y = a.y || 0;
  const z = a.z || 0;
  return Math.sqrt(x * x + y * y + z * z);
}

/** Magnitude of the difference between two acceleration samples. */
export function motionDelta(a, b) {
  if (!a || !b) return 0;
  return accelMagnitude({
    x: (a.x || 0) - (b.x || 0),
    y: (a.y || 0) - (b.y || 0),
    z: (a.z || 0) - (b.z || 0),
  });
}

/**
 * How much the phone moved in this event. Prefers gravity-excluded
 * `acceleration`; falls back to the frame-to-frame delta of
 * `accelerationIncludingGravity` (some devices only report the latter).
 */
function movementFrom(e) {
  const a = e.acceleration;
  if (a && a.x != null) return accelMagnitude(a);
  const g = e.accelerationIncludingGravity;
  if (!g) return 0;
  const cur = { x: g.x, y: g.y, z: g.z };
  const d = sleep.prevAccel ? motionDelta(cur, sleep.prevAccel) : 0;
  sleep.prevAccel = cur;
  return d;
}

/* ===================== the motion sources ===================== */

/**
 * Is the shell's native sensor bridge here? Only the pi-shell injects it, and
 * only it can see the accelerometer with the screen off. Read live rather than
 * cached at boot: `bootstrap.js` runs before the app's modules, but a page kept
 * open across a shell update should not be pinned to the old answer.
 */
function nativeMotion() {
  return typeof window !== "undefined" && !!window.__PI_MOTION__;
}

/**
 * A move worth counting, from whichever source saw it.
 *
 * `fromSensor` separates a real accelerometer reading from the screen coming
 * back on (`noteInteraction`), which counts as movement but is not evidence that
 * the SENSOR saw anything — and the sensor is exactly what the test blip is
 * asking about. Blipping when you wake the screen would answer "yes, motion
 * works" to someone who has learnt nothing.
 */
function registerMotion(fromSensor) {
  sleep.lastMotionAt = Date.now();
  if (fromSensor) testBlip();
  if (sleep.graceUntil) {
    endGrace(); // moved in time → stay awake
    setStatus("😴 Movimiento detectado, sigo leyendo…");
  }
}

function onMotion(e) {
  if (!sleep.on) return;
  if (movementFrom(e) < SLEEP_MOTION_THRESHOLD) return;
  registerMotion(true);
}

/**
 * The shell saw the phone move. The native side has already applied its own
 * threshold (it will not wake the page for the hum of a table), so anything that
 * arrives here counts.
 */
function onNativeMotion() {
  if (!sleep.on) return;
  registerMotion(true);
}

/**
 * Anything that proves a person is handling the phone — the screen coming back
 * on, chiefly. Counts as movement: it is the same evidence the accelerometer
 * would have given, and in a browser tab with the screen off it is the ONLY
 * evidence available, since waking the screen is what restarts `devicemotion`.
 */
export function noteInteraction() {
  if (!sleep.on) return;
  registerMotion(false);
}

/* ===================== beep ===================== */

function ensureAudio() {
  try {
    if (!sleep.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) sleep.audioCtx = new AC();
    }
    if (sleep.audioCtx && sleep.audioCtx.state === "suspended") {
      sleep.audioCtx.resume();
    }
  } catch (_) {}
}

/**
 * The warning beeps, all scheduled now on the audio clock, so a throttled timer
 * cannot bunch or drop one.
 */
//
// A low sine at low gain, faded in and out, reaches a listener still awake and
// passes under one already asleep; a hard 880 Hz edge is what wakes people.
function beep() {
  silenceBeeps();
  ensureAudio();
  const ctx = sleep.audioCtx;
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    for (let i = 0; i < SLEEP_WARN_BEEPS; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = t0 + (i * SLEEP_WARN_EVERY_MS) / 1000;
      osc.type = "sine";
      osc.frequency.value = 523;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(SLEEP_WARN_GAIN, start + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.65);
      sleep.beeps.push(gain);
    }
  } catch (_) {}
}

function silenceBeeps() {
  for (const g of sleep.beeps) {
    try {
      g.disconnect();
    } catch (_) {}
  }
  sleep.beeps = [];
}

function endGrace() {
  sleep.graceUntil = 0;
  silenceBeeps();
}

/**
 * The diagnostic blip: ONE short high note, every time a real sensor reading is
 * counted as movement, while ⚙️ → "Pitar al mover" is on.
 *
 * Why it exists: whether the phone can feel your hand with the screen off is the
 * one thing about sleep mode that no test here can settle — it depends on the
 * device, on the shell's native listener surviving the screen going off, and on
 * whether a real bedside shake clears SLEEP_MOTION_THRESHOLD. Without this, the
 * only way to find out is to arm the mode, wait out the whole interval and see
 * whether the grace beep can be answered: one 20-40 min round trip per attempt.
 * With it, the answer is a shake away, screen off, no waiting.
 *
 * Higher and shorter than the `beep()` warning, so a test chirp never reads as
 * it. SLEEP_TEST_BEEP_MS throttles the ~62 events/s to one blip per shake.
 */
function testBlip() {
  if (!sleep.testBeep) return;
  const now = Date.now();
  if (now - sleep.lastTestBeepAt < SLEEP_TEST_BEEP_MS) return;
  sleep.lastTestBeepAt = now;
  ensureAudio();
  const ctx = sleep.audioCtx;
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 1320;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.2, t0 + 0.01);
    gain.gain.linearRampToValueAtTime(0, t0 + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.14);
  } catch (_) {}
}

/**
 * Turn the diagnostic blip on or off. Called at boot with the stored value and
 * again on every ⚙️ change.
 *
 * The AudioContext is opened HERE rather than at the first blip: switching the
 * setting is a user gesture, and a mobile AudioContext created outside one
 * starts suspended — the first shake would then be silent, which reads exactly
 * like the sensor failing, i.e. the diagnostic lying about the thing it exists
 * to measure.
 */
export function setShakeBeep(on) {
  sleep.testBeep = !!on;
  sleep.lastTestBeepAt = -Infinity;
  if (sleep.testBeep) ensureAudio();
}

/** For the ⚙️ badge and the tests: is the blip armed? */
export function isShakeBeepOn() {
  return sleep.testBeep;
}

/* ===================== the periodic check ===================== */

function tick() {
  if (!sleep.on) return;
  const now = Date.now();
  // Stamped before any of the early returns: what this records is that the PAGE
  // ran, which is the question `reconcileSleepDeadline` asks — not what the
  // watchdog decided once it had.
  sleep.lastTickAt = now;
  // Only count idle time while actually reading; pausing shouldn't nag.
  if (!(state.speaking && !state.paused)) {
    sleep.lastMotionAt = now;
    endGrace();
    return;
  }
  if (sleep.graceUntil) {
    if (now >= sleep.graceUntil) fallAsleep();
    return;
  }
  if (now - sleep.lastMotionAt < sleep.checkMs) return;

  // Beeps everywhere: a browser tab with the screen off can still answer them,
  // because waking the screen counts as a move.
  beep();
  sleep.graceUntil = now + SLEEP_GRACE_MS;
  setStatus("😴 ¿Sigues despierto? Mueve el móvil para continuar…");
}

/**
 * You dozed off. Stop FIRST (so the rewind below can't restart playback —
 * jumpAndMaybePlay resumes when it sees us still "playing"), THEN step the book
 * back the configured rewind minutes of listening and save that position. The
 * amount is read LIVE from the `#rewindMin` control by `sleepRewind`, which is
 * shared with `reconcileStalePlayback` so the two ways of noticing a night ended
 * cannot drift apart. This is the automatic replacement for the old 🌅 manual
 * rewind button, and it ONLY runs on a sleep-mode stop, nowhere else.
 *
 * `at` is the instant being accounted for. Normally now — but a deadline settled
 * retroactively (see `reconcileSleepDeadline`) is accounting for a night that
 * ended hours ago, and the per-night log buckets by timestamp.
 *
 * The watchdog is NOT torn down afterwards: sleep mode is a setting now, not a
 * session, so pressing ▶ again later the same night is watched again without
 * anyone re-arming anything. `tick` idles for free while nothing is playing.
 */
function fallAsleep(at = Date.now()) {
  stopAll(); // stops playback and releases the wake lock playback holds
  sleepRewind(at);
  saveProgress();

  endGrace();
  sleep.lastMotionAt = Date.now();
  setStatus("😴 Sin movimiento: lectura detenida. Buenas noches.");
}

/**
 * THE DEADLINE HAS TO SURVIVE THE PAGE. Settle it against the wall clock, after a
 * stretch in which nothing here was allowed to run.
 *
 * WHY THE WATCHDOG ALONE CANNOT DO THIS. `tick` is a `setInterval` inside the very
 * page it is meant to outlive, so the one state it exists for — a frozen page —
 * is the one that kills it. Measured 2026-07-31: playback started at 22:23, the
 * last position was saved at 22:28:46, the process sat at oom_score_adj=700 (cached,
 * freezable) and STILL ALIVE at 04:26 with audio focus never abandoned. No timers,
 * therefore no beep, no stop, no rewind — and the page thawed only when the app was
 * opened at 04:21 the next morning, by which time `tick` sees "still for six hours"
 * and cheerfully starts the beep-and-grace conversation with an empty room.
 *
 * So this asks the question the tick cannot: was I RUNNING? A gap in `lastTickAt`
 * past SLEEP_FROZEN_MS is not a slow tick — a hidden browser tab still gets one a
 * minute — it is the process having been stopped. When that gap also spans the
 * whole stillness interval AND the grace that would have followed it, the answer
 * was settled while we were away: no beep (there was no one to answer it hours
 * ago, and none now), no grace, just the stop and the rewind, booked against
 * `state.lastSpeakAt` — the minute the reading actually ended, not the minute the
 * phone was picked up.
 *
 * WHY NOT A NATIVE ALARM IN PI-SHELL. That was the other candidate, and it buys
 * nothing here: the page freezes precisely BECAUSE its audio stopped, so at the
 * deadline there is never a book still playing for an alarm to interrupt — only
 * bookkeeping to settle, which needs the page anyway. An alarm would be the answer
 * to a different failure (audio that plays on past the deadline while the page's
 * timers are throttled), and that one is not what the phone does. Revisit if
 * nightwatch ever records a night still SOUNDING past its interval.
 */
export function reconcileSleepDeadline(now = Date.now()) {
  if (!sleep.on || sleep.lastTickAt == null) return false;
  // The tick was running, so it owns the deadline — including the beep-and-grace
  // conversation, which this must never pre-empt.
  if (now - sleep.lastTickAt < SLEEP_FROZEN_MS) return false;
  sleep.lastTickAt = now;
  if (!(state.speaking && !state.paused)) return false;
  if (now - sleep.lastMotionAt < sleep.checkMs + SLEEP_GRACE_MS) return false;
  fallAsleep(state.lastSpeakAt || sleep.lastMotionAt);
  return true;
}

/* ===================== enable / disable ===================== */

/** Turn the motion sensor on (async: iOS needs a permission prompt). */
async function enableMotion() {
  if (typeof DeviceMotionEvent === "undefined") return false;
  if (!window.isSecureContext) return false; // sensors need HTTPS/localhost
  try {
    if (typeof DeviceMotionEvent.requestPermission === "function") {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== "granted") return false;
    }
  } catch (_) {
    return false;
  }
  window.addEventListener("devicemotion", onMotion);
  return true;
}

/**
 * Arm or disarm the watchdog. Called with the stored setting at boot and again
 * whenever the ⚙️ select changes; idempotent, so a repeat of the current state
 * costs nothing.
 *
 * Turning it OFF stops the sensor as well as the timer — an accelerometer left
 * streaming for a feature nobody armed is battery spent on nothing, and in the
 * shell it is a native listener holding a sensor open.
 */
export async function setSleepEnabled(on) {
  const want = !!on;
  if (want === sleep.on) return;
  sleep.on = want;

  if (!want) {
    clearInterval(sleep.tick);
    sleep.tick = null;
    sleep.lastTickAt = null; // nothing is running, so no gap means anything
    endGrace();
    sleep.prevAccel = null;
    window.removeEventListener?.("devicemotion", onMotion);
    if (nativeMotion()) window.__PI_MOTION__.watch(false);
    return;
  }

  sleep.lastMotionAt = Date.now();
  endGrace();
  sleep.prevAccel = null;
  // As if the tick had just run: arming is the page demonstrably running, and a
  // fresh watchdog must not read as one that has been frozen since the epoch.
  sleep.lastTickAt = sleep.lastMotionAt;
  sleep.tick = setInterval(tick, 3000);
  if (nativeMotion()) window.__PI_MOTION__.watch(true);
  // `devicemotion` is kept on even in the shell: it is the finer-grained of the
  // two while the screen is on, and the native side is deliberately coarse.
  await enableMotion();
}

/** The `pi-motion` listener is wired once per page, not once per arming. */
let wired = false;

/**
 * Wire the app's sleep-mode controls to this module. Called once at boot with
 * the value main.js has already restored from localStorage.
 *
 * The native channel is listened for even when the setting is OFF and even in a
 * browser, where nothing will ever dispatch it: the listener is inert, and the
 * alternative — subscribing at arming time — would miss the shell's first report
 * on a page armed before `bootstrap.js` had wired its side.
 */
export function initSleep(on) {
  if (!wired) {
    wired = true;
    window.addEventListener?.("pi-motion", onNativeMotion);
    // Arming the short run — and, crucially, SPENDING it — changes the interval
    // under a watchdog that is already running. Subscribed here rather than at
    // the toggle, because the spend has no user gesture behind it.
    onSleepPresetChange(applySleepMinutes);
  }
  applySleepMinutes();
  return setSleepEnabled(on);
}

/**
 * Read the interval in force and apply it. If the watchdog is armed, restart the
 * idle countdown from now so changing the setting takes effect immediately
 * instead of only after the next stop.
 *
 * The SHORT RUN wins over #sleepMin while it is armed (⚙️ → the preset chip), and
 * this is also what puts the long interval back when the short one is spent —
 * `initSleep` subscribes this to the preset, because the spending happens at
 * 4 a.m. with nobody looking and the live watchdog must not keep the 30 min it
 * was armed with for a night that has already ended.
 */
export function applySleepMinutes() {
  const override = sleepMinutesOverride();
  const el = $("sleepMin");
  const stored = el ? Number.parseInt(el.value, 10) : Number.NaN;
  const mins = override == null ? stored : override;
  sleep.checkMs = (Number.isFinite(mins) ? mins : SLEEP_MIN_DEFAULT) * 60000;
  if (sleep.on) {
    sleep.lastMotionAt = Date.now();
    endGrace();
  }
}

/**
 * How sleep mode will behave HERE, in one sentence, for the ⚙️ panel. The
 * difference between the shell and a browser tab is not a detail the reader can
 * be left to discover at 3 a.m.: in one the phone can be moved to keep reading
 * with the screen off, in the other the countdown simply runs out.
 *
 * IT NAMES BOTH NUMBERS, and says which of them travels. Diagnosed 2026-07-31:
 * the phone had been running 40/−15 for weeks while its operator believed it was
 * 45/−15 — piapp.localhost had no stored sleep keys at all, so it was on the
 * defaults, and the 45 set in the Pi's browser face could never have reached it
 * because the interval was per-origin. The interval and the rewind now sync (see
 * settings.js) and the switch does not, which is a deliberate split and therefore
 * one the panel has to state rather than leave to be inferred from a silent
 * disagreement between two devices.
 */
export function sleepModeNote(mins, rewind) {
  // `Number("")` is 0, and an ABSENT control is not a reader who chose "don't
  // rewind" — one is a DOM that has not filled in yet, the other is a decision.
  const rw = rewind == null || rewind === "" ? Number.NaN : Number(rewind);
  const back = Number.isFinite(rw) ? rw : REWIND_MIN_DEFAULT;
  const stop = back > 0 ? `se detiene y retrocede ${back} min` : `se detiene (sin retroceder)`;
  // Which setting follows the reader and which belongs to the device they fall
  // asleep holding. Last, because it answers a question the first sentence raises.
  let scope =
    ` Los minutos y el retroceso te siguen entre dispositivos; el interruptor 😴 ` +
    `es solo de este aparato.`;
  // The short run is the one state of this panel that EXPIRES, so the note has
  // to say so: a reader who armed it hours ago must be able to tell, from the
  // panel alone, that these numbers are for tonight and not the new normal.
  if (isShortRun()) {
    scope +=
      ` Ahora mismo está puesto el preajuste CORTO: vale solo para esta vez — al ` +
      `detenerse la lectura vuelve solo al normal. Los dos desplegables de arriba ` +
      `son los suyos mientras esté puesto, así que puedes afinarlos aquí.`;
  }
  if (nativeMotion()) {
    return (
      `Con la lectura en marcha: si no mueves el móvil en ${mins} min, suenan ` +
      `${SLEEP_WARN_BEEPS} pitidos suaves y, si sigues sin moverlo, ${stop}. ` +
      `Funciona con la pantalla apagada.` +
      scope
    );
  }
  return (
    `Con la lectura en marcha: tras ${mins} min sin tocar el móvil suenan ` +
    `${SLEEP_WARN_BEEPS} pitidos suaves y, si nadie responde, ${stop}. Con la ` +
    `pantalla encendida basta con moverlo para seguir; apagada, enciéndela durante ` +
    `los pitidos (en la app del móvil basta con moverlo también con la pantalla ` +
    `apagada).` + scope
  );
}
