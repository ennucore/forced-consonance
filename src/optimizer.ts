import { createSignal } from "solid-js";
import {
  type SpectralPeak,
  getPoolFreqs,
  REFERENCE_PEAK_LIMIT,
  referenceSpectrum,
  renderPeaksToSpectrum,
  setOptimizerActive,
  updateSpectrum,
} from "./audio";

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

export const [dissWeight, setDissWeight] = createSignal(2.0);
export const [matchWeight, setMatchWeight] = createSignal(0.25);
export const [freqLr, setFreqLr] = createSignal(0.0004);
export const [energyLr, setEnergyLr] = createSignal(0.001);
export const [targetDiss, setTargetDiss] = createSignal(0.0);
export const [running, setRunning] = createSignal(false);

export const [dissHistory, setDissHistory] = createSignal<number[]>([]);
export const [matchHistory, setMatchHistory] = createSignal<number[]>([]);
export const [optimizedPeaks, setOptimizedPeaks] = createSignal<SpectralPeak[]>([]);

const HISTORY_MAX = 300;

function pushHistory(
  setter: (fn: (prev: number[]) => number[]) => void,
  value: number,
) {
  setter((prev) => {
    const next = [...prev, value];
    if (next.length > HISTORY_MAX) next.shift();
    return next;
  });
}

// ---------------------------------------------------------------------------
// Peak objective
// ---------------------------------------------------------------------------

const KERNEL_A = 0.0023;
const LOG_FREQ_DELTA = 1e-4;
const ENERGY_DELTA = 1e-4;
const ENERGY_FLOOR = 1e-8;
const STATE_ENERGY_MIN = 0;
const ENERGY_MAX = Math.exp(4);
const OPTIMIZED_PEAK_COUNT = REFERENCE_PEAK_LIMIT;
const MATCH_ENERGY_WEIGHT = 500;
const UNMATCHED_ENERGY_WEIGHT = 4;
const TARGET_BIN_THRESHOLD_RATIO = 1e-3;
const MATCH_STEPS_PER_TICK = 5;
const DISS_STEPS_PER_TICK = 5;

export type MatchTarget = {
  logFreq: number;
  energy: number;
};

export type PeakMatch = {
  peakIndex: number;
  targetIndex: number | null;
  cost: number;
};

export const [matchTargets, setMatchTargets] = createSignal<MatchTarget[]>([]);
export const [peakMatches, setPeakMatches] = createSignal<PeakMatch[]>([]);

function kernel(x: number): number {
  const absx = Math.abs(x);
  return 50 * absx * Math.exp(-(x * x) / KERNEL_A);
}

function totalEnergy(peaks: SpectralPeak[]): number {
  let total = 0;
  for (const peak of peaks) total += peak.energy;
  return total;
}

function peakDissonance(peaks: SpectralPeak[]): number {
  if (peaks.length < 2) return 0;

  let total = 0;
  for (let i = 0; i < peaks.length; i++) {
    const a = peaks[i]!;
    const ampA = Math.sqrt(a.energy);
    if (ampA <= 1e-6) continue;

    for (let j = i + 1; j < peaks.length; j++) {
      const b = peaks[j]!;
      const ampB = Math.sqrt(b.energy);
      if (ampB <= 1e-6) continue;

      const low = Math.min(a.centerFreq, b.centerFreq);
      const high = Math.max(a.centerFreq, b.centerFreq);
      total += ampA * ampB * kernel(high / low - 1);
    }
  }
  return total;
}

function targetDissonance(): number {
  return Math.max(0, targetDiss());
}

function spectrumEnergy(spectrum: Float64Array): number {
  let total = 0;
  for (let i = 0; i < spectrum.length; i++) {
    total += spectrum[i]! * spectrum[i]!;
  }
  return total;
}

function spectrumToEnergies(spectrum: Float64Array): Float64Array {
  const energies = new Float64Array(spectrum.length);
  for (let i = 0; i < spectrum.length; i++) {
    energies[i] = spectrum[i]! * spectrum[i]!;
  }
  return energies;
}

