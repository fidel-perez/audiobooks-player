/**
 * Entry point: wires every DOM control to the modules, starts the background
 * watchdogs, and rehydrates the library from IndexedDB on load.
 */

import { $, setStatus, showToast } from "./dom.js";
import { holdable } from "../_shared/ui/holdable.js";
import { installPullToRefreshGuard } from "../_shared/ui/pullToRefreshGuard.js";
import { acquireWake, watchPlaybackProtection } from "./background.js";
import { idbGetAll } from "./db.js";
import { hydrateAll } from "./pdf.js";
import {
  isRendering,
  jumpToPct,
  pausePlayback,
  reconcileStalePlayback,
  restartCurrent,
  secsAtPct,
  showRate,
  showVol,
  speakCurrent,
  stepChunk,
  stepRate,
  stepVol,
  togglePlayPause,
} from "./player.js";
import {
  activateDoc,
  evictDroppedDoc,
  adoptAheadDocs,
  gotoChapter,
  renderTabs,
} from "./library.js";
import {
  catalogEntryFor,
  curPct,
  flushNow,
  isProgressReady,
  mostRecentSyncedBook,
  saveProgress,
  syncNow,
} from "./progress.js";
import { reloadWhenSynced, reloadWhenSyncedIfIdle, reloadCommitted } from "./reload.js";
import { fmtHm } from "./utils.js";
import {
  isHandSet,
  markHandSet,
  pullSettings,
  pushSetting,
  whenClosed,
} from "./settings.js";
import {
  MAX_DOCS,
  LS_RATE,
  LS_VOL,
  LS_MODULATION,
  VOL_MAX,
  LS_ACTIVE_KEY,
  LS_SLEEP_BEEP,
  LS_SLEEP_MIN,
  LS_SLEEP_ON,
  SLEEP_BEEP_DEFAULT,
  SLEEP_MIN_DEFAULT,
  SLEEP_ON_DEFAULT,
  LS_REWIND_MIN,
  REWIND_MIN_DEFAULT,
  APP_BUILD,
  PIPER_VOICES,
  VOICE_DEVICE,
  VOL_MAX_DEVICE,
} from "./config.js";
import { agoEs } from "./version.js";
import { setOnPlaybackStolen } from "./solo.js";
import { bindTransportButtons } from "./mediakeys.js";
import { state, synth } from "./state.js";
import {
  applySleepMinutes,
  initSleep,
  isShakeBeepOn,
  noteInteraction,
  reconcileSleepDeadline,
  setShakeBeep,
  setSleepEnabled,
  sleepModeNote,
} from "./sleep.js";
import {
  initSleepPreset,
  isShortRun,
  onSleepPresetChange,
  rewindMinutesOverride,
  setShortMinutes,
  setShortRate,
  setShortRewindMinutes,
  setShortRun,
  shortMinutes,
  shortRate,
  shortRewindMinutes,
  sleepMinutesOverride,
} from "./sleepPreset.js";
import { bindModalEsc, closeModal, openModal, wireModal } from "./modal.js";
import {
  advanceAfterFinish,
  bindBiblioteca,
  initBiblioteca,
  openCatalogBook,
  settleBootCard,
} from "./biblioteca.js";
import { bindEnCurso, flipShelf } from "./encurso.js";
import { MODE_META } from "./mode.js";
import { openProgressLog, wireProgressLog } from "./logview.js";
import { flushLogNow, totalListenedMin } from "./progresslog.js";
import {
  loadSelectedVoice,
  loadVoices,
  saveSelectedVoice,
  selectedVoice,
  setSelectedVoice,
  voiceHintUpdate,
} from "./voices.js";
import {
  clearCache,
  downloadedVoices,
  isPiperVoice,
  prefetchVoice,
  setModulation,
} from "./piper.js";
import { MODULATION, MODULATION_DEFAULT } from "./modulation.js";
import { enhanceAllSelects } from "./ui.js";

/* ===================== modals (settings + biblioteca) ===================== */
wireModal("settingsModal");
wireProgressLog();
bindModalEsc();
// Replace native <select> pickers with in-page dropdowns that can be dismissed
// without committing a choice (native <select> can't, on iOS). Options that
// populate later (voces/capítulos/categorías) sync via the observer in ui.js.
enhanceAllSelects();
$("settingsBtn").addEventListener("click", () => {
  openModal("settingsModal");
  renderBuildInfo();
  paintSettingsChips();
});

/* ===================== folded-section summary chips ===================== */
// A folded section still has to say its value, so its summary carries a badge:
// 😴 Modo dormir shows the current stop/rewind config, 📈 Registro the total
// hours listened. Repainted on open and whenever the sleep controls change.
function fmtAccrued(min) {
  if (!(min > 0)) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.round((min / 60) * 10) / 10;
  return `${(Number.isInteger(h) ? String(h) : String(h).replace(".", ","))} h`;
}
/* ---------- which sleep preset the two ⚙️ dropdowns are showing ---------- */
/**
 * The LONG pair's live copy. The two controls used to BE this pair; since the
 * dropdowns follow the armed preset they hold the SHORT numbers while «⏱️ Corto»
 * is on, so the long ones need somewhere to wait that a repaint can read them
 * back from. localStorage is the persistence — this is the value in hand, so a
 * device with storage blocked still switches back to the numbers it was using
 * rather than to the factory 40 · ↺15.
 */
const longSleep = {
  min: String(SLEEP_MIN_DEFAULT),
  rewind: String(REWIND_MIN_DEFAULT),
  // The long preset's SPEED is the global one (LS_RATE) — filled in from the
  // slider once that has been restored, below. Null until then so a repaint that
  // somehow ran first cannot write a made-up speed over the reader's.
  rate: null,
};

/** Is `v` one of `id`'s offered options? A stored value that isn't is refused. */
const isOption = (id, v) =>
  [...($(id)?.options || [])].some((o) => o.value === String(v));

/**
 * Put `want` in a select and relabel its enhanced trigger — `dd:sync` and NOT
 * `change`, which would push the value straight back to the server and echo this
 * device's copy over whatever the reader last chose elsewhere.
 */
function setSelectValue(id, want) {
  const sel = $(id);
  const v = String(want);
  if (!sel || sel.value === v || !isOption(id, v)) return;
  sel.value = v;
  sel.dispatchEvent(new Event("dd:sync"));
}

/**
 * Point the two dropdowns at the preset IN FORCE. This is the whole answer to
 * "what will tonight do" — and, because the same controls write back to whichever
 * pair they are showing, also the only place the short pair can be tuned.
 *
 * Called on every preset change INCLUDING the spend at 4 a.m., and before
 * sleep.js's own subscriber runs (subscribed first, below), so the watchdog reads
 * long numbers out of a control that is already showing them.
 */
function paintSleepControls() {
  const shortOn = isShortRun();
  setSelectValue("sleepMin", shortOn ? shortMinutes() : longSleep.min);
  setSelectValue("rewindMin", shortOn ? shortRewindMinutes() : longSleep.rewind);
  applyPresetRate(shortOn ? shortRate() : longSleep.rate);
}

/** A speed clamped to the ⚡ slider's own range; whatever it is showing if `v`
 *  cannot be a speed at all. */
function clampRate(v) {
  const r = $("rate");
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return Number.parseFloat(r.value);
  return Math.max(
    Number.parseFloat(r.min),
    Math.min(Number.parseFloat(r.max), n),
  );
}

