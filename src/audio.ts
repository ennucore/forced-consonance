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

type RenderedPartial = { freq: number; amp: number };

// Active notes stored as fundamentals; overtone stack rebuilt on every render
// so preset/editor changes apply immediately.
const activeNotes = new Map<string, number>();

function buildChordPartials(): RenderedPartial[] {
  const fundamentals = Array.from(activeNotes.values()).sort((a, b) => a - b);
  if (fundamentals.length === 0) return [];

  const amps = overtoneAmps();
  const result: RenderedPartial[] = [];

  for (let i = 0; i < amps.length; i++) {
    const amp = amps[i]!;
    if (amp === 0) continue;
    const harmonic = i + 1;

    for (const fundamental of fundamentals) {
      const freq = fundamental * harmonic;
      if (freq > 20000) continue;
      result.push({ freq, amp });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Render all active notes
// ---------------------------------------------------------------------------

let rendered: { oscs: OscillatorNode[]; master: GainNode } | null = null;

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

  const partials = buildChordPartials();
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

export function refreshActiveNotes() {
  if (activeNotes.size > 0) renderAll();
}

export function noteOn(note: string, freq: number) {
  if (activeNotes.has(note)) return;
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
