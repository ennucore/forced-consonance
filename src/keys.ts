export interface PianoKey {
  note: string;
  freq: number;
  type: "white" | "black";
  label: string; // keyboard shortcut
}

// C4 to B5 — two octaves
const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[midi % 12]!;
  return `${name}${octave}`;
}

// Keyboard layout: bottom row = white keys, top row = black keys
const WHITE_KEYS = "asdfghjkl;'\\";
const BLACK_KEYS = "wetyuop]";

export function buildKeys(): PianoKey[] {
  const keys: PianoKey[] = [];
  const startMidi = 60; // C4

  let whiteIdx = 0;
  let blackIdx = 0;

  for (let i = 0; i < 24; i++) {
    const midi = startMidi + i;
    const octave = Math.floor(midi / 12) - 1;
    const noteName = NOTE_NAMES[midi % 12]!;
    const isBlack = noteName.includes("#");

    let label = "";
    if (isBlack) {
      label = BLACK_KEYS[blackIdx] ?? "";
      blackIdx++;
    } else {
      label = WHITE_KEYS[whiteIdx] ?? "";
      whiteIdx++;
    }

    keys.push({
      note: `${noteName}${octave}`,
      freq: midiToFreq(midi),
      type: isBlack ? "black" : "white",
      label,
    });
  }

  return keys;
}

// Map keyboard key -> note name
export function buildKeyMap(keys: PianoKey[]): Map<string, PianoKey> {
  const map = new Map<string, PianoKey>();
  for (const k of keys) {
    if (k.label) map.set(k.label.toLowerCase(), k);
  }
  return map;
}
