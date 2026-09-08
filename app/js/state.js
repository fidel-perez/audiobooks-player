/**
 * Shared mutable runtime state.
 *
 * A single object (rather than a bag of module-level `let`s) so any module can
 * both read and write the live values — ES-module bindings are read-only for
 * importers, and the playback/library layers all need to mutate this.
 */

// `null` where the platform has no Web Speech API at all. That is not a
// hypothetical: WebKitGTK — the webview the pi-shell desktop app runs on —
// ships no speech-dispatcher binding, so `window.speechSynthesis` is
// `undefined` there, not an empty voice list. The distinction matters because
// main.js calls `loadVoices()` at MODULE TOP LEVEL: reading `.getVoices()` off
// `undefined` threw, and a throw during module evaluation abandons everything
// after it — including the boot IIFE that opens the last book. The symptom was
// the whole app wedged on "⏳ Abriendo tu libro…" forever, with one TypeError
// in the console and no other clue. Every consumer of this binding guards on
// `null`; Piper synthesises in the page and never comes through here, so it
// stays fully available on a platform with no device voice.
export const synth = window.speechSynthesis || null;

export const state = {
  // Library.
  docs: [], // hydrated docs (see pdf.js)
  active: -1, // index into docs, or -1

  // Active document (mirrors docs[active] for hot-path reads).
  fullText: "",
  chunks: [],
  charTotal: 0,
  curChunk: 0,
  // Char offset INTO the current chunk's SPOKEN text (NOT into fullText — the
  // chunk text is whitespace-collapsed, so this is a different coordinate space
  // from chunk.start/end and the two must never be added). It is the WORD we've
  // been read up to, so a pause, a doc switch, a rate change or a reload all
  // resume from that word rather than re-reading the paragraph. Fed by the
  // utterance `boundary` event, or — where the voice never fires one, as the
  // Android device voice tends not to — by player.js's spoken-time estimate.
  // Persisted as `off` alongside `pos` (progress.js). Reset to 0 when curChunk moves.
  chunkOffset: 0,
  chapters: [],
  chapterSkipped: [], // per-chapter: front/back matter hidden from playback
  bodyStartChar: 0, // first char of the real text (after front matter)
  bodyEndChar: 0, // first char of trailing back matter (0 ⇒ = charTotal)
  pageCharStarts: [],
  numPages: 1,
  wordsBefore: [0],
  totalWords: 0,
  docKey: "",

  // Playback.
  speaking: false,
  paused: false,
  speakGen: 0, // bumped to invalidate in-flight async speech callbacks
  lastSpeakAt: 0, // watchdog timestamp
  voices: [], // SpeechSynthesis device voices

  // Background keep-alive.
  wakeLock: null,
  keepAlive: null, // silent looping <audio> that keeps the tab alive
};