function extractEnergeticTargets(targetEnergies: Float64Array): MatchTarget[] {
  let maxEnergy = 0;
  let strongestIndex = 0;

  for (let i = 0; i < targetEnergies.length; i++) {
    const energy = targetEnergies[i]!;
    if (energy > maxEnergy) {
      maxEnergy = energy;
      strongestIndex = i;
    }
  }

  const threshold = Math.max(ENERGY_FLOOR, maxEnergy * TARGET_BIN_THRESHOLD_RATIO);
  const peakIndices: number[] = [];

  for (let i = 0; i < targetEnergies.length; i++) {
    const energy = targetEnergies[i]!;
    if (energy < threshold) continue;

    const prev = i > 0 ? targetEnergies[i - 1]! : -Infinity;
    const next = i + 1 < targetEnergies.length ? targetEnergies[i + 1]! : -Infinity;
    if (energy >= prev && energy >= next) {
      peakIndices.push(i);
    }
  }

  if (peakIndices.length === 0 && maxEnergy > ENERGY_FLOOR) {
    peakIndices.push(strongestIndex);
  }

  peakIndices.sort((a, b) => targetEnergies[b]! - targetEnergies[a]! || poolLogFreqs[a]! - poolLogFreqs[b]!);
  const selected = peakIndices
    .slice(0, OPTIMIZED_PEAK_COUNT)
    .sort((a, b) => poolLogFreqs[a]! - poolLogFreqs[b]!);

  return selected.map((index) => ({
    logFreq: poolLogFreqs[index]!,
    energy: targetEnergies[index]!,
  }));
}

