/**
 * Piper — neural voice synthesised IN THE PAGE, played through a real <audio>.
 *
 * The other engine this app has is the Android device voice, and it has two
 * limits nothing can work around: the OS renders it outside the page, so the
 * browser can neither amplify it past 100% nor keep it speaking once the page
 * is hidden. Piper produces WAV bytes we own, which fixes both — the audio goes
 * through a WebAudio compressor + gain (so >100% is real, not a lie), and a
 * media element keeps playing with the screen off.
 *
 * Everything runs locally: the model lives in OPFS after the first download and
 * inference is WASM. No request per paragraph, so it works offline, which is
 * the whole reason it is in-browser and not on the Pi.
 *
 * WHAT THIS MODULE OWNS
 *  - the worker that holds the ONNX session (one voice at a time),
 *  - the synthesis cache + read-ahead, so playback never waits on the model,
 *  - the audio graph and the playback controls the player drives.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *  - where we are in the book (player.js/progress.js), and
 *  - any transport handler. The MediaSession layer stays deleted; see
 *    tests/audiobooks-no-mediasession.test.js for why.
 *
 * NOTHING HEAVY ON THE MAIN THREAD. Synthesis is two long synchronous WASM
 * calls, so it runs in js/piper-worker.js. A blocked main thread does not stop
 * audio that is already playing, but it does stop the HANDOVER — `ended` →
 * advance → play() are main-thread callbacks — so a paragraph finishing during
 * a synthesis used to wait for it. That was the gap between paragraphs, and it
 * grew worse with speed: shorter paragraphs end more often inside a synthesis
 * window. See the worker's header.
 *
 * THE PAUSES ARE IN THE AUDIO. Piper renders sentence punctuation as real
 * silence — measured, 0.6 to 1.6 seconds per full stop, a quarter to a third of
 * every paragraph. `capSilence` (js/piper-trim.js) cuts every one of them to a
 * word space on the way out of the engine, which is the only reason this reads
 * at a listenable pace. See that file for the numbers.
 *
 * ONE SYNTHESIS AT A TIME. `queue` below serialises requests and lets a
 * paragraph we are waiting on jump ahead of the read-ahead. Firing several at
 * once bought nothing — they contend for the same single WASM thread — while
 * making the wait for the one that mattered unpredictable.
 *
 * ...so the WASM thread count is the lever that matters, and it is not set
 * here. The vendored library already asks for every core (`ort.env.wasm
 * .numThreads = navigator.hardwareConcurrency`), but onnxruntime-web can only
 * honour that when `crossOriginIsolated` is true, which needs the COOP+COEP
 * pair the Caddyfile sets on /main/audiobooks*. Miss them and ORT clamps to one
 * thread SILENTLY — the symptom is not an error, it is a pause at a paragraph
 * seam, because `pump()` cannot preempt a running job: a paragraph that ends
 * while a speculative read-ahead is mid-render waits for that render to finish
 * before its own urgent one begins. `warnIfNotIsolated` below is the only thing
 * standing between that regression and a listener wondering why it got slow.
 *
 * NO GAP AT THE SEAM. Two <audio> elements share the graph: the next paragraph
 * is loaded and decoded into the standby element while the current one plays,
 * so advancing is a swap, not a fetch-and-decode.
 *
 * ...AND NO GAP AT A PAUSE. ⏸ HOLDS the playing element rather than tearing its
 * source down (`suspendAudio`), so ▶ is a `play()` on audio that is still
 * decoded and still positioned — see the reasoning there. What a pause cannot
 * hold, a seek covers: a paragraph is rendered whole and a mid-paragraph start
 * seeks into that single rendering, so the resume word never turns a warm
 * paragraph into a fresh synthesis.
 *
 * THE BUFFER IS BUILT WHILE NOBODY IS LISTENING. `readAhead` covers the playing
 * case; `precache` covers the far commoner one — a book open and stopped, which
 * is where the reader is standing every time they press ▶. Both abandon
 * themselves the moment playback needs the engine, and the cache evicts by
 * DISTANCE from the playhead, never by insertion order: a look-ahead buffer's
 * oldest entry is the paragraph about to be played.
 *
 * PITCH. Accelerating a rendered WAV by resampling raises the pitch — at 200%
 * the reader sounds like a cartoon squirrel. `preservesPitch` makes the browser
 * time-stretch instead, so speed and tone are independent. It is on by default
 * in modern browsers; it is set explicitly anyway because a silent regression
 * here is the single most audible way this engine can break.
 *
 * SPEED IS NOT `length_scale`. Piper can render faster natively, but it does
 * not scale linearly: VITS rounds each phoneme's duration UP to a whole frame,
 * so short phonemes hit a floor and stop compressing — measured, asking for 2x
 * yields about 1.3x. Trusting the request would mean believing we were feeding
 * a 200% read while actually serving 133%, and the read-ahead would drain. So
 * the speed control is `playbackRate` alone: exact by construction, adjustable
 * mid-paragraph, and free.
 */

import { speechTextFrom } from "./cleanForSpeech.js";
import {
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  MAX_PRECACHE_CHUNKS,
  MAX_READAHEAD_CHUNKS,
  PIPER_BASE_URL,
  PIPER_VOICES,
  PREBUFFER_CHARS,
  PRECACHE_CHARS,
  READAHEAD_CHARS,
} from "./config.js";
import { setStatus } from "./dom.js";
import {
  MODULATION_DEFAULT,
  modulation,
  softClipCurve,
} from "./modulation.js";
import { capSilence } from "./piper-trim.js";

