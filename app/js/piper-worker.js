/**
 * Piper synthesis, OFF the main thread.
 *
 * WHY THIS FILE EXISTS. Synthesising a paragraph is two long synchronous WASM
 * calls: the espeak-ng phonemiser (an Emscripten `callMain`) and the ONNX
 * inference. Run on the main thread they pin it for seconds at a time. That
 * does not stop the audio already playing — media output lives on its own
 * thread — but it does stop the *handover*: `ended` → advance → play() are all
 * main-thread callbacks, so a paragraph that finishes mid-synthesis sits in the
 * event queue until the WASM call returns. That wait IS the gap the listener
 * hears, and it gets WORSE the faster you play, because shorter paragraphs end
 * more often inside a synthesis window. Moving the work here keeps the main
 * thread free, so the handover happens the instant the audio ends.
 *
 * PROTOCOL. One request in flight at a time — the caller (js/piper.js) enforces
 * that, so this file never has to reason about a second `ensureVoice` arriving
 * mid-download.
 *
 *   in : {id, op: "ensure" | "predict" | "stored", voiceId?, text?}
 *   out: {id, ok: true, value} | {id, ok: false, error} | {id, type: "progress", pct}
 *
 * The model itself still lives in OPFS, which is reachable from here, so a
 * voice downloaded before this worker existed is not re-fetched.
 */

// Proof of life, posted the INSTANT this script runs — before the heavy vendor
// import below. The main thread (js/piper.js) starts an init watchdog when it
// spawns this worker and falls the whole engine back to the inline main-thread
// path if no message arrives, because the module-worker SCRIPT request can hang
// (Chrome doesn't route it through the SW cache, so a precached worker still
// depends on a live network fetch). Pinging before the import means that
// watchdog only ever trips on a genuinely unfetched script — never on a slow
// first synthesis, whose worker is already alive.
self.postMessage({ type: "booted" });

// The library is imported LAZILY (not a top-level `import`) so the boot ping
// above lands first; without that, a stall inside the vendor module would delay
// the very ping the watchdog waits for.
let libPromise = null;
function lib() {
  if (!libPromise) libPromise = import("../vendor/piper-tts-web.js");
  return libPromise;
}

let session = null;
let sessionVoice = "";

/**
 * Hold the session on `voiceId`, downloading the model if this device has never
 * used it.
 *
 * The `_instance = null` is load-bearing and must stay wherever the session is
 * created: TtsSession is a singleton whose constructor returns the EXISTING
 * instance and merely relabels its `voiceId`, leaving the previously loaded
 * ONNX model in place. Without the reset, picking a second voice keeps speaking
 * in the first one.
 */
async function ensureVoice(voiceId, onProgress) {
  const { TtsSession } = await lib();
  if (session && sessionVoice === voiceId) return;
  TtsSession._instance = null;
  session = null;
  sessionVoice = "";
  const s = await TtsSession.create({
    voiceId,
    progress: (p) => {
      if (p && p.total) onProgress(Math.round((p.loaded / p.total) * 100));
    },
  });
  session = s;
  sessionVoice = voiceId;
}

self.onmessage = async (ev) => {
  const { id, op, voiceId, text } = ev.data || {};
  const progress = (pct) => self.postMessage({ id, type: "progress", pct });
  try {
    let value = null;
    if (op === "ensure") {
      await ensureVoice(voiceId, progress);
    } else if (op === "predict") {
      await ensureVoice(voiceId, progress);
      value = await session.predict(text);
    } else if (op === "stored") {
      const { stored } = await lib();
      value = await stored();
    } else {
      throw new Error(`unknown op: ${op}`);
    }
    self.postMessage({ id, ok: true, value });
  } catch (e) {
    // Errors do not survive structuredClone, so only the message crosses back.
    self.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
