import { createSignal } from "solid-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OVERTONE_COUNT = 16;

// ---------------------------------------------------------------------------
// Waveform presets
// ---------------------------------------------------------------------------

export type WaveformPreset = "sawtooth" | "sine" | "square" | "triangle" | "string" | "piano";

function sawtoothAmps(): number[] {
  return Array.from({ length: OVERTONE_COUNT }, (_, i) => 1 / (i + 1));
}

function sineAmps(): number[] {
  return Array.from({ length: OVERTONE_COUNT }, (_, i) => (i === 0 ? 1.0 : 0));
}

function squareAmps(): number[] {
  return Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    return n % 2 === 1 ? 1 / n : 0;
  });
}

function triangleAmps(): number[] {
  return Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    return n % 2 === 1 ? 1 / (n * n) : 0;
  });
}

// Plucked string: sin(n*pi*p) / n^2 where p ≈ 0.2 (pluck at 1/5 of string)
// Naturally suppresses every 5th harmonic, gives a warm guitar-like tone
function stringAmps(): number[] {
  const p = 0.2;
  const raw = Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    return Math.abs(Math.sin(n * Math.PI * p)) / (n * n);
  });
  const max = Math.max(...raw);
  return raw.map((a) => a / max);
}

// Piano: hammer strike at p ≈ 1/7 of string, with exponential damping
// Suppresses 7th harmonic and multiples, higher partials decay faster
function pianoAmps(): number[] {
  const p = 1 / 7;
  const raw = Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    return (Math.abs(Math.sin(n * Math.PI * p)) / n) * Math.exp(-0.04 * n * n);
  });
  const max = Math.max(...raw);
  return raw.map((a) => a / max);
}

// ---------------------------------------------------------------------------
// Reactive overtone state
// ---------------------------------------------------------------------------

export const [overtoneAmps, setOvertoneAmps] =
  createSignal<number[]>(sawtoothAmps());

// Reference spectrum: the instrument preset we want to stay close to
export const [referenceAmps, setReferenceAmps] =
  createSignal<number[]>(sawtoothAmps());

// ---------------------------------------------------------------------------
// Preset application
// ---------------------------------------------------------------------------

function getPresetAmps(preset: WaveformPreset): number[] {
  switch (preset) {
    case "sine": return sineAmps();
    case "sawtooth": return sawtoothAmps();
    case "square": return squareAmps();
    case "triangle": return triangleAmps();
    case "string": return stringAmps();
    case "piano": return pianoAmps();
  }
}

export function applyPreset(preset: WaveformPreset): void {
  const amps = getPresetAmps(preset);
  setOvertoneAmps(amps);
  setReferenceAmps(amps);
}

// ---------------------------------------------------------------------------
// Sethares-style sensory dissonance
// ---------------------------------------------------------------------------

// Roughness kernel: captures beating / roughness between two partials whose
// relative frequency difference is x = f2/f1 - 1.
const KERNEL_A = 0.0023;

function kernel(x: number): number {
  const absx = Math.abs(x);
  return 50 * absx * Math.exp(-(x * x) / KERNEL_A);
}

/**
 * Compute total dissonance for a set of fundamentals with the given overtone
 * amplitudes. Sums pairwise roughness across all pairs of fundamentals.
 * Returns 0 if fewer than 2 notes are playing.
 */
export function computeChordDissonance(
  amps: number[],
  fundamentals: number[]
): number {
  if (fundamentals.length < 2) return 0;

  let total = 0;
  for (let a = 0; a < fundamentals.length; a++) {
    for (let b = a + 1; b < fundamentals.length; b++) {
      const ratio = fundamentals[b]! / fundamentals[a]!;
      // Sum pairwise partial roughness for this interval
      for (let i = 0; i < amps.length; i++) {
        const wi = amps[i]!;
        if (wi === 0) continue;
        const fi = i + 1;
        for (let j = 0; j < amps.length; j++) {
          const wj = amps[j]!;
          if (wj === 0) continue;
          const fj = (j + 1) * ratio;
          total += wi * wj * kernel(fj / fi - 1);
        }
      }
    }
  }
  return total;
}