// How many pauses this chunk ASKED FOR. The sentence stop is the chunk boundary,
// so only the marks inside it count.
const clauseMarks = (text) => (String(text).match(/[,;:…—–()"«»]/g) || []).length;

/** Is `id` one of our voices? Guards a stale/synced value from another build. */
export const isPiperVoice = (id) => PIPER_VOICES.some((v) => v.id === id);

/* ===================== the native engine, where there is one ===================== */

/**
 * THE SAME PIPER, RENDERED OUTSIDE THE WEBVIEW.
 *
 * Everything below this section is unchanged and stays in charge: the cache, the
 * queue and its urgent lane, the silence trim, the read-ahead, the double buffer,
 * the audio graph. Only the one call that turns text into WAV bytes can be
 * answered by somebody else.
 *
 * WHY IT HAS TO BE. onnxruntime-web needs `crossOriginIsolated` to use more than
 * one wasm thread, and under pi-shell on Android it can never have it — measured
 * over CDP with COOP and COEP both arriving on the response: `crossOriginIsolated`
 * false, `SharedArrayBuffer` undefined, eight cores idle. The cause is structural
 * rather than a missing header (every response on that origin comes out of
 * `shouldInterceptRequest`, and an intercepted response is not the network
 * stack's), so no header can fix it. One thread measured on that phone, on real
 * prose: `carlfm-x_low` RTF 2.6–2.9, `davefx-medium` 1.6–1.8 and as low as 1.0
 * when the phone is busy — against a reader that plays at 1.8–2.0x. Synthesis
 * must sustain RTF ≥ the playback rate or the read-ahead drains and every seam is
 * a wait, so the good voice was unusable and the fast one had no margin.
 *
 * `window.__PI_TTS__` is the shell's doorway to sherpa-onnx, which runs the same
 * VITS models with the same espeak-ng phonemisation on real threads. See the
 * shell's `tts.rs`.
 *
 * WHAT THIS IS NOT: a replacement. It is an *acceleration*, and everything it
 * cannot answer falls through to the worker below — a browser tab, the desktop
 * shell, a voice sherpa has no build for, a device where the model has not
 * downloaded. That is why the wasm engine is still here in full.
 */
const nativeApi = () => globalThis.__PI_TTS__ || null;

/** The capability answer, asked once. Never the install list — that changes. */
let nativeCaps = null;
let nativeProbe = null;

/**
 * Native failures in a row. A model that vanished, a plugin that stopped
 * answering — one is worth retrying, a run of them means the native engine is not
 * coming back this session and every paragraph would pay a failed round trip
 * before falling back anyway.
 */
let nativeStrikes = 0;
let nativeDown = false;
const NATIVE_MAX_STRIKES = 3;

function nativeFailed(op, error) {
  nativeStrikes += 1;
  if (nativeStrikes >= NATIVE_MAX_STRIKES && !nativeDown) {
    nativeDown = true;
    console.warn(
      `[piper] motor nativo descartado tras ${nativeStrikes} fallos (${op}: ` +
        `${error?.message || error}) → el resto de la sesión sintetiza en wasm.`,
    );
  }
}

/** Ask the shell what it can speak with. `null` when there is no shell. */
function nativeCapabilities() {
  const api = nativeApi();
  if (!api || nativeDown) return Promise.resolve(null);
  if (nativeCaps) return Promise.resolve(nativeCaps);
  if (!nativeProbe) {
    nativeProbe = api
      .state("")
      .then((state) => {
        // A shell that has the doorway but no engine behind it — the desktop
        // build, or an Android build whose plugin never registered — answers
        // `supported: false`, and that is a final answer, not an error.
        nativeCaps = {
          supported: Boolean(state?.supported),
          ids: new Set((state?.voices || []).map((v) => v.id)),
        };
        return nativeCaps;
      })
      .catch((e) => {
        // A doorway that throws on the capability question is one we cannot use;
        // it does not count as a strike, because nothing was rendered.
        console.warn(`[piper] el shell no respondió a __PI_TTS__.state: ${e?.message || e}`);
        nativeCaps = { supported: false, ids: new Set() };
        return nativeCaps;
      });
  }
  return nativeProbe;
}

/**
 * Voices this session has SEEN installed, so the render path does not ask the
 * shell before every paragraph. A local round trip is milliseconds, but it is
 * milliseconds on the hop that is holding up the audio, once per paragraph, for
 * the whole of a book — and the answer only ever changes in one direction.
 */
const nativeReady = new Set();

const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long a download may make no progress at all before it is given up on. */
const NATIVE_INSTALL_STALL_MS = 120000;

/**
 * Download a model, reporting the percentage while it runs.
 *
 * THE DOWNLOAD IS NOT THE REQUEST WE WAIT ON, and it cannot be: **a fetch from an
 * app page to the shell dies at 30 seconds on Android.** Measured on the phone —
 * a 13 MB model came back `Failed to fetch` at 30018 ms while the shell went on
 * and finished it perfectly well, leaving the reader told the voice had failed
 * and the shell holding the voice. A 23 MB model over a phone link is about a
 * minute, so this is the normal case rather than an edge one.
 *
 * So `install()` only STARTS it (the shell's `claim` makes that idempotent, so
 * polling cannot spawn a second download) and the percentage is polled. That the
 * poll is also the only channel for progress is a happy accident of the same
 * constraint: a shell cannot push anything to a page mid-request.
 *
 * IT GIVES UP ON A DOWNLOAD THAT HAS STOPPED MOVING, rather than on a clock. A
 * model on a slow link is legitimately minutes, and any fixed deadline generous
 * enough for that is too long to be a diagnosis; `pct` not having moved for two
 * minutes is the same statement without the guesswork.
 *
 * The model-fetch bookkeeping is the same one the worker path keeps, so the
 * offline EPUB buffer still stands aside for a voice download — see
 * `noteModelFetch`. Tens of megabytes only ever arrive at the moments the app can
 * least afford to split the link.
 */
async function nativeInstall(voiceId, onProgress, job) {
  const api = nativeApi();
  noteModelFetch(job);
  try {
    await api.install(voiceId);
    let pct = -1;
    let movedAt = Date.now();
    for (;;) {
      const state = await api.state(voiceId);
      if ((state?.installed || []).includes(voiceId)) {
        if (onProgress) onProgress(100);
        return;
      }
      const progress = state?.progress || {};
      if (progress.error) throw new Error(progress.error);
      if (!progress.installing) {
        // Not installed, not installing: the shell dropped it without saying why.
        throw new Error("la descarga se detuvo");
      }
      if (progress.pct !== pct) {
        pct = progress.pct;
        movedAt = Date.now();
        if (onProgress && pct > 0) onProgress(pct);
      } else if (Date.now() - movedAt > NATIVE_INSTALL_STALL_MS) {
        throw new Error(`la descarga se quedó en ${pct}%`);
      }
      await nap(500);
    }
  } finally {
    releaseModelFetch(job);
  }
}

/**
 * Run one job on the native engine. Throws if it cannot, so `callEngine` can fall
 * through to the worker with the reason.
 */
async function runNative(op, { voiceId, text }, onProgress) {
  const api = nativeApi();
  if (op === "stored") {
    const installed = (await api.state("")).installed || [];
    installed.forEach((id) => nativeReady.add(id));
    return installed;
  }
  if (op === "ensure") {
    await nativeEnsureModel(voiceId, onProgress);
    return null;
  }
  // `predict`. The model has to be here before the first paragraph can be
  // rendered, and a reader who changed voice in the settings and pressed ▶ never
  // went through `prefetchVoice` — so this covers it rather than failing.
  await nativeEnsureModel(voiceId, onProgress);
  return api.speak(voiceId, text);
}

/** Have the model, downloading it if this device has never used the voice. */
async function nativeEnsureModel(voiceId, onProgress) {
  if (nativeReady.has(voiceId)) return;
  const installed = (await nativeApi().state(voiceId)).installed || [];
  installed.forEach((id) => nativeReady.add(id));
  if (nativeReady.has(voiceId)) return;
  await nativeInstall(voiceId, onProgress, {});
  nativeReady.add(voiceId);
}

/**
 * The one seam. Native first where there is a native engine that knows this
 * voice, the worker (and its own inline fallback) everywhere else and whenever
 * the native side fails.
 *
 * A FAILED NATIVE JOB IS RETRIED ON WASM, not surfaced. The reader asked for a
 * paragraph, and "the shell could not open the model" is not an answer to that
 * question when there is a second engine sitting right here that can. It is
 * logged, it counts as a strike, and after `NATIVE_MAX_STRIKES` the session stops
 * asking — see `nativeFailed`.
 */
async function callEngine(op, payload, onProgress) {
  if (!nativeDown) {
    const caps = await nativeCapabilities();
    // `stored` is a question about the engine, not about a voice, so it is the
    // one op that does not need the catalogue to contain anything in particular.
    const usable =
      caps?.supported && (op === "stored" || caps.ids.has(payload?.voiceId || ""));
    if (usable) {
      try {
        return await runNative(op, payload, onProgress);
      } catch (error) {
        console.warn(`[piper] motor nativo falló (${op}): ${error?.message || error}`);
        nativeFailed(op, error);
        // A voice whose model went missing must be re-checked, not assumed.
        nativeReady.delete(payload?.voiceId);
      }
    }
  }
  return callWorker(op, payload, onProgress);
}

/**
 * Is this session rendering natively? Diagnosis seam — the difference between
 * "slow because it is on one wasm thread" and "slow for some other reason" is the
 * first thing to establish, and it is otherwise invisible from the page.
 */
export function engineInUse() {
  if (nativeDown || !nativeCaps?.supported) return "wasm";
  return workerDead ? "native (wasm inline de reserva)" : "native";
}

/* ===================== the synthesis worker ===================== */

let worker = null;
let inlineLib = null; // fallback path: the library on this thread
// Latched once the worker is unusable (hung script, crash, or a context that
// refuses to create one). Kept SEPARATE from `inlineLib` because `callInline`
// overwrites `inlineLib` with the loaded module the first time it runs — so
// overloading it as the "don't use the worker" signal let the next call respawn
// the worker and hang again. This flag sticks, so once we fall back we stay
// inline for the session.
let workerDead = false;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, onProgress, model}

/* ===================== "a voice model is on the wire" ===================== */

/**
 * How many jobs are pulling a voice MODEL right now, and who is waiting for that
 * to stop.
 *
 * A model is tens of megabytes, and it only ever downloads at the moments the
 * app is least able to share the link: the first ▶ of a session, or the
 * `prewarmResumePoint` that fires the instant a book is restored at boot. That
 * is exactly when the offline buffer also wakes up and starts pulling EPUBs.
 * Both are "background" work from their own side, and neither knew about the
 * other, so on a phone they split the bandwidth and the reader waits twice as
 * long for the one thing they asked for — the voice.
 *
 * A progress event IS the download: the worker only emits them while pulling the
 * model (see piper-worker.js), so no extra protocol is needed to detect one. The
 * flag clears when the job settles, which makes it self-healing — a worker that
 * dies rejects its pending jobs and releases every waiter with it.
 */
let modelFetches = 0;
let modelIdleWaiters = [];

/** A job just reported download progress ⇒ it is pulling a model. Idempotent. */
function noteModelFetch(job) {
  if (!job || job.model) return;
  job.model = true;
  modelFetches++;
}

/** A job settled: if it had been pulling a model, release the waiters. */
function releaseModelFetch(job) {
  if (!job || !job.model) return;
  job.model = false;
  modelFetches = Math.max(0, modelFetches - 1);
  if (modelFetches === 0) {
    const waiters = modelIdleWaiters;
    modelIdleWaiters = [];
    waiters.forEach((r) => r());
  }
}

/** True while a voice model is being downloaded. */
export function voiceModelInFlight() {
  return modelFetches > 0;
}

/**
 * Resolves once no voice model is downloading — immediately when none is. For
 * background work that can afford to wait (the offline book buffer) and should,
 * so the voice the reader is waiting on gets the whole link.
 */
export function whenVoiceModelIdle() {
  if (modelFetches === 0) return Promise.resolve();
  return new Promise((res) => modelIdleWaiters.push(res));
}

/**
 * Spawn the worker, once. A browser without module workers (or a context that
 * refuses to create one) falls back to synthesising on this thread: slower and
 * janky, but a working voice beats no voice.
 */
/**
 * Say so, once, when this page is NOT cross-origin isolated.
 *
 * Deliberately load-bearing noise. Losing isolation costs a multiple of the
 * synthesis speed and produces no error of its own, so the only evidence left
 * is a pause the listener has to notice and report — which is exactly how this
 * was found in the first place.
 *
 * Two contexts where it is EXPECTED and there is nothing to fix: the ?lan=1
 * http face, which cannot be isolated at all, and pi-shell on Android, where it
 * is a platform limit rather than a policy — the shell does send both headers
 * (the page can read them back off its own response) and WebView still reports
 * `crossOriginIsolated` false, because it does not site-isolate arbitrary
 * origins. Measured on a moto g34: false under the shell, true in Chrome on the
 * same phone and the same page.
 *
 * Anywhere else it is a regression: the Caddyfile headers stopped arriving, or a
 * new cross-origin subresource without CORP got added to the page and the
 * browser dropped isolation rather than block it.
 */
let isolationWarned = false;
function warnIfNotIsolated() {
  if (isolationWarned || globalThis.crossOriginIsolated) return;
  isolationWarned = true;
  console.warn(
    "[piper] crossOriginIsolated=false → onnxruntime-web is clamped to ONE WASM " +
      "thread and synthesis will be several times slower (audible as a pause at " +
      "paragraph seams). Expected on the ?lan=1 http face and under pi-shell on " +
      "Android (WebView cannot be isolated, headers or no headers); anywhere " +
      "else, check the COOP/COEP headers on /main/audiobooks* in the Caddyfile.",
  );
}

// The module-worker SCRIPT request can hang indefinitely: Chrome does NOT route
// it through the service-worker cache (it carries no `sw` tag in the waterfall),
// so a worker that is precached still depends on a live network fetch, and when
// that pends the worker never inits — `callWorker` posts into the void and
// `synthesize`'s promise never settles. That was the permanent "⏳ Generando
// voz…". This watchdog bounds it: the worker posts a `{type:"booted"}` ping the
// instant its script runs (see piper-worker.js), so a healthy worker proves
// itself in well under a second; if nothing arrives by the deadline the script
// is hung and the whole engine falls back to the main-thread inline path. The
// deadline is generous because the ping fires BEFORE the heavy vendor import, so
// it can only ever trip on a script that never ran — never a slow first render.
const WORKER_INIT_TIMEOUT_MS = 8000;
let workerProvenAlive = false;
let workerInitTimer = null;

function clearWorkerInitTimer() {
  if (workerInitTimer) {
    clearTimeout(workerInitTimer);
    workerInitTimer = null;
  }
}

// Post-boot stall watchdog. The init watchdog above only covers a worker whose
// SCRIPT never runs; the instant `{type:"booted"}` lands it is disarmed. But a
// worker that boots and THEN wedges — stuck in the heavy vendor import, or inside
// `predict()` on the single WASM thread — strands its in-flight job's promise
// just as permanently, and because `pump` runs one job at a time, the whole queue
// behind it never advances either. That is the same terminal "⏳ Generando voz…",
// only past boot, so the init watchdog can't see it. So every dispatched job
// carries its OWN deadline: if it neither settles nor reports progress in time,
// the worker is treated as hung and every pending job is replayed inline — the
// exact recovery `failWorkerToInline` already does for a boot failure.
//
// Progress-gated: a voice model is tens of MB and can legitimately take longer
// than any fixed deadline to pull, so each progress event RE-ARMS the timer —
// only a job that goes fully silent trips it. Inference emits no progress, so the
// deadline is deliberately generous: it must clear the slowest single-paragraph
// render on the slowest (non-isolated, one-thread) device, because a false trip
// drops the whole session to the slower main-thread path, whereas a real hang
// costs only this one deadline before the fallback takes over.
// ...AND IT MUST SCALE WITH THE TEXT, because a flat number cannot be both. The
// deadline was 30 s flat, and 30 s is a real render here: measured on a moto g34
// under pi-shell (one WASM thread — WebView cannot be cross-origin isolated), the
// engine sustains RTF 1.0–1.8 with `es_ES-davefx-medium`, i.e. roughly 20 chars of
// text per second of rendering. A 702-char paragraph of the open book took 29.4 s
// — SIX HUNDRED MILLISECONDS under the deadline meant to catch a hang, and the
// same book holds 29 chunks longer than that. Every one of them would have been
// read as a wedged worker: terminated mid-render, `workerDead` latched, the whole
// remaining session demoted to the slower main-thread path. The chunk cap
// (pdf.js#capLength) stops those chunks from existing; this stops the deadline
// from being a lie about how long honest work takes.
//
// 150 ms/char is that measured ~50 ms/char with a 3× margin, the same shape of
// allowance `INLINE_STALL_FACTOR` makes below and for the same reason: a false
// trip costs the whole session, a true hang costs one deadline.
const WORKER_STALL_TIMEOUT_MS = 30000;
const STALL_MS_PER_CHAR = 150;

function stallTimeoutMs(chars = 0) {
  // `__PIPER_STALL_TIMEOUT_MS` is a test hook (drives the watchdog in ms); real
  // clients never set it and get the full deadline. It overrides the per-char
  // budget outright — a test that wants a 30 ms deadline means 30 ms.
  const hook = Number(globalThis.__PIPER_STALL_TIMEOUT_MS);
  if (hook) return hook;
  return Math.max(WORKER_STALL_TIMEOUT_MS, Math.round(chars * STALL_MS_PER_CHAR));
}

/** How much text a job carries, so its deadline can be sized to it. */
const jobChars = (job) => job?.payload?.text?.length || 0;

function armStall(job) {
  clearStall(job);
  job.stallTimer = setTimeout(() => {
    // This job — and everything queued behind it — is wedged on a booted-then-
    // hung worker. Same recovery as a boot failure: tear it down, replay inline.
    failWorkerToInline(`job de ${jobChars(job)} caracteres sin respuesta`);
  }, stallTimeoutMs(jobChars(job)));
}

function clearStall(job) {
  if (job && job.stallTimer) {
    clearTimeout(job.stallTimer);
    job.stallTimer = null;
  }
}

/**
 * The worker never came alive within the init deadline (a hung module-worker
 * script). Retarget every job waiting on it at the inline main-thread library
 * instead of rejecting them — the user picked this voice, and a slower
 * main-thread render beats a dead worker's error (and the permanent "Generando
 * voz" it caused). `workerDead` stops `ensureWorker` from re-spawning a worker
 * that would only hang the same way, so we stay inline for the rest of the
 * session.
 *
 * AND IT SAYS SO. This is a one-way door — every later paragraph renders on the
 * main thread, slower and blocking the seam handover — and until now it happened
 * in complete silence, which is why a session that had fallen back was
 * indistinguishable from a device that was merely slow. `why` names what tripped
 * it, so the next report comes with its own diagnosis.
 */
function failWorkerToInline(why = "arranque del worker") {
  console.warn(
    `[piper] worker descartado (${why}) → el resto de la sesión sintetiza en el ` +
      "hilo principal: más lento y bloquea el relevo entre párrafos.",
  );
  clearWorkerInitTimer();
  const jobs = [...pending.values()];
  pending.clear();
  try {
    if (worker) worker.terminate();
  } catch (_) {}
  worker = null;
  workerDead = true;
  for (const job of jobs) {
    clearStall(job);
    releaseModelFetch(job);
    callInline(job.op, job.payload, job.onProgress).then(job.resolve, job.reject);
  }
}

function ensureWorker() {
  if (worker || workerDead) return worker;
  warnIfNotIsolated();
  try {
    worker = new Worker(new URL("./piper-worker.js", import.meta.url), {
      type: "module",
    });
    workerProvenAlive = false;
    // `__PIPER_INIT_TIMEOUT_MS` is a test hook (drives the watchdog in ms); real
    // clients never set it and get the full deadline.
    const initMs = Number(globalThis.__PIPER_INIT_TIMEOUT_MS) || WORKER_INIT_TIMEOUT_MS;
    workerInitTimer = setTimeout(() => {
      if (workerProvenAlive) return; // it answered in time
      failWorkerToInline();
    }, initMs);
    worker.onmessage = (ev) => {
      const { id, type, pct, ok, value, error } = ev.data || {};
      // ANY message proves the script loaded — cancel the watchdog. The worker
      // sends `{type:"booted"}` before its heavy import for exactly this.
      if (!workerProvenAlive) {
        workerProvenAlive = true;
        clearWorkerInitTimer();
      }
      if (type === "booted") return; // liveness ping only, no job attached
      const job = pending.get(id);
      if (!job) return;
      if (type === "progress") {
        noteModelFetch(job); // only a model download reports progress
        armStall(job); // progress ⇒ still alive; push the stall deadline out
        if (job.onProgress) job.onProgress(pct);
        return;
      }
      pending.delete(id);
      clearStall(job);
      releaseModelFetch(job);
      if (ok) job.resolve(value);
      else job.reject(new Error(error || "synthesis failed"));
    };
    worker.onerror = () => {
      // The worker died (a bad import, an OOM). Fail everything waiting rather
      // than leaving the player hanging on a promise that can never settle.
      clearWorkerInitTimer();
      for (const [, job] of pending) {
        clearStall(job);
        releaseModelFetch(job); // …and never strand whoever deferred to it
        job.reject(new Error("worker caído"));
      }
      pending.clear();
      worker = null;
      workerDead = true;
    };
  } catch (_) {
    worker = null;
    workerDead = true;
  }
  return worker;
}

/** The fallback path's session, mirroring the worker's own state. */
let inlineSession = null;
let inlineVoice = "";

// The inline path's own deadline, and the LAST one in the system: a worker that
// hangs falls back to inline, and until this existed nothing watched inline. Any
// await in `callInline` that never settled — and there was a real one, an engine
// piece fetched from a CDN with no connection to reach it — stranded the job
// forever. `pump` runs one job at a time and clears `running` in a `.finally`, so
// that one job also froze every synthesis queued behind it for the rest of the
// session, and `speakPiper`'s curtain (released in ITS `finally`) stayed up. That
// is the permanent "Generando voz…" with no error and no way out but a restart.
//
// Progress re-arms it, exactly like the worker's stall watchdog: a voice model is
// tens of MB and must be allowed to take as long as it takes. Only silence trips
// it.
//
// LONGER than the worker's deadline, deliberately. A worker that trips falls back
// to inline and the reader still gets their voice; inline tripping is terminal
// for that paragraph, so a false trip costs more here than there — while a true
// hang was infinite, so any finite number is an improvement.
const INLINE_STALL_FACTOR = 3;

/**
 * Run `work` under a progress-gated deadline. `work` is handed the progress
 * callback it must report through; every call re-arms the clock.
 */
function withInlineDeadline(work, onProgress, chars = 0) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const disarm = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const arm = () => {
      disarm();
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("la voz no respondió"));
      }, stallTimeoutMs(chars) * INLINE_STALL_FACTOR);
    };
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      disarm();
      fn(value);
    };
    arm();
    work((pct) => {
      arm();
      if (onProgress) onProgress(pct);
    }).then(settle(resolve), settle(reject));
  });
}

