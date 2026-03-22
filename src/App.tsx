import { createEffect, createSignal, onMount, onCleanup, For } from "solid-js";
import { buildKeys, buildKeyMap, midiToFreq, midiToNoteName, type PianoKey } from "./keys";
import { noteOn, noteOff, refreshActiveNotes } from "./audio";
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

  function handleMidiMessage(e: MIDIMessageEvent) {
    const [status, midiNote, velocity] = e.data!;
    const cmd = status! & 0xf0;

    if (cmd === 0x90 && velocity! > 0) {
      // Note on
      const name = midiToNoteName(midiNote!);
      const freq = midiToFreq(midiNote!);
      noteOn(name, freq);
      setActive((prev) => new Set(prev).add(name));
    } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
      // Note off
      const name = midiToNoteName(midiNote!);
      noteOff(name);
      setActive((prev) => {
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
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
