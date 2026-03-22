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
// Spectrum: the central data structure
// ---------------------------------------------------------------------------

export type SpectralLine = { freq: number; amp: number };

// The spectrum currently being synthesized
export const [spectrum, setSpectrum] = createSignal<SpectralLine[]>([]);

// The "reference" spectrum (snapshot at key change, before optimization)
export const [referenceSpectrum, setReferenceSpectrum] = createSignal<SpectralLine[]>([]);

// Active note fundamentals (just for tracking which keys are held)
const activeNotes = new Map<string, number>();

// Callbacks for key-change events (optimizer reset)
let onSpectrumReset: (() => void) | null = null;
export function setOnSpectrumReset(cb: (() => void) | null) {
  onSpectrumReset = cb;
}

/**
 * Build a spectrum from active fundamentals + current overtone amps.
 */
function buildSpectrum(): SpectralLine[] {
  const fundamentals = Array.from(activeNotes.values()).sort((a, b) => a - b);
  if (fundamentals.length === 0) return [];

  const amps = overtoneAmps();
  const lines: SpectralLine[] = [];

  for (let i = 0; i < amps.length; i++) {
    const amp = amps[i]!;
    if (amp === 0) continue;
    const harmonic = i + 1;

    for (const f0 of fundamentals) {
      const freq = f0 * harmonic;
      if (freq > 20000) continue;
      lines.push({ freq, amp });
    }
  }

  return lines;
}

/**
 * Regenerate spectrum from keys + overtones, set as both current and reference.
 */
function resetSpectrum() {
  const lines = buildSpectrum();
  setSpectrum(lines);
  setReferenceSpectrum(lines.map((l) => ({ ...l })));
  renderSpectrum(lines);
  onSpectrumReset?.();
}

// ---------------------------------------------------------------------------
// Audio renderer: plays whatever spectrum it's given
// ---------------------------------------------------------------------------

let rendered: { oscs: OscillatorNode[]; gains: GainNode[]; master: GainNode } | null = null;

function renderSpectrum(lines: SpectralLine[]) {
  const audio = getCtx();
  const now = audio.currentTime;

  if (rendered) {
    const old = rendered;
    old.master.gain.cancelScheduledValues(now);
    old.master.gain.setValueAtTime(old.master.gain.value, now);
    old.master.gain.linearRampToValueAtTime(0, now + 0.008);
    for (const osc of old.oscs) osc.stop(now + 0.01);
    rendered = null;
  }

  if (lines.length === 0) return;

  const master = audio.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.25, now + 0.008);
  master.connect(getAnalyser());

  const oscs: OscillatorNode[] = [];
  const gains: GainNode[] = [];

  for (const line of lines) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = line.freq;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(line.amp, now);
    gain.gain.exponentialRampToValueAtTime(line.amp * 0.6, now + 0.3);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);

    oscs.push(osc);
    gains.push(gain);
  }

  rendered = { oscs, gains, master };
}

/**
 * Called by the optimizer to update spectrum amplitudes in-place.
 * Smoothly ramps existing oscillator gains instead of tearing down
 * and rebuilding, avoiding crossfade artifacts.
 */
export function updateSpectrum(lines: SpectralLine[]) {
  setSpectrum(lines);

  // If the oscillator count matches, update gains in-place
  if (rendered && rendered.gains.length === lines.length) {
    const audio = getCtx();
    const now = audio.currentTime;
    for (let i = 0; i < lines.length; i++) {
      const g = rendered.gains[i]!;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime(lines[i]!.amp * 0.6, now + 0.05);
    }
  } else {
    // Structure changed — full rebuild
    renderSpectrum(lines);
  }
}

// ---------------------------------------------------------------------------
// Note on/off
// ---------------------------------------------------------------------------

export function refreshActiveNotes() {
  if (activeNotes.size > 0) resetSpectrum();
}

export function noteOn(note: string, freq: number) {
  if (activeNotes.has(note)) return;
  activeNotes.set(note, freq);
  resetSpectrum();
}

export function noteOff(note: string) {
  if (!activeNotes.has(note)) return;
  activeNotes.delete(note);

  if (activeNotes.size === 0) {
    setSpectrum([]);
    setReferenceSpectrum([]);
    if (rendered) {
      const audio = getCtx();
      const now = audio.currentTime;
      rendered.master.gain.cancelScheduledValues(now);
      rendered.master.gain.setValueAtTime(rendered.master.gain.value, now);
      rendered.master.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      for (const osc of rendered.oscs) osc.stop(now + 0.35);
      rendered = null;
    }
    onSpectrumReset?.();
  } else {
    resetSpectrum();
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
