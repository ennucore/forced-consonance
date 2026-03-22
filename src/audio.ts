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
// Raw partials per note (full harmonic series, never deduped internally)
// ---------------------------------------------------------------------------

const activeNotes = new Map<string, { freq: number; amp: number; fundamental: number }[]>();

function rawPartials(fundamentalHz: number, amps: number[]): { freq: number; amp: number; fundamental: number }[] {
  const out: { freq: number; amp: number; fundamental: number }[] = [];
  for (let i = 0; i < amps.length; i++) {
    const a = amps[i]!;
    if (a === 0) continue;
    const f = fundamentalHz * (i + 1);
    if (f > 20000) break;
    out.push({ freq: f, amp: a, fundamental: fundamentalHz });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-note merge: pool all partials across notes, merge only across
// different fundamentals. Walk from highest frequency down so high overtones
// merge first. Fundamentals and their octave multiples are never merged.
// ---------------------------------------------------------------------------

// Check if freq is a power-of-2 multiple (octave) of any active fundamental
function isOctaveOfFundamental(freq: number): boolean {
  for (const partials of activeNotes.values()) {
    const f0 = partials[0]?.fundamental;
    if (!f0) continue;
    const ratio = freq / f0;
    if (ratio >= 1 && Math.abs(Math.log2(ratio) - Math.round(Math.log2(ratio))) < 0.01) {
      return true;
    }
  }
  return false;
}

function mergeAcrossNotes(windowSemitones: number): { freq: number; amp: number }[] {
  const tagged: { freq: number; amp: number; note: string; protected_: boolean }[] = [];
  for (const [note, partials] of activeNotes) {
    for (const p of partials) {
      tagged.push({ freq: p.freq, amp: p.amp, note, protected_: isOctaveOfFundamental(p.freq) });
    }
  }

  if (windowSemitones <= 0 || tagged.length === 0) {
    return tagged.map(({ freq, amp }) => ({ freq, amp }));
  }

  // Sort descending by frequency — merge from top
  tagged.sort((a, b) => b.freq - a.freq);

  const result: { freq: number; amp: number }[] = [];
  const used = new Set<number>();

  for (let i = 0; i < tagged.length; i++) {
    if (used.has(i)) continue;
    used.add(i);

    // Protected partials never merge
    if (tagged[i]!.protected_) {
      result.push({ freq: tagged[i]!.freq, amp: tagged[i]!.amp });
      continue;
    }

    // Keep this partial, discard any from other notes within the window
    result.push({ freq: tagged[i]!.freq, amp: tagged[i]!.amp });

    for (let j = i + 1; j < tagged.length; j++) {
      if (used.has(j)) continue;
      const c = tagged[j]!;

      if (c.protected_) continue;
      if (c.note === tagged[i]!.note) continue;

      if (Math.abs(Math.log2(c.freq / tagged[i]!.freq)) < windowSemitones / 12) {
        used.add(j); // discard
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Render all active notes
// ---------------------------------------------------------------------------

let rendered: { oscs: OscillatorNode[]; master: GainNode } | null = null;
let currentWindow = 0;

function renderAll() {
  const audio = getCtx();
  const now = audio.currentTime;

  // Quick crossfade out old render
  if (rendered) {
    const old = rendered;
    old.master.gain.cancelScheduledValues(now);
    old.master.gain.setValueAtTime(old.master.gain.value, now);
    old.master.gain.linearRampToValueAtTime(0, now + 0.008);
    for (const osc of old.oscs) osc.stop(now + 0.01);
    rendered = null;
  }

  const partials = mergeAcrossNotes(currentWindow);
  if (partials.length === 0) return;

  const master = audio.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.25, now + 0.008);
  master.connect(getAnalyser());

  const oscs: OscillatorNode[] = [];

  for (const p of partials) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = p.freq;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(p.amp, now);
    gain.gain.exponentialRampToValueAtTime(p.amp * 0.6, now + 0.3);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    oscs.push(osc);
  }

  rendered = { oscs, master };
}

// ---------------------------------------------------------------------------
// Note on/off (piano keyboard)
// ---------------------------------------------------------------------------

export function noteOn(note: string, freq: number, windowSemitones: number) {
  if (activeNotes.has(note)) return;
  currentWindow = windowSemitones;
  activeNotes.set(note, rawPartials(freq, overtoneAmps()));
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

  for (const p of partials) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = p.freq;

    const gain = audio.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(p.amp, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(p.amp * 0.6, now + 0.3);

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
