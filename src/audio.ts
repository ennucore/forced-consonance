import { createSignal } from "solid-js";
import { getHarmonics, overtoneAmps } from "./overtones";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// ---------------------------------------------------------------------------
// AnalyserNode
// ---------------------------------------------------------------------------

let analyser: AnalyserNode | null = null;

export function getAnalyser(): AnalyserNode {
  const audio = getCtx();
  if (!analyser) {
    analyser = audio.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(audio.destination);
  }
  return analyser;
}

// ---------------------------------------------------------------------------
// Dense synthesis spectrum
// ---------------------------------------------------------------------------

export type SpectralPeak = {
  centerFreq: number;
  energy: number;
};

const SPECTRUM_MIN_FREQ = 32.70319566257483; // C1
const SPECTRUM_MAX_FREQ = 8000;
export const SPECTRUM_SIZE = 384;
const SPECTRUM_WIDTH_SEMITONES = 0.25;
export const REFERENCE_PEAK_LIMIT = 48;
const PEAK_ENERGY_FLOOR = 1e-8;

const SPECTRUM_FREQS: number[] = Array.from({ length: SPECTRUM_SIZE }, (_, i) => {
  const t = i / (SPECTRUM_SIZE - 1);
  return SPECTRUM_MIN_FREQ * Math.pow(SPECTRUM_MAX_FREQ / SPECTRUM_MIN_FREQ, t);
});

export const [dissDelta, setDissDelta] = createSignal(2.5);

export function getPoolFreqs(): number[] {
  return SPECTRUM_FREQS;
}

function semitoneDistance(freqA: number, freqB: number): number {
  return 12 * Math.log2(freqA / freqB);
}

function peakWeight(centerFreq: number, freq: number): number {
  const distance = Math.abs(semitoneDistance(freq, centerFreq));
  if (distance > SPECTRUM_WIDTH_SEMITONES * 5) return 0;
  const normalized = distance / SPECTRUM_WIDTH_SEMITONES;
  return Math.exp(-0.5 * normalized * normalized);
}

function mergeReferencePeaks(peaks: { logFreq: number; energy: number }[]): { logFreq: number; energy: number }[] {
  if (peaks.length === 0) return [];

  peaks.sort((a, b) => a.logFreq - b.logFreq);
  const merged: { logFreq: number; energy: number }[] = [];

  for (const peak of peaks) {
    const prev = merged[merged.length - 1];
    if (!prev || Math.abs((peak.logFreq - prev.logFreq) * 12) > 0.05) {
      merged.push({ ...peak });
      continue;
    }

    const totalEnergy = prev.energy + peak.energy;
    prev.logFreq = (prev.logFreq * prev.energy + peak.logFreq * peak.energy) / totalEnergy;
    prev.energy = totalEnergy;
  }

  merged.sort((a, b) => b.energy - a.energy || a.logFreq - b.logFreq);
  return merged;
}

export function renderPeaksToSpectrum(peaks: SpectralPeak[]): Float64Array {
  const energySpectrum = new Float64Array(SPECTRUM_SIZE);

  for (const peak of peaks) {
    const energy = peak.energy;
    if (energy <= PEAK_ENERGY_FLOOR) continue;

    const weights = new Float64Array(SPECTRUM_SIZE);
    let totalWeight = 0;

    for (let i = 0; i < SPECTRUM_SIZE; i++) {
      const weight = peakWeight(peak.centerFreq, SPECTRUM_FREQS[i]!);
      weights[i] = weight;
      totalWeight += weight;
    }

    if (totalWeight <= 1e-12) continue;

    const scale = energy / totalWeight;
    for (let i = 0; i < SPECTRUM_SIZE; i++) {
      energySpectrum[i] += weights[i]! * scale;
    }
  }

  const amps = new Float64Array(SPECTRUM_SIZE);
  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    amps[i] = Math.sqrt(energySpectrum[i]!);
  }
  return amps;
}

// ---------------------------------------------------------------------------
// Spectrum state
// ---------------------------------------------------------------------------

export const [spectrum, setSpectrum] = createSignal<Float64Array>(
  new Float64Array(SPECTRUM_SIZE),
);

export const [referenceSpectrum, setReferenceSpectrum] = createSignal<Float64Array>(
  new Float64Array(SPECTRUM_SIZE),
);

export const [referencePeaks, setReferencePeaks] = createSignal<SpectralPeak[]>([]);

const activeNotes = new Map<string, { freq: number; amp: number }>();

function buildFundamentalPeaks(
  f0: number,
  amps: readonly number[],
  noteAmp: number,
): { logFreq: number; energy: number }[] {
  const candidates: { logFreq: number; energy: number }[] = [];
  const harmonics = getHarmonics();

  for (let i = 0; i < amps.length; i++) {
    const amp = amps[i]! * noteAmp;
    if (amp <= 0) continue;

    const centerFreq = f0 * harmonics[i]!;
    if (centerFreq < SPECTRUM_MIN_FREQ || centerFreq > SPECTRUM_MAX_FREQ) continue;

    candidates.push({
      logFreq: Math.log2(centerFreq),
      energy: Math.max(amp * amp, PEAK_ENERGY_FLOOR),
    });
  }

  return mergeReferencePeaks(candidates);
}

