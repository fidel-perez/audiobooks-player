/**
 * Playback controller.
 *
 * Owns the play/pause/stop state machine, renders the current chunk through
 * WHICHEVER engine is selected, advances on completion, and holds all the
 * jump/seek helpers. `speakGen` is bumped on every state change so stale async
 * callbacks (a late utterance end, a synthesis that finished after a jump)
 * no-op instead of racing.
 *
 * TWO ENGINES, ONE STATE MACHINE. The device (SpeechSynthesis) voice and Piper
 * differ only in how a paragraph is rendered and how "it finished" arrives:
 * an utterance's `onend`, or an <audio> element's `ended`. Everything else —
 * where we are, what counts as finished, when progress is saved — is shared, so
 * the split is confined to `speakCurrent` and `cancelAudio`. Keep it that way:
 * the position/finish bookkeeping is the part that must not fork.
 *
 * The speed and volume controls are global and apply to both, best-effort: the
 * device voice cannot exceed 100% volume (the OS renders it outside the page),
 * so it clamps, while Piper honours the full range through a gain node.
 */

import {
  BASE_WPM,
  PRECACHE_CHARS,
  PRECACHE_TICK_MS,
  REWIND_MIN_DEFAULT,
  VOL_MAX,
  VOL_MAX_DEVICE,
} from "./config.js";
import { setBusyOverlayLabel, showBusyOverlay } from "./busy.js";
import { $, setStatus } from "./dom.js";
import {
  acquireWake,
  holdPlayback,
  releaseWake,
  startKeepAlive,
  stopKeepAlive,
} from "./background.js";
import {
  bodyNumPages,
  bodyPageSpan,
  chunkAtChar,
  curBodyPageNum,
  curCharPos,
  curPct,
  docPct,
  addPlayed,
  listenedEnough,
  markDocRead,
  saveProgress,
} from "./progress.js";
import { noteRewind, noteSeek } from "./progresslog.js";
// A CYCLE, DELIBERATELY: sleep.js calls `stopAll`/`sleepRewind` here and this
// asks it back whether the watchdog was armed. Neither side touches the other at
// module scope — only inside functions — so the hoisted declarations are in place
// by the time either is called, whichever module the graph enters through.
import { isSleepOn, noteInteraction } from "./sleep.js";
// No cycle here: sleepPreset.js imports nothing but config, which is why the
// one-shot lives there and not in either of the two modules that read it.
import { consumeShortRun, rewindMinutesOverride } from "./sleepPreset.js";
import { claimPlayback, releasePlayback } from "./solo.js";
import { state, synth } from "./state.js";
import { escapeHtml, fmtTime, offsetAfterWords, snapToWordStart } from "./utils.js";
import { speechTextFrom } from "./cleanForSpeech.js";
import { currentVoice, selectedVoice } from "./voices.js";
import {
  bufferAhead,
  heldTag,
  isCached,
  isInterrupted as isPiperInterrupted,
  isPiperVoice,
  isPlaying as isPiperPlaying,
  playBlob,
  precache,
  prewarm,
  readAhead,
  resumeHeld,
  setCacheFocus,
  setHandlers as setPiperHandlers,
  setRate as setPiperRate,
  setVolume as setPiperVolume,
  stopAudio as stopPiperAudio,
  suspendAudio,
  synthesize,
} from "./piper.js";

/* ===================== play/pause button ===================== */
/**
 * The button's face — and, because every transition in and out of reading passes
 * through here, the one place the shell is told. See background.js#holdPlayback:
 * under the pi-shell an <audio> element is the wrong thing to ask while Piper is
 * synthesising, and the answer decides whether this process may be frozen.
 */
export function setPlaying(on) {
  holdPlayback(on);
  const btn = $("playpause");
  if (on) {
    btn.textContent = "⏸ Pause";
    btn.classList.remove("go");
    btn.classList.add("playing");
  } else {
    btn.textContent = "▶ Play";
    btn.classList.add("go");
    btn.classList.remove("playing");
  }
}

/**
 * Silence whatever is rendering, whichever engine produced it.
 *
 * Called on every state change (pause, jump, chapter, stop), and it has to be
 * unconditional: the engine can change mid-book, so stopping "the current one"
 * would leave the other still speaking over the new selection.
 */
export function cancelAudio() {
  try {
    synth?.cancel();
  } catch (_) {}
  try {
    stopPiperAudio();
  } catch (_) {}
}

/**
 * Is the selected engine still rendering the current paragraph?
 *
 * The stall watchdogs (main.js) used to ask `synth.speaking || synth.pending`
 * directly. That is the DEVICE voice's queue, and Piper never puts anything in
 * it — so under Piper both watchdogs saw a permanent stall and re-entered
 * `speakCurrent()` every few seconds: `cancelAudio()` cut the audio mid-word,
 * the paragraph was re-synthesised from the estimated offset (a cache miss, so
 * seconds of silence), and playback resumed a word or two BEHIND where it was.
 * That is what "it re-reads" and most of "clunky" actually were. The watchdogs
 * are still worth having for both engines — they just have to ask the engine
 * that is playing.
 *
 * "Rendering" deliberately includes the synthesis that has not produced audio
 * yet: a paragraph waiting on the model is making progress, and restarting it
 * only throws that work away and starts the wait again.
 *
 * …and an INTERRUPTION for the same reason: audio the browser paused for a call
 * or a notification is audio the browser will resume, so relaunching it stops a
 * book that was about to carry on by itself — and leaves the interrupted element
 * loaded for that resume to start alongside its replacement. See
 * piper.js#isInterrupted.
 */
export function isRendering() {
  if (isPiperVoice(selectedVoice())) {
    return (
      piperPendingGen === state.speakGen || isPiperPlaying() || isPiperInterrupted()
    );
  }
  return !!(synth && (synth.speaking || synth.pending));
}

/**
 * Is sound coming out, or about to?
 *
 * `isRendering` above answers "leave this alone", which an INTERRUPTION also
 * qualifies for. This one answers "the book is genuinely in flight", so an element
 * paused by something outside the app does NOT count. The difference is the whole
 * point: waiting out an interruption is right for a phone call and wrong for a
 * pause that is never coming back.
 */
function audioInFlight() {
  if (isPiperVoice(selectedVoice())) {
    return piperPendingGen === state.speakGen || isPiperPlaying();
  }
  return !!(synth && (synth.speaking || synth.pending));
}

/**
 * How long the app may believe it is reading while no engine is producing sound.
 *
 * `lastSpeakAt` is restamped by every paragraph launch, and a paragraph is under a
 * minute of audio even at the slowest speed, so two minutes of silence is not a
 * slow synthesis — it is playback that ended somewhere the app could not see.
 */
