let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

const OVERTONE_COUNT = 16;

// Raw partials per active note (full harmonic series, never deduped internally)
const activeNotes = new Map<string, { freq: number; amp: number }[]>();

// Currently rendered oscillators
let rendered: { oscs: OscillatorNode[]; master: GainNode } | null = null;

let currentWindow = 0;

function rawPartials(fundamentalHz: number): { freq: number; amp: number }[] {
  const out: { freq: number; amp: number }[] = [];
  for (let n = 1; n <= OVERTONE_COUNT; n++) {
    const f = fundamentalHz * n;
    if (f > 20000) break;
    out.push({ freq: f, amp: 1 / n });
  }
  return out;
}

// Pool all partials across notes, merge only across different fundamentals.
// Walk from highest frequency down so high overtones merge first.
function mergeAcrossNotes(windowSemitones: number): { freq: number; amp: number }[] {
  const tagged: { freq: number; amp: number; note: string }[] = [];
  for (const [note, partials] of activeNotes) {
    for (const p of partials) {
      tagged.push({ ...p, note });
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

    const group = [tagged[i]!];
    const notes = new Set([tagged[i]!.note]);

    for (let j = i + 1; j < tagged.length; j++) {
      if (used.has(j)) continue;
      const c = tagged[j]!;

      // Don't merge partials from the same fundamental
      if (notes.has(c.note)) continue;

      const tAmp = group.reduce((s, g) => s + g.amp, 0);
      const avgFreq = group.reduce((s, g) => s + g.freq * g.amp, 0) / tAmp;

      if (Math.abs(Math.log2(c.freq / avgFreq)) >= windowSemitones / 12) continue;

      group.push(c);
      notes.add(c.note);
      used.add(j);
    }

    if (group.length === 1) {
      result.push({ freq: group[0]!.freq, amp: group[0]!.amp });
    } else {
      const tAmp = group.reduce((s, g) => s + g.amp, 0);
      const avgFreq = group.reduce((s, g) => s + g.freq * g.amp, 0) / tAmp;
      const energy = group.reduce((s, g) => s + g.amp * g.amp, 0);
      result.push({ freq: avgFreq, amp: Math.sqrt(energy) });
    }
  }

  return result;
}

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
  master.connect(audio.destination);

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

export function noteOn(note: string, freq: number, windowSemitones: number) {
  if (activeNotes.has(note)) return;
  currentWindow = windowSemitones;
  activeNotes.set(note, rawPartials(freq));
  renderAll();
}

export function noteOff(note: string) {
  if (!activeNotes.has(note)) return;
  activeNotes.delete(note);

  if (activeNotes.size === 0) {
    // Fade out everything
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
