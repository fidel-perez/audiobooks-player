/**
 * Cap the silence Piper bakes into a rendered paragraph.
 *
 * WHY. espeak-ng emits a pause token for sentence punctuation and VITS renders
 * it at full length, so the WAV that comes back is a quarter to a third
 * SILENCE. Measured in the deployed app with es_ES-carlfm-x_low (2026-07-18,
 * magallanes over host Chrome):
 *
 *   "Se detuvo junto a la ventana. Luego cerro los postigos."  → 1.58 s pause
 *   "Solo dijo una cosa: que no volveria."                     → 0.91 s
 *   "¿Quien anda ahi? Nadie contesto."                         → 0.86 s
 *   four narrative sentences                                   → 0.66/0.81/0.57
 *   the same clause joined with a comma                        → 0.42 s
 *   the same words with NO punctuation                         → 0.14 s
 *
 * That is where the "awkward pauses" came from, and it is why they survived
 * every playback fix and did not care about the speed setting: the dead air is
 * IN the audio, not between the paragraphs. `playbackRate` scales it, so a
 * 1.58 s pause is still 0.85 s at 185%.
 *
 * WHAT THIS DOES. Walks the PCM and shortens any silent run past the cap,
 * leaving everything else sample-for-sample identical. It does not compress,
 * resample or touch speech.
 *
 * ONE CAP INSIDE A CHUNK, ONE SEAM BETWEEN THEM. A comma keeps a beat, an
 * invented breath does not; the sentence stop gets SEAM_S.
 *
 * IT IS SAFE BECAUSE THE PUNCTUATION IS STILL THERE IN THE TEXT. A chunk is one
 * sentence (pdf.js, `minChunk = 0`), so the structure a pause used to carry is
 * carried by the chunk boundary and the fresh prosody contour that starts there.
 * Removing the silence does not remove the sentence.
 *
 * DETECTION IS DELIBERATELY CONSERVATIVE. A run counts as silence only below
 * about −50 dBFS, and only past the cap — which is still longer than the quiet
 * inside a word. Measured 2026-08-04 by running the three shipped es_ES models
 * directly (onnxruntime, espeak-ng phonemes with the clause punctuation put
 * back), over 11 lines of punctuation-free prose per voice including
 * plosive-heavy fixtures ("el pacto exacto que aquel objeto compacto tapaba"),
 * counting every internal silent run at the same −50 dBFS gate:
 *
 *   davefx-medium    p50 10 ms   p90 23 ms   max 36 ms
 *   sharvard-medium  p50  9 ms   p90 32 ms   p99 112 ms   max 155 ms
 *   carlfm-x_low     p50  8 ms   p90 70 ms   max 681 ms
 *
 * A real word space or stop closure is TENS of milliseconds. Everything in the
 * long tail is the model breathing — carlfm's 681 ms sits in a line with no mark
 * in it at all. So 50 ms clears every genuine gap davefx makes and all but the
 * top decile of sharvard's, while the invented breaths die.
 *
 * The format is fixed by the library that produces it (vendor/piper-tts-web.js
 * `pcm2wav`): 16-bit mono PCM, 44-byte canonical header. Anything else is
 * returned untouched rather than guessed at.
 */

const HEADER = 44;
// −50 dBFS in 16-bit units. Below this is silence to a listener on headphones.
const SILENCE = Math.round(0.0032 * 32768);

/**
 * The gap between two ordinary words, from the measurements above, and the
 * ceiling for every silence in the book. Raising it brings the dead air back;
 * below ~0.04 s it starts landing inside the real distribution and clipping the
 * closure of a stop consonant, which is heard as a swallowed `p`/`t`/`k`.
 */
export const WORD_SPACE_S = 0.05;

/** Every silence between two words of the same chunk, whatever punctuation put
 *  it there. */
export const MAX_PAUSE_S = WORD_SPACE_S;

/**
 * One seam per sentence stop: the chunk's trailing silence and the next one's
 * lead SUM to this. The models render 156–199 ms themselves.
 */
export const SEAM_S = 0.18;

/**
 * The lead is not zero: an all-silence chunk renders a zero-sample WAV, which no
 * `<audio>` gives a duration for, so the player waits forever.
 */
export const MAX_LEAD_S = 0.01;
export const MAX_TRAIL_S = SEAM_S - MAX_LEAD_S;

/**
 * Below this a quiet run is a zero crossing, not a gap: the waveform dips under
 * the gate every cycle.
 */
export const SPACE_FLOOR_S = 0.005;

/**
 * The ceiling on the sampled word space. A chunk whose only long runs ARE
 * breaths reads a huge median, and clamping keeps it honest.
 */
export const SPACE_MAX_S = 0.03;

/**
 * How many word spaces long a silence must be to count as an anomaly. Spaces
 * cluster at 5–20 ms; the breaths land at 50–630 ms.
 */
export const ANOMALY_K = 4;