function callInline(op, payload, onProgress) {
  // The model-fetch bookkeeping is created HERE rather than inside `runInline`,
  // so a job the deadline gives up on still releases whoever deferred to it. The
  // hung promise may settle later and release the same job again; that is
  // idempotent (`releaseModelFetch` checks the flag), and the alternative is an
  // offline book buffer that waits for a download nobody is doing any more.
  const job = {};
  return withInlineDeadline(
    (progress) => runInline(op, payload, progress, job),
    onProgress,
    payload?.text?.length || 0,
  ).catch((e) => {
    releaseModelFetch(job);
    throw e;
  });
}

async function runInline(op, { voiceId, text }, onProgress, job) {
  if (!inlineLib) {
    inlineLib = await import("../vendor/piper-tts-web.js");
  }
  if (op === "stored") return inlineLib.stored();
  if (!inlineSession || inlineVoice !== voiceId) {
    inlineLib.TtsSession._instance = null; // see the worker: the singleton relabels
    inlineSession = null;
    inlineVoice = "";
    // Same bookkeeping as the worker path, so deferring to a model download
    // works identically on the fallback thread. `finally`, so a failed create
    // can't leave the buffer waiting for a download that is no longer happening.
    try {
      inlineSession = await inlineLib.TtsSession.create({
        voiceId,
        progress: (p) => {
          if (p && p.total) {
            noteModelFetch(job);
            if (onProgress) onProgress(Math.round((p.loaded / p.total) * 100));
          }
        },
      });
    } finally {
      releaseModelFetch(job);
    }
    inlineVoice = voiceId;
  }
  return op === "predict" ? inlineSession.predict(text) : null;
}