/**
 * Put the armed preset's speed on the ⚡ slider and INTO THE BOOK THAT IS PLAYING.
 *
 * Live and not at the next paragraph, unlike an adopted synced speed: this runs
 * because the preset moved — the reader pressed «⏱️ Corto», or the night ended and
 * spent it — and a slider that reads 150% over a voice still going at 200% is the
 * panel disagreeing with what is audible. `restartCurrent` is the cheap path for
 * Piper (the media element takes the rate live, no re-synthesis, no lost place)
 * and a re-speak from the current word for the device voice, whose utterance
 * froze its rate when it was queued.
 *
 * No-op when nothing moved, which is most repaints: a repeat would restart the
 * paragraph for a speed that is already the one playing.
 */
function applyPresetRate(want) {
  const r = $("rate");
  if (!r || want == null) return;
  const v = String(clampRate(want));
  if (r.value === v) return;
  r.value = v;
  showRate();
  restartCurrent();
}

function paintSettingsChips() {
  const sleepEl = $("sleepSummary");
  const off = $("sleepOn") && $("sleepOn").value === "0";
  const shortOn = isShortRun();
  // The numbers IN FORCE, not the ones stored: with the short run armed the
  // controls below still read 40/15 and the watchdog is on 30/8, so a badge
  // built from the controls would be describing a night that is not happening.
  const smOver = sleepMinutesOverride();
  const rwOver = rewindMinutesOverride();
  const sm = smOver == null ? $("sleepMin")?.value : String(smOver);
  const rw = rwOver == null ? $("rewindMin")?.value : String(rwOver);
  if (sleepEl) {
    // "Desactivado" first: with the mode off the minutes are inert, and a badge
    // reading "40 min · ↺15" over a watchdog that will never run is a lie the
    // folded section tells at a glance.
    if (off) sleepEl.textContent = "Desactivado";
    else {
      let base = sm ? (Number(rw) > 0 ? `${sm} min · ↺${rw}` : `${sm} min`) : "";
      // A one-shot preset has to say it is one: the same badge tomorrow night
      // will read differently for no reason the reader did anything about. Its
      // SPEED goes in the same breath — it is the one number of the three that is
      // also a global setting, so a badge that left it out would be describing a
      // night at a speed the reader last saw somewhere else entirely.
      if (shortOn) {
        base += `${base ? " · " : ""}⚡${Math.round(shortRate() * 100)}% · 1 vez`;
      }
      // The test blip is loud and lives in a folded section: say so in the badge,
      // or one left on after a test chirps at the reader all night unexplained.
      sleepEl.textContent = isShakeBeepOn() ? `${base}${base ? " · " : ""}🔔 prueba` : base;
    }
  }
  // The main-page chip: tonight's preset without opening ⚙️. Off is its own
  // answer — «Normal» over a dead watchdog is a lie.
  const chipEl = $("chipSleep");
  if (chipEl) {
    chipEl.textContent = off ? "😴 Desactivado" : shortOn ? "⏱️ Corto" : "🌙 Normal";
    chipEl.classList.toggle("is-short", !!shortOn && !off);
  }
  // The preset chip in the section's own header, so the night can be switched
  // without unfolding anything. DISABLED with 😴 off: arming a one-shot for a
  // watchdog that will never run is a tap that silently does nothing.
  const presetEl = $("sleepPreset");
  if (presetEl) {
    // The NAME only: the badge next to it already carries "30 min · ↺8 · 1 vez",
    // and on a 360px phone the title, the badge and a numbered chip do not fit on
    // one line — the header wraps and the row stops looking like a row.
    presetEl.textContent = shortOn ? "⏱️ Corto" : "🌙 Normal";
    presetEl.setAttribute("aria-pressed", String(shortOn));
    presetEl.disabled = !!off;
  }
  // WHICH PAIR THE CONTROLS BELOW ARE EDITING. The two dropdowns show the armed
  // preset's numbers, so arming the short run MOVES them — and a panel whose
  // values changed with nothing on screen saying why is indistinguishable from a
  // bug. Not .prose: this one cannot be behind the ℹ️ reveal.
  const scopeEl = $("sleepPresetScope");
  if (scopeEl) {
    scopeEl.textContent = off
      ? ""
      : shortOn
        ? "⏱️ Estos ajustes —y la velocidad ⚡— son del preajuste CORTO (vale solo para esta vez)"
        : "🌙 Estos ajustes —y la velocidad ⚡— son del preajuste NORMAL";
    scopeEl.classList.toggle("is-short", !!shortOn && !off);
  }
  // …and the same warning over the ⚡ slider, which is in another section of the
  // sheet and edits the armed preset just as the two dropdowns do. Without it, a
  // speed that moved on its own — at the arming, and again at the spend — is the
  // single most alarming thing the panel could do silently.
  const rateScopeEl = $("rateScope");
  if (rateScopeEl) {
    const scoped = shortOn && !off;
    rateScopeEl.textContent = scoped
      ? "⏱️ Esta velocidad es la del preajuste CORTO (vale solo para esta vez)"
      : "";
    rateScopeEl.classList.toggle("is-short", !!scoped);
  }
  // The behaviour line under the minutes: what "sin movimiento" means HERE
  // depends on whether the shell's native sensor is behind the page.
  const noteEl = $("sleepModeNote");
  if (noteEl) noteEl.textContent = off ? "" : sleepModeNote(sm || "", rw);
  const progEl = $("progressSummary");
  if (progEl) progEl.textContent = fmtAccrued(totalListenedMin());
}

/* ===================== prose reveal (ℹ️) ===================== */
// All explanatory .prose text is hidden by default so ⚙️ Ajustes is controls-only;
// this toggles it back on in one tap (a body class the CSS keys off).
$("proseToggle")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const on = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(on));
  document.querySelector("#settingsModal .modal-body")?.classList.toggle("show-prose", on);
});

// 📈 Registro de progreso renders INLINE inside its own fold (no button, no
// separate modal). Painting on every expand pulls the server blob (openProgressLog
// → refreshLog), so the inline total + grid are fresh; repaint the summary badge
// once that lands too. Collapsing paints nothing — the DOM just hides.
$("progressDetails")?.addEventListener("toggle", (e) => {
  if (!e.currentTarget.open) return;
  openProgressLog(paintSettingsChips);
});

/* ===================== "última actualización" (Ajustes) ===================== */
// Show how long ago the running code was built, so a stale cache is obvious: if
// the app misbehaves while this reads a distant date, the client is running
// cached bytes → tap it to force a refresh. We also fetch the server's LIVE
// sw.js Last-Modified (bypassing every cache via ?_bust) and flag when it is
// meaningfully newer than this bundle — a genuine "update available" signal.
const buildMs = Date.parse(APP_BUILD);
const STALE_MS = 30 * 60 * 1000; // server this much newer ⇒ flag as stale

/**
 * The APP_BUILD stamp the server is currently serving (ms), or null if it can't
 * be read.
 *
 * Read from the CONTENT of config.js, not from sw.js's `Last-Modified`. The pi
 * deploys by `git pull` into the served tree, and a checkout rewrites the mtime
 * of every file it touches — including files whose bytes did not change. The
 * header therefore jumped ahead of this bundle's APP_BUILD after any deploy,
 * and the ⚙️ line announced "🔄 nueva versión — toca para actualizar" to a
 * client that was already running the newest code. Tapping it is the manual
 * reload path, so a false positive here manufactures exactly the pointless
 * refreshes this pass is trying to remove. The stamp in the file is the truth:
 * it changes when, and only when, a build changes.
 */
const BUILD_RE = /APP_BUILD\s*=\s*["']([^"']+)["']/;