export const STALE_PLAYBACK_MS = 120000;

/**
 * THE BUTTON MUST NOT LIE. Reconcile "we are reading" against the engines, and
 * stand down when nothing is playing.
 *
 * Playback can end without this app being told. The pi-shell's foreground service
 * gives up and the page is FROZEN mid-paragraph (measured 2026-07-28) — a frozen
 * page runs no timers, so nothing here notices; audio focus can also go to another
 * app and never come back. Either way `state.speaking` stays true and the
 * transport still reads "⏸ Pause": reported 2026-07-30, the app was reopened the
 * morning after a sleep-mode night showing ⏸ over silence, when ▶ is what the
 * reader needed. And it is not only cosmetic — every watchdog, the wake lock and
 * the saved position all go on reasoning from "we are reading".
 *
 * `isRendering` cannot be the test here: it counts an interrupted element as
 * rendering (rightly — a call resumes by itself), which is exactly the state that
 * can sit there forever. So this asks `audioInFlight` and adds the clock:
 * STALE_PLAYBACK_MS of silence means dead, not busy.
 *
 * The stand-down is a full stop rather than a ⏸ hold: audio suspended overnight is
 * not audio worth resuming into (the element's source may be long gone), so the
 * source goes, the word is persisted, and ▶ re-renders from it — prewarmed, so the
 * tap is still instant. Returns whether it acted, so the caller can skip the
 * relaunch it was about to attempt.
 *
 * AND IT OWES THE READER THE SLEEP REWIND. Standing down over silence that lasted
 * all night IS falling asleep — it is the same event sleep.js's watchdog exists to
 * catch, arriving through the only code that was still able to run. Without the
 * rewind the morning ▶ resumes at the stall point, which is a stretch of book that
 * was read to nobody; measured 2026-07-31, the per-night log read +15.2/−0,
 * +39.9/−0, +4.6/−0 on three consecutive nights, because this path saved and the
 * watchdog never got to. Only when the setting is ARMED: with 😴 off, a book that
 * died in the background is a stall to resume from, not a night to step back over.
 */
export function reconcileStalePlayback(now = Date.now()) {
  if (!(state.speaking && state.chunks.length) || state.paused) return false;
  if (audioInFlight()) return false;
  if (now - state.lastSpeakAt < STALE_PLAYBACK_MS) return false;
  const armed = isSleepOn();
  // Where the night actually ENDED, not when we noticed. `noteRewind` buckets by
  // timestamp and the night rolls over at 06:00, so a rewind booked with `now` on
  // an app opened at nine would land on the wrong night — the one column the
  // morning readout exists to show.
  const stalledAt = state.lastSpeakAt;
  stopAll();
  const rewound = armed && sleepRewind(stalledAt);
  if (!rewound) {
    saveProgress(); // the word we got to, as a ⏸ would have saved it
    prewarmResumePoint(); // stopped, not idle: render where ▶ now lands
  }
  setStatus(
    rewound
      ? "😴 La lectura se quedó parada mientras dormías: retrocedida y guardada. Pulsa ▶."
      : "⏸ La lectura se detuvo en segundo plano. Pulsa ▶ para continuar."
  );
  return true;
}

/**
 * Step the book back by the ⚙️ «Rebobinar al detenerse» minutes and book them in
 * the night's log, at `ts` (the moment being accounted for, which is not always
 * now — see `reconcileStalePlayback`). Returns whether it moved anything: a
 * rewind of 0 is a valid choice and leaves the caller to save for itself.
 *
 * The amount is read LIVE from `#rewindMin` (synced cross-device), falling back to
 * REWIND_MIN_DEFAULT when the control is missing — unless the ⚙️ SHORT RUN is
 * armed, whose smaller step-back overrides it for the one night it lasts. TWO
 * CALLERS, ONE RULE: sleep.js's `fallAsleep`, which is the watchdog noticing, and
 * `reconcileStalePlayback`, which is the morning noticing that the watchdog never
 * got the chance. Both mean "you fell asleep here", so both owe the same −15.
 *
 * AND BOTH END THE NIGHT, which is why the short run is SPENT here rather than in
 * either caller: this is the one line both already share, so the one-shot cannot
 * come back armed through the path someone forgot to update. Spent even when the
 * rewind itself is 0 — a preset is used up by the stop, not by the step-back.
 */
export function sleepRewind(ts = Date.now()) {
  const override = rewindMinutesOverride();
  const el = $("rewindMin");
  const raw = el ? Number.parseInt(el.value, 10) : Number.NaN;
  const stored = Number.isFinite(raw) ? raw : REWIND_MIN_DEFAULT;
  const mins = override == null ? stored : override;
  // MEASURE THE STEP-BACK FIRST, SPEND THE PRESET AFTER. `rewindMinutes` converts
  // minutes to characters at the speed on the ⚡ slider, and the spend is what puts
  // the LONG preset's speed back there (main.js repaints on the announcement). Spent
  // first, a short run played at 150% was stepped back as if it had played at 200%
  // — a −8 that lands a couple of minutes earlier than the eight minutes nobody
  // heard. Still spent when the rewind is 0: a preset is used up by the stop, not
  // by the step-back.
  const moved = mins > 0;
  if (moved) rewindMinutes(mins, ts);
  consumeShortRun();
  return moved;
}

/** The live values of the two global controls, shared by both engines. */
const curRate = () => Number.parseFloat($("rate").value) || 1;
const curVol = () => Number.parseFloat($("vol").value) || 0;

/**
 * Push speed/volume into a PLAYING Piper stream.
 *
 * Unlike an utterance — whose rate and volume are frozen the moment it is
 * queued, which is why a device-voice change has to re-speak the paragraph —
 * a media element takes both live. So the slider moves and the voice responds
 * mid-sentence, with no re-synthesis and no lost position.
 */
export function applyLiveAudio() {
  if (!isPiperVoice(selectedVoice())) return false;
  setPiperRate(curRate());
  setPiperVolume(curVol());
  return true;
}

/* ============ where-are-we INSIDE the paragraph (the resume word) ============ */

/**
 * `state.chunkOffset` — the char we've been spoken up to inside the current
 * paragraph — is what makes ▶ resume at the WORD you paused on instead of
 * re-reading the paragraph from its first word. Two sources feed it:
 *
 *  1. the utterance's `boundary` event (exact, and the only one we trust); and
 *  2. failing that, a clock. Android's device voice — the ONLY engine this app
 *     still has (see NOTES.md) — often never fires `boundary` at all, and that
 *     silence is precisely why pausing used to rewind to the paragraph start.
 *     So while an utterance runs without announcing a single boundary, we count
 *     how long it has actually been speaking and convert that to words at the
 *     current rate. `offsetAfterWords` deliberately lands a word SHORT, so the
 *     guess can only ever repeat a word, never skip one.
 *
 * The clock counts SPOKEN time, not wall time: hiding the page suspends Android
 * TTS while `Date.now()` keeps running, so a naive elapsed-time reading would
 * sprint ahead of the voice every time the screen went off.
 */
