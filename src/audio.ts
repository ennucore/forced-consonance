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
// Chord partial construction
// ---------------------------------------------------------------------------

type RawPartial = { freq: number; amp: number; fundamental: number };
type RenderedPartial = { freq: number; amp: number };

// Active notes are stored as fundamentals; the overtone stack is rebuilt
// on every render so preset/editor changes apply immediately.
const activeNotes = new Map<string, number>();

export function getActiveFundamentals(): number[] {
  return Array.from(activeNotes.values());
}

function rawPartials(fundamentalHz: number, amps: number[]): RawPartial[] {
  const out: RawPartial[] = [];
  for (let i = 0; i < amps.length; i++) {
    const amp = amps[i]!;
    if (amp === 0) continue;
    const freq = fundamentalHz * (i + 1);
    if (freq > 20000) break;
    out.push({ freq, amp, fundamental: fundamentalHz });
  }
  return out;
}

function minimumSeparationHz(freq: number, windowSemitones: number): number {
  return freq * (Math.pow(2, windowSemitones / 12) - 1);
}

function isTooCloseToAcceptedOvertone(
  candidateFreq: number,
  acceptedOvertones: number[],
  windowSemitones: number,
): boolean {
  if (windowSemitones <= 0) return false;

  return acceptedOvertones.some((acceptedFreq) => {
    const threshold = minimumSeparationHz(
      Math.min(acceptedFreq, candidateFreq),
      windowSemitones,
    );
    return Math.abs(candidateFreq - acceptedFreq) < threshold;
  });
}

function buildChordPartials(windowSemitones: number): RenderedPartial[] {
  const fundamentals = Array.from(activeNotes.values()).sort((a, b) => a - b);
  if (fundamentals.length === 0) return [];

  const amps = overtoneAmps();
  const fundamentalAmp = amps[0] ?? 1;

  const accepted: RenderedPartial[] = fundamentals.map((freq) => ({
    freq,
    amp: fundamentalAmp,
  }));
  const acceptedOvertones: number[] = [];

  for (let i = 1; i < amps.length; i++) {
    const amp = amps[i]!;
    if (amp === 0) continue;

    const harmonic = i + 1;
    for (const fundamental of fundamentals) {
      const freq = fundamental * harmonic;
      if (freq > 20000) break;
      if (isTooCloseToAcceptedOvertone(freq, acceptedOvertones, windowSemitones)) {
        continue;
      }

      accepted.push({ freq, amp });
      acceptedOvertones.push(freq);
    }
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Render all active notes
// ---------------------------------------------------------------------------

let rendered: { oscs: OscillatorNode[]; master: GainNode } | null = null;
let currentWindow = 0;

function renderAll() {
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

  const partials = buildChordPartials(currentWindow);
  if (partials.length === 0) return;

  const master = audio.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.25, now + 0.008);
  master.connect(getAnalyser());

  const oscs: OscillatorNode[] = [];

  for (const partial of partials) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = partial.freq;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(partial.amp, now);
    gain.gain.exponentialRampToValueAtTime(partial.amp * 0.6, now + 0.3);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    oscs.push(osc);
  }

  rendered = { oscs, master };
}

export function setConsonanceWindow(windowSemitones: number) {
  currentWindow = windowSemitones;
  if (activeNotes.size > 0) renderAll();
}

export function refreshActiveNotes() {
  if (activeNotes.size > 0) renderAll();
}

export function noteOn(note: string, freq: number, windowSemitones: number) {
  if (activeNotes.has(note)) return;
  currentWindow = windowSemitones;
  activeNotes.set(note, freq);
  renderAll();
}

export function noteOff(note: string) {
  if (!activeNotes.has(note)) return;
  activeNotes.delete(note);

  if (activeNotes.size === 0) {
    if (rendered) {
      const audio = getCtx();
      const now = audio.currentTime;
      rendered.master.gain.cancelScheduledValues(now);
      rendered.master.gain.setValueAtTime(rendered.master.gain.value, now);
      rendered.master.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      for (const osc of rendered.oscs) osc.stop(now + 0.35);
      rendered = null;
    }
  } else {
    renderAll();
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
  const partials = rawPartials(freq, amps);

  const master = audio.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.25, now + 0.02);
  master.connect(getAnalyser());

  const oscillators: OscillatorNode[] = [];

  for (const partial of partials) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = partial.freq;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(partial.amp, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(partial.amp * 0.6, now + 0.3);

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
