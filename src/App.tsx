import { createEffect, createSignal, onMount, onCleanup, For } from "solid-js";
import { buildKeys, buildKeyMap, midiToFreq, midiToNoteName, type PianoKey } from "./keys";
import { noteOn, noteOff, refreshActiveNotes, scaleNoteAmp, setDissDelta } from "./audio";
import { overtoneAmps } from "./overtones";
import { OvertoneEditor } from "./components/OvertoneEditor";
import SpectrumAnalyser from "./components/SpectrumAnalyser";
import DissonanceCurve from "./components/DissonanceCurve";
import DissonanceMeter from "./components/DissonanceMeter";

const pianoKeys = buildKeys();
const keyMap = buildKeyMap(pianoKeys);

export default function App() {
  const [active, setActive] = createSignal<Set<string>>(new Set());

  createEffect(() => {
    overtoneAmps();
    refreshActiveNotes();
  });

  function press(key: PianoKey) {
    noteOn(key.note, key.freq);
    setActive((prev) => new Set(prev).add(key.note));
  }

  function release(key: PianoKey) {
    noteOff(key.note);
    setActive((prev) => {
      const next = new Set(prev);
      next.delete(key.note);
      return next;
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.repeat) return;
    const pk = keyMap.get(e.key.toLowerCase());
    if (pk) press(pk);
  }

  function onKeyUp(e: KeyboardEvent) {
    const pk = keyMap.get(e.key.toLowerCase());
    if (pk) release(pk);
  }

  // Sustain pedal state
  let pedalDown = false;
  const sustainedNotes = new Map<string, number>(); // name -> current amplitude (0-1)

  const DECAY_RATE = 0.97; // per tick (~30hz)
  const DECAY_THRESHOLD = 0.01;
  let decayIntervalId = 0;

  function startDecay() {
    if (decayIntervalId) return;
    decayIntervalId = window.setInterval(() => {
      if (sustainedNotes.size === 0) return;
      for (const [name, amp] of sustainedNotes) {
        const newAmp = amp * DECAY_RATE;
        if (newAmp < DECAY_THRESHOLD) {
          sustainedNotes.delete(name);
          releaseNote(name);
        } else {
          sustainedNotes.set(name, newAmp);
          scaleNoteAmp(name, newAmp);
        }
      }
    }, 33); // ~30hz
  }

  function releaseNote(name: string) {
    noteOff(name);
    setActive((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }

  function handleMidiMessage(e: MIDIMessageEvent) {
    const data = e.data;
    if (!data || data.length < 3) return;

    const status = data[0]!;
    const byte1 = data[1]!;
    const byte2 = data[2]!;
    const cmd = status & 0xf0;

    // Pitch bend → dissonance delta (-5 to 10, center = 2.5)
    if (cmd === 0xe0) {
      const bend = (byte2 << 7) | byte1; // 14-bit value: 0–16383, center 8192
      const normalized = (bend - 8192) / 8192; // -1 to 1
      // Map: -1 → -5, 0 → 2.5, 1 → 10
      const delta = normalized >= 0
        ? 2.5 + normalized * 7.5
        : 2.5 + normalized * 7.5;
      setDissDelta(delta);
      return;
    }

    // Control Change
    if (cmd === 0xb0) {
      // CC 64 = sustain pedal
      if (byte1 === 64) {
        if (byte2 >= 64) {
          pedalDown = true;
          startDecay();
        } else {
          pedalDown = false;
          // Release all sustained notes
          for (const [name] of sustainedNotes) {
            releaseNote(name);
          }
          sustainedNotes.clear();
        }
      }
      return;
    }

    if (cmd === 0x90 && byte2 > 0) {
      const name = midiToNoteName(byte1);
      const freq = midiToFreq(byte1);
      sustainedNotes.delete(name); // re-struck while sustained
      noteOn(name, freq);
      setActive((prev) => new Set(prev).add(name));
    } else if (cmd === 0x80 || (cmd === 0x90 && byte2 === 0)) {
      const name = midiToNoteName(byte1);
      if (pedalDown) {
        sustainedNotes.set(name, 1.0);
      } else {
        releaseNote(name);
      }
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Web MIDI
    if (navigator.requestMIDIAccess) {
      navigator.requestMIDIAccess().then((midi) => {
        for (const input of midi.inputs.values()) {
          input.onmidimessage = handleMidiMessage;
        }
        // Handle hot-plugged devices
        midi.onstatechange = () => {
          for (const input of midi.inputs.values()) {
            input.onmidimessage = handleMidiMessage;
          }
        };
      });
    }
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    clearInterval(decayIntervalId);
  });

  const whiteKeys = pianoKeys.filter((k) => k.type === "white");
  const blackKeys = pianoKeys.filter((k) => k.type === "black");

  function blackKeyOffset(key: PianoKey): number {
    const chromaticIdx = pianoKeys.indexOf(key);
    let whitesBefore = 0;
    for (let i = 0; i < chromaticIdx; i++) {
      if (pianoKeys[i]!.type === "white") whitesBefore++;
    }
    return whitesBefore * 52 - 16;
  }

  return (
    <div class="app">
      <h1>forced consonance</h1>
      <p class="hint">play with keyboard or click the keys</p>
      <div class="piano">
        <For each={whiteKeys}>
          {(key) => (
            <div
              class={`key white ${active().has(key.note) ? "active" : ""}`}
              onMouseDown={() => press(key)}
              onMouseUp={() => release(key)}
              onMouseLeave={() => { if (active().has(key.note)) release(key); }}
            >
              <span class="key-label">{key.label}</span>
            </div>
          )}
        </For>
        <For each={blackKeys}>
          {(key) => (
            <div
              class={`key black ${active().has(key.note) ? "active" : ""}`}
              style={{ position: "absolute", left: `${blackKeyOffset(key)}px` }}
              onMouseDown={() => press(key)}
              onMouseUp={() => release(key)}
              onMouseLeave={() => { if (active().has(key.note)) release(key); }}
            >
              <span class="key-label">{key.label}</span>
            </div>
          )}
        </For>
      </div>
      <div class="panels-row">
        <OvertoneEditor />
        <DissonanceMeter />
        <SpectrumAnalyser />
      </div>
      <DissonanceCurve />
    </div>
  );
}
