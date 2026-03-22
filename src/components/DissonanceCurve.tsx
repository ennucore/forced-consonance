import { createEffect, createSignal } from "solid-js";
import { overtoneAmps } from "../overtones";
import { computeDissonanceCurve } from "../overtones";
import { playInterval, stopInterval } from "../audio";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const R_MIN = 0.5;
const R_MAX = 2.5;
const DEFAULT_BASE_FREQ = 220;

const INTERVALS: [number, string][] = [
  [1, "P1"],
  [6 / 5, "m3"],
  [5 / 4, "M3"],
  [4 / 3, "P4"],
  [3 / 2, "P5"],
  [5 / 3, "M6"],
  [2, "P8"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ratioFromX(x: number, width: number): number {
  return R_MIN + (R_MAX - R_MIN) * (x / width);
}

function xFromRatio(ratio: number, width: number): number {
  return ((ratio - R_MIN) / (R_MAX - R_MIN)) * width;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DissonanceCurve() {
  let canvas!: HTMLCanvasElement;
  const [baseFreq, setBaseFreq] = createSignal(DEFAULT_BASE_FREQ);

  // -------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------

  createEffect(() => {
    const amps = overtoneAmps();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    const curve = computeDissonanceCurve(amps, width, R_MIN, R_MAX);

    ctx.clearRect(0, 0, width, height);

    const maxD = Math.max(...curve.map((p) => p.dissonance), 1e-9);

    // --- Interval reference lines ---
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(147, 146, 147, 0.3)";
    ctx.fillStyle = "rgba(147, 146, 147, 0.6)";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";

    for (const [ratio, label] of INTERVALS) {
      const x = xFromRatio(ratio, width);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height - 14);
      ctx.stroke();
      ctx.fillText(label, x, height - 2);
    }
    ctx.restore();

    // --- Dissonance curve ---
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = "#ab9df2";
    ctx.lineWidth = 2;
    ctx.beginPath();

    for (let i = 0; i < curve.length; i++) {
      const { dissonance } = curve[i]!;
      const x = i;
      const y = height - (dissonance / maxD) * (height - 20);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
    ctx.restore();

    // --- X-axis labels ---
    ctx.save();
    ctx.fillStyle = "rgba(147, 146, 147, 0.6)";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";

    for (let r = 0.6; r <= 2.41; r += 0.2) {
      const x = xFromRatio(r, width);
      ctx.fillText(r.toFixed(1), x, height - 14);
    }
    ctx.restore();
  });

  // -------------------------------------------------------------------
  // Mouse interaction
  // -------------------------------------------------------------------

  function handleMouseDown(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const x = (e.clientX - rect.left) * scaleX;
    const ratio = ratioFromX(x, canvas.width);
    playInterval(baseFreq(), ratio);

    function onMouseMove(ev: MouseEvent) {
      const moveX = (ev.clientX - rect.left) * scaleX;
      const clampedRatio = Math.max(
        R_MIN,
        Math.min(R_MAX, ratioFromX(moveX, canvas.width))
      );
      playInterval(baseFreq(), clampedRatio);
    }

    function onMouseUp() {
      stopInterval();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  return (
    <div class="dissonance-curve">
      <div class="dissonance-header">
        <span class="panel-label">dissonance curve</span>
        <label class="base-freq-control">
          base:
          <input
            type="number"
            value={baseFreq()}
            min={20}
            max={2000}
            step={1}
            onInput={(e) => setBaseFreq(Number(e.currentTarget.value))}
          />
          Hz
        </label>
      </div>
      <canvas
        ref={canvas}
        width={800}
        height={200}
        onMouseDown={handleMouseDown}
        style={{ cursor: "crosshair" }}
      />
    </div>
  );
}