const OFFSET_TICK_MS = 500;
// The generation whose Piper synthesis is in flight, or -1. Read by
// `isRendering` so a paragraph still waiting on the model does not look stalled.
let piperPendingGen = -1;
let speakBase = 0; // chunk offset this utterance started from
let sawBoundary = false; // did THIS utterance ever report a boundary?
let spokenMs = 0; // ms it has actually been rendering
let offsetTicker = null;

function stopOffsetTicker() {
  if (offsetTicker) clearInterval(offsetTicker);
  offsetTicker = null;
}

function tickOffset() {
  if (sawBoundary) {
    stopOffsetTicker(); // real boundaries arrived — the estimate is redundant
    return;
  }
  if (!state.speaking || state.paused) return;
  if (typeof document !== "undefined" && document.hidden) return; // TTS suspended
  if (!synth?.speaking) return; // queued but not yet rendering
  spokenMs += OFFSET_TICK_MS;
  const c = state.chunks[state.curChunk];
  if (!c) return;
  const rate = Number.parseFloat($("rate").value) || 1;
  const words = (BASE_WPM * rate * spokenMs) / 60000;
  state.chunkOffset = offsetAfterWords(c.text, speakBase, words);
}

/** Begin tracking the word position for a freshly queued utterance from `base`. */
function trackOffsetFrom(base) {
  speakBase = base;
  sawBoundary = false;
  spokenMs = 0;
  stopOffsetTicker();
  offsetTicker = setInterval(tickOffset, OFFSET_TICK_MS);
}

/**
 * Word position while a Piper paragraph plays.
 *
 * Piper emits no word boundaries — there is no `boundary` event and no timing
 * metadata in the WAV — so the resume word is interpolated from how far through
 * the audio we are. Speech is close enough to linear in characters over one
 * paragraph for this to land within a word or two, and `snapToWordStart` pulls
 * it back to a word start so a resume never begins mid-word.
 *
 * This is a small regression against the device voice's `boundary` events where
 * those actually fire — but on Android they usually do not, so in practice this
 * replaces the spoken-time ESTIMATE, not the exact source. It is also strictly
 * better than that estimate: it reads the real elapsed audio rather than
 * predicting from an assumed words-per-minute.
 */
function piperOffsetTracker(c) {
  return (frac) => {
    if (!state.speaking || state.paused) return;
    if (!frac) return;
    // The audio spans the WHOLE paragraph (see speakPiper), so the fraction maps
    // straight onto the whole text — and it is the exact inverse of the
    // `startFrac` a resume seeks with, which is what keeps ⏸/▶ landing on the
    // word it left rather than drifting a little further each time.
    state.chunkOffset = snapToWordStart(c.text, Math.floor(frac * c.text.length));
  };
}

/**
 * What the engine should tell the player about THIS paragraph, bound to the
 * generation that started it. Shared by the render path and the instant-resume
 * path so a resumed paragraph advances the book exactly like a rendered one —
 * that split is precisely where a "the book stops at the end of the paragraph
 * you resumed" bug would live.
 */
function piperHandlersFor(c, myGen, advance) {
  return {
    onEnded: () => {
      if (myGen !== state.speakGen) return;
      advance();
    },
    onError: () => {
      if (myGen !== state.speakGen) return;
      setStatus("❌ Error de audio; salto al siguiente párrafo.");
      advance();
    },
    onTime: piperOffsetTracker(c),
  };
}

/**
 * Is the audio the graph is still HOLDING (a deliberate ⏸ that kept its source)
 * exactly the audio a ▶ now wants?
 *
 * Everything that repositions the book — a jump, a chapter, a step, a voice
 * change, the sleep rewind — goes through `cancelAudio`, which drops the source
 * and the hold with it. So a match here means nothing has happened since the
 * pause but the pause, and the element can simply be told to carry on.
 */
function heldMatches(docKey, voiceId, idx, off) {
  const tag = heldTag();
  return (
    !!tag &&
    tag.docKey === docKey &&
    tag.voiceId === voiceId &&
    tag.idx === idx &&
    tag.off === off
  );
}

/**
 * Render one paragraph with Piper and play it.
 *
 * Async, so every resumption point re-checks `speakGen`: a jump, a pause or a
 * voice change during synthesis must abandon this paragraph rather than start
 * speaking it late over whatever the user chose instead.
 *
 * THE PARAGRAPH IS ALWAYS RENDERED WHOLE, from its first word, and a resume
 * SEEKS into that one rendering. It used to render only the text still to come,
 * which made the resume word part of the cache key — so a paragraph the
 * read-ahead had already rendered was a guaranteed MISS the moment it was paused
 * anywhere but at its start, and ⏸ then ▶ meant waiting on the engine for audio
 * the app was already holding. One entry per paragraph also stops a reader who
 * pauses often from filling the cache with a dozen overlapping renderings of the
 * same words and evicting the read-ahead to make room for them.
 */