/**
 * Half the 5 ms gap the model leaves between words, so an invented breath lands
 * under hearing. Flat, not scaled.
 */
export const ANOMALY_RESIDUE_S = 0.0025;

/**
 * What a clause mark keeps. A chunk spares its longest runs, one per `,` `;`
 * `:`, and crushes the rest.
 */
export const PUNCT_PAUSE_S = 0.12;

/**
 * Shorten over-long silences in a 16-bit mono PCM WAV.
 *
 * Returns a NEW ArrayBuffer, or the input unchanged when the format is not the
 * one Piper produces or when nothing needed shortening.
 */
export function capSilence(
  buffer,
  {
    maxPauseS = MAX_PAUSE_S,
    maxLeadS = MAX_LEAD_S,
    maxTrailS = MAX_TRAIL_S,
    marks = 0,
  } = {},
) {
  if (!buffer || buffer.byteLength <= HEADER) return buffer;
  const view = new DataView(buffer);
  const channels = view.getUint16(22, true);
  const bits = view.getUint16(34, true);
  const rate = view.getUint32(24, true);
  if (channels !== 1 || bits !== 16 || !rate) return buffer;

  const samples = new Int16Array(buffer, HEADER, (buffer.byteLength - HEADER) >> 1);
  const maxPause = Math.round(maxPauseS * rate);
  const maxLead = Math.round(maxLeadS * rate);
  const maxTrail = Math.round(maxTrailS * rate);
  const spaceFloor = Math.round(SPACE_FLOOR_S * rate);
  const spaceMax = Math.round(SPACE_MAX_S * rate);

  // Two passes so the output is allocated exactly once: measure, then copy.
  // `keep` is how many samples of an over-long silent run survive.
  //
  // ONLY the runs that actually need shortening are recorded. A run below its
  // ceiling is not a pause to be rewritten — it is the paragraph's own noise
  // floor between two words, or the closure of a stop consonant — and it stays
  // part of the ordinary speech copy below, sample for sample.
  const runs = []; // {start, len, cap, edge}
  const spaces = [];
  let runStart = -1;
  for (let i = 0; i <= samples.length; i++) {
    const quiet = i < samples.length && Math.abs(samples[i]) < SILENCE;
    if (quiet) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const len = i - runStart;
      // An edge run is half a seam between chunks, not a pause between words,
      // so each edge gets half the ceiling.
      const edge = runStart === 0 || i === samples.length;
      const cap = edge ? (runStart === 0 ? maxLead : maxTrail) : maxPause;
      if (!edge && len >= spaceFloor) spaces.push(len);
      if (len > cap) runs.push({ start: runStart, len, cap, edge });
      runStart = -1;
    }
  }

  // The word space THIS paragraph uses, from its own spacing. Finding an anomaly
  // is relative to it; what survives one is flat.
  const sorted = spaces.slice().sort((a, b) => a - b);
  const normal = sorted.length ? Math.min(sorted[sorted.length >> 1], spaceMax) : spaceMax;
  const anomaly = normal * ANOMALY_K;
  const residue = Math.max(1, Math.round(ANOMALY_RESIDUE_S * rate));
  // The chunk's own marks say how many of its holes were ASKED FOR, longest
  // first: those keep a beat, and every other anomaly is a breath.
  const spared = new Set(
    runs
      .filter((r) => !r.edge)
      .sort((a, b) => b.len - a.len)
      .slice(0, marks),
  );
  const punct = Math.round(PUNCT_PAUSE_S * rate);
  for (const r of runs)
    r.keep = spared.has(r)
      ? Math.min(r.len, punct)
      : !r.edge && r.len > anomaly
        ? residue
        : r.cap;

  const dropped = runs.reduce((n, r) => n + (r.len - r.keep), 0);
  if (dropped === 0) return buffer;

  const outSamples = samples.length - dropped;
  const out = new ArrayBuffer(HEADER + outSamples * 2);
  new Uint8Array(out).set(new Uint8Array(buffer, 0, HEADER));
  const outView = new DataView(out);
  // RIFF chunk size and data chunk size both carry the new length; a WAV whose
  // header disagrees with its payload decodes to silence or to noise.
  outView.setUint32(4, out.byteLength - 8, true);
  outView.setUint32(40, outSamples * 2, true);

  const dst = new Int16Array(out, HEADER, outSamples);
  let w = 0;
  let read = 0;
  for (const r of runs) {
    dst.set(samples.subarray(read, r.start), w); // the speech before this run
    w += r.start - read;
    // The pause, shortened — the run's OWN opening samples, not a block of
    // digital zero. Piper's silence is a low-level floor, and splicing absolute
    // silence into it makes the noise floor cut out and back, which is heard as
    // a dropout rather than a pause.
    dst.set(samples.subarray(r.start, r.start + r.keep), w);
    w += r.keep;
    read = r.start + r.len;
  }
  dst.set(samples.subarray(read), w);
  return out;
}
