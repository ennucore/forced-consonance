import { createSignal } from "solid-js";
import {
  overtoneAmps,
  setOvertoneAmps,
  optimizeDissonance,
} from "../overtones";

export default function DissonanceTarget() {
  const [target, setTarget] = createSignal(0.5);
  const [running, setRunning] = createSignal(false);

  function optimize() {
    setRunning(true);
    // Defer so the UI updates before the sync computation
    requestAnimationFrame(() => {
      const result = optimizeDissonance(overtoneAmps(), target());
      setOvertoneAmps(result);
      setRunning(false);
    });
  }

  // Knob drag state
  let knobRef!: HTMLDivElement;

  function knobAngle(): number {
    // Map 0–1 to -135° to 135°
    return -135 + target() * 270;
  }

  function onKnobDrag(e: MouseEvent) {
    e.preventDefault();
    const rect = knobRef.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    function update(ev: MouseEvent) {
      const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * (180 / Math.PI);
      // Map angle to 0–1: -135° = 0, 135° = 1
      // atan2 gives -180 to 180, with 0 = right
      // We want: top-left (-135°) = 0, top-right (135°) = 1
      // Remap: angle + 90 shifts so up = 0°
      let normalized = angle + 90;
      if (normalized < -135) normalized += 360;
      const value = Math.max(0, Math.min(1, (normalized + 135) / 270));
      setTarget(value);
    }

    function onUp() {
      window.removeEventListener("mousemove", update);
      window.removeEventListener("mouseup", onUp);
    }

    update(e);
    window.addEventListener("mousemove", update);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div class="dissonance-target">
      <span class="panel-label">target dissonance</span>
      <div class="target-controls">
        <div class="knob" ref={knobRef} onMouseDown={onKnobDrag}>
          <div
            class="knob-indicator"
            style={{ transform: `rotate(${knobAngle()}deg)` }}
          />
          <span class="knob-value">{target().toFixed(2)}</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={target()}
          onInput={(e) => setTarget(parseFloat(e.currentTarget.value))}
        />
        <button
          class="optimize-btn"
          onClick={optimize}
          disabled={running()}
        >
          {running() ? "..." : "optimize"}
        </button>
      </div>
    </div>
  );
}