async function speakPiper(c, base, myGen, advance, voiceId, fromUser, resuming) {
  const docKey = state.docKey;
  let blob;
  // Claimed before the first await: from here until this paragraph is either
  // playing or abandoned, `isRendering` must report progress even though no
  // audio has started, or a watchdog will restart the synthesis we are waiting
  // on. Cleared only by a NEWER generation superseding it, so an abandoned
  // paragraph cannot leave the flag stuck.
  piperPendingGen = myGen;
  // Eviction needs to know where the listener is before anything new is
  // rendered, or the render that follows can push out the paragraph next to it.
  setCacheFocus(docKey, voiceId, state.curChunk);

  // THE INSTANT PATH: this very paragraph is still sitting in the audio element,
  // paused, at the sample it stopped on. Nothing to render, nothing to decode,
  // nothing to seek — hand it the new generation's handlers and let it carry on.
  // This is what makes a quick ⏸/▶ (and the media-notification pause, and an
  // accidental double tap) cost nothing at all.
  if (resuming) {
    setPiperHandlers(piperHandlersFor(c, myGen, advance));
    try {
      if (await resumeHeld()) {
        if (piperPendingGen === myGen) piperPendingGen = -1;
        readAhead(docKey, voiceId, state.chunks, state.curChunk + 1);
        return;
      }
    } catch (_) {
      // The element refused to restart (an autoplay policy after a long pause).
      // Fall through and render it properly rather than leaving the book silent.
    }
    if (myGen !== state.speakGen) return;
  }

  // Already rendered? Then ▶ is not a wait, and must not behave like one: the
  // curtain swallows taps for as long as it is up, so raising it over a cache hit
  // is exactly how a ⏸ pressed a moment after ▶ went missing. The cushion below
  // is skipped for the same reason — a warm paragraph means the precache and the
  // read-ahead have been here already.
  const warm = isCached(docKey, voiceId, state.curChunk, 0);
  // A reader's own ▶/seek raises the blocking overlay for the whole synthesis:
  // Piper produces no audio for the first second or two, and that silent gap is
  // exactly the window a second tap turned into two intertwined readers. The
  // curtain both says "working" and swallows those taps. Released in `finally`
  // whatever happens below — the moment playback starts, or the paragraph is
  // abandoned. An auto-advance seam passes `fromUser` falsy and stays curtainless
  // so warm, silent seams raise nothing. (The reveal is still delay-gated, so a
  // cached/warm synthesis flashes no spinner at all.)
  const releaseOverlay = fromUser && !warm
    ? showBusyOverlay({ label: "Generando voz…" })
    : null;
  try {
    // Re-cleaned rather than sliced raw: the stored paragraph was cleaned by
    // whatever rules existed when the book was imported (see speechTextFrom).
    // WHOLE, from the top: `base` is applied as a seek into the finished audio,
    // not as a slice of the text — see this function's header.
    const text = speechTextFrom(c.text);
    // A model DOWNLOAD reports progress; surface it honestly rather than sit on a
    // mute "Generando voz" while tens of MB come down (the reported symptom after
    // a cookie/site-data clear evicted the model). Seeing progress also means the
    // generic wait line below must NOT fire — the download is the real status.
    let sawDownload = false;
    const onProgress = (pct) => {
      sawDownload = true;
      if (myGen === state.speakGen) {
        setStatus(`⬇️ Descargando voz… ${pct}%`);
        // Keep the curtain's line honest too, so a big first-download is a
        // labelled wait and not a mute spinner behind a blocked screen.
        if (releaseOverlay) setBusyOverlayLabel(`Descargando voz… ${pct}%`);
      }
    };
    const pending = setTimeout(() => {
      // Only surfaces when synthesis is slower than the read-ahead covered —
      // the first paragraph after a jump, or a device too slow to keep up.
      if (myGen === state.speakGen && !sawDownload) setStatus("⏳ Generando voz…");
    }, 600);
    // Urgent: playback is blocked on THIS paragraph, so it must overtake the
    // speculative read-ahead already queued behind it. And ABANDONABLE: if the
    // reader pauses (or jumps) before the engine gets to it, this job is dropped
    // from the queue rather than rendering audio nobody will hear while the next
    // ▶ waits behind it. That pile-up is what made the SECOND and third taps of a
    // quick ⏸/▶/⏸/▶ slower than the first.
    const stale = () => myGen !== state.speakGen;
    try {
      blob = await synthesize(
        docKey,
        voiceId,
        state.curChunk,
        0,
        text,
        true,
        onProgress,
        stale,
      );
      clearTimeout(pending);
    } catch (e) {
      clearTimeout(pending);
      if (myGen !== state.speakGen) return;
      // The model failed to load or synthesis threw. Stop rather than silently
      // dropping to the device voice: the user picked this voice deliberately,
      // and a silent downgrade is how the old online engines rotted unnoticed.
      setStatus(`❌ La voz no pudo generar audio. ${e?.message || ""}`.trim());
      finishReading("Lectura detenida.");
      return;
    }
    if (myGen !== state.speakGen || !state.speaking || state.paused) return;

    // Build a cushion of the FOLLOWING sentences before this first one starts, so
    // a run of short opening phrases doesn't play faster than the single WASM
    // thread can synthesise the next — the silence-between-the-first-few-phrases
    // gap. Measured in CHARACTERS (bufferAhead), so a handful of tiny sentences
    // still amounts to real audio. Only on a reader's own ▶/seek (fromUser): an
    // auto-advance seam is already covered by the read-ahead and must not stall to
    // re-buffer at every paragraph. The blocking overlay is still up here, so the
    // wait is a labelled curtain, not a mystery pause.
    if (fromUser && !warm) {
      await bufferAhead(docKey, voiceId, state.chunks, state.curChunk + 1);
      if (myGen !== state.speakGen || !state.speaking || state.paused) return;
    }

    // Registered on the module, not on an element: which of the two elements is
    // playing changes on every paragraph, and a stale handler left behind would
    // advance the book twice.
    setPiperHandlers(piperHandlersFor(c, myGen, advance));

    // The resume word, as a fraction of the paragraph — the audio is the WHOLE
    // paragraph now, so this is where to drop the needle.
    const startFrac = base > 0 && c.text.length > 0 ? base / c.text.length : 0;
    const opts = { rate: curRate(), volume: curVol(), startFrac };
    try {
      await playBlob(blob, opts);
    } catch (e) {
      if (myGen !== state.speakGen) return;
      // The audio EXISTS — this is the element refusing to start it (an autoplay
      // policy, or a load that raced the previous paragraph's teardown). One
      // retry, because the racing case succeeds on the second attempt; only then
      // is it a real block, and one the user must clear with a tap.
      try {
        await playBlob(blob, opts);
      } catch (e2) {
        if (myGen !== state.speakGen) return;
        setStatus(`❌ Reproducción bloqueada. ${e2?.message || e?.message || ""}`.trim());
        finishReading("Lectura detenida; pulsa ▶ para reanudar.");
        return;
      }
    }
    // Playing now, so the element itself is the honest answer to "still going?".
    if (piperPendingGen === myGen) piperPendingGen = -1;
    // Only once THIS paragraph is safely playing: a read-ahead started earlier
    // would compete with the synthesis we are actually waiting on. The first of
    // these is also staged into the standby element as soon as it lands, so the
    // next paragraph starts with no decode at the seam. Depth is a CHARACTER
    // budget (READAHEAD_CHARS), not a paragraph count — see piper.js#readAhead.
    readAhead(docKey, voiceId, state.chunks, state.curChunk + 1);
  } finally {
    // Drop the curtain on every path out — playing, abandoned, or thrown. Once
    // audio is running (or this paragraph is dead) a second tap is legitimate
    // again, so it must not stay blocked.
    if (releaseOverlay) releaseOverlay();
  }
}