function callWorker(op, payload, onProgress) {
  const w = ensureWorker();
  if (!w) return callInline(op, payload, onProgress);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    // op + payload are kept so `failWorkerToInline` can replay a hung worker's
    // pending jobs on the main-thread library instead of rejecting them.
    const job = { resolve, reject, onProgress, op, payload };
    pending.set(id, job);
    // Arm the post-boot stall watchdog for this job (progress re-arms it, a
    // settle clears it). Independent of the init watchdog: a boot hang trips the
    // shorter init deadline first and clears this along with the rest.
    armStall(job);
    w.postMessage({ id, op, ...payload });
  });
}

/* ===================== one job at a time, urgent first ===================== */

/**
 * There is a single WASM thread behind all of this, so running two syntheses
 * concurrently does not finish them any sooner — it only makes the one we are
 * actually waiting on land later. Requests queue, and a paragraph the player is
 * blocked on is marked urgent so it overtakes the speculative read-ahead.
 *
 * QUEUED WORK CAN BE ABANDONED, and it has to be. A job the player no longer
 * wants — the paragraph of a ▶ that was paused a moment later, the read-ahead of
 * a book that has been closed — still occupies the one WASM thread for its full
 * render if it is allowed to start, and everything behind it waits. That is
 * exactly what a fast ⏸/▶ (or two, or five) used to build: a queue of dead
 * paragraphs the live one had to sit behind, so the tap that mattered was the
 * SLOWEST one. `stale()` is asked immediately before dispatch — not at enqueue
 * time, when the answer is always no — and a job that has gone stale is dropped
 * without ever reaching the engine. A render already RUNNING cannot be recalled
 * (the WASM call is synchronous and there is nothing to interrupt it), so the
 * worst case is one dead paragraph, not a pile of them.
 */
const urgentQ = [];
const bgQ = [];
let running = false;
/** How many queued jobs have been dropped as stale. Test seam / diagnosis. */
let droppedJobs = 0;

export function droppedJobCount() {
  return droppedJobs;
}

/** The rejection a dropped job produces — never surfaced to the reader. */
export class Abandoned extends Error {
  constructor() {
    super("síntesis abandonada");
    this.name = "Abandoned";
  }
}

function nextJob() {
  for (;;) {
    const job = urgentQ.shift() || bgQ.shift();
    if (!job) return null;
    let stale = false;
    try {
      stale = !!job.stale?.();
    } catch (_) {}
    if (!stale) return job;
    droppedJobs++;
    job.reject(new Abandoned());
  }
}

function pump() {
  if (running) return;
  const job = nextJob();
  if (!job) return;
  running = true;
  job
    .run()
    .then(job.resolve, job.reject)
    .finally(() => {
      running = false;
      pump();
    });
}

function enqueue(run, urgent, stale = null) {
  return new Promise((resolve, reject) => {
    (urgent ? urgentQ : bgQ).push({ run, resolve, reject, stale });
    pump();
  });
}

/**
 * Drop every SPECULATIVE job still queued. The urgent queue is left alone: it
 * holds paragraphs somebody is waiting on, and each of those carries its own
 * `stale` predicate already. For a book/voice change, where everything
 * speculative was rendered against text that no longer applies.
 */