function buildReferencePeaks(): SpectralPeak[] {
  const notes = Array.from(activeNotes.values());
  if (notes.length === 0) return [];

  const amps = overtoneAmps();
  const notePeaks = notes.map(({ freq, amp }) => buildFundamentalPeaks(freq, amps, amp));
  const baseBudget = Math.floor(REFERENCE_PEAK_LIMIT / notePeaks.length);
  const bonusSlots = REFERENCE_PEAK_LIMIT % notePeaks.length;
  const selected: { logFreq: number; energy: number }[] = [];
  const leftovers: { logFreq: number; energy: number }[] = [];

  for (let i = 0; i < notePeaks.length; i++) {
    const budget = baseBudget + (i < bonusSlots ? 1 : 0);
    const peaks = notePeaks[i]!;
    const kept = peaks.slice(0, budget);
    selected.push(...kept);
    leftovers.push(...peaks.slice(kept.length));
  }

  if (selected.length < REFERENCE_PEAK_LIMIT) {
    leftovers.sort((a, b) => b.energy - a.energy || a.logFreq - b.logFreq);
    selected.push(...leftovers.slice(0, REFERENCE_PEAK_LIMIT - selected.length));
  }

  const merged = mergeReferencePeaks(selected).slice(0, REFERENCE_PEAK_LIMIT);
  return merged.map((peak) => ({
    centerFreq: Math.pow(2, peak.logFreq),
    energy: peak.energy,
  }));
}

function updateReference() {
  const peaks = buildReferencePeaks();
  setReferencePeaks(peaks);
  setReferenceSpectrum(renderPeaksToSpectrum(peaks));
}

// ---------------------------------------------------------------------------
// Persistent oscillator pool
// ---------------------------------------------------------------------------

let pool: { oscs: OscillatorNode[]; gains: GainNode[]; master: GainNode } | null = null;

function ensurePool() {
  if (pool) return;

  const audio = getCtx();
  const now = audio.currentTime;
  const master = audio.createGain();
  master.gain.setValueAtTime(0.18, now);
  master.connect(getAnalyser());

  const oscs: OscillatorNode[] = [];
  const gains: GainNode[] = [];

  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = SPECTRUM_FREQS[i]!;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, now);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);

    oscs.push(osc);
    gains.push(gain);
  }

  pool = { oscs, gains, master };
}

function applySpectrum(amps: Float64Array) {
  if (!pool) return;

  const audio = getCtx();
  const now = audio.currentTime;

  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    const gain = pool.gains[i]!;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(amps[i]!, now + 0.03);
  }
}

export function updateSpectrum(amps: Float64Array) {
  ensurePool();
  setSpectrum(amps);
  applySpectrum(amps);
}

// ---------------------------------------------------------------------------
// Note on/off
// ---------------------------------------------------------------------------

let optimizerActive = false;

export function setOptimizerActive(active: boolean) {
  optimizerActive = active;
}

export function refreshActiveNotes() {
  updateReference();
  if (!optimizerActive) {
    const ref = renderPeaksToSpectrum(referencePeaks());
    updateSpectrum(ref);
  }
}

export function scaleNoteAmp(note: string, amp: number) {
  const entry = activeNotes.get(note);
  if (!entry) return;
  entry.amp = Math.max(0, amp);
  updateReference();

  if (!optimizerActive) {
    updateSpectrum(renderPeaksToSpectrum(referencePeaks()));
  }
}

export function noteOn(note: string, freq: number) {
  if (activeNotes.has(note)) return;
  ensurePool();
  activeNotes.set(note, { freq, amp: 1 });
  updateReference();

  if (!optimizerActive) {
    updateSpectrum(renderPeaksToSpectrum(referencePeaks()));
  }
}

export function noteOff(note: string) {
  if (!activeNotes.has(note)) return;
  activeNotes.delete(note);
  updateReference();

  if (!optimizerActive) {
    updateSpectrum(renderPeaksToSpectrum(referencePeaks()));
  }
}

// ---------------------------------------------------------------------------
// Interval playback (dissonance curve interaction)
// ---------------------------------------------------------------------------

interface Voice {
  oscillators: OscillatorNode[];
  master: GainNode;
}

function startVoice(freq: number, amps: number[]): Voice {
  const audio = getCtx();
  const now = audio.currentTime;

  const master = audio.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.25, now + 0.02);
  master.connect(getAnalyser());

  const oscillators: OscillatorNode[] = [];
  const harmonics = getHarmonics();

  for (let i = 0; i < amps.length; i++) {
    const amp = amps[i]!;
    if (amp === 0) continue;
    const freq_ = freq * harmonics[i]!;
    if (freq_ > 20000) continue;

    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq_;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(amp, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(amp * 0.6, now + 0.3);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);

    oscillators.push(osc);
  }

  return { oscillators, master };
}

let intervalVoices: Voice[] = [];

export function playInterval(baseFreq: number, ratio: number) {
  stopInterval();
  const amps = overtoneAmps();
  intervalVoices = [
    startVoice(baseFreq, amps),
    startVoice(baseFreq * ratio, amps),
  ];
}

export function playTriad(baseFreq: number, r1: number, r2: number) {
  stopInterval();
  const amps = overtoneAmps();
  intervalVoices = [
    startVoice(baseFreq, amps),
    startVoice(baseFreq * r1, amps),
    startVoice(baseFreq * r2, amps),
  ];
}

export function playTetrad(baseFreq: number, r1: number, r2: number, r3: number) {
  stopInterval();
  const amps = overtoneAmps();
  intervalVoices = [
    startVoice(baseFreq, amps),
    startVoice(baseFreq * r1, amps),
    startVoice(baseFreq * r2, amps),
    startVoice(baseFreq * r3, amps),
  ];
}

export function stopInterval() {
  const audio = getCtx();
  const now = audio.currentTime;
  for (const voice of intervalVoices) {
    voice.master.gain.cancelScheduledValues(now);
    voice.master.gain.setValueAtTime(voice.master.gain.value, now);
    voice.master.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    for (const osc of voice.oscillators) osc.stop(now + 0.2);
  }
  intervalVoices = [];
}