/**
 * The character a ▶ would start speaking from, inside the current paragraph.
 *
 * ONE definition, deliberately. It is no longer part of the synthesis cache key
 * — a paragraph is rendered whole and this is applied as a SEEK into it — but it
 * is still the word ⏸ recorded and the word ▶ must land on, so `speakCurrent`,
 * the resume check and the offset tracker all have to agree on it exactly. A
 * disagreement here does not fail loudly; it drifts the resume a word or two
 * further into the paragraph on every pause.
 */
function resumeBase(c) {
  return snapToWordStart(
    c.text,
    Math.max(0, Math.min(state.chunkOffset || 0, c.text.length)),
  );
}

/**
 * Render (and decode) the paragraph ▶ will start on, while nothing is playing.
 *
 * The read-ahead only runs behind a paragraph that is ALREADY playing, so every
 * moment the app spends stopped — freshly opened, paused, or just repositioned —
 * left the next ▶ paying for a synthesis from scratch.
 *
 * Called on every transition INTO the stopped state, and fire-and-forget: this
 * is spare time being spent, and a warm-up that fails just leaves the paragraph
 * to render on demand exactly as before.
 *
 * This is now the SHALLOW half of the answer — one paragraph, staged into the
 * element so ▶ is a swap rather than a load. `idlePrecacheTick` below is the
 * deep half, and the two run together: this makes the very next tap instant,
 * that one keeps it instant for the following minutes.
 */
export function prewarmResumePoint() {
  // The read-ahead owns the playing case, and its standby element must not be
  // written from under it.
  if (state.speaking && !state.paused) return;
  const voiceId = selectedVoice();
  if (!isPiperVoice(voiceId)) return; // the device voice renders nothing ahead
  const c = state.chunks?.[state.curChunk];
  if (!c) return;
  setCacheFocus(state.docKey, voiceId, state.curChunk);
  // Nothing to warm when the graph is still HOLDING this exact paragraph: ▶ is
  // already a resume, and rendering over it would spend the engine to arrive at
  // audio we have.
  if (!heldMatches(state.docKey, voiceId, state.curChunk, resumeBase(c))) {
    // Staged as well as rendered: with audio silent the standby element is free,
    // so ▶ becomes a swap instead of a load+decode. Re-asked at the moment of
    // staging rather than decided here — the render takes seconds and ▶ may well
    // land inside it, at which point the standby element is the read-ahead's again
    // and writing to it would make the next seam repeat a paragraph. See
    // piper.js#prewarm.
    const stillStopped = () => !(state.speaking && !state.paused);
    prewarm(state.docKey, voiceId, state.chunks, state.curChunk, 2, stillStopped).catch(
      () => {},
    );
  }
  // …and then keep going, much deeper, for as long as nobody is listening.
  idlePrecacheTick();
}

/* ===================== the idle precache =====================
 *
 * An open book that is not playing is the app's most common state — on the
 * bedside table with sleep mode armed, in a hand between chapters, restored at
 * boot and waiting for the first ▶ — and until now it rendered nothing. Every
 * second of it is a second of free CPU, and every paragraph rendered during one
 * is a paragraph the reader never waits for.
 *
 * It abandons itself the moment playback starts: the predicate below is re-asked
 * between paragraphs AND handed to the queue, so a speculative render that has
 * not begun is dropped rather than sitting in front of the paragraph ▶ is
 * blocked on. Only a render already inside the WASM call has to finish, because
 * there is nothing there to interrupt.
 */
let precacheGen = 0;
let precacheBusy = false;

export function idlePrecacheTick() {
  if (precacheBusy) return;
  if (state.speaking && !state.paused) return; // playing → readAhead owns the engine
  if (!state.chunks?.length) return;
  const voiceId = selectedVoice();
  if (!isPiperVoice(voiceId)) return;
  const docKey = state.docKey;
  const from = state.curChunk;
  const gen = ++precacheGen;
  const stale = () =>
    gen !== precacheGen ||
    docKey !== state.docKey ||
    selectedVoice() !== voiceId ||
    (state.speaking && !state.paused);
  precacheBusy = true;
  precache(docKey, voiceId, state.chunks, from, PRECACHE_CHARS, stale)
    .catch(() => {})
    .finally(() => {
      precacheBusy = false;
    });
}

// Top the buffer back up on a slow tick as well as on every transition into the
// stopped state. The transitions cover "the reader just paused"; this covers the
// hours after it — a book left open while the precache was still shallow (the
// voice model had not finished downloading, the tab was throttled, the reader
// changed the speed) gets filled in rather than staying half-built until
// something happens to nudge it. A no-op when everything ahead is already
// rendered, which is the usual case.
const precacheTimer = setInterval(idlePrecacheTick, PRECACHE_TICK_MS);
// Under Node (the test shim) a bare interval is a live handle that keeps the
// event loop alive, so importing this module would hang the runner after the
// last test instead of exiting. `unref` exists only there — in a browser
// `setInterval` returns a number and this is a no-op, so the loop is unchanged
// where it actually matters.
if (typeof precacheTimer?.unref === "function") precacheTimer.unref();

/** Tear down playback and report why (end of book / end of body text). */
function finishReading(msg) {
  state.speaking = false;
  state.paused = false;
  piperPendingGen = -1;
  releasePlayback(); // not reading any more → stop watching the shared claim
  stopOffsetTicker();
  setPlaying(false);
  releaseWake();
  stopKeepAlive();
  setStatus(msg);
}

