/**
 * Peak handling for the Piper chain, as presets.
 *
 * A peak trips the phone's speaker protection: ~200 ms of silence.
 */

// -1 dBFS. Below full scale, so the device mixer never sees a square peak.
const CEILING = 0.891;

/**
 * tanh soft clip. Instantaneous, so unlike a compressor it cannot duck and
 * leave a hole; input past full scale clamps to the last curve entry.
 */
export function softClipCurve(k, n = 1024) {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(k * x) / norm) * CEILING;
  }
  return c;
}

/**
 * `comp` goes on the DynamicsCompressor, `makeup` on the gain after it, `clip`
 * is the soft-clip drive (0 = no shaper). Labels live in index.html.
 */
export const MODULATION = {
  // What shipped before this setting existed. Kept so a change is reversible.
  clasica: {
    comp: { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
    makeup: 1,
    clip: 0,
  },
  // Ceiling only: no time constants anywhere, so no pumping and no hole.
  limite: {
    comp: { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 },
    makeup: 1,
    clip: 2,
  },
  // Compressed, but a 50 ms release is under the ear's gap threshold.
  rapido: {
    comp: { threshold: -18, knee: 6, ratio: 4, attack: 0.002, release: 0.05 },
    makeup: 1.2,
    clip: 2,
  },
  // Quiet passages lifted by the low threshold plus makeup: one steady level.
  nivelado: {
    comp: { threshold: -40, knee: 12, ratio: 6, attack: 0.01, release: 0.4 },
    makeup: 2.5,
    clip: 3,
  },
  // The raw voice, for judging what the others cost.
  cruda: {
    comp: { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25 },
    makeup: 1,
    clip: 0,
  },
};

// The complaint this setting answers is the dropout, so the fix is the default.
export const MODULATION_DEFAULT = "limite";

/** The named preset, or the default for an unknown/stale stored name. */
export function modulation(name) {
  return MODULATION[name] || MODULATION[MODULATION_DEFAULT];
}