async function serverBuildMs() {
  try {
    const r = await fetch(`js/config.js?_bust=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return null;
    const m = BUILD_RE.exec(await r.text());
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch (_) {
    return null;
  }
}

async function renderBuildInfo() {
  const el = $("buildInfo");
  if (!el) return;
  const base = Number.isFinite(buildMs)
    ? `Actualizado ${agoEs(buildMs)}`
    : "Versión desconocida";
  el.textContent = base;
  el.classList.remove("stale");
  const srv = await serverBuildMs();
  if (srv && Number.isFinite(buildMs) && srv - buildMs > STALE_MS) {
    el.textContent = `${base} · 🔄 nueva versión — toca para actualizar`;
    el.classList.add("stale");
  } else if (srv) {
    el.textContent = `${base} · al día ✓`;
  }
}

// The reload gate, reachable from index.html's inline controllerchange handler
// (a separate script, so no import) and from the pi-shell's "a bundle moved"
// announcement. Until this module evaluates there is nothing in flight to
// protect, and that handler falls back to a plain reload.
//
// The IfIdle flavour deliberately: both callers are refreshes NOBODY ASKED FOR,
// and neither can tell on its own whether a book is being read (the shell asks
// its `anyPlaying()`, which is false at every Piper seam). See reload.js.
window.__reloadWhenSynced = reloadWhenSyncedIfIdle;

// Tapping the line force-refreshes: ask the SW to update (its skipWaiting +
// clients.claim fire controllerchange → the index.html handler reloads), and
// reload here ourselves when no update was found, so a current app still
// visibly refreshes. Both paths run through reloadWhenSynced, which holds the
// refresh back while progress is still uploading and reloads once the push
// confirms.
//
// WHY THE `coming` BRANCH — this is the "it loads twice" bug. When the tap DID
// find an update, reloading here as well is not a fallback, it is a second
// refresh of the same event: the takeover has not happened yet when we
// navigate, so that first load comes off the OLD shell, and the new worker's
// controllerchange then reloads it again to get the new one. Two loads, and the
// first one wasted. So when an update is on its way we hand the single reload
// to the takeover and only arm a timeout in case it never arrives.
//
// `updatefound` is what we watch, not `reg.installing`/`reg.waiting` after the
// fact: sw.js calls skipWaiting() during install, so by the time update()
// resolves the new worker can already have moved past both of those slots and
// an inspection would report "no update" for an update that is mid-handover.
const HANDOVER_MS = 8000;

$("buildInfo")?.addEventListener("click", async () => {
  const el = $("buildInfo");
  if (el) el.textContent = "Actualizando…";
  let coming = false;
  const onFound = () => {
    coming = true;
  };
  try {
    const reg =
      navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg) {
      reg.addEventListener("updatefound", onFound);
      try {
        await reg.update();
      } finally {
        reg.removeEventListener("updatefound", onFound);
      }
      coming = coming || !!(reg.installing || reg.waiting);
    }
  } catch (_) {}
  const refresh = () => {
    if (reloadWhenSynced() && el) el.textContent = "Esperando sincronización…";
  };
  if (!coming) {
    refresh();
    return;
  }
  if (el) el.textContent = "Instalando nueva versión…";
  // A worker that installs but never activates (it threw in `activate`, or the
  // browser is holding the takeover) must not strand the app on that message.
  // Harmless if the takeover wins the race: reloadWhenSynced is latched.
  setTimeout(refresh, HANDOVER_MS);
});
bindBiblioteca();
bindEnCurso();
// NOTE: initBiblioteca() is deliberately NOT called here — see the startup block
// at the bottom. It preloads the catalog, favorites, queue and offline book
// buffer, which the book you were reading needs none of.

// Another window of this app just started reading. Two readers on one book is
// two voices over each other and two positions overwriting each other in the
// sync, and it is easy to end up with two windows: the installed PWA is not the
// tab it was installed from, and Piper keeps reading from a hidden page on
// purpose. So this window stands down — pausing the way ⏸ does, so its place is
// saved — and says why, because the alternative is a book that stops itself for
// no visible reason. No warm-up: the window that IS reading needs the model.
setOnPlaybackStolen(() =>
  pausePlayback({
    note: "⏸ Pausado: el libro se está leyendo en otra ventana.",
    warm: false,
  }),
);

// The lock screen, the media notification and a headset's play/pause reach the
// page whether or not this app answers them — and left unanswered they pause the
// raw <audio> element behind the app's back, leaving it certain it is still
// reading. Take the presses so ⏸ from outside is the same ⏸ as the button's. The
// skip keys are bound INERT, which is the only way to make them do nothing at
// all: see mediakeys.js.
bindTransportButtons();

// A book finished under normal playback → advance to the queue head, or a
// filtered 🎲 random. Keeps the current voice / speed / volume (all global).
document.addEventListener("audiobooks:finished", (e) =>
  advanceAfterFinish(e.detail?.src),
);

// A book trashed on another device (a tombstone just pulled into the synced map)
// is still LOADED here — free its slot + IndexedDB text. The shelf already hides
// it; this is background cleanup, and it never touches the active/playing doc.
document.addEventListener("audiobooks:dropped", (e) => {
  for (const k of e.detail?.keys || []) evictDroppedDoc(k);
});

// Another device read one of the LOADED books further than this one did (a server
// pull just merged its newer position in). Move the reader up to that place, so a
// device reopened after the phone read on doesn't sit in the past. Never touches
// the book that is currently playing.
document.addEventListener("audiobooks:ahead", (e) => {
  adoptAheadDocs(e.detail?.keys || []);
});

/* ===================== chapters ===================== */
$("chapter").addEventListener("change", (e) => gotoChapter(e.target.value));

/* ===================== voices ===================== */
// The device voice list arrives asynchronously, so re-read it whenever the
// platform says it changed. Android still owns WHICH device voice is used
// (⚙️ Ajustes explains where); the picker below chooses the ENGINE.
loadVoices();
if (synth && synth.onvoiceschanged !== undefined) synth.onvoiceschanged = loadVoices;

// Build the picker from the voice table, so adding a voice is a config edit and
// the markup keeps only the device option (the one that is always available).
for (const v of PIPER_VOICES) {
  const o = document.createElement("option");
  o.value = v.id;
  o.textContent = `${v.label} · ${v.mb} MB`;
  $("voice").appendChild(o);
}

/**
 * Reflect the current voice in the collapsed summary, the volume hint and the
 * download note. The section is collapsed by default, so the summary badge is
 * the only thing saying which voice is in use — it has to stay accurate.
 */
async function paintVoiceUi() {
  const sel = selectedVoice();
  const isPiper = isPiperVoice(sel);
  const meta = PIPER_VOICES.find((v) => v.id === sel);
  $("voiceSummary").textContent = isPiper ? meta.label : "Voz del móvil";
  $("deviceVoiceHelp").hidden = isPiper;

  // Volume means different things per engine, so the hint is not decoration:
  // it is what stops a user pushing a slider that cannot move.
  $("volHint").textContent = isPiper
    ? `Puede pasar del 100%: el audio se genera en la página y se amplifica con ` +
      `un compresor, así que sube sin distorsionar. El nivel se recuerda.`
    : `El tope real es ${Math.round(VOL_MAX_DEVICE * 100)}%: la voz la genera ` +
      `Android fuera de la página y el navegador no puede amplificarla. ¿Más ` +
      `alta? Sube el volumen de multimedia del móvil.`;

  if (!isPiper) {
    $("voiceStatus").textContent =
      "Funciona sin descargar nada, pero no suena con la pantalla apagada.";
    voiceHintUpdate();
    return;
  }
  const have = await downloadedVoices();
  $("voiceStatus").textContent = have.includes(sel)
    ? "Descargada en este dispositivo. Funciona sin conexión y suena con la pantalla apagada."
    : `Sin descargar en este dispositivo (${meta.mb} MB). Se descarga al elegirla.`;
  voiceHintUpdate();
}

/**
 * A voice change takes effect on the NEXT paragraph, not this one: interrupting
 * mid-sentence to re-render in another voice loses the position the reader is
 * on. The rendered-audio cache is dropped because it is keyed by voice and the
 * old entries can never be reused.
 */
$("voice").addEventListener("change", async () => {
  markHandSet("voice"); // this device just chose; a synced pull must not undo it
  const v = saveSelectedVoice($("voice").value);
  pushSetting("voice", v); // follows the operator across devices
  clearCache();
  await paintVoiceUi();
  // Pull the model NOW, with progress on screen, rather than letting the first
  // ▶ stall for tens of MB with nothing to explain the silence.
  if (isPiperVoice(v)) {
    await prefetchVoice(v);
    await paintVoiceUi();
  }
});

// The local copy wins at boot so an offline start reads with the right voice;
// the synced value is adopted below, once the server answers.
setSelectedVoice(loadSelectedVoice());
$("voice").value = selectedVoice();
paintVoiceUi();

$("lang").addEventListener("change", () => {
  document.documentElement.lang = $("lang").value;
  voiceHintUpdate();
  restartCurrent();
});

/* ===================== rate / volume ===================== */
/**
 * Persist the speed just chosen — INTO THE PRESET THAT IS ARMED, which is the one
 * the slider is showing (see `paintSleepControls`).
 *
 * With «⏱️ Corto» on, the speed is the short run's third number: it is what the
 * run keeps for as long as it lasts, and it is handed back at the spend. It must
 * NOT reach LS_RATE or the `rate` blob key, or a 150% chosen for one 3 a.m. run
 * would become the reader's speed on every device until they noticed.
 *
 * With «🌙 Normal» on this is exactly what it always was: the global speed,
 * persisted locally and synced. `markHandSet` names the control that was actually
 * set, so the boot pull can still fill in the OTHER preset's speed.
 */
const saveRate = () => {
  const v = $("rate").value;
  if (isShortRun()) {
    markHandSet("sleepShortRate");
    setShortRate(v);
    pushSetting("sleepShortRate", v);
    return;
  }
  markHandSet("rate");
  longSleep.rate = v;
  try {
    localStorage.setItem(LS_RATE, v);
  } catch (_) {}
  pushSetting("rate", v); // mirror the global speed (atomic PATCH)
};
// The stored global speed (default 200%), clamped to the slider's 80–300% range.
// This is the LONG preset's speed; `paintSleepControls` decides what the slider
// ends up showing, once the armed preset is known.
try {
  const stored = Number.parseFloat(localStorage.getItem(LS_RATE));
  if (Number.isFinite(stored)) {
    const r = $("rate");
    r.value = Math.max(
      Number.parseFloat(r.min),
      Math.min(Number.parseFloat(r.max), stored),
    );
  }
} catch (_) {}
longSleep.rate = $("rate").value;

// Adopt the cross-device synced settings from the server after the local
// defaults are applied — so a value set on another device (or one that survived
// a storage wipe) wins. Fire-and-forget: no network ⇒ the per-device
// localStorage values stand. Neither branch re-fires a `change` (which would
// echo the just-pulled value straight back to the server); the enhanced-select
// label is refreshed with a `dd:sync` event instead (see ui.js).
//
// Deferred behind the ⚙️ sheet: the pull is a boot fetch with no deadline and can
// land while the sheet is open, which is the app rewriting its own controls in
// front of the reader (see settings.js#whenClosed).
pullSettings((s) =>
  whenClosed($("settingsModal"), () => applySyncedSettings(s)),
);

function applySyncedSettings(s) {
  // Global speed — the LONG preset's. Into `longSleep.rate` and the store always,
  // onto the slider only with «🌙 Normal» armed: the short run's speed is what is
  // on screen while it lasts, and writing the long one there would put a speed on
  // the panel that tonight is not going to read at (the same rule as #rewindMin
  // below).
  const rate = Number(s.rate);
  if (Number.isFinite(rate) && !isHandSet("rate")) {
    longSleep.rate = String(clampRate(rate));
    try {
      localStorage.setItem(LS_RATE, longSleep.rate);
    } catch (_) {}
    if (!isShortRun()) {
      $("rate").value = longSleep.rate;
      showRate();
      // No restart: an utterance's rate is fixed once queued, and a speed another
      // device changed shouldn't cut this paragraph off. It applies at the next one.
    }
  }

  // The voice follows the operator across devices. Adopted silently — no
  // `change` event, which would echo it straight back to the server — and NOT
  // downloaded here: a value synced from the phone must not start pulling tens
  // of MB onto the tablet the user merely opened. The model is fetched on the
  // first ▶ with that voice, or when it is picked by hand.
  if (typeof s.voice === "string" && s.voice && !isHandSet("voice")) {
    const was = selectedVoice();
    const v = saveSelectedVoice(s.voice);
    const sel = $("voice");
    if (sel && sel.value !== v) {
      sel.value = v;
      sel.dispatchEvent(new Event("dd:sync")); // refresh the enhanced label only
    }
    // ONLY when the voice actually moved. This pull lands a second or two into
    // every boot — normally answering with the voice this device is already on —
    // and clearing regardless threw away the paragraphs the read-ahead had just
    // rendered for the book being opened, at the one moment the reader is
    // waiting on them. The cache is keyed by voice, so an unchanged voice has
    // nothing stale in it to drop.
    if (was !== v) clearCache();
    paintVoiceUi();
  }

  // Sleep-mode rewind-on-stop minutes: adopt only if it's one of our options.
  // Into `longSleep` and the store, NOT straight into the control — with «⏱️ Corto»
  // armed that control is showing the SHORT pair, and writing the long rewind into
  // it would put a number on screen that no preset is going to use. The repaint
  // below decides what is on show.
  const rw = Number(s.rewindMin);
  if (Number.isFinite(rw) && !isHandSet("rewindMin") && isOption("rewindMin", rw)) {
    longSleep.rewind = String(rw);
    try {
      localStorage.setItem(LS_REWIND_MIN, longSleep.rewind);
    } catch (_) {}
  }

  // Sleep-mode stop interval, same deal — and the one that was missing until
  // 2026-07-31, which is why the shell app sat on the 40-min default for weeks
  // while the Pi's browser face had been set to 45. `applySleepMinutes` because
  // an adopted value must reach the live watchdog, not only the control: this
  // pull lands seconds into a boot, potentially with a book already playing.
  let liveInterval = false;
  const sm2 = Number(s.sleepMin);
  if (Number.isFinite(sm2) && !isHandSet("sleepMin") && isOption("sleepMin", sm2)) {
    longSleep.min = String(sm2);
    try {
      localStorage.setItem(LS_SLEEP_MIN, longSleep.min);
    } catch (_) {}
    liveInterval = !isShortRun();
  }

  // The SHORT pair travels too (2026-08-04): "a 3 a.m. run is twenty minutes for
  // me" is a fact about the reader, like the interval above. `setShort*` refuse an
  // unusable number and, while the preset is armed, re-read the live watchdog
  // themselves — so there is no `liveInterval` to raise for these.
  if (!isHandSet("sleepShortMin")) setShortMinutes(s.sleepShortMin);
  if (!isHandSet("sleepShortRewind")) setShortRewindMinutes(s.sleepShortRewind);
  // Its speed rides with them. `setShortRate` is silent by design, so the slider
  // is reached by the `paintSleepControls` below — one repaint for all four
  // numbers, and none at all for a preset that is not armed.
  if (!isHandSet("sleepShortRate")) setShortRate(s.sleepShortRate);

  // One repaint for whichever of the four numbers moved, then the live watchdog
  // only if the pull actually changed the interval IN FORCE: `applySleepMinutes`
  // restarts the idle countdown, and a boot-time pull that answers with the value
  // this device already had must not silently give a playing book another 40 min.
  paintSleepControls();
  if (liveInterval) applySleepMinutes();

  paintSettingsChips();
}

$("rate").addEventListener("input", showRate);
// `saveRate` also does the `markHandSet` — which control the reader just set
// depends on the armed preset, and only it knows.
$("rate").addEventListener("change", () => {
  saveRate();
  restartCurrent();
  paintSettingsChips(); // the 😴 badge carries the short run's speed
});

// Speed lives in the ⚙️ settings modal (slider + ±% fine steps); changes persist
// live as they happen. The on-screen ⚡ readout row was removed from the player
// view (the gear is one tap away on the top bar).
// ±1/5/10/15/20 → step the rate by that many percent (mirrors the old 🐢/🐇).
$("rateDeltas").addEventListener("click", (e) => {
  const d = e.target?.dataset?.d;
  if (d == null) return;
  stepRate(Number(d)); // the ±% steps set the speed as surely as the slider does
  saveRate();
  restartCurrent();
  paintSettingsChips();
});
showRate();

/* ===================== seek (progress) modal ===================== */
// Tap the progress bar → pick a position (drag the slider or nudge with ±%),
// then "Ir" jumps there. It edits a PENDING value; ✕/backdrop/Cancelar close
// without moving the reader. The ⏮/⏭ paragraph steps are the deliberate
// exception: they commit on press (see below).
wireModal("seekModal");
const seekPct = () => Math.round(Number($("seekRange").value));
const showSeek = () => {
  const pct = seekPct();
  $("seekVal").textContent = `${pct}%`;
  // Clock the PENDING position, not the live one, so dragging the slider tells
  // you how far in you're about to land — in the same hh:mm the player reads.
  const { curSec, totalSec } = secsAtPct(pct);
  $("seekTime").textContent = `(${fmtHm(curSec)} / ${fmtHm(totalSec)})`;
};
/** Snap the slider back onto the reader's real position, then repaint. */
const syncSeekToReader = () => {
  $("seekRange").value = Math.round(curPct());
  showSeek();
};
const openSeekModal = () => {
  if ($("controls").hidden) return; // no book loaded → nothing to seek
  syncSeekToReader();
  openModal("seekModal");
};
$("seekBar").addEventListener("click", openSeekModal);
$("seekBar").addEventListener("keydown", (e) => {
  // Enter only — Space is the global play/pause shortcut, so don't double-fire.
  if (e.key === "Enter") {
    e.preventDefault();
    openSeekModal();
  }
});
$("seekRange").addEventListener("input", showSeek);
$("seekDeltas").addEventListener("click", (e) => {
  const d = e.target?.dataset?.d;
  if (d == null) return;
  const v = Math.max(0, Math.min(100, seekPct() + Number(d)));
  $("seekRange").value = v;
  showSeek();
});
// ⏮/⏭ paragraph steps. They used to sit on the player, where a mistap moved the
// reader; behind the modal they're out of reach, so they keep acting IMMEDIATELY
// (no "Ir a esta posición" confirmation) — the modal stays open and the slider
// snaps to wherever the step landed, ready to be dragged from there.
$("seekPrevPara").addEventListener("click", () => {
  stepChunk(-1);
  syncSeekToReader();
});
$("seekNextPara").addEventListener("click", () => {
  stepChunk(1);
  syncSeekToReader();
});
$("seekApply").addEventListener("click", () => {
  const wasPlaying = state.speaking && !state.paused;
  jumpToPct(Number($("seekRange").value), wasPlaying);
  closeModal("seekModal");
});
$("seekCancel").addEventListener("click", () => closeModal("seekModal"));

// Restore the persisted volume (clamped to the slider's 0–VOL_MAX range); it's
// global (like rate), so a level chosen once — including a >100% boost — sticks
// across reloads instead of snapping back to the default.
const saveVol = () => {
  try {
    localStorage.setItem(LS_VOL, $("vol").value);
  } catch (_) {}
};
try {
  const stored = Number.parseFloat(localStorage.getItem(LS_VOL));
  if (Number.isFinite(stored)) {
    // Clamped to the PIPER ceiling, not the device one: the slider is shared and
    // a level chosen for a downloaded voice has to survive a session on the
    // device voice (which clamps itself at render time) instead of being
    // permanently ground down to 100% by the next reload.
    $("vol").value = Math.max(0, Math.min(VOL_MAX, stored));
  }
} catch (_) {}
// Persist on `input`, not only on `change`: on some Android browsers a range's
// `change` is unreliable (it can fail to fire on a touch-drag release), which is
// exactly how a chosen 120% snapped back to 100% on the next load. `input` fires
// on every move, so the level is always in localStorage by the time the finger
// lifts; `change` is left to do the audio restart only.
$("vol").addEventListener("input", () => {
  showVol();
  saveVol();
});
$("vol").addEventListener("change", restartCurrent);
$("volDown").addEventListener("click", () => {
  stepVol(-0.05);
  saveVol();
});
$("volUp").addEventListener("click", () => {
  stepVol(0.05);
  saveVol();
});
showVol();

// Modulation: per-device, restored before the graph exists so the first
// paragraph already plays with the chosen preset.
{
  const sel = $("modulation");
  const paint = () => {
    $("modulationVal").textContent =
      sel.options[sel.selectedIndex]?.textContent.replace(/ \(.*/, "") || "";
  };
  let stored = null;
  try {
    stored = localStorage.getItem(LS_MODULATION);
  } catch (_) {}
  sel.value = MODULATION[stored] ? stored : MODULATION_DEFAULT;
  // enhanceAllSelects already labelled the trigger off the default option.
  sel.dispatchEvent(new Event("dd:sync"));
  setModulation(sel.value);
  paint();
  sel.addEventListener("change", () => {
    setModulation(sel.value);
    paint();
    try {
      localStorage.setItem(LS_MODULATION, sel.value);
    } catch (_) {}
  });
}

/* ===================== transport ===================== */
// ▶ Play is the only transport there is, on-screen or off. The ⏮/⏭ paragraph
// steps live in the 📍 Posición modal (a mistap here used to lose your paragraph),
// and the car/headset MediaSession layer is gone: its ⏭ random-jumped INSIDE the
// book and saved at once, so one mispressed steering-wheel key destroyed your
// place and pushed it to every device — no confirm, no undo.

// Held, ▶ crosses to Música, which holds its own ▶ to come back.
const MUSICA_URL = "../musica/index.html";
//
// A hold is already a decision to leave: the shell's flag spares the reader the
// refresh confirm below.
const playHeld = holdable($("playpause"), () => {
  window.__PI_LEAVING__ = true;
  location.href = MUSICA_URL;
});
$("playpause").addEventListener("click", () => {
  // A hold that also toggled would leave the book reading into a page that is
  // being replaced.
  if (playHeld()) return;
  togglePlayPause();
});

// Held, the transcript flips día⇄noche: the shelf the 📖 toggle flips, ⏱️ Corto
// and all.
const holdFlipShelf = () => {
  const meta = MODE_META[flipShelf()];
  showToast(`${meta.glyph} Estantería ${meta.label}`);
};
const nowHeld = holdable($("now"), holdFlipShelf);
// #now is no button, so its click has nothing to swallow — this clears the latch
// for the next hold.
$("now").addEventListener("click", nowHeld);

/* ===================== sleep mode ===================== */
// Restore the last-used LONG pair (40 · ↺15 by default) into `longSleep`; what
// reaches the two controls is decided by `paintSleepControls` further down, once
// the armed preset is known — with «⏱️ Corto» restored, the dropdowns must come up
// showing ITS numbers and not the long ones the reader is not running tonight.
// Nothing here dispatches `change`: that pushes to the server, and a boot that
// pushes is a boot that echoes this device's stored value back over whatever the
// reader last chose elsewhere.
try {
  const savedMin = localStorage.getItem(LS_SLEEP_MIN);
  if (savedMin != null && isOption("sleepMin", savedMin)) longSleep.min = savedMin;
  const savedRw = localStorage.getItem(LS_REWIND_MIN);
  if (savedRw != null && isOption("rewindMin", savedRw)) longSleep.rewind = savedRw;
} catch (_) {}
// Live-update the stop interval if the setting changes mid-session, remember the
// choice for next time — and SYNC it, like #rewindMin.
//
// WHICH PAIR IT WRITES depends on the armed preset, because that is the pair the
// control is showing (see `paintSleepControls`). Armed, this is how the short run
// gets tuned; `setShortMinutes` persists it and re-reads the live interval on its
// own. NOT `markHandSet("sleepMin")` in that branch: the reader has not touched
// the long interval, so a synced long value must still be allowed to land.
//
// WHY IT SYNCS, decided 2026-07-31. It did not, and the cost was measured: the
// shell app had been running the 40-min default for weeks while its operator
// believed it was on 45, because piapp.localhost is a separate origin with its
// own empty localStorage and the 45 set in the Pi's browser face had no way to
// cross. "How long before it stops" is a fact about the person falling asleep,
// not about the device — the same argument that already made #rewindMin follow
// the reader — and a setting that silently disagrees with itself per origin is
// one nobody can verify without a debugger at 4 a.m. The 😴 SWITCH still does not
// travel: whether this is a device you fall asleep holding is genuinely local.
$("sleepMin").addEventListener("change", () => {
  const v = $("sleepMin").value;
  if (isShortRun()) {
    markHandSet("sleepShortMin");
    setShortMinutes(v);
    pushSetting("sleepShortMin", v);
  } else {
    markHandSet("sleepMin");
    longSleep.min = v;
    try {
      localStorage.setItem(LS_SLEEP_MIN, v);
    } catch (_) {}
    applySleepMinutes();
    pushSetting("sleepMin", v);
  }
  paintSettingsChips();
});
// Rewind-on-stop minutes (default 15), same split as the interval above: with the
// short run armed this is ITS step-back — the one that is 8 out of the box because
// −15 over a 30-min run rewinds past most of what it played. Persisted locally AND
// synced cross-device (atomic PATCH) either way. sleep.js reads the override or
// #rewindMin live when it auto-stops.
$("rewindMin").addEventListener("change", () => {
  const v = $("rewindMin").value;
  if (isShortRun()) {
    markHandSet("sleepShortRewind");
    setShortRewindMinutes(v);
    pushSetting("sleepShortRewind", v);
  } else {
    markHandSet("rewindMin");
    longSleep.rewind = v;
    try {
      localStorage.setItem(LS_REWIND_MIN, v);
    } catch (_) {}
    pushSetting("rewindMin", v);
  }
  paintSettingsChips();
});
// The on/off switch itself. LOCAL ONLY, unlike #rewindMin: whether the watchdog
// is wanted is a property of the device you fall asleep holding, not of the
// account, so the laptop must not inherit the phone's answer. Default ON — see
// SLEEP_ON_DEFAULT. `dd:sync` relabels the enhanced select without pretending the
// user chose it; the arming is done once by initSleep below.
try {
  const savedOn = localStorage.getItem(LS_SLEEP_ON);
  const so = $("sleepOn");
  const want = savedOn != null ? savedOn : SLEEP_ON_DEFAULT ? "1" : "0";
  if ([...so.options].some((o) => o.value === want) && so.value !== want) {
    so.value = want;
    so.dispatchEvent(new Event("dd:sync"));
  }
} catch (_) {}
$("sleepOn").addEventListener("change", () => {
  try {
    localStorage.setItem(LS_SLEEP_ON, $("sleepOn").value);
  } catch (_) {}
  setSleepEnabled($("sleepOn").value === "1");
  paintSettingsChips();
});
// "Pitar al mover": the diagnostic blip. Local-only and OFF by default (see
// SLEEP_BEEP_DEFAULT) — it is a test instrument, so it must never arrive armed on
// a device that did not ask for it. Remembered rather than reset each load: the
// test it serves involves locking the screen and putting the phone down, which a
// session-scoped toggle could not survive.
try {
  const savedBeep = localStorage.getItem(LS_SLEEP_BEEP);
  const sb = $("sleepBeep");
  const want = savedBeep != null ? savedBeep : SLEEP_BEEP_DEFAULT ? "1" : "0";
  if ([...sb.options].some((o) => o.value === want) && sb.value !== want) {
    sb.value = want;
    sb.dispatchEvent(new Event("dd:sync"));
  }
} catch (_) {}
$("sleepBeep").addEventListener("change", () => {
  try {
    localStorage.setItem(LS_SLEEP_BEEP, $("sleepBeep").value);
  } catch (_) {}
  // Called from the change handler on purpose: this is the user gesture that
  // lets the AudioContext start unsuspended, so the first shake is audible.
  setShakeBeep($("sleepBeep").value === "1");
  paintSettingsChips();
});
setShakeBeep($("sleepBeep").value === "1");
// The night's PRESET (⚙️ → 😴 header chip): «🌙 Normal» is the long pair, «⏱️ Corto»
// its own pair (30·↺8 out of the box) for ONE stop and then back by itself. The
// ARMING is a plain toggle, no select and no sync — it is a decision taken half
// asleep, about this phone, for the next few minutes. Its two NUMBERS do sync,
// because they are a preference and not tonight's decision; the dropdowns above
// switch to them while it is on, which is both how the reader sees what the night
// will do and how they change it.
//
// preventDefault AND stopPropagation, both: the chip lives inside the <summary>,
// and a click there has the fold's open/close as its DEFAULT ACTION. Without
// these, switching the preset also collapses the section you were reading.
$("sleepPreset")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setShortRun(!isShortRun());
});
// THE SAME TWO DECISIONS, HELD ON THE TOP BAR'S CHIPS: both are taken in the
// dark and both were four taps away through ⚙️.
//
// The chip already reads what the hold sets, so the new label is the answer.
holdable($("chipSleep"), () => {
  // 😴 off disables the preset chip; arming a run for a watchdog that will never
  // start is a hold that silently does nothing.
  if ($("sleepOn")?.value === "0") return false;
  setShortRun(!isShortRun());
});
// The shelf, on the chip that names it: flipping it used to mean opening 📖 or
// finding the transcript. applyModeCue (encurso.js) paints the chip, so the new
// label is the answer — and the flip is the one in flipShelf, so ⏱️ Corto and the
// cola follow here exactly as they do everywhere else.
holdable($("chipShelf"), holdFlipShelf);
// The pair worth swinging between at 3 a.m.; anything else is the ⚡ slider.
const RATE_HELD = [1.8, 1.5];
holdable($("chipRate"), () => {
  const r = $("rate");
  const near = (a, b) => Math.abs(a - b) < 0.03;
  r.value = String(near(Number.parseFloat(r.value), RATE_HELD[0]) ? RATE_HELD[1] : RATE_HELD[0]);
  showRate();
  saveRate();
  restartCurrent();
  paintSettingsChips();
});
// Repaint on every preset change — including the one nobody is present for, when
// the stop at 4 a.m. spends the short run and the panel must not still claim it
// is armed the next time it is opened. The CONTROLS first and the chips after:
// the badge reads the numbers in force, and this same subscription is what puts
// the long pair back in the dropdowns when the short run is spent. Registered
// BEFORE initSleep (which subscribes applySleepMinutes), so the watchdog reads
// #sleepMin only once it is showing the preset that is actually running.
onSleepPresetChange(() => {
  paintSleepControls();
  paintSettingsChips();
});
// Restore the arming and the short pair BEFORE initSleep, so the watchdog starts
// on the interval that is actually in force rather than adopting it a beat later.
// It announces, so the subscription above is also what first fills the two
// dropdowns from `longSleep` / the restored short pair.
initSleepPreset();
// Arm (or not) with the value just restored, and start listening for the shell's
// native motion reports. Everything else is the 3 s tick's business.
initSleep($("sleepOn").value === "1");
paintSettingsChips();

/* ===================== keyboard (space = play/pause) ===================== */
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const t = e.target;
  const tag = t?.tagName ? t.tagName.toLowerCase() : "";
  if (
    tag === "input" ||
    tag === "select" ||
    tag === "textarea" ||
    tag === "button" ||
    t?.isContentEditable
  ) {
    return;
  }
  if ($("controls").hidden) return;
  e.preventDefault();
  togglePlayPause();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // FIRST, and before `noteInteraction` below: if this page was FROZEN, the
    // sleep deadline it was holding ran out while nothing here could act on it,
    // and picking the phone up is what destroys the evidence — `noteInteraction`
    // restamps the countdown from now, so a night that ended at 22:28 would look
    // like a book that has been still for zero seconds. Settle it against the
    // wall clock while it can still be read. No-op unless the page really did
    // stop (see sleep.js#reconcileSleepDeadline).
    reconcileSleepDeadline();
    // Screen back on → somebody is holding the phone, which is the same evidence
    // the accelerometer would have given and, in a browser tab, the ONLY evidence
    // there was: `devicemotion` does not fire while the page is hidden, so the
    // sleep countdown has been frozen at the moment the screen went off. Restart
    // it from now rather than stopping the book seconds after it is picked up.
    noteInteraction();
    // Screen back on → auto-sync: pull other devices' progress + push ours. If
    // we're offline with unsynced progress, progress.js raises the retry banner
    // (activa Internet…) and keeps trying. This replaced the manual 🌅 button.
    syncNow();
    // Coming back to a book that stopped while we were away — the page frozen
    // mid-paragraph, audio focus taken and never returned — must show ▶, not ⏸
    // over silence, and must NOT relaunch the paragraph out of nowhere hours
    // later. Asked FIRST, and it answers false for an ordinary screen-off.
    if (state.speaking && !state.paused && !reconcileStalePlayback()) {
      // The browser drops the wake lock whenever the page hides; take it again.
      acquireWake();
      if (!isRendering()) {
        // Android kills the utterance while the page is hidden; relaunch it.
        // Asked of the ENGINE, not of speechSynthesis: Piper plays through a
        // media element the browser keeps running while hidden, and the device
        // queue it never touches reads as stalled, so this used to restart the
        // paragraph on every screen-on.
        speakCurrent();
      }
    }
  } else {
    // Screen off / app backgrounded → push the latest delta NOW (keepalive),
    // before Chromium freezes the tab. Waiting for the debounced PUT (or the
    // online-event retry) is exactly what dropped last night's progress when the
    // browser was closed — those never run once we're suspended. See flushNow.
    flushNow();
    flushLogNow(); // the night's minutes ride up on the same freeze deadline
  }
});

// The shell could not keep the foreground service up, so this process may be
// frozen the moment the audio next stops — at the next paragraph seam, with the
// screen off. Two things are worth doing with that half-second of warning, and
// only two: get the position onto disk and out to the server while there is still
// a running page to do it, and say so, because a book that stops for this reason
// is otherwise indistinguishable from one the app broke. There is nothing here
// that can restart the service; Android decides that, and it has said no.
watchPlaybackProtection(() => {
  saveProgress();
  flushNow();
  setStatus("⚠️ El móvil no deja proteger la reproducción: puede pararse con la pantalla apagada.");
});

/* ===================== watchdogs ===================== */
setInterval(saveProgress, 5000);
window.addEventListener("beforeunload", saveProgress);
// A hard refresh tears down the read-ahead buffer, the warmed voice and the word
// position, so a mistap on reload costs the reader their place.
//
// Only beforeunload can stop a hard refresh; a set returnValue is what shows the
// dialog. Pull-to-refresh is guarded separately.
//
// EXCEPTIONS, both the reader's decision: our version-update reload (reload.js
// latches first), and a deliberate leave — the shell's home chip, the held ▶
// above — raising __PI_LEAVING__.
window.addEventListener("beforeunload", (e) => {
  if (reloadCommitted() || window.__PI_LEAVING__) return;
  e.preventDefault();
  e.returnValue = ""; // Chrome requires a set returnValue to show the dialog
});
// pagehide is the reliable "leaving the page" signal on mobile (beforeunload
// frequently doesn't fire on Android); flush the last delta with keepalive so it
// reaches the server even as the tab is torn down (while online). A bfcache
// restore (pageshow.persisted) re-shows the page WITHOUT re-running module code,
// so pull+push explicitly to catch up on anything another device advanced.
window.addEventListener("pagehide", () => {
  flushNow();
  flushLogNow();
});
window.addEventListener("pageshow", (e) => {
  // A bfcache restore re-shows the page without re-running module code, so the
  // sleep countdown rides back in frozen at the moment of suspend. Same reading
  // as above: the page being shown again means a person is here — but settle any
  // deadline that expired in the meantime BEFORE saying so, or the restore itself
  // erases the night it should have ended.
  reconcileSleepDeadline();
  noteInteraction();
  if (e.persisted) syncNow();
});

// If speech stalls (background, network hiccup), relaunch the current chunk.
//
// `isRendering` asks whichever engine is selected. It used to ask
// `synth.speaking || synth.pending` — the DEVICE voice's queue — which Piper
// never puts anything into, so every Piper paragraph looked stalled 3 s in and
// this timer restarted it, and kept restarting it (speakCurrent restamps
// lastSpeakAt), roughly every 4 s for the whole book. Each restart cut the
// audio, re-synthesised from the ESTIMATED word offset — a cache miss, so
// seconds of silence — and resumed a word or two behind. That was the
// re-reading, and most of the clunkiness with it.
//
// The same timer is where a DEAD playback is noticed: an interruption counts as
// rendering (see isRendering), so the relaunch below never fires for one, and a
// pause that no longer has anything to come back to would otherwise leave the app
// reading forever with no sound. reconcileStalePlayback stands the transport down
// once the silence is long enough to be certain; it no-ops the rest of the time.
setInterval(() => {
  if (state.speaking && !state.paused) {
    // THE THAW PATH THAT ACTUALLY RUNS UNDER THE PI-SHELL. `visibilitychange`
    // never fires there — Android WebView ties page visibility to the VIEW's
    // window, so a backgrounded activity keeps reporting "visible" and dispatches
    // nothing (see NativePlugin#syncOnResume) — so this timer resuming is the
    // first thing that happens when the process comes out of the freezer, and it
    // is where a deadline that expired overnight has to be settled. Asked before
    // reconcileStalePlayback: both stand playback down, and this one knows the
    // night ended, which the other can only infer.
    if (reconcileSleepDeadline()) return;
    try {
      synth?.resume();
    } catch (_) {}
    if (reconcileStalePlayback()) return;
    if (!isRendering() && Date.now() - state.lastSpeakAt > 3000) {
      speakCurrent();
    }
  }
}, 2000);

/* ===================== startup ===================== */
/** The docKey open when the app closed; "" when the reader parked it, null when
 *  there never was one. */
function lastActiveKey() {
  try {
    return localStorage.getItem(LS_ACTIVE_KEY);
  } catch (_) {
    return null;
  }
}

/**
 * Rebuild the library from IndexedDB. `hydrateAll` isolates each record, so one
 * unreadable doc no longer takes the whole library down with it on a refresh.
 *
 * It returns the docs COLD: the sentence re-chunk, the one part of hydration
 * that is O(text), is deferred until a doc is actually opened. Boot used to run
 * it for up to MAX_DOCS books back-to-back on the main thread BEFORE the first
 * paint, so the reader waited on nineteen books they weren't opening. The
 * `activateDoc` below warms the one that matters; the rest warm when tapped.
 */
async function restoreLibrary() {
  let stored;
  try {
    stored = await idbGetAll();
  } catch (_) {
    // Blocked / private mode / a wedged upgrade. Say so rather than render an
    // indistinguishable "no books" state; the catalog fallback still runs.
    setStatus("No se pudo leer la biblioteca local de este dispositivo.");
    return;
  }
  if (!stored?.length) return;
  stored.sort((a, b) => (a.order || 0) - (b.order || 0));
  const { docs, skipped } = hydrateAll(stored.slice(0, MAX_DOCS));
  state.docs.push(...docs);
  if (!state.docs.length) return;
  renderTabs();
  // Reopen the book that was active before the reload (its position is already
  // restored per-doc in hydrate; speed/voice are global). Fall back to the first
  // doc if that key is gone (never set, or its doc evicted).
  const key = lastActiveKey();
  const i = key ? state.docs.findIndex((d) => d.docKey === key) : -1;
  // A parked player stays parked: queueing the book you were reading empties it,
  // and reopening docs[0] here undid that.
  if (key !== "") activateDoc(i >= 0 ? i : 0);
  // No "N documento(s) cargados desde el dispositivo." line any more: activateDoc
  // has just painted the book's card over #status, so that text was only ever
  // read as a delay before the book appeared. The card IS the confirmation.
  // A DROPPED book is the one thing worth saying out loud — unhide the line the
  // card just hid, so a corrupt record can't vanish silently.
  // Un-hide BEFORE writing: setStatus only toasts what the card is HIDING, so a
  // line that is on its way back to visibility must already be visible or the
  // warning lands twice (raw line + toast).
  if (skipped) {
    $("status").hidden = false;
    setStatus(`${skipped} documento(s) ilegible(s), omitido(s).`);
  }
}

/**
 * Nothing came back from IndexedDB, but we know which book was open: re-download
 * it from the raspi library and resume where we left off. IndexedDB holds the
 * bulky extracted text and browsers evict it under storage pressure (a PWA that
 * sat unused for a week, a low-disk phone), so "open the last book" must not
 * depend on it. The synced progress map — mirrored to localStorage AND the
 * server — carries the catalog `src` and the saved position, which is all a
 * reopen needs. Local uploads have no `src` and can't be re-fetched; they leave
 * the app on the empty state as before. Never auto-plays (`openCatalogBook`
 * selects only), so a reload can't start reading at you. The download itself
 * runs in the background — `openCatalogBook` reports its own progress/errors
 * through the status line.
 */
function restoreLastBookFromCatalog() {
  const key = lastActiveKey();
  if (!key) return false;
  const entry = catalogEntryFor(key);
  if (!entry) return false;
  setStatus(`Recuperando "${entry.title}" de la biblioteca…`);
  openCatalogBook(entry.src, entry.title);
  return true;
}

// Boot decides whether to restore from LOCAL sources (IndexedDB library, then the
// localStorage active-key). Both are empty after a full site-data clear — the very
// case where the shelf showed "elige un libro" though the server still held the
// book. So a SECOND restore path derives the last book from the merged server map
// (mostRecentSyncedBook), fired when progress.js announces the GET landed.
//
// `bootSettled` gates it: the derive must run only AFTER boot has confirmed the
// local sources found nothing, and the progressready event can arrive before OR
// after that. `bootRestoreOpened` makes both paths idempotent — the local restore
// sets it when it kicks a download off, so the derive never opens a second book,
// and a doc already loaded (state.docs.length) suppresses it outright.
let bootSettled = false;
let bootRestoreOpened = false;

function tryDeriveRestore() {
  if (!bootSettled) return; // wait until local sources have been ruled out
  if (bootRestoreOpened || state.docs.length) return; // already restoring / have a book
  if (lastActiveKey() === "") return; // parked on purpose — leave the slot empty
  if (!isProgressReady()) return; // the server map hasn't merged yet
  const bk = mostRecentSyncedBook();
  if (!bk) return;
  bootRestoreOpened = true;
  setStatus(`Recuperando "${bk.title}" de la biblioteca…`);
  openCatalogBook(bk.src, bk.title); // select-only: never auto-plays
}

// progress.js fires this once, on the boot GET→merge transition.
document.addEventListener("audiobooks:progressready", tryDeriveRestore);

// Before any of the boot work: an over-scroll at the top of a long transcript
// must never reload, which would kill playback and the loaded voice model. The
// `overscroll-behavior-y: contain` in css/_base.css handles Chromium; this adds
// the touch guard WebKit needs, where that CSS is ignored for pull-to-refresh.
installPullToRefreshGuard();

// Boot order is a priority, not a formality: the ONE thing the operator opened
// the app for is the book they were reading, so it goes first and everything
// else queues behind it. `initBiblioteca` used to run at import time, ahead of
// this — it fetches the whole catalog (a JSON blob it then indexes on the main
// thread), the favorites/reactions blobs, the queue, and then downloads book
// files into the offline buffer. All of that competed with the IndexedDB read +
// text-chunking that actually puts the book on screen. Now it starts once the
// book is up. `finally`, not a plain await: a library that fails to restore must
// not also cost you the 📚 button.
(async () => {
  try {
    await restoreLibrary();
    if (!state.docs.length) bootRestoreOpened = restoreLastBookFromCatalog();
  } finally {
    // The card slot has been showing "⏳ Abriendo tu libro…" since bind time.
    // Boot is done deciding: either a book activated and painted over it, or
    // there is genuinely nothing open and the "elige un libro" button is now a
    // true statement rather than a guess made before the library was read.
    // (restoreLastBookFromCatalog is a background download that activates when
    // it lands — its own status line covers that wait.)
    settleBootCard();
    // Local restore is done deciding. If it found nothing and the server map
    // already merged, derive the last book now; otherwise the progressready
    // event will (it may still be in flight). Either ordering restores once.
    bootSettled = true;
    tryDeriveRestore();
    initBiblioteca();
  }
})();