/* ===================== speak current chunk ===================== */
export function speakCurrent(fromUser = false) {
  const end = state.bodyEndChar || state.charTotal;
  // End of book, or already at/inside the trailing back matter (e.g. resumed
  // there or stepped in manually): the real text is over.
  if (state.curChunk >= state.chunks.length || curCharPos() >= end) {
    finishReading("Lectura finalizada.");
    return;
  }
  const c = state.chunks[state.curChunk];
  // Resume from the WORD the last utterance left off on (0 on a fresh paragraph)
  // so a pause — or a live rate change — re-speaks only the text still to come,
  // not the whole paragraph. Snapped back to a word start: a persisted offset
  // may have been produced by another device's engine, or by the estimate below.
  const base = resumeBase(c);
  const voiceId = selectedVoice();
  // Decided BEFORE anything is torn down: `cancelAudio` drops the source, and
  // with it the very audio the instant-resume path is about to reuse. A ⏸ that
  // is still being held is resumed; everything else silences first, as always.
  const resuming =
    isPiperVoice(voiceId) && heldMatches(state.docKey, voiceId, state.curChunk, base);
  const myGen = ++state.speakGen;
  if (!resuming) cancelAudio();
  const advance = () => {
    if (myGen !== state.speakGen) return;
    if (!state.speaking || state.paused) return;
    // This chunk was just spoken to completion — count it toward the cumulative
    // "hours played" total that gates the auto-finish below.
    addPlayed(state.docKey, c.text.length);
    // Stop at the end of the real text without stepping the saved position into
    // the skipped back matter — stay parked on the last body paragraph.
    const next = state.curChunk + 1;
    if (next >= state.chunks.length || state.chunks[next].start >= end) {
      updateProgress();
      saveProgress();
      const finishedKey = state.docKey;
      // The finished book's catalog path (null for a local drop): lets the
      // auto-advance play the NEXT book in the current filter list instead of a
      // pure random, so a series tends to roll on to its next volume.
      const finishedSrc = state.docs[state.active]?.src || null;
      // Only mark finished if enough of the book was actually played — reaching
      // the last paragraph by jumping to the final chapter must not count.
      const span = end - (state.bodyStartChar || 0);
      // Genuine end-of-book: read in the library AND into the "recientemente"
      // inbox — the one path that sets both bits (manual ✅/📖 each set just one).
      if (listenedEnough(finishedKey, span)) markDocRead(finishedKey);
      finishReading("Lectura finalizada.");
      // Book completed under normal playback (NOT a manual jump-to-end): let the
      // queue / auto-advance take over, keeping the current voice, speed
      // and volume (those are global + persisted, so they carry across).
      document.dispatchEvent(
        new CustomEvent("audiobooks:finished", {
          detail: { docKey: finishedKey, src: finishedSrc },
        }),
      );
      return;
    }
    state.curChunk = next;
    state.chunkOffset = 0; // new paragraph → resume tracking from its start
    saveProgress();
    updateProgress();
    speakCurrent();
  };
  $("now").innerHTML = `<small>${escapeHtml(c.text)}</small>`;
  state.lastSpeakAt = Date.now();

  state.chunkOffset = base;

  // The engine split lives HERE and in cancelAudio, and nowhere else: `advance`
  // above (position, finish, auto-advance) is shared by both, so the bookkeeping
  // cannot fork between them.
  if (isPiperVoice(voiceId)) {
    stopOffsetTicker(); // the spoken-time clock is device-voice only
    speakPiper(c, base, myGen, advance, voiceId, fromUser, resuming);
    updateProgress();
    return;
  }

  // Reaching the device branch on a platform that has no Web Speech API is a
  // dead end, not a slow start — `synth.speak` would be a silent no-op and the
  // paragraph would sit there with no `onend` to advance it, looking like a
  // hang. Say so instead, and stop: Piper is right there in the same picker.
  if (!synth) {
    stopAll();
    setStatus("❌ Este dispositivo no tiene voz del sistema — elige una voz Piper.");
    return;
  }

  const u = new SpeechSynthesisUtterance(speechTextFrom(c.text, base));
  const v = currentVoice();
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  } else {
    u.lang = $("lang").value;
  }
  u.rate = Number.parseFloat($("rate").value);
  // The slider runs to the Piper ceiling (VOL_MAX). Android renders this voice
  // outside the page, so anything above VOL_MAX_DEVICE is unreachable here and
  // clamps rather than pretending to apply.
  u.volume = Math.min(VOL_MAX_DEVICE, Number.parseFloat($("vol").value));
  // `boundary` charIndex is relative to THIS utterance's text; add `base` to
  // keep the offset chunk-absolute. Where the voice never fires it (the Android
  // device voice usually doesn't), `trackOffsetFrom`'s clock estimates instead.
  // The utterance is the re-cleaned copy, so on an OLD book (imported before a
  // rule existed) charIndex runs slightly short of the stored text it is added
  // to — a few characters over a paragraph, which `snapToWordStart` absorbs.
  // A freshly-imported book re-cleans to itself and the two coincide exactly.
  u.onboundary = (e) => {
    if (myGen !== state.speakGen) return;
    if (typeof e.charIndex !== "number") return;
    sawBoundary = true;
    state.chunkOffset = snapToWordStart(c.text, base + e.charIndex);
  };
  u.onend = advance;
  u.onerror = advance;
  trackOffsetFrom(base);
  synth.speak(u);
  updateProgress();
}

/* ===================== play / pause / stop ===================== */
export function play() {
  if (!state.chunks.length) return;
  // ▶ is a reader who is awake. Without it a thawed page's stale sleep deadline
  // stops the book seconds after the tap.
  noteInteraction();
  // This window is the reader now. Another one may have been left playing — the
  // installed PWA and the tab it came from are two windows, and Piper keeps
  // reading from a hidden page by design — and two readers on one book is the
  // "two readings intertwined" report. Claiming pauses the others — the ones on
  // this origin at once, and one on another origin (the installed shell vs a
  // browser tab) at its next poll. The book is passed because that second half
  // spans devices, where two people reading two different books is not a
  // conflict. See solo.js.
  claimPlayback(state.docKey);
  state.paused = false;
  state.speaking = true;
  setPlaying(true);
  // The SCREEN lock exists because Android suspends the device voice the moment
  // the page hides — a lit screen IS the playback requirement there. Piper plays
  // through a real <audio> element, which the browser keeps running in the
  // background, so holding the screen on would only burn battery for nothing.
  if (!isPiperVoice(selectedVoice())) acquireWake();
  // The KEEP-ALIVE runs under both engines, and under Piper it is the load-
  // bearing one. It is not about throttling there: it is the only sound in flight
  // at a paragraph seam and during a synthesis, and everything outside this page
  // that asks "is audio playing" — the pi-shell's foreground service and the
  // partial wake lock it holds — reads exactly that. Without it the CPU is free
  // to suspend mid-synthesis with the screen off, and the service gives up 15
  // minutes later; measured 2026-07-28, that ended the book at 15 min and took
  // sleep mode's rewind down with it (a frozen page runs no timers).
  startKeepAlive();
  // No status echo here (nor on pause): setStatus now surfaces as a toast while a
  // book is loaded, and a popup on every ▶/⏸ tap is noise — the button already
  // carries that state. The status surface is for things you did NOT do (the
  // auto-advance, a failed download, the sleep timer).
  //
  // `true`: this is a reader's own ▶ (or a seek/step/jump that routes through
  // here), so the Piper synthesis it kicks off gets the blocking overlay — the
  // window where a second tap would otherwise queue a second reader. An
  // auto-advance at a paragraph seam calls speakCurrent() with no flag, so the
  // read-ahead's silent, already-warm seams raise no curtain.
  speakCurrent(true);
}