/**
 * Compute the Sethares sensory-dissonance curve for a complex tone played
 * against itself transposed by ratio r.
 */
export function computeDissonanceCurve(
  amps: number[],
  points: number = 800,
  rMin: number = 0.5,
  rMax: number = 2.5
): { ratio: number; dissonance: number }[] {
  const result: { ratio: number; dissonance: number }[] = [];

  for (let p = 0; p < points; p++) {
    const ratio = rMin + (p / (points - 1)) * (rMax - rMin);
    let dissonance = 0;

    for (let i = 0; i < amps.length; i++) {
      const wi = amps[i];
      if (wi === 0) continue;
      const fi = i + 1;

      for (let j = 0; j < amps.length; j++) {
        const wj = amps[j];
        if (wj === 0) continue;
        const fj = (j + 1) * ratio;

        const x = fj / fi - 1;
        dissonance += wi * wj * kernel(x);
      }
    }

    result.push({ ratio, dissonance });
  }

  return result;
}

// ---------------------------------------------------------------------------
// FFT spectrum representation
// ---------------------------------------------------------------------------

const SPEC_BINS = 1024;
const HZ_PER_BIN = 20; // 0–20480 Hz
const FALLBACK_FUNDAMENTALS = [220, 220 * 5 / 4, 220 * 3 / 2]; // A3 major triad

/**
 * Build a frequency spectrum: place overtone energies at their Hz bins
 * for every active fundamental.
 */
function buildSpectrum(
  amps: number[],
  fundamentals: number[]
): Float64Array {
  const spec = new Float64Array(SPEC_BINS);
  for (const f0 of fundamentals) {
    for (let i = 0; i < amps.length; i++) {
      const a = amps[i]!;
      if (a === 0) continue;
      const bin = Math.round((f0 * (i + 1)) / HZ_PER_BIN);
      if (bin >= 0 && bin < SPEC_BINS) {
        spec[bin] += a * a; // energy
      }
    }
  }
  return spec;
}

/**
 * Dissonance from the frequency spectrum: sum roughness between all
 * pairs of occupied bins using the Sethares kernel.
 */
function spectralDissonance(spec: Float64Array): number {
  // Collect non-zero bins
  const active: { bin: number; energy: number }[] = [];
  for (let i = 0; i < SPEC_BINS; i++) {
    if (spec[i]! > 0) active.push({ bin: i, energy: spec[i]! });
  }

  let total = 0;
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const fa = active[a]!.bin * HZ_PER_BIN;
      const fb = active[b]!.bin * HZ_PER_BIN;
      if (fa === 0) continue;
      const x = fb / fa - 1;
      // Weight by sqrt of energies (amplitude product)
      total += Math.sqrt(active[a]!.energy * active[b]!.energy) * kernel(x);
    }
  }
  return total;
}

/**
 * Wasserstein W1 distance between two spectra in frequency space.
 * Normalizes energy to probability, then sums |CDF_a - CDF_b| * bin_width.
 */
