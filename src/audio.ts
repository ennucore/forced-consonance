let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// String-like harmonic series: fundamental + overtones with 1/n falloff
// Each overtone n has frequency = fundamental * n
// Deduplicate overtones within 1 semitone of each other
const OVERTONE_COUNT = 16;

function buildPartials(
  fundamentalHz: number,
  count: number,
  windowSemitones: number
): { freq: number; amp: number }[] {
  const raw: { freq: number; amp: number }[] = [];
  for (let n = 1; n <= count; n++) {
    raw.push({ freq: fundamentalHz * n, amp: 1 / n });
  }

  if (windowSemitones <= 0) return raw;

  const kept: { freq: number; amp: number }[] = [];
  for (const partial of raw) {
    const tooClose = kept.some((k) => {
      const ratio = Math.abs(Math.log2(partial.freq / k.freq));
      return ratio < windowSemitones / 12;
    });
    if (!tooClose) {
      kept.push(partial);
    }
  }
  return kept;
}

interface Voice {
  oscillators: OscillatorNode[];
  gains: GainNode[];
  master: GainNode;
}

const activeVoices = new Map<string, Voice>();

export function noteOn(note: string, freq: number, windowSemitones: number) {
  if (activeVoices.has(note)) return;

  const audio = getCtx();
  const now = audio.currentTime;
  const partials = buildPartials(freq, OVERTONE_COUNT, windowSemitones);

  const master = audio.createGain();
  master.gain.setValueAtTime(0, now);
  master.gain.linearRampToValueAtTime(0.25, now + 0.02);
  master.connect(audio.destination);

  const oscillators: OscillatorNode[] = [];
  const gains: GainNode[] = [];

  for (const p of partials) {
    if (p.freq > 20000) continue; // skip inaudible

    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = p.freq;

    const gain = audio.createGain();
    // shape the amplitude: attack + gentle decay for string-like feel
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(p.amp, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(p.amp * 0.6, now + 0.3);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);

    oscillators.push(osc);
    gains.push(gain);
  }

  activeVoices.set(note, { oscillators, gains, master });
}

export function noteOff(note: string) {
  const voice = activeVoices.get(note);
  if (!voice) return;

  const audio = getCtx();
  const now = audio.currentTime;

  // Release: fade out over 0.3s then stop
  voice.master.gain.cancelScheduledValues(now);
  voice.master.gain.setValueAtTime(voice.master.gain.value, now);
  voice.master.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

  const stopTime = now + 0.35;
  for (const osc of voice.oscillators) {
    osc.stop(stopTime);
  }

  activeVoices.delete(note);
}