/**
 * Pause exactly as ⏸ does — silence, freeze the word, persist it.
 *
 * Exported because ⏸ is no longer the only thing that pauses this window:
 * another window claiming playback pauses this one too (see solo.js), and it has
 * to leave the book in the SAME state a tap would, or the reader loses their
 * place in whichever window they come back to.
 *
 * `note` is the reason to show when the pause was not the reader's own doing.
 * `warm` renders the resume word ahead of the next ▶ — right for a real pause,
 * wrong for a window that just lost the book: it would spend the model on audio
 * nobody is waiting for, competing with the window that IS reading.
 */
export function pausePlayback({ note = "", warm = true } = {}) {
  if (!(state.speaking && !state.paused)) return;
  const voiceId = selectedVoice();
  state.paused = true;
  state.speakGen++;
  releasePlayback(); // this window is not the reader any more
  // HOLD the Piper audio rather than tearing it down, so ▶ is a resume and not a
  // re-render — see piper.js#suspendAudio. The device voice has nothing to hold
  // (the OS owns the utterance), so it still silences outright.
  const heldOk =
    isPiperVoice(voiceId) &&
    suspendAudio({
      docKey: state.docKey,
      voiceId,
      idx: state.curChunk,
      off: state.chunkOffset || 0,
    });
  if (!heldOk) cancelAudio();
  // Freeze the word we got to, THEN persist it: saveProgress writes whatever
  // `state.chunkOffset` holds, and ▶ resumes from exactly there.
  stopOffsetTicker();
  saveProgress();
  setPlaying(false);
  releaseWake();
  // A paused book is not playing anything, and now that the keep-alive runs under
  // Piper too, leaving it looping would hold the shell's wake lock and its
  // notification open all night over a book nobody is listening to.
  stopKeepAlive();
  if (note) setStatus(note);
  // Paused is not idle: start rendering the word ▶ would resume on, so the
  // next tap plays instead of waiting on the model.
  if (warm) prewarmResumePoint();
}

export function togglePlayPause() {
  if (!state.chunks.length) return;
  if (state.speaking && !state.paused) pausePlayback();
  else play();
}

export function stopAll(keepAudio) {
  state.speaking = false;
  state.paused = false;
  state.speakGen++;
  releasePlayback();
  cancelAudio();
  stopOffsetTicker();
  setPlaying(false);
  releaseWake();
  if (!keepAudio) stopKeepAlive();
}

/**
 * Re-render the current chunk after a setting changed.
 *
 * For the device voice this is the only way a new rate or volume can take
 * effect, because an utterance freezes both when it is queued. Piper takes them
 * live, so re-rendering would be strictly worse: it would throw away audio that
 * is already correct and stall on a fresh synthesis. So the live path wins when
 * it applies, and the re-speak is the fallback.
 */
export function restartCurrent() {
  if (!(state.speaking && !state.paused)) return;
  if (applyLiveAudio()) return;
  state.speakGen++;
  cancelAudio();
  speakCurrent();
}

/* ===================== paragraph / percentage stepping =====================
 * `stepChunk` is the one reposition that does NOT go through `jumpToChar`, so it
 * carries its own `noteSeek` for the per-night reading log. Stepping a paragraph
 * WHILE PLAYING is what makes that necessary: progresslog's playing gate cannot
 * tell that save apart from the auto-advance one paragraph later — they are the
 * same size, from the same state. */
export function stepChunk(dir) {
  if (!state.chunks.length) return;
  const wasPlaying = state.speaking && !state.paused;
  state.curChunk = Math.max(0, Math.min(state.chunks.length - 1, state.curChunk + dir));
  state.chunkOffset = 0;
  state.speakGen++;
  cancelAudio();
  noteSeek(state.docKey); // ⏮/⏭ is a seek, not listening — see below
  saveProgress();
  updateProgress();
  if (wasPlaying) {
    play();
  } else {
    state.speaking = false;
    state.paused = false;
    setPlaying(false);
    prewarmResumePoint(); // stepped while stopped → warm where ▶ now lands
  }
}

function jumpToChar(charIndex) {
  charIndex = Math.max(0, Math.min(charIndex, state.charTotal));
  state.curChunk = chunkAtChar(charIndex);
  state.chunkOffset = 0;
  state.speakGen++;
  cancelAudio();
  // Every deliberate move through the book funnels through here, and the save
  // below is the one that would look like a huge burst of "reading" to the
  // per-night log. Tell the log to skip it: skipping a chapter is navigation,
  // not minutes listened. (The sleep rewind books its own −minutes first, in
  // rewindMinutes, before landing here.)
  noteSeek(state.docKey);
  saveProgress();
  updateProgress();
}

export function jumpAndMaybePlay(charIndex, forcePlay) {
  const wasPlaying = state.speaking && !state.paused;
  jumpToChar(charIndex);
  if (wasPlaying || forcePlay) {
    play();
  } else {
    state.speaking = false;
    state.paused = false;
    setPlaying(false);
    prewarmResumePoint(); // seek/rewind while stopped → warm the new landing spot
  }
}

export function jumpToPct(pct, forcePlay) {
  // Percentages map onto the body span, so a "50%" or random jump never lands
  // in the skipped front/back matter.
  const start = state.bodyStartChar || 0;
  const end = state.bodyEndChar || state.charTotal;
  const span = end - start;
  const char = span > 0 ? start + (span * pct) / 100 : (state.charTotal * pct) / 100;
  jumpAndMaybePlay(Math.round(char), forcePlay);
}

export function jumpToPage(page, forcePlay) {
  // `page` is body-numbered, like the readout: page 1 is the first real chapter.
  const { first, count } = bodyPageSpan();
  const abs = first + Math.max(1, Math.min(page, count)) - 1;
  const char = Math.max(state.pageCharStarts[abs] ?? 0, state.bodyStartChar || 0);
  jumpAndMaybePlay(char, forcePlay);
}

/**
 * Rewind the current book by `mins` minutes of listening at the CURRENT speed
 * (the "sleep rewind": you dozed off, so step back to before you stopped taking
 * it in). Words covered = wpm(at this rate) × mins, converted to characters via
 * the book's own average chars-per-word. Repositions only — never auto-plays —
 * so the morning tap on ▶ resumes ~`mins` earlier.
 *
 * `ts` is the instant the rewind is ACCOUNTED to, defaulting to now. It is a
 * parameter because the night can be reconciled hours after it ended, and the log
 * buckets by timestamp.
 */
export function rewindMinutes(mins, ts = Date.now()) {
  if (!state.chunks.length || !(mins > 0)) return;
  const rate = Number.parseFloat($("rate").value) || 1;
  const words = BASE_WPM * rate * mins;
  const cpw = state.totalWords > 0 ? state.charTotal / state.totalWords : 6;
  const target = Math.max(0, curCharPos() - words * cpw);
  // Book the rewind in the per-night log before moving: this is the "−15" the
  // morning readout is for, and it is the ONLY thing that ever fills that
  // column — a plain backward seek is navigation and stays uncounted.
  noteRewind(state.docKey, mins, ts);
  jumpAndMaybePlay(Math.round(target), false);
}