function spectralWasserstein(a: Float64Array, b: Float64Array): number {
  let sumA = 0, sumB = 0;
  for (let i = 0; i < SPEC_BINS; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  if (sumA === 0 || sumB === 0) return 0;

  let cdfA = 0, cdfB = 0, dist = 0;
  for (let i = 0; i < SPEC_BINS; i++) {
    cdfA += a[i]! / sumA;
    cdfB += b[i]! / sumB;
    dist += Math.abs(cdfA - cdfB);
  }
  return dist / SPEC_BINS; // normalize by bin count
}

// ---------------------------------------------------------------------------
// Adam optimizer in FFT space
// ---------------------------------------------------------------------------

const ADAM_STEPS = 20;
const ADAM_LR = 0.05;
const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPS = 1e-8;
const GRAD_DELTA = 1e-4;
const WASSERSTEIN_LAMBDA = 0.3;

export type LossRecord = {
  total: number;
  dissonance: number;
  wasserstein: number;
};
export const [lossHistory, setLossHistory] = createSignal<LossRecord[]>([]);

function computeLoss(
  amps: number[],
  target: number,
  fundamentals: number[],
  refAmps: number[]
): LossRecord {
  const spec = buildSpectrum(amps, fundamentals);
  const refSpec = buildSpectrum(refAmps, fundamentals);

  const d = spectralDissonance(spec);
  const dLoss = (d - target) ** 2;
  const wLoss = spectralWasserstein(spec, refSpec);

  return {
    dissonance: dLoss,
    wasserstein: wLoss,
    total: dLoss + WASSERSTEIN_LAMBDA * wLoss,
  };
}

/**
 * Run 20 steps of Adam on log-scale overtone amplitudes.
 * All losses (dissonance + Wasserstein) are computed in FFT spectrum
 * space — actual frequency bins with real Hz positions.
 */
export function optimizeDissonance(
  currentAmps: number[],
  target: number,
  fundamentals: number[] = []
): number[] {
  const n = currentAmps.length;
  const ref = referenceAmps();
  const freqs = fundamentals.length >= 2 ? fundamentals : FALLBACK_FUNDAMENTALS;

  const theta = currentAmps.map((a) => Math.log(Math.max(a, 1e-6)));

  const m = new Float64Array(n);
  const v = new Float64Array(n);
  const history: LossRecord[] = [];

  for (let step = 0; step < ADAM_STEPS; step++) {
    const amps = theta.map((t) => Math.exp(t));
    const energy = amps.reduce((s, a) => s + a * a, 0);
    const scale = energy > 0 ? Math.sqrt(1 / energy) : 1;
    const normAmps = amps.map((a) => a * scale);

    const losses = computeLoss(normAmps, target, freqs, ref);
    history.push(losses);

    const grad = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const saved = theta[i]!;
      theta[i] = saved + GRAD_DELTA;

      const pertAmps = theta.map((t) => Math.exp(t));
      const pertEnergy = pertAmps.reduce((s, a) => s + a * a, 0);
      const pertScale = pertEnergy > 0 ? Math.sqrt(1 / pertEnergy) : 1;
      const pertNorm = pertAmps.map((a) => a * pertScale);
      const pertLosses = computeLoss(pertNorm, target, freqs, ref);

      grad[i] = (pertLosses.total - losses.total) / GRAD_DELTA;
      theta[i] = saved;
    }

    const t = step + 1;
    for (let i = 0; i < n; i++) {
      m[i] = ADAM_BETA1 * m[i]! + (1 - ADAM_BETA1) * grad[i]!;
      v[i] = ADAM_BETA2 * v[i]! + (1 - ADAM_BETA2) * grad[i]! * grad[i]!;

      const mHat = m[i]! / (1 - ADAM_BETA1 ** t);
      const vHat = v[i]! / (1 - ADAM_BETA2 ** t);

      theta[i] = theta[i]! - ADAM_LR * mHat / (Math.sqrt(vHat) + ADAM_EPS);
    }
  }

  setLossHistory(history);

  const finalAmps = theta.map((t) => Math.exp(t));
  const maxOvertone = Math.max(...finalAmps.slice(1), 0);
  if (finalAmps[0]! <= maxOvertone) {
    finalAmps[0] = maxOvertone * 1.2;
  }
  const finalEnergy = finalAmps.reduce((s, a) => s + a * a, 0);
  const finalScale = finalEnergy > 0 ? Math.sqrt(1 / finalEnergy) : 1;
  return finalAmps.map((a) => Math.max(0, Math.min(1, a * finalScale)));
}
