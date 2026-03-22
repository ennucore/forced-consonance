import { createSignal, createEffect, onCleanup } from "solid-js";
import {
  overtoneAmps,
  setOvertoneAmps,
  optimizeDissonance,
} from "../overtones";
import { getActiveFundamentals } from "../audio";

export default function DissonanceTarget() {
  const [target, setTarget] = createSignal(0.5);

  // Continuously run optimize on a loop
  let rafId = 0;

  function loop() {
    const result = optimizeDissonance(overtoneAmps(), target(), getActiveFundamentals());
    setOvertoneAmps(result);
    rafId = requestAnimationFrame(loop);
  }

  createEffect(() => {
    // Re-subscribe whenever target changes
    target();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  });

  onCleanup(() => cancelAnimationFrame(rafId));

  // Knob drag state
  let knobRef!: HTMLDivElement;

  function knobAngle(): number {
    return -135 + target() * 270;
  }

  function onKnobDrag(e: MouseEvent) {
    e.preventDefault();
    const rect = knobRef.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    function update(ev: MouseEvent) {
      const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * (180 / Math.PI);
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
      </div>
    </div>
  );
}