/* ===================== rate / volume ===================== */
export function showRate() {
  const pct = `${Math.round(Number.parseFloat($("rate").value) * 100)}%`;
  const rv = $("rateVal"); // legacy on-screen ⚡ row (removed from the player view)
  if (rv) rv.textContent = pct;
  const m = $("rateModalVal"); // modal header badge (present once the modal exists)
  if (m) m.textContent = pct;
  // The main-page chip rides here rather than on its own listener: every path
  // that moves the speed (slider, ±%, preset, synced pull) already calls this.
  const c = $("chipRate");
  if (c) c.textContent = `⚡ ${pct}`;
}
export function stepRate(deltaPct) {
  const r = $("rate");
  const min = Number.parseFloat(r.min);
  const max = Number.parseFloat(r.max);
  let v = Math.round((Number.parseFloat(r.value) + deltaPct / 100) * 100) / 100;
  v = Math.max(min, Math.min(max, v));
  r.value = v;
  showRate();
  updateTimeDisplay();
}
export function showVol() {
  const pct = `${Math.round(Number.parseFloat($("vol").value) * 100)}%`;
  $("volVal").textContent = pct;
}
export function stepVol(delta) {
  const v = $("vol");
  let x = Math.round((Number.parseFloat(v.value) + delta) * 100) / 100;
  x = Math.max(0, Math.min(VOL_MAX, x));
  v.value = x;
  showVol();
  // Piper takes the new level live; the device voice can only pick it up on the
  // next utterance, so there it re-speaks from the current offset.
  if (state.speaking && !state.paused) restartCurrent();
}

/* ===================== progress + time display ===================== */

/**
 * Reflect the current reading position in the chapter <select> so the picker
 * shows where we are instead of staying on "— Selecciona capítulo —". The label
 * is updated via `dd:sync` (see ui.js) — NOT a `change` event, which would loop
 * back through gotoChapter and jump the reader.
 */
function syncChapterSelect() {
  const sel = $("chapter");
  const chs = state.chapters;
  if (!sel || !chs.length) return;
  // Use the END of the current chunk, not its start. A paragraph can straddle a
  // chapter boundary, so the chunk we're speaking often STARTS in the previous
  // chapter — matching on its start then lags the picker one (or, with front
  // matter skipped, lands it on a greyed entry) chapter behind. A chapter counts
  // as current once it begins anywhere before this chunk ends. Fixes "el
  // desplegable muestra uno o dos capítulos anteriores".
  const chunk = state.chunks[Math.min(state.curChunk, state.chunks.length - 1)];
  const upto = chunk ? chunk.end : curCharPos() + 1;
  let idx = 0;
  for (let i = 0; i < chs.length; i++) {
    if (chs[i].charIndex < upto) idx = i;
    else break;
  }
  // Don't let the picker point past the body into trailing skipped matter (the
  // last body paragraph's chunk can reach into the first back-matter chapter):
  // if we landed on a skipped entry, step back to the nearest real chapter.
  const skip = state.chapterSkipped || [];
  while (idx > 0 && skip[idx]) idx--;
  const val = String(idx);
  if (sel.value !== val) sel.value = val;
  sel.dispatchEvent(new Event("dd:sync"));
}

export function updateProgress() {
  const pct = curPct();
  $("progBar").style.width = `${pct}%`;
  $("pctNow").textContent = pct.toFixed(0);
  // Pages are counted over the body, matching the % bar and the clock: the
  // skipped front/back matter is not text you will hear, so it is not a page.
  $("pageInfo").textContent = `Página ~${curBodyPageNum()}/${bodyNumPages()}`;
  syncChapterSelect();
  updateTimeDisplay();
  // The tab strip was removed; update its per-doc % only if it's present.
  const tabsEl = $("tabs");
  if (tabsEl && state.active >= 0) {
    const tab = tabsEl.children[state.active];
    if (tab) {
      const pp = tab.querySelector(".pp");
      if (pp) pp.textContent = `${docPct(state.docs[state.active])}%`;
    }
  }
}

/**
 * Listening-time model over the BODY span only, so a clock reads "how long is
 * the book itself" and ignores the skipped front/back matter.
 */
function bodyTimeModel() {
  const rate = Number.parseFloat($("rate").value) || 1;
  const wpm = BASE_WPM * rate;
  const wb = state.wordsBefore;
  const last = wb.length - 1;
  const clamp = (n) => Math.max(0, Math.min(n, last));
  const startChunk = state.bodyStartChar ? chunkAtChar(state.bodyStartChar) : 0;
  const endChunk = state.bodyEndChar ? chunkAtChar(state.bodyEndChar) : state.chunks.length;
  const startWords = wb[clamp(startChunk)] || 0;
  const endWords = state.bodyEndChar ? wb[clamp(endChunk)] || state.totalWords : state.totalWords;
  return { wpm, wb, clamp, startWords, bodyWords: Math.max(0, endWords - startWords) };
}

/** Seconds listened at `chunkIdx`, and the body's total, at the current speed. */
function secsAtChunk(chunkIdx) {
  const { wpm, wb, clamp, startWords, bodyWords } = bodyTimeModel();
  const idx = clamp(Math.min(chunkIdx, state.chunks.length));
  const doneWords = Math.max(0, Math.min((wb[idx] || 0) - startWords, bodyWords));
  return { curSec: (doneWords / wpm) * 60, totalSec: (bodyWords / wpm) * 60 };
}

/**
 * The same clock, at an ARBITRARY body percentage — the 📍 Posición head's
 * preview while the slider is dragged. `pct` maps onto the body span exactly
 * the way jumpToPct does, so the previewed time is the time you land on.
 */
export function secsAtPct(pct) {
  if (!state.chunks.length) return { curSec: 0, totalSec: 0 };
  const p = Math.max(0, Math.min(100, pct));
  const start = state.bodyStartChar || 0;
  const end = state.bodyEndChar || state.charTotal;
  const span = end - start;
  const char = span > 0 ? start + (span * p) / 100 : (state.charTotal * p) / 100;
  return secsAtChunk(chunkAtChar(Math.round(char)));
}

export function updateTimeDisplay() {
  const { curSec, totalSec } = secsAtChunk(state.curChunk);
  $("timeInfo").textContent = `⏱ ${fmtTime(curSec)} / ${fmtTime(totalSec)}`;
}