function hungarianAssignment(costs: number[][]): number[] {
  const rowCount = costs.length;
  if (rowCount === 0) return [];

  const colCount = costs[0]!.length;
  if (colCount < rowCount) {
    throw new Error("hungarianAssignment requires at least as many columns as rows");
  }
  const u = new Float64Array(rowCount + 1);
  const v = new Float64Array(colCount + 1);
  const p = new Int32Array(colCount + 1);
  const way = new Int32Array(colCount + 1);

  for (let i = 1; i <= rowCount; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(colCount + 1);
    minv.fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(colCount + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;

      for (let j = 1; j <= colCount; j++) {
        if (used[j]) continue;
        const cur = costs[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }

      for (let j = 0; j <= colCount; j++) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array<number>(rowCount).fill(0);
  for (let j = 1; j <= colCount; j++) {
    if (p[j]! !== 0) assignment[p[j]! - 1] = j - 1;
  }
  return assignment;
}

function pairCost(peak: SpectralPeak, target: MatchTarget): number {
  const semitoneOffset = 12 * (Math.log2(peak.centerFreq) - target.logFreq);
  const energyOffset = peak.energy - target.energy;
  return semitoneOffset * semitoneOffset + MATCH_ENERGY_WEIGHT * energyOffset * energyOffset;
}

function solveMatching(peaks: SpectralPeak[], targets: MatchTarget[]): PeakMatch[] {
  const matches: PeakMatch[] = peaks.map((_, peakIndex) => ({
    peakIndex,
    targetIndex: null,
    cost: 0,
  }));

  if (peaks.length === 0 || targets.length === 0) {
    return matches;
  }

  const costs: number[][] = [];
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const row = new Array<number>(peaks.length);
    for (let peakIndex = 0; peakIndex < peaks.length; peakIndex++) {
      row[peakIndex] = pairCost(peaks[peakIndex]!, targets[targetIndex]!);
    }
    costs.push(row);
  }

  const assignment = hungarianAssignment(costs);
  for (let targetIndex = 0; targetIndex < assignment.length; targetIndex++) {
    const peakIndex = assignment[targetIndex]!;
    matches[peakIndex] = {
      peakIndex,
      targetIndex,
      cost: costs[targetIndex]![peakIndex]!,
    };
  }

  return matches;
}

function unmatchedLoss(peaks: SpectralPeak[], matches: PeakMatch[]): number {
  let total = 0;
  for (const match of matches) {
    if (match.targetIndex !== null) continue;
    const peak = peaks[match.peakIndex]!;
    total += UNMATCHED_ENERGY_WEIGHT * peak.energy * peak.energy;
  }
  return total / Math.max(peaks.length, 1);
}

function matchedPeaks(peaks: SpectralPeak[], matches: PeakMatch[]): SpectralPeak[] {
  const result: SpectralPeak[] = [];
  for (const match of matches) {
    if (match.targetIndex === null) continue;
    result.push(peaks[match.peakIndex]!);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Optimized peak state
// ---------------------------------------------------------------------------

let logFreqs = new Float64Array(0);
let energies = new Float64Array(0);
let initialized = false;

const poolFreqs = getPoolFreqs();
const poolLogFreqs = poolFreqs.map((freq) => Math.log2(freq));
const minLogFreq = Math.log2(poolFreqs[0]!);
const maxLogFreq = Math.log2(poolFreqs[poolFreqs.length - 1]!);

function initFromTargets(targets: MatchTarget[]) {
  logFreqs = new Float64Array(OPTIMIZED_PEAK_COUNT);
  energies = new Float64Array(OPTIMIZED_PEAK_COUNT);

  for (let i = 0; i < OPTIMIZED_PEAK_COUNT; i++) {
    const t = OPTIMIZED_PEAK_COUNT > 1 ? i / (OPTIMIZED_PEAK_COUNT - 1) : 0;
    logFreqs[i] = minLogFreq + (maxLogFreq - minLogFreq) * t;
    energies[i] = 0;
  }

  for (let i = 0; i < Math.min(targets.length, OPTIMIZED_PEAK_COUNT); i++) {
    logFreqs[i] = targets[i]!.logFreq;
    energies[i] = targets[i]!.energy;
  }

  initialized = true;
  resetAdam();
}

// Merge peaks closer than 1 semitone: energy-weighted avg frequency, sum energy
function mergeClosePeaks() {
  const HALF_STEP = 1 / 12; // 1 semitone in log2 (octaves)

  // Sort by logFreq
  const indices = Array.from({ length: logFreqs.length }, (_, i) => i);
  indices.sort((a, b) => logFreqs[a]! - logFreqs[b]!);

  const merged = new Set<number>();

  for (let k = 0; k < indices.length - 1; k++) {
    const i = indices[k]!;
    const j = indices[k + 1]!;
    if (merged.has(i) || merged.has(j)) continue;

    const dist = Math.abs(logFreqs[j]! - logFreqs[i]!);
    if (dist < HALF_STEP) {
      const ei = energies[i]!;
      const ej = energies[j]!;
      const totalE = ei + ej;
      if (totalE > ENERGY_FLOOR) {
        // Energy-weighted average in log-freq space
        logFreqs[i] = (ei * logFreqs[i]! + ej * logFreqs[j]!) / totalE;
        energies[i] = totalE;
      }
      // Zero out the merged peak
      energies[j] = 0;
      merged.add(j);
    }
  }
}

function peaksFromState(): SpectralPeak[] {
  const peaks: SpectralPeak[] = [];

  for (let i = 0; i < logFreqs.length; i++) {
    peaks.push({
      centerFreq: Math.pow(
        2,
        Math.max(minLogFreq, Math.min(maxLogFreq, logFreqs[i]!)),
      ),
      energy: Math.max(STATE_ENERGY_MIN, Math.min(ENERGY_MAX, energies[i]!)),
    });
  }

  return peaks;
}

function resolveMatches(
  peaks: SpectralPeak[],
  targets: MatchTarget[],
  matches: PeakMatch[],
): {
  resolvedMatches: PeakMatch[];
  matchedLoss: number;
} {
  let matchedCount = 0;
  let matchedTotal = 0;
  const resolvedMatches = matches.map((match) => {
    if (match.targetIndex === null) {
      return { ...match, cost: 0 };
    }
    const cost = pairCost(peaks[match.peakIndex]!, targets[match.targetIndex]!);
    matchedCount++;
    matchedTotal += cost;
    return { ...match, cost };
  });

  return {
    resolvedMatches,
    matchedLoss: matchedTotal / Math.max(matchedCount, 1),
  };
}

function evaluateMatchObjective(
  peaks: SpectralPeak[],
  targets: MatchTarget[],
  matches: PeakMatch[],
): {
  peaks: SpectralPeak[];
  matches: PeakMatch[];
  match: number;
  loss: number;
} {
  const { resolvedMatches, matchedLoss } = resolveMatches(peaks, targets, matches);
  const match = matchedLoss + unmatchedLoss(peaks, resolvedMatches);

  return {
    peaks,
    matches: resolvedMatches,
    match,
    loss: matchWeight() * match,
  };
}

function matchObjective(targets: MatchTarget[]) {
  const peaks = peaksFromState();
  const matches = solveMatching(peaks, targets);
  return evaluateMatchObjective(peaks, targets, matches);
}

function matchGradients(targets: MatchTarget[]) {
  const base = matchObjective(targets);
  const baseMatches = base.matches;
  const freqGrad = new Float64Array(logFreqs.length);
  const energyGrad = new Float64Array(energies.length);

  for (let i = 0; i < logFreqs.length; i++) {
    if (isMatched(baseMatches[i])) {
      const savedFreq = logFreqs[i]!;
      logFreqs[i] = savedFreq + LOG_FREQ_DELTA;
      freqGrad[i] = (
        evaluateMatchObjective(peaksFromState(), targets, baseMatches).loss - base.loss
      ) / LOG_FREQ_DELTA;
      logFreqs[i] = savedFreq;
    } else {
      freqGrad[i] = 0;
    }

    const savedEnergy = energies[i]!;
    energies[i] = savedEnergy + ENERGY_DELTA;
    energyGrad[i] = (
      evaluateMatchObjective(peaksFromState(), targets, baseMatches).loss - base.loss
    ) / ENERGY_DELTA;
    energies[i] = savedEnergy;
  }

  return { baseMatches, freqGrad, energyGrad };
}

function evaluateDissObjective(
  peaks: SpectralPeak[],
  targets: MatchTarget[],
  matches: PeakMatch[],
  targetDiss: number,
): {
  peaks: SpectralPeak[];
  matches: PeakMatch[];
  diss: number;
  loss: number;
} {
  const { resolvedMatches } = resolveMatches(peaks, targets, matches);
  const currentDiss = peakDissonance(matchedPeaks(peaks, resolvedMatches));
  const dissGap = currentDiss - targetDiss;
  const diss = dissGap * dissGap;

  return {
    peaks,
    matches: resolvedMatches,
    diss,
    loss: dissWeight() * diss,
  };
}

function dissObjective(targets: MatchTarget[], targetDiss: number) {
  const peaks = peaksFromState();
  const matches = solveMatching(peaks, targets);
  return evaluateDissObjective(peaks, targets, matches, targetDiss);
}

function dissGradients(targets: MatchTarget[], targetDiss: number) {
  const base = dissObjective(targets, targetDiss);
  const baseMatches = base.matches;
  const freqGrad = new Float64Array(logFreqs.length);
  const energyGrad = new Float64Array(energies.length);

  for (let i = 0; i < logFreqs.length; i++) {
    if (isMatched(baseMatches[i])) {
      const savedFreq = logFreqs[i]!;
      logFreqs[i] = savedFreq + LOG_FREQ_DELTA;
      freqGrad[i] = (
        evaluateDissObjective(peaksFromState(), targets, baseMatches, targetDiss).loss - base.loss
      ) / LOG_FREQ_DELTA;
      logFreqs[i] = savedFreq;
    } else {
      freqGrad[i] = 0;
    }

    const savedEnergy = energies[i]!;
    energies[i] = savedEnergy + ENERGY_DELTA;
    energyGrad[i] = (
      evaluateDissObjective(peaksFromState(), targets, baseMatches, targetDiss).loss - base.loss
    ) / ENERGY_DELTA;
    energies[i] = savedEnergy;
  }

  return { baseMatches, freqGrad, energyGrad };
}

function evaluateObjective(
  peaks: SpectralPeak[],
  targets: MatchTarget[],
  matches: PeakMatch[],
  targetDiss: number,
): {
  peaks: SpectralPeak[];
  matches: PeakMatch[];
  diss: number;
  match: number;
  loss: number;
} {
  const { resolvedMatches, matchedLoss } = resolveMatches(peaks, targets, matches);
  const currentDiss = peakDissonance(matchedPeaks(peaks, resolvedMatches));
  const dissGap = currentDiss - targetDiss;
  const diss = dissGap * dissGap;
  const match = matchedLoss + unmatchedLoss(peaks, resolvedMatches);

  return {
    peaks,
    matches: resolvedMatches,
    diss,
    match,
    loss: dissWeight() * diss + matchWeight() * match,
  };
}

function objective(targets: MatchTarget[], targetDiss: number) {
  const peaks = peaksFromState();
  const matches = solveMatching(peaks, targets);
  return evaluateObjective(peaks, targets, matches, targetDiss);
}

function isMatched(match: PeakMatch | undefined): boolean {
  return !!match && match.targetIndex !== null;
}

const ADAM_BETA1 = 0.0;
const ADAM_BETA2 = 0.99;
const ADAM_EPS = 1e-8;

type AdamState = {
  freqM: Float64Array;
  freqV: Float64Array;
  energyM: Float64Array;
  energyV: Float64Array;
  t: number;
};

function createAdamState(): AdamState {
  return {
    freqM: new Float64Array(0),
    freqV: new Float64Array(0),
    energyM: new Float64Array(0),
    energyV: new Float64Array(0),
    t: 0,
  };
}

let matchAdam = createAdamState();
let dissAdam = createAdamState();

function resetAdamState(state: AdamState) {
  state.freqM = new Float64Array(logFreqs.length);
  state.freqV = new Float64Array(logFreqs.length);
  state.energyM = new Float64Array(energies.length);
  state.energyV = new Float64Array(energies.length);
  state.t = 0;
}

function resetAdam() {
  resetAdamState(matchAdam);
  resetAdamState(dissAdam);
}

function applyAdamStep(
  state: AdamState,
  baseMatches: PeakMatch[],
  freqGrad: Float64Array,
  energyGrad: Float64Array,
) {
  state.t++;
  for (let i = 0; i < logFreqs.length; i++) {
    if (isMatched(baseMatches[i])) {
      state.freqM[i] = ADAM_BETA1 * state.freqM[i]! + (1 - ADAM_BETA1) * freqGrad[i]!;
      state.freqV[i] = ADAM_BETA2 * state.freqV[i]! + (1 - ADAM_BETA2) * freqGrad[i]! * freqGrad[i]!;

      const freqMHat = state.freqM[i]! / (1 - Math.pow(ADAM_BETA1, state.t));
      const freqVHat = state.freqV[i]! / (1 - Math.pow(ADAM_BETA2, state.t));
      logFreqs[i] = Math.max(
        minLogFreq,
        Math.min(
          maxLogFreq,
          logFreqs[i]! - freqLr() * freqMHat / (Math.sqrt(freqVHat) + ADAM_EPS),
        ),
      );
    } else {
      state.freqM[i] = 0;
      state.freqV[i] = 0;
    }

    state.energyM[i] = ADAM_BETA1 * state.energyM[i]! + (1 - ADAM_BETA1) * energyGrad[i]!;
    state.energyV[i] = ADAM_BETA2 * state.energyV[i]! + (1 - ADAM_BETA2) * energyGrad[i]! * energyGrad[i]!;

    const energyMHat = state.energyM[i]! / (1 - Math.pow(ADAM_BETA1, state.t));
    const energyVHat = state.energyV[i]! / (1 - Math.pow(ADAM_BETA2, state.t));
    energies[i] = Math.max(
      STATE_ENERGY_MIN,
      Math.min(
        ENERGY_MAX,
        energies[i]! - energyLr() * energyMHat / (Math.sqrt(energyVHat) + ADAM_EPS),
      ),
    );
  }
}

function matchAdamStep(targets: MatchTarget[]) {
  const { baseMatches, freqGrad, energyGrad } = matchGradients(targets);
  applyAdamStep(matchAdam, baseMatches, freqGrad, energyGrad);
}

function dissAdamStep(targets: MatchTarget[], targetDiss: number) {
  const { baseMatches, freqGrad, energyGrad } = dissGradients(targets, targetDiss);
  applyAdamStep(dissAdam, baseMatches, freqGrad, energyGrad);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function step() {
  const reference = referenceSpectrum();
  const targetTotalEnergy = spectrumEnergy(reference);

  if (targetTotalEnergy <= ENERGY_FLOOR) {
    updateSpectrum(new Float64Array(poolFreqs.length));
    setOptimizedPeaks([]);
    setMatchTargets([]);
    setPeakMatches([]);
    initialized = false;
    resetAdam();
    return;
  }

  const targetEnergies = spectrumToEnergies(reference);
  const targets = extractEnergeticTargets(targetEnergies);
  const desiredDiss = targetDissonance();

  if (!initialized) {
    initFromTargets(targets);
  }

  for (let i = 0; i < MATCH_STEPS_PER_TICK; i++) {
    matchAdamStep(targets);
    mergeClosePeaks();
  }
  for (let i = 0; i < DISS_STEPS_PER_TICK; i++) {
    dissAdamStep(targets, desiredDiss);
    mergeClosePeaks();
  }
  const result = objective(targets, desiredDiss);
  pushHistory(setDissHistory, result.diss);
  pushHistory(setMatchHistory, result.match);
  setOptimizedPeaks(result.peaks);
  setMatchTargets(targets);
  setPeakMatches(result.matches);
  updateSpectrum(renderPeaksToSpectrum(result.peaks));
}

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

let intervalId: number | null = null;

export function startOptimizer() {
  if (intervalId !== null) return;
  setRunning(true);
  setOptimizerActive(true);
  initialized = false;
  intervalId = window.setInterval(step, 33);
}

export function stopOptimizer() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  setRunning(false);
  setOptimizerActive(false);
  setOptimizedPeaks([]);
  setMatchTargets([]);
  setPeakMatches([]);
  initialized = false;
}