export function dropSpeculative() {
  const jobs = bgQ.splice(0, bgQ.length);
  for (const job of jobs) {
    droppedJobs++;
    job.reject(new Abandoned());
  }
}

/**
 * Ensure the session holds `voiceId`, downloading the model if this device has
 * never used it. `onProgress` receives 0..100 during the download.
 */
export function ensureVoice(voiceId, onProgress) {
  return enqueue(() => callEngine("ensure", { voiceId }, onProgress), true);
}

/** Voices whose model is already on this device (so the UI can say so). */
export async function downloadedVoices() {
  try {
    return (await enqueue(() => callEngine("stored", {}), true)) || [];
  } catch (_) {
    return [];
  }
}

/* ===================== synthesis cache + read-ahead ===================== */

/**
 * Rendered paragraphs, keyed `<doc>|<voice>|<chunk index>|<start offset>`.
 *
 * The document key is part of it because a chunk index means nothing on its
 * own: without it, opening a second book served the FIRST book's paragraph 3
 * for the second book's paragraph 3 — right voice, right position, wrong text.
 *
 * The offset is STRUCTURALLY still in the key and is now always 0 from the
 * player, which is the point rather than an oversight. It used to carry the
 * resume word, because a resume synthesised only the text still to come — and
 * that made a paused paragraph a guaranteed cache MISS, since the entry the
 * read-ahead had rendered was that paragraph from word 0 and the entry ▶ asked
 * for was the same paragraph from word 40. A reader who paused often also filled
 * the cache with overlapping renderings of the same words, evicting the
 * read-ahead to make room for them. Paragraphs are rendered WHOLE now and a
 * resume seeks (player.js#speakPiper), so there is exactly one entry per
 * paragraph and a pause costs nothing. The field stays because the key format is
 * cheap and losing the ability to distinguish partial renders is not something
 * to do silently.
 */
const cache = new Map(); // key -> {blob, docKey, voiceId, idx, bytes}
const inFlight = new Map();
let cacheBytes = 0;

const keyOf = (docKey, voiceId, idx, off) => `${docKey}|${voiceId}|${idx}|${off}`;

/**
 * WHERE THE LISTENER IS, so eviction knows what it is allowed to throw away.
 *
 * The old rule was "drop the oldest INSERTED", and for a look-ahead buffer that
 * is precisely backwards: entries are rendered in reading order, so the oldest
 * insertion is the paragraph NEAREST the playhead — the next one to be needed —
 * while the newest is the one furthest in the future. Under any pressure at all
 * that policy ate the buffer from the front and handed the reader the gap the
 * buffer exists to remove. LRU is no better here: nothing in a read-ahead is
 * ever "used" until it plays, so every unplayed entry looks equally cold.
 *
 * So eviction is by DISTANCE from the playhead instead. Another book or another
 * voice goes first (that audio can never be wanted again without a re-open),
 * then the furthest ahead, then the long-since-played. A few paragraphs behind
 * the playhead are held deliberately: a small rewind, and the ⏮ button, are
 * common and land on audio we already have.
 */
let focus = { docKey: "", voiceId: "", idx: 0 };

export function setCacheFocus(docKey, voiceId, idx) {
  focus = { docKey: docKey || "", voiceId: voiceId || "", idx: idx || 0 };
}

/** Paragraphs behind the playhead kept as cheaply as ones just ahead of it. */
const KEEP_BEHIND = 3;

/** How droppable an entry is — bigger is dropped sooner. */
function evictScore(e) {
  if (e.docKey !== focus.docKey || e.voiceId !== focus.voiceId) return Number.MAX_SAFE_INTEGER;
  const delta = e.idx - focus.idx;
  if (delta >= 0) return delta; // ahead: the further off, the more droppable
  const back = -delta;
  // Just-played paragraphs are worth about as much as the near future (a rewind
  // or a ⏮ lands on them); anything older than that is dead weight.
  return back <= KEEP_BEHIND ? back : 1e6 + back;
}

/**
 * Hold the render, then evict until BOTH caps are met — bytes and entries.
 *
 * Bytes is the cap that matters on a phone: a WAV is ~44 KB per second of
 * speech, so a deep idle precache is measured in tens of megabytes long before
 * it is measured in dozens of entries. The entry cap is only a backstop against
 * a book of one-word sentences.
 *
 * `CACHE_MIN_ENTRIES` is a floor NEITHER cap may push through: the read-ahead
 * window plus the current paragraph must survive any eviction, or a single
 * enormous paragraph could evict the very audio about to play.
 */
const CACHE_MIN_ENTRIES = MAX_READAHEAD_CHUNKS + 4;

/**
 * The live caps. The `__PIPER_CACHE_*` globals are test hooks — driving the real
 * eviction path with three entries instead of building forty megabytes of fake
 * WAV — exactly like `__PIPER_STALL_TIMEOUT_MS` above. Real clients never set
 * them and get the constants.
 */
function caps() {
  return {
    bytes: Number(globalThis.__PIPER_CACHE_MAX_BYTES) || CACHE_MAX_BYTES,
    entries: Number(globalThis.__PIPER_CACHE_MAX_ENTRIES) || CACHE_MAX_ENTRIES,
    min: Number(globalThis.__PIPER_CACHE_MIN_ENTRIES) || CACHE_MIN_ENTRIES,
  };
}

function remember(key, blob, docKey, voiceId, idx) {
  const bytes = blob?.size || 0;
  const old = cache.get(key);
  if (old) cacheBytes -= old.bytes;
  cache.set(key, { blob, docKey, voiceId, idx, bytes });
  cacheBytes += bytes;
  const { bytes: maxBytes, entries: maxEntries, min } = caps();
  while (cache.size > min && (cacheBytes > maxBytes || cache.size > maxEntries)) {
    let worstKey = null;
    let worst = -1;
    for (const [k, e] of cache) {
      const s = evictScore(e);
      if (s > worst) {
        worst = s;
        worstKey = k;
      }
    }
    if (worstKey === null) break;
    // The entry just rendered is judged on the same scale as the rest, and can
    // lose: a speculative render that overshot the window has no more claim on
    // the space than the paragraph next to the reader, and exempting it would
    // let the far future push out the near future one render at a time. The
    // caller still receives the blob — it simply is not retained.
    cacheBytes -= cache.get(worstKey).bytes;
    cache.delete(worstKey);
  }
}

/**
 * Is this paragraph ALREADY rendered? Synchronous, so the player can decide —
 * before it commits to anything — whether ▶ is a wait or an instant start. That
 * decision is what keeps the blocking curtain off a warm resume: raising it for
 * a cache hit means a tap that could have been answered in a frame instead
 * swallows the reader's next tap for a frame or two, which is how a quick ⏸ went
 * missing entirely.
 */
export function isCached(docKey, voiceId, idx, off = 0) {
  return cache.has(keyOf(docKey, voiceId, idx, off));
}

/** Bytes currently held, for the settings readout and the tests. */
export function cacheStats() {
  return { entries: cache.size, bytes: cacheBytes };
}

/**
 * The WAV for one paragraph, from cache when possible. Concurrent callers for
 * the same key share one synthesis — the read-ahead and a play() that catches
 * up with it must never render the same text twice.
 *
 * `urgent` marks the paragraph playback is waiting on, so it overtakes whatever
 * read-ahead is queued behind it.
 */
