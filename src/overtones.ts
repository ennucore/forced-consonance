import { createSignal } from "solid-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OVERTONE_COUNT = 16;

// ---------------------------------------------------------------------------
// Waveform presets
// ---------------------------------------------------------------------------

export type WaveformPreset = "sawtooth" | "sine" | "square" | "triangle";

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

/**
 * Compute the Sethares sensory-dissonance curve for a complex tone played
 * against itself transposed by ratio r.
 *
 * For each ratio r in [rMin, rMax], we sum the pairwise roughness between
 * partial i of note A (frequency i) and partial j of note B (frequency j*r),
 * weighted by their amplitudes.
 *
 * @param amps   Amplitude array of length OVERTONE_COUNT (partial n = index+1)
 * @param points Number of sample points across the ratio range
 * @param rMin   Minimum frequency ratio (default 0.5 = one octave below)
 * @param rMax   Maximum frequency ratio (default 2.5)
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
      const fi = i + 1; // partial frequency (relative to fundamental)

      for (let j = 0; j < amps.length; j++) {
        const wj = amps[j];
        if (wj === 0) continue;
        const fj = (j + 1) * ratio; // partial frequency of transposed note

        // Relative detuning of fj with respect to fi
        const x = fj / fi - 1;
        dissonance += wi * wj * kernel(x);
      }
    }

    result.push({ ratio, dissonance });
  }

  return result;
}
