/**
 * Which voice speaks, and the device (SpeechSynthesis) voice list behind it.
 *
 * ONE value names both the engine and the voice: `"device"` for whatever
 * Android is configured to use, or a Piper voice id for a neural voice
 * synthesised in the page (js/piper.js). A single value rather than an
 * engine+voice pair because the two are not independent — there is nothing to
 * pick for the device voice (Android owns that choice) and no engine to pick
 * for a Piper voice.
 *
 * It is SYNCED, unlike the old per-language voice preference that stayed
 * per-device: the operator asked for the choice to follow them. The local copy
 * is still authoritative at boot so an offline start reads with the right voice,
 * and the synced value is adopted afterwards (js/main.js).
 *
 * The device voice remains the fallback everywhere, because it is the only one
 * that needs no download and can never fail to load.
 */

import { LS_VOICE, VOICE_DEFAULT, VOICE_DEVICE, PIPER_VOICES } from "./config.js";
import { $ } from "./dom.js";
import { state, synth } from "./state.js";

/* ---------- the selection ---------- */

let selected = VOICE_DEFAULT;

/** The current engine+voice value. */
export const selectedVoice = () => selected;

/** Is a value one this build knows? Guards a value synced from a newer build. */
const known = (v) => v === VOICE_DEVICE || PIPER_VOICES.some((x) => x.id === v);

/**
 * Set the voice. Unknown values fall back to the device voice rather than
 * leaving the app mute — a value synced from a build that has a voice this one
 * does not must degrade, not break.
 */
export function setSelectedVoice(v) {
  selected = known(v) ? v : VOICE_DEFAULT;
  return selected;
}

/** Restore the per-device copy. The synced value is adopted later, in main.js. */
export function loadSelectedVoice() {
  try {
    const v = localStorage.getItem(LS_VOICE);
    if (v) setSelectedVoice(v);
  } catch (_) {}
  return selected;
}

/** Persist locally, so an offline boot still reads with the chosen voice. */
export function saveSelectedVoice(v) {
  setSelectedVoice(v);
  try {
    localStorage.setItem(LS_VOICE, selected);
  } catch (_) {}
  return selected;
}

/* ---------- local-voice ranking ---------- */
function voiceScore(v, lang) {
  const n = (v.name || "").toLowerCase();
  const l = (v.lang || "").toLowerCase().replace("_", "-");
  let s = 0;
  if (lang === "es") {
    if (n === "google español" && l.startsWith("es-es")) s = 120;
    else if (n.includes("google") && n.includes("español") && !n.includes("estados")) s = 110;
    else if (n.includes("google") && l.startsWith("es-es")) s = 100;
    else if (l.startsWith("es-es") && (n.includes("google") || !v.localService)) s = 90;
    else if (l.startsWith("es-es")) s = 80;
    else if (n.includes("google") && l.startsWith("es")) s = 60;
    else if (l.startsWith("es")) s = 50;
  } else {
    if (n.includes("google") && l.startsWith(lang)) s = 100;
    else if (l.startsWith(lang)) s = 60;
  }
  return s;
}

/**
 * Does this platform expose a device voice at all?
 *
 * Distinct from "the list is empty": an Android that has not populated
 * `getVoices()` yet still gets one later, while WebKitGTK never will. Only the
 * second case makes the device option a dead end worth saying so about.
 */
export const hasDeviceVoice = () => synth !== null;

/** (Re)load the device voice list; safe to call repeatedly. */
export function loadVoices() {
  state.voices = synth ? synth.getVoices() : [];
  voiceHintUpdate();
}

/**
 * The best device voice for the current language, or null when the platform
 * exposes none yet (Android populates the list asynchronously) — the utterance
 * then just carries `lang` and Android picks for itself.
 */
export function currentVoice() {
  const lang = $("lang").value;
  let best = 0;
  let chosen = null;
  state.voices.forEach((v) => {
    const s = voiceScore(v, lang);
    if (s > best) {
      best = s;
      chosen = v;
    }
  });
  return chosen;
}

/**
 * Say what will actually speak. Only meaningful for the device voice — a Piper
 * voice is named by the picker itself, and its own note reports the download.
 */
export function voiceHintUpdate() {
  const el = $("voiceNote");
  if (!el) return;
  if (selected !== VOICE_DEVICE) {
    el.textContent = "";
    return;
  }
  if (!hasDeviceVoice()) {
    el.textContent =
      "Este dispositivo no tiene voz del sistema — elige una voz Piper de la lista.";
    return;
  }
  const v = currentVoice();
  el.textContent = v
    ? `Voz en uso ahora mismo: "${v.name}" (${v.lang}).`
    : "Aún no hay ninguna voz instalada para este idioma — sigue los pasos de arriba.";
}
