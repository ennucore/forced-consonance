import { For } from "solid-js";
import {
  OVERTONE_COUNT,
  WaveformPreset,
  overtoneAmps,
  setOvertoneAmps,
  applyPreset,
} from "../overtones";

const PRESETS: WaveformPreset[] = ["sine", "sawtooth", "square", "triangle"];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function OvertoneEditor() {
  // Per-bar ref storage so we can compute bounding rect during drag
  const barRefs: HTMLDivElement[] = [];

  let draggingIndex: number | null = null;

  function ampFromMouseY(index: number, clientY: number): number {
    const el = barRefs[index];
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return 1 - clamp(clientY - rect.top, 0, rect.height) / rect.height;
  }

  function updateAmp(index: number, clientY: number) {
    const amp = ampFromMouseY(index, clientY);
    setOvertoneAmps((prev) => {
      const next = [...prev];
      next[index] = amp;
      return next;
    });
  }

  function onMouseMove(e: MouseEvent) {
    if (draggingIndex === null) return;
    updateAmp(draggingIndex, e.clientY);
  }

  function onMouseUp() {
    draggingIndex = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  function onBarMouseDown(index: number, e: MouseEvent) {
    e.preventDefault();
    draggingIndex = index;
    updateAmp(index, e.clientY);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div class="overtone-editor">
      <div class="preset-buttons">
        <For each={PRESETS}>
          {(preset) => (
            <button class="preset-btn" onClick={() => applyPreset(preset)}>
              {preset}
            </button>
          )}
        </For>
      </div>

      <div class="overtone-bars">
        <For each={overtoneAmps()}>
          {(amp, i) => (
            <div
              class="bar-container"
              ref={(el) => {
                barRefs[i()] = el;
              }}
              onMouseDown={(e) => onBarMouseDown(i(), e)}
            >
              <div
                class="bar-fill"
                style={{ height: `${clamp(amp, 0, 1) * 100}%` }}
              />
              <div class="bar-label">{i() + 1}×</div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
