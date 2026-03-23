import { createSignal } from "solid-js";
import { overtoneAmps } from "./overtones";

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
// Fixed frequency pool
// ---------------------------------------------------------------------------
//
// Pre-allocate one oscillator per semitone from C1 (~32 Hz) to C9 (~8372 Hz).
// The spectrum is just an amplitude array over this fixed grid.
// Nothing is ever created or destroyed after init — only gains change.

const POOL_MIN_MIDI = 24;  // C1 ~32 Hz
const POOL_MAX_MIDI = 108; // C9 ~8372 Hz
const POOL_SIZE = POOL_MAX_MIDI - POOL_MIN_MIDI + 1; // 85 semitones

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Pre-compute the frequency for each pool slot
const POOL_FREQS: number[] = [];
for (let m = POOL_MIN_MIDI; m <= POOL_MAX_MIDI; m++) {
  POOL_FREQS.push(midiToFreq(m));
}

// Find the nearest pool index for a given frequency
function nearestPoolIndex(freq: number): number {
  // midi = 69 + 12 * log2(freq / 440)
  const midi = 69 + 12 * Math.log2(freq / 440);
  const idx = Math.round(midi) - POOL_MIN_MIDI;
  return Math.max(0, Math.min(POOL_SIZE - 1, idx));
}

// ---------------------------------------------------------------------------
// Spectrum state: amplitude per pool slot
// ---------------------------------------------------------------------------

export const SPECTRUM_SIZE = POOL_SIZE;
export function getPoolFreqs(): number[] { return POOL_FREQS; }

// Current amplitudes being played
export const [spectrum, setSpectrum] = createSignal<Float64Array>(
  new Float64Array(POOL_SIZE)
);

// Reference spectrum: what the current chord "should" sound like
export const [referenceSpectrum, setReferenceSpectrum] = createSignal<Float64Array>(
  new Float64Array(POOL_SIZE)
);

// Dissonance delta — shared so MIDI pitch bend can control it
export const [dissDelta, setDissDelta] = createSignal(2.5);

// Active notes: name -> { freq, amp (0-1 scaling factor) }
const activeNotes = new Map<string, { freq: number; amp: number }>();

/**
 * Scale amplitude of an active note (for pedal decay).
 */
export function scaleNoteAmp(note: string, amp: number) {
  const entry = activeNotes.get(note);
  if (!entry) return;
  const prevAmp = entry.amp;
  entry.amp = amp;
  updateReference();

  // Also scale the playing spectrum directly for this note's bins
  if (prevAmp > 1e-10) {
    const ratio = amp / prevAmp;
    const amps = overtoneAmps();
    const current = spectrum();
    const updated = new Float64Array(current);
    for (let i = 0; i < amps.length; i++) {
      if (amps[i]! === 0) continue;
      const freq = entry.freq * (i + 1);
      if (freq > 20000) continue;
      const idx = nearestPoolIndex(freq);
      updated[idx] *= ratio;
    }
    setSpectrum(updated);
    applySpectrum(updated);
  }
}

/**
 * Build reference spectrum from current keys + overtone amps.
 * Maps each harmonic to its nearest semitone bin.
 */
function buildReference(): Float64Array {
  const ref = new Float64Array(POOL_SIZE);
  const entries = Array.from(activeNotes.values());
  if (entries.length === 0) return ref;

  const amps = overtoneAmps();
  for (const { freq: f0, amp: noteAmp } of entries) {
    for (let i = 0; i < amps.length; i++) {
      const a = amps[i]! * noteAmp;
      if (a === 0) continue;
      const freq = f0 * (i + 1);
      if (freq > 20000) continue;
      const idx = nearestPoolIndex(freq);
      ref[idx] = Math.max(ref[idx]!, a);
    }
  }
  return ref;
}

/**
 * Update the reference spectrum (called on key change and overtone change).
 * Does NOT touch the playing spectrum — the optimizer steers it.
 */
function updateReference() {
  setReferenceSpectrum(buildReference());
}

// ---------------------------------------------------------------------------
// Audio pool: persistent oscillators
// ---------------------------------------------------------------------------

let pool: { oscs: OscillatorNode[]; gains: GainNode[]; master: GainNode } | null = null;

function ensurePool() {
  if (pool) return;
  const audio = getCtx();
  const now = audio.currentTime;

  const master = audio.createGain();
  master.gain.setValueAtTime(0.25, now);
  master.connect(getAnalyser());

  const oscs: OscillatorNode[] = [];
  const gains: GainNode[] = [];

  for (let i = 0; i < POOL_SIZE; i++) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = POOL_FREQS[i]!;

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

/**
 * Apply the current spectrum amplitudes to the oscillator pool.
 */
function applySpectrum(amps: Float64Array) {
  if (!pool) return;
  const audio = getCtx();
  const now = audio.currentTime;

  for (let i = 0; i < POOL_SIZE; i++) {
    const g = pool.gains[i]!;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(amps[i]!, now + 0.03);
  }
}

/**
 * Called by the optimizer to update the playing spectrum.
 */
export function updateSpectrum(amps: Float64Array) {
  setSpectrum(amps);
  applySpectrum(amps);
}

// ---------------------------------------------------------------------------
// Note on/off
// ---------------------------------------------------------------------------

export function refreshActiveNotes() {
  updateReference();
  // If optimizer is not running, snap the playing spectrum to the reference
  if (!optimizerActive) {
    const ref = buildReference();
    setSpectrum(ref);
    applySpectrum(ref);
  }
}

let optimizerActive = false;
export function setOptimizerActive(active: boolean) {
  optimizerActive = active;
}

export function noteOn(note: string, freq: number) {
  if (activeNotes.has(note)) return;
  ensurePool();
  activeNotes.set(note, { freq, amp: 1 });
  updateReference();

  if (!optimizerActive) {
    const ref = buildReference();
    setSpectrum(ref);
    applySpectrum(ref);
  }
}

export function noteOff(note: string) {
  if (!activeNotes.has(note)) return;
  activeNotes.delete(note);
  updateReference();

  if (!optimizerActive) {
    const ref = buildReference();
    setSpectrum(ref);
    applySpectrum(ref);
  }
  // If optimizer is active, it will steer toward new reference (which has 0s for released notes)
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

  for (let i = 0; i < amps.length; i++) {
    const amp = amps[i]!;
    if (amp === 0) continue;
    const freq_ = freq * (i + 1);
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