export async function synthesize(
  docKey,
  voiceId,
  idx,
  off,
  text,
  urgent = false,
  onProgress = null,
  stale = null,
) {
  const key = keyOf(docKey, voiceId, idx, off);
  const hit = cache.get(key);
  if (hit) return hit.blob;
  const job = inFlight.get(key);
  if (job) return job.promise;

  // ONE place for the silence cap, deliberately: it sits after the engine
  // rather than inside it, so the worker and the main-thread fallback cannot
  // drift into producing differently-paced audio — and the native engine, which
  // renders somewhere else entirely, is paced by the same rule for free.
  // ONE ceiling too, whatever the text says: no silence outlives a word space.
  // See piper-trim.js for the measured distribution that sizes it.
  // `onProgress` (the urgent playback path passes it) surfaces a model DOWNLOAD
  // as honest "⬇️ Descargando voz… N%" status instead of a mute "Generando voz".
  const promise = enqueue(
    () => callEngine("predict", { voiceId, text }, onProgress),
    urgent,
    stale,
  )
    .then(
      async (blob) =>
        new Blob([capSilence(await blob.arrayBuffer(), { marks: clauseMarks(text) })], {
          type: blob.type,
        }),
    )
    .then((blob) => {
      remember(key, blob, docKey, voiceId, idx);
      return blob;
    });
  inFlight.set(key, { promise });
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Render the NEXT paragraphs while the current one plays, and stage the very
 * next one in the standby audio element the moment it is ready, so advancing to
 * it costs a swap rather than a decode.
 *
 * The depth is a CHARACTER budget, not a paragraph count. Each sentence is its
 * own chunk now (pdf.js), so "three ahead" could be three tiny lines — almost no
 * audio, and the single WASM thread fell behind a run of short sentences, which
 * the reader heard as "⏳ Generando voz…" mid-play. A char budget renders a
 * constant amount of speech ahead however the sentences weigh. `MAX_READAHEAD_
 * CHUNKS` bounds the pathological all-short-lines case so the queue (and the
 * cache) can't blow up.
 *
 * Fire-and-forget by design — a failed read-ahead must not break playback, and
 * the paragraph will simply be synthesised on demand when it is reached.
 */
export function readAhead(docKey, voiceId, chunks, fromIdx, chars = READAHEAD_CHARS) {
  let budget = chars;
  let n = 0;
  for (let i = fromIdx; i < chunks.length && n < MAX_READAHEAD_CHUNKS; i++) {
    const c = chunks[i];
    if (!c) break;
    const isNext = i === fromIdx;
    synthesize(docKey, voiceId, i, 0, speechTextFrom(c.text))
      .then((blob) => {
        if (isNext) stageBlob(blob);
      })
      .catch(() => {});
    n++;
    budget -= c.text?.length || 0;
    if (budget <= 0) break; // always renders at least the immediate next chunk
  }
}

/**
 * Render a CHARACTER budget of upcoming chunks and AWAIT it — the cushion built
 * before the first paragraph of a reader-initiated ▶/seek starts playing.
 *
 * Read-ahead only runs once a paragraph is already playing, so the opening few
 * short sentences of a session played faster than the next could be synthesised
 * and the reader heard silence between them. This fills the cache ahead first,
 * so by the time playback starts there is a buffer to coast on. Non-urgent so a
 * second seek still overtakes it; does NOT stage (the caller's playBlob owns the
 * standby element for the paragraph it is about to start). Never rejects — a
 * cushion that failed to build just means playback falls back to on-demand.
 */
export async function bufferAhead(docKey, voiceId, chunks, fromIdx, chars = PREBUFFER_CHARS) {
  let budget = chars;
  let n = 0;
  for (let i = fromIdx; i < chunks.length && n < MAX_READAHEAD_CHUNKS && budget > 0; i++) {
    const c = chunks[i];
    if (!c) break;
    try {
      await synthesize(docKey, voiceId, i, 0, speechTextFrom(c.text));
    } catch (_) {
      // one speculative render failing is not worth abandoning the rest
    }
    n++;
    budget -= c.text?.length || 0;
  }
}

/**
 * Render the paragraph ▶ will START on — before ▶ is pressed.
 *
 * Read-ahead only ever runs once a paragraph is already playing, so the FIRST
 * one of a session was always synthesised while the listener waited: open a
 * book, press play, hear nothing for several seconds, and the same again at the
 * next paragraph until the read-ahead catches up. Opening the book is dead time
 * that can absorb exactly that.
 *
 * There is no `base` here any more, and that is the point of the change it came
 * from: a paragraph is rendered WHOLE and a mid-paragraph resume seeks into it
 * (see player.js#speakPiper), so a resumed book and a fresh one warm the same
 * single cache entry. It used to render only the text still to come, which made
 * the resume word part of the key — warm the wrong word and the render was real,
 * cached, and never asked for.
 *
 * Two guards keep this from being a cost of its own:
 *   - a voice whose model is not on the device already is skipped, so opening a
 *     book never starts a ~28 MB download nobody asked for;
 *   - everything is queued NON-urgent, so the moment the user does press ▶ the
 *     paragraph they are waiting on overtakes whatever is still speculative.
 *
 * `canStage` decides whether the warmed paragraph is also LOADED into the
 * standby <audio> element. Rendering it only fills the cache — ▶ still pays a
 * createObjectURL + decode before the first sample, which on a phone is the last
 * visible fraction of the wait. Staging spends that too, so ▶ becomes the same
 * swap an ordinary paragraph seam is. It is only safe while nothing is playing:
 * the standby element belongs to the read-ahead once audio runs, and staging
 * over it would drop the decode the next seam is about to use.
 *
 * It is a PREDICATE and not a boolean because this function awaits twice, and
 * the answer can go stale across those awaits — the whole point of warming is
 * that the user may press ▶ at any moment, including while the render they are
 * about to benefit from is still in flight. A boolean decided at call time would
 * then stage the paragraph now PLAYING into the standby slot, and the next seam
 * would repeat it. Asked here, immediately before the stage and with no await in
 * between, the answer cannot go stale.
 */
export async function prewarm(docKey, voiceId, chunks, fromIdx, count = 2, canStage = null) {
  const first = chunks?.[fromIdx];
  if (!first) return;
  const have = await downloadedVoices();
  if (!have.includes(voiceId)) return;
  try {
    const blob = await synthesize(docKey, voiceId, fromIdx, 0, speechTextFrom(first.text));
    if (canStage?.()) stageBlob(blob);
  } catch (_) {
    return; // a speculative render that failed is not an error the user has to see
  }
  // Deliberately NOT readAhead: that stages its FIRST blob, which is the
  // paragraph AFTER `fromIdx` — the wrong audio for a ▶ that starts on
  // `fromIdx` itself. The staging that IS right here happened above.
  for (let i = fromIdx + 1; i < Math.min(fromIdx + 1 + count, chunks.length); i++) {
    const c = chunks[i];
    if (!c) break;
    synthesize(docKey, voiceId, i, 0, speechTextFrom(c.text)).catch(() => {});
  }
}

/**
 * Render a DEEP cushion ahead while nothing is playing — the idle precache.
 *
 * `readAhead` only runs behind a paragraph that is already playing, and
 * `prewarm` covers the resume point and a couple after it. Between them they
 * leave the app's most common state unused: OPEN, stopped, in somebody's hand or
 * on the bedside table with sleep mode armed. That is minutes of a free CPU, and
 * every second of it spent rendering is a second the next ▶ does not wait.
 *
 * Deliberately different from `readAhead` in three ways:
 *  - the budget is much larger (PRECACHE_CHARS), because there is no paragraph
 *    seam to hit and nothing competing for the engine;
 *  - it renders one at a time and re-asks `stale()` between each, so the moment
 *    the reader presses ▶ (or opens another book) the rest is abandoned instead
 *    of sitting in front of the paragraph they are waiting on; and
 *  - it never stages into the standby element — `prewarm` owns that decision,
 *    and staging the wrong paragraph is how a seam repeats itself.
 *
 * Returns the number of paragraphs it actually rendered, so a caller can tell a
 * full run from one that found everything already warm.
 */
/**
 * Is any paragraph in the precache window still unrendered? The cheap,
 * synchronous half of `precache`, so the idle tick can decide to do nothing
 * without asking the worker anything. Walks the SAME budget the render loop
 * does, so the two can never disagree about what "full" means.
 */
export function precacheGap(docKey, voiceId, chunks, fromIdx, chars = PRECACHE_CHARS) {
  let budget = chars;
  for (let i = fromIdx; i < chunks.length && budget > 0; i++) {
    const c = chunks[i];
    if (!c) break;
    budget -= c.text?.length || 0; // spent whether or not it needed rendering
    if (!isCached(docKey, voiceId, i, 0)) return true;
  }
  return false;
}

export async function precache(
  docKey,
  voiceId,
  chunks,
  fromIdx,
  chars = PRECACHE_CHARS,
  stale = null,
) {
  if (!chunks?.length) return 0;
  // Is there anything to do at all? Asked FIRST, and synchronously, because this
  // runs on a timer for as long as a book is open: the settled state is "already
  // full", and in that state the whole tick must cost nothing. `downloadedVoices`
  // below is a round-trip to the worker on the URGENT queue, so an unguarded
  // version would poke the engine every few seconds, all night, to be told each
  // time that it has nothing to render.
  if (!precacheGap(docKey, voiceId, chunks, fromIdx, chars)) return 0;
  // Same guard `prewarm` has, and for a stronger reason: this runs on a timer,
  // so an unguarded version would start a ~28 MB model download by itself, on
  // mobile data, for a book merely left open. A voice that is not on the device
  // is warmed by the reader choosing it, never by the buffer.
  const have = await downloadedVoices();
  if (!have.includes(voiceId)) return 0;
  if (stale?.()) return 0;
  let budget = chars;
  let made = 0;
  for (let i = fromIdx; i < chunks.length && made < MAX_PRECACHE_CHUNKS && budget > 0; i++) {
    if (stale?.()) break;
    const c = chunks[i];
    if (!c) break;
    budget -= c.text?.length || 0;
    if (isCached(docKey, voiceId, i, 0)) continue; // already warm; costs nothing
    try {
      await synthesize(docKey, voiceId, i, 0, speechTextFrom(c.text), false, null, stale);
      made++;
    } catch (_) {
      // Abandoned (the reader pressed ▶) or a failed render — either way the
      // paragraph will be synthesised on demand if it is ever reached.
      if (stale?.()) break;
    }
  }
  return made;
}

/** Drop everything rendered — on a voice change, or when the book changes. */
export function clearCache() {
  cache.clear();
  cacheBytes = 0;
  dropSpeculative();
}

/* ===================== audio graph ===================== */

/**
 * TWO <audio> elements → compressor → gain → speakers.
 *
 * One plays while the other holds the next paragraph, already fetched from its
 * blob URL and decoded. Advancing swaps which is which, so the seam between
 * paragraphs costs nothing; a single element would have to load and decode at
 * exactly the moment the listener is waiting.
 *
 * The compressor is what makes a loud setting usable: it pulls the peaks down
 * before the gain lifts everything, so the voice gets substantially louder
 * without the clipping a bare gain would cause at the same level. These are
 * gentle broadcast-ish settings, not a limiter — the goal is a louder voice in
 * a noisy room, not a squashed one.
 */
let els = null; // [playing-or-idle, the other one]
let cur = 0;
let ctx = null;
let gainNode = null;
let comp = null;
let makeup = null;
let shaper = null;
let modStyle = MODULATION_DEFAULT;
const urls = [null, null]; // object URL loaded in each element, revoked on replacement
let staged = null; // the blob sitting in the standby element
let handlers = {}; // {onEnded, onError, onTime} — reattached on every swap
/**
 * The paragraph this app paused ON PURPOSE and is still holding, or null.
 *
 * `{docKey, voiceId, idx, off}` — enough for the player to prove that the audio
 * sitting in the element is the audio ▶ would now want. See `suspendAudio`.
 */
let held = null;

/**
 * ONLY `els[cur]` MAY SOUND — enforced, not assumed.
 *
 * Everything this module does keeps that true by construction: `playBlob`
 * pauses the outgoing element before it flips `cur`, and the whole swap is
 * synchronous, so two paragraphs cannot start over each other. What that
 * argument cannot cover is a `play()` THIS APP DID NOT MAKE, and on a phone
 * those exist: Chromium pauses a media element when something takes audio focus
 * (a call, another app, a notification sound) and RESUMES it when focus comes
 * back; the media notification, the lock screen and a headset/Bluetooth button
 * all drive the same default handler.
 *
 * The standby element is exactly what makes that dangerous. It is not idle — it
 * holds the NEXT paragraph, fetched and decoded, which is the whole point of the
 * double buffer. So a resume aimed at it starts a second, perfectly valid
 * reading of the same book a paragraph away from the first, and nothing in the
 * player is watching: `cur`, `speakGen` and the handlers all still describe the
 * one reading we started. What you hear is the book being read twice at once,
 * intertwined, from a single window on a single phone.
 *
 * So the element itself refuses. The listener is installed once, for the life of
 * the graph, and is never detached — `attach`/`detach` swap the PLAYBACK
 * handlers, and a veto that came and went with them would be absent for exactly
 * the element it has to protect. Deliberately noisy: this fires only when
 * something outside this module started audio, and that is worth seeing.
 */
let strayPlays = 0;

function vetoStrayPlay(el, idx) {
  el.addEventListener("play", () => {
    // The one we started, as intended — unless we are deliberately HELD, in
    // which case the app believes it is paused and any sound at all is a lie the
    // reader would hear as the book restarting itself. A hold keeps the source
    // loaded (that is the whole point — ▶ is then instant), so for the first
    // time `els[cur]` is a resume target for the OS too, and the veto has to
    // cover it. `resumeHeld` clears the hold BEFORE it plays, so our own resume
    // never lands here.
    if (idx === cur && !held) return;
    strayPlays++;
    try {
      el.pause();
      el.currentTime = 0;
    } catch (_) {}
    if (strayPlays === 1) {
      console.warn(
        "[piper] the standby audio element was started by something outside " +
          "this app (audio-focus return, media notification, headset button) — " +
          "paused it. Left alone it reads the book a second time, over the first.",
      );
    }
  });
}

/** How many times a stray play has been vetoed. Test seam / diagnosis. */
export function strayPlayCount() {
  return strayPlays;
}

function ensureGraph() {
  if (els) return;
  els = [new Audio(), new Audio()];
  for (const e of els) e.preload = "auto";
  els.forEach(vetoStrayPlay);
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    comp = ctx.createDynamicsCompressor();
    makeup = ctx.createGain();
    gainNode = ctx.createGain();
    shaper = ctx.createWaveShaper();
    // Both elements feed the same compressor, so a swap cannot change the tone
    // or the level mid-book.
    for (const e of els) ctx.createMediaElementSource(e).connect(comp);
    // The shaper sits LAST so its ceiling is absolute: the volume slider drives
    // into it rather than past it.
    comp.connect(makeup);
    makeup.connect(gainNode);
    gainNode.connect(shaper);
    shaper.connect(ctx.destination);
    applyModulation();
  } catch (_) {
    // No WebAudio (or an autoplay policy that refuses a context): still play,
    // just without the >100% boost. el.volume caps at 1 and that is the floor
    // of the feature, not a failure.
    ctx = null;
    gainNode = null;
    comp = makeup = shaper = null;
  }
}

