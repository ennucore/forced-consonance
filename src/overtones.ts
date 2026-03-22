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

// ---------------------------------------------------------------------------
// Preset application
// ---------------------------------------------------------------------------

export function applyPreset(preset: WaveformPreset): void {
  switch (preset) {
    case "sine":
      setOvertoneAmps(sineAmps());
      break;
    case "sawtooth":
      setOvertoneAmps(sawtoothAmps());
      break;
    case "square":
      setOvertoneAmps(squareAmps());
      break;
    case "triangle":
      setOvertoneAmps(triangleAmps());
      break;
    case "string":
      setOvertoneAmps(stringAmps());
      break;
    case "piano":
      setOvertoneAmps(pianoAmps());
      break;
  }
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

/** Average dissonance across a set of common intervals (P5, M3, P4, etc.) */
function averageDissonance(amps: number[]): number {
  const ratios = [6 / 5, 5 / 4, 4 / 3, 3 / 2, 5 / 3];
  let total = 0;
  for (const ratio of ratios) {
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
  return total / ratios.length;
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
// Adam optimizer: tune overtone amps to reach a target dissonance
// ---------------------------------------------------------------------------

const ADAM_STEPS = 20;
const ADAM_LR = 0.05;
const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPS = 1e-8;
const GRAD_DELTA = 1e-4;

/**
 * Run 20 steps of Adam on log-scale overtone amplitudes to reach
 * targetDissonance. Total energy (sum of amp^2) is normalized after
 * each step to preserve loudness.
 *
 * @param currentAmps  Starting amplitudes
 * @param target       Target dissonance value (0 = pure sine, higher = rougher)
 * @returns            New amplitude array
 */
export function optimizeDissonance(
  currentAmps: number[],
  target: number
): number[] {
  const n = currentAmps.length;

  // Work in log space: theta = log(amp + eps)
  const theta = currentAmps.map((a) => Math.log(Math.max(a, 1e-6)));

  // Adam state
  const m = new Float64Array(n);
  const v = new Float64Array(n);

  for (let step = 0; step < ADAM_STEPS; step++) {
    // Current amps from theta
    const amps = theta.map((t) => Math.exp(t));
    const energy = amps.reduce((s, a) => s + a * a, 0);
    const scale = energy > 0 ? Math.sqrt(1 / energy) : 1;
    const normAmps = amps.map((a) => a * scale);

    const currentD = averageDissonance(normAmps);
    const loss = (currentD - target) ** 2;

    // Numerical gradient in log space
    const grad = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const saved = theta[i]!;
      theta[i] = saved + GRAD_DELTA;

      const pertAmps = theta.map((t) => Math.exp(t));
      const pertEnergy = pertAmps.reduce((s, a) => s + a * a, 0);
      const pertScale = pertEnergy > 0 ? Math.sqrt(1 / pertEnergy) : 1;
      const pertNorm = pertAmps.map((a) => a * pertScale);
      const pertD = averageDissonance(pertNorm);
      const pertLoss = (pertD - target) ** 2;

      grad[i] = (pertLoss - loss) / GRAD_DELTA;
      theta[i] = saved;
    }

    // Adam update
    const t = step + 1;
    for (let i = 0; i < n; i++) {
      m[i] = ADAM_BETA1 * m[i]! + (1 - ADAM_BETA1) * grad[i]!;
      v[i] = ADAM_BETA2 * v[i]! + (1 - ADAM_BETA2) * grad[i]! * grad[i]!;

      const mHat = m[i]! / (1 - ADAM_BETA1 ** t);
      const vHat = v[i]! / (1 - ADAM_BETA2 ** t);

      theta[i] = theta[i]! - ADAM_LR * mHat / (Math.sqrt(vHat) + ADAM_EPS);
    }
  }

  // Final: convert back from log, ensure fundamental is loudest, normalize energy
  const finalAmps = theta.map((t) => Math.exp(t));
  const maxOvertone = Math.max(...finalAmps.slice(1), 0);
  if (finalAmps[0]! <= maxOvertone) {
    finalAmps[0] = maxOvertone * 1.2;
  }
  const finalEnergy = finalAmps.reduce((s, a) => s + a * a, 0);
  const finalScale = finalEnergy > 0 ? Math.sqrt(1 / finalEnergy) : 1;
  return finalAmps.map((a) => Math.max(0, Math.min(1, a * finalScale)));
}
