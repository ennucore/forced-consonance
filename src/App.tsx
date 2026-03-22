import { createSignal, onMount, onCleanup, For } from "solid-js";
import { buildKeys, buildKeyMap, type PianoKey } from "./keys";
import { noteOn, noteOff } from "./audio";

const pianoKeys = buildKeys();
const keyMap = buildKeyMap(pianoKeys);

export default function App() {
  const [active, setActive] = createSignal<Set<string>>(new Set());

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

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  });

  // Split into white and black for rendering
  const whiteKeys = pianoKeys.filter((k) => k.type === "white");
  const blackKeys = pianoKeys.filter((k) => k.type === "black");

  // Compute black key positions based on their index in the chromatic scale
  function blackKeyOffset(key: PianoKey): number {
    const chromaticIdx = pianoKeys.indexOf(key);
    // Count white keys before this black key
    let whitesBefore = 0;
    for (let i = 0; i < chromaticIdx; i++) {
      if (pianoKeys[i]!.type === "white") whitesBefore++;
    }
    // Black key sits between the two adjacent white keys
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
    </div>
  );
}