/** Push the chosen preset onto the live nodes. No-op before the graph exists. */
function applyModulation() {
  if (!comp) return;
  const m = modulation(modStyle);
  for (const k of Object.keys(m.comp)) comp[k].value = m.comp[k];
  makeup.gain.value = m.makeup;
  shaper.curve = m.clip ? softClipCurve(m.clip) : null;
}

/**
 * Choose how peaks are handled (js/modulation.js). Live: the reader hears the
 * difference without restarting the paragraph.
 */
export function setModulation(name) {
  modStyle = name;
  applyModulation();
}

/**
 * What the player wants told about the CURRENT paragraph: it finished, it
 * failed, or it moved. Registered rather than hung on an element, because which
 * element is playing changes on every paragraph — the player must not have to
 * track that, and a handler left on the standby element would fire for audio
 * nobody is listening to.
 */
export function setHandlers(h) {
  handlers = h || {};
}

function attach(el) {
  el.onended = () => handlers.onEnded && handlers.onEnded();
  el.onerror = () => handlers.onError && handlers.onError();
  el.ontimeupdate = () => handlers.onTime && handlers.onTime(fractionOf(el));
}

function detach(el) {
  el.onended = null;
  el.onerror = null;
  el.ontimeupdate = null;
}

/**
 * Volume. Up to 1 rides the elements; above 1 the gain node does the lifting,
 * which is the part the device voice can never do.
 */
export function setVolume(v) {
  ensureGraph();
  const x = Math.max(0, v);
  if (gainNode) {
    for (const e of els) e.volume = 1;
    gainNode.gain.value = x;
  } else {
    for (const e of els) e.volume = Math.min(1, x);
  }
}

/** Speed. Live — no re-render, unlike an utterance whose rate is fixed once queued. */
export function setRate(r) {
  ensureGraph();
  for (const el of els) {
    el.playbackRate = r;
    // Time-stretch instead of resample, or the voice rises in pitch with speed.
    el.preservesPitch = true;
    el.mozPreservesPitch = true;
    el.webkitPreservesPitch = true;
  }
}

/**
 * Load a rendered paragraph into the STANDBY element so its decode happens
 * while the current paragraph is still playing. Idempotent: staging the blob
 * that is already staged is a no-op, so the read-ahead can call it freely.
 */
export function stageBlob(blob) {
  if (!blob) return;
  ensureGraph();
  if (staged === blob) return;
  const other = 1 - cur;
  const next = URL.createObjectURL(blob);
  if (urls[other]) URL.revokeObjectURL(urls[other]);
  urls[other] = next;
  els[other].src = next;
  els[other].load();
  staged = blob;
}

