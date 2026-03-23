import { createSignal } from "solid-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OVERTONE_COUNT = 16;

// Harmonic multipliers: which frequency ratios the overtone bars represent.
// Integer mode: [1, 2, 3, ..., 16]
// Half-step mode: [1, 1.5, 2, 2.5, ..., 8.5]
export const [halfSteps, setHalfSteps] = createSignal(false);

export function getHarmonics(): number[] {
  if (halfSteps()) {
    return Array.from({ length: OVERTONE_COUNT }, (_, i) => 1 + i * 0.5);
  }
  return Array.from({ length: OVERTONE_COUNT }, (_, i) => i + 1);
}

// ---------------------------------------------------------------------------
// Waveform presets
// ---------------------------------------------------------------------------

export type WaveformPreset =
  | "sawtooth" | "sine" | "square" | "triangle" | "string" | "piano"
  | "clarinet" | "oboe" | "brass" | "flute" | "bell" | "organ" | "vowelA" | "vowelE";

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

// Clarinet: strong odd harmonics, weak even (cylindrical bore)
function clarinetAmps(): number[] {
  return Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    if (n % 2 === 0) return 0.05 / n;
    return 1 / n;
  });
}

// Oboe: all harmonics present, peaked around 3rd-5th, gradual rolloff
function oboeAmps(): number[] {
  const raw = Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    return Math.exp(-0.3 * (n - 3) * (n - 3)) / n;
  });
  const max = Math.max(...raw);
  return raw.map((a) => a / max);
}

// Brass: strong low harmonics with formant bump around 8th-10th
function brassAmps(): number[] {
  const raw = Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    const base = 1 / n;
    const formant = 0.5 * Math.exp(-0.5 * (n - 9) * (n - 9));
    return base + formant;
  });
  const max = Math.max(...raw);
  return raw.map((a) => a / max);
}

// Flute: very strong fundamental, weak upper harmonics
function fluteAmps(): number[] {
  return Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    return Math.exp(-0.8 * (n - 1));
  });
}

// Bell: inharmonic-ish but approximated on harmonic grid, sharp attack profile
function bellAmps(): number[] {
  const raw = Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    // Bells have energy at scattered partials
    return (1 / Math.sqrt(n)) * (1 + 0.5 * Math.sin(n * 1.7));
  });
  const max = Math.max(...raw);
  return raw.map((a) => Math.max(0, a / max));
}

// Organ: equal amplitude for all harmonics (additive registration)
function organAmps(): number[] {
  return Array.from({ length: OVERTONE_COUNT }, () => 1);
}

// Vowel "A" (as in "father"): formants at ~800Hz and ~1200Hz
// Approximated as emphasis on harmonics 3-5 relative to a 220Hz fundamental
function vowelAAmps(): number[] {
  const raw = Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    const f1 = Math.exp(-2 * (n - 3.5) * (n - 3.5));
    const f2 = 0.6 * Math.exp(-2 * (n - 5.5) * (n - 5.5));
    return (f1 + f2 + 0.1) / n;
  });
  const max = Math.max(...raw);
  return raw.map((a) => a / max);
}

// Vowel "E" (as in "see"): formants at ~300Hz and ~2500Hz
// Emphasis on harmonics 1-2 and 10-12
function vowelEAmps(): number[] {
  const raw = Array.from({ length: OVERTONE_COUNT }, (_, i) => {
    const n = i + 1;
    const f1 = Math.exp(-2 * (n - 1.5) * (n - 1.5));
    const f2 = 0.5 * Math.exp(-1 * (n - 11) * (n - 11));
    return (f1 + f2 + 0.05) / n;
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

export function getPresetAmps(preset: WaveformPreset): number[] {
  switch (preset) {
    case "sine": return sineAmps();
    case "sawtooth": return sawtoothAmps();
    case "square": return squareAmps();
    case "triangle": return triangleAmps();
    case "string": return stringAmps();
    case "piano": return pianoAmps();
    case "clarinet": return clarinetAmps();
    case "oboe": return oboeAmps();
    case "brass": return brassAmps();
    case "flute": return fluteAmps();
    case "bell": return bellAmps();
    case "organ": return organAmps();
    case "vowelA": return vowelAAmps();
    case "vowelE": return vowelEAmps();
  }
}

export function applyPreset(preset: WaveformPreset): void {
  setOvertoneAmps(getPresetAmps(preset));
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
      const harmonics = getHarmonics();
      for (let i = 0; i < amps.length; i++) {
        const wi = amps[i]!;
        if (wi === 0) continue;
        const fi = harmonics[i]!;
        for (let j = 0; j < amps.length; j++) {
          const wj = amps[j]!;
          if (wj === 0) continue;
          const fj = harmonics[j]! * ratio;
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

    const harmonics = getHarmonics();
    for (let i = 0; i < amps.length; i++) {
      const wi = amps[i];
      if (wi === 0) continue;
      const fi = harmonics[i]!;

      for (let j = 0; j < amps.length; j++) {
        const wj = amps[j];
        if (wj === 0) continue;
        const fj = harmonics[j]! * ratio;

        const x = fj / fi - 1;
        dissonance += wi * wj * kernel(x);
      }
    }

    result.push({ ratio, dissonance });
  }

  return result;
}