/**
 * Wait until `el` knows its own duration, so a fractional seek has something to
 * multiply. A staged element has usually had a whole paragraph to decode and
 * answers immediately; a cold one (a jump) is given a short grace and then
 * played from the top rather than held up — starting a paragraph one sentence
 * early is a far smaller failure than a ▶ that does nothing.
 */
const METADATA_WAIT_MS = 400;

/** Seconds of overlap re-played on a mid-paragraph resume. See `playBlob`. */
const RESUME_LEAD_S = 0.4;

function whenDurationKnown(el) {
  if (Number.isFinite(el.duration) && el.duration > 0) return Promise.resolve(true);
  if (typeof el.addEventListener !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), METADATA_WAIT_MS);
    el.addEventListener(
      "loadedmetadata",
      () => {
        clearTimeout(timer);
        finish(true);
      },
      { once: true },
    );
  });
}

/**
 * Swap to the paragraph and start it. Resolves once playback has begun.
 *
 * `startFrac` (0..1) is where INSIDE the paragraph to begin — the resume word,
 * expressed as a fraction of the text. It exists so a mid-paragraph resume can
 * play the paragraph's ONE cached rendering from the middle instead of asking
 * the engine for a second, shorter rendering of the same words. See the header
 * of `synthesize`'s cache and player.js#speakPiper.
 */
export async function playBlob(blob, { rate, volume, startFrac = 0 }) {
  ensureGraph();
  if (ctx && ctx.state === "suspended") await ctx.resume().catch(() => {});
  // Not already waiting in the standby element (a jump, or a read-ahead that
  // did not finish in time): load it there now, then swap as usual.
  if (staged !== blob) stageBlob(blob);

  const prev = els[cur];
  detach(prev);
  try {
    prev.pause();
  } catch (_) {}

  cur = 1 - cur;
  staged = null;
  held = null; // a new paragraph supersedes whatever was being held
  const el = els[cur];
  attach(el);
  setRate(rate);
  setVolume(volume);
  let at = 0;
  if (startFrac > 0 && (await whenDurationKnown(el))) {
    // Land SHORT, deliberately, the same way the word estimate does: the
    // char→time map is linear while the audio is not (`capSilence` shortens
    // pauses unevenly), so a small lead turns "might clip the word you stopped
    // on" into "might repeat it".
    at = Math.max(0, Math.min(1, startFrac) * el.duration - RESUME_LEAD_S);
  }
  try {
    el.currentTime = at; // a staged element may have been left mid-seek
  } catch (_) {}
  await el.play();
}

/**
 * Pause WITHOUT throwing the audio away — the reader's own ⏸.
 *
 * `stopAudio` drops the source, which is right for a jump or a book change and
 * exactly wrong for a pause: the paragraph in the element is the paragraph ▶
 * wants back, already fetched, already decoded, positioned to the sample the
 * sound stopped on. Tearing it down meant every ▶ went back to the engine for a
 * fresh rendering of the remaining words — a rendering that, because it started
 * from a different word, was a different cache entry and therefore always a
 * MISS. That is why a quick ⏸/▶ produced seconds of silence over audio the app
 * was already holding.
 *
 * `tag` is what the audio IS, so the player can prove on the way back that the
 * element still holds the paragraph it is about to resume — a jump or a voice
 * change between the two must fall through to a real render.
 */
export function suspendAudio(tag) {
  if (!els || !tag) return false;
  const el = els[cur];
  if (!el || !el.currentSrc) return false;
  held = tag;
  try {
    el.pause();
  } catch (_) {}
  return true;
}

/** What is being held, or null. The player matches this before resuming. */
export function heldTag() {
  return held;
}

/**
 * Resume the held paragraph exactly where it stopped. No synthesis, no decode,
 * no seek — the whole point. Returns false if there is nothing held to resume,
 * so the caller falls through to the ordinary render path.
 */
export async function resumeHeld() {
  if (!held || !els) return false;
  const el = els[cur];
  if (!el || !el.currentSrc) {
    held = null;
    return false;
  }
  // Cleared BEFORE the play, or our own resume trips the stray-play veto.
  held = null;
  attach(el);
  if (ctx && ctx.state === "suspended") await ctx.resume().catch(() => {});
  await el.play();
  return true;
}

/**
 * Is a paragraph actually coming out of the speakers right now?
 *
 * The stall watchdogs need an engine-correct answer to "is it still going?".
 * Asking `speechSynthesis` gives them `false` under Piper — nothing is ever
 * queued there — which reads as a permanent stall. See player.js `isRendering`.
 */
export function isPlaying() {
  if (!els) return false;
  const el = els[cur];
  return !!el && !el.paused && !el.ended;
}

/**
 * Paused by something that is NOT this app — an interruption, not a stall.
 *
 * Chromium pauses the media element when audio focus goes elsewhere (a call, a
 * notification, another app) and resumes it when focus returns. The stall
 * watchdogs cannot tell that apart from dead playback, so they used to relaunch
 * the paragraph into an interruption they only had to wait out: the re-synthesis
 * happens while the phone is busy, the `play()` behind it is likely to be
 * refused, and the book ends up STOPPED ("pulsa ▶ para reanudar") over something
 * that would have resumed by itself. Worse, the relaunch leaves the interrupted
 * element loaded and idle, so the browser's own resume then starts it AGAIN
 * alongside the paragraph that replaced it — the same book read twice at once.
 *
 * Every pause this module makes tears the source down (`stopAudio`) or belongs
 * to the standby element, so `els[cur]` sitting paused, unfinished, part-way
 * through a source it still holds is precisely the outside pause and nothing
 * else.
 */
export function isInterrupted() {
  if (!els) return false;
  // A deliberate hold looks IDENTICAL to an interruption from the element's side
  // — paused, unfinished, part-way through a source it still holds — because it
  // is the same thing done for a different reason. The reason is the whole
  // distinction, and only this module knows it.
  if (held) return false;
  const el = els[cur];
  return !!el && el.paused && !el.ended && el.currentTime > 0 && !!el.currentSrc;
}

export function pauseAudio() {
  if (els) els[cur].pause();
}

export function resumeAudio() {
  return els ? els[cur].play() : Promise.resolve();
}

/**
 * Hard stop: silence now, and drop the source so no `ended` fires later.
 *
 * ONLY the element that is speaking. The player calls this on every state
 * change, and "every state change" includes the advance between two paragraphs
 * of ordinary playback — so clearing the standby element here threw away the
 * read-ahead's decode a moment before the swap that was about to use it, and
 * every seam paid for a fresh load. That made the double buffer dead code on
 * the one path it exists for. See tests/audiobooks-piper-seam.test.js.
 *
 * Keeping the standby loaded is safe on the paths that are NOT an advance: it
 * carries no handlers (only the current element is attached, so it cannot fire
 * `ended` into a stopped player), and `playBlob` matches it by blob identity,
 * so a stage left over from another book or voice is simply replaced.
 */
export function stopAudio() {
  if (!els) return;
  held = null; // the source is about to go; nothing is being held any more
  detach(els[cur]);
  try {
    els[cur].pause();
    els[cur].removeAttribute("src");
    els[cur].load();
  } catch (_) {}
  if (urls[cur]) {
    URL.revokeObjectURL(urls[cur]);
    urls[cur] = null;
  }
}

function fractionOf(el) {
  if (!el || !el.duration || !Number.isFinite(el.duration)) return 0;
  return Math.max(0, Math.min(1, el.currentTime / el.duration));
}

/* ===================== first-run download ===================== */

/**
 * Pull a voice's model with the progress on screen. Called when the user picks
 * a voice, so the tens of MB happen once, visibly, instead of as a mysterious
 * stall on the first ▶.
 */
export async function prefetchVoice(voiceId) {
  const v = PIPER_VOICES.find((x) => x.id === voiceId);
  const name = v ? v.label : voiceId;
  let last = -1;
  try {
    await ensureVoice(voiceId, (pct) => {
      if (pct !== last && pct % 5 === 0) {
        last = pct;
        setStatus(`⬇️ Descargando voz ${name}… ${pct}%`);
      }
    });
    setStatus(`✅ Voz ${name} lista.`);
    return true;
  } catch (e) {
    setStatus(`❌ No se pudo descargar la voz ${name}. ${e?.message || ""}`.trim());
    return false;
  }
}

/** Where the models come from, surfaced for the settings hint. */
export const modelSource = PIPER_BASE_URL;
