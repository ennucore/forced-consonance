import { createEffect } from "solid-js";
import { overtoneAmps } from "../overtones";
import { playTriad, stopInterval } from "../audio";

const R_MIN = 1.0;
const R_MAX = 2.5;
const SIZE = 200; // resolution

const KERNEL_A = 0.0023;
function kernel(x: number): number {
  const absx = Math.abs(x);
  return 50 * absx * Math.exp(-(x * x) / KERNEL_A);
}

const INTERVALS: [number, string][] = [
  [1, "P1"],
  [6 / 5, "m3"],
  [5 / 4, "M3"],
  [4 / 3, "P4"],
  [3 / 2, "P5"],
  [5 / 3, "M6"],
  [2, "P8"],
];

// Precompute pairwise dissonance between two notes at a given ratio,
// given overtone amplitudes. Returns the roughness contribution.
function pairDiss(amps: number[], ratio: number): number {
  let total = 0;
  for (let i = 0; i < amps.length; i++) {
    const wi = amps[i]!;
    if (wi === 0) continue;
    const fi = i + 1;
    for (let j = 0; j < amps.length; j++) {
      const wj = amps[j]!;
      if (wj === 0) continue;
      const fj = (j + 1) * ratio;
      total += wi * wj * kernel(fj / fi - 1);
    }
  }
  return total;
}

// Three-note dissonance: pairs (1,r1), (1,r2), (r1,r2)
function triadDiss(amps: number[], r1: number, r2: number): number {
  return pairDiss(amps, r1) + pairDiss(amps, r2) + pairDiss(amps, r2 / r1);
}

// Viridis-like colormap: low=dark purple, mid=teal, high=yellow
function colormap(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 * t - 0.1)));
  const g = Math.round(255 * Math.min(1, Math.max(0, -2 * (t - 0.55) * (t - 0.55) + 0.7)));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1 - 1.5 * t)));
  return [r, g, b];
}

function ratioToPos(r: number): number {
  return ((r - R_MIN) / (R_MAX - R_MIN)) * SIZE;
}

const BASE_FREQ = 220;

export default function DissonanceHeatmap() {
  let canvas!: HTMLCanvasElement;

  function ratiosFromMouse(e: MouseEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const r1 = R_MIN + (R_MAX - R_MIN) * x;
    const r2 = R_MIN + (R_MAX - R_MIN) * (1 - y);
    return [r1, r2];
  }

  function handleMouseDown(e: MouseEvent) {
    const [r1, r2] = ratiosFromMouse(e);
    playTriad(BASE_FREQ, r1, r2);

    const onMove = (ev: MouseEvent) => {
      const [r1, r2] = ratiosFromMouse(ev);
      playTriad(BASE_FREQ, r1, r2);
    };
    const onUp = () => {
      stopInterval();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  createEffect(() => {
    const amps = overtoneAmps();
    const ctx = canvas.getContext("2d")!;
    const imgData = ctx.createImageData(SIZE, SIZE);
    const data = imgData.data;

    // Compute heatmap
    let maxD = 0.001;
    const values = new Float64Array(SIZE * SIZE);

    for (let yi = 0; yi < SIZE; yi++) {
      const r2 = R_MIN + (R_MAX - R_MIN) * (1 - yi / (SIZE - 1)); // y=top is high ratio
      for (let xi = 0; xi < SIZE; xi++) {
        const r1 = R_MIN + (R_MAX - R_MIN) * (xi / (SIZE - 1));
        // Only compute below diagonal (r2 >= r1), mirror above
        const d = r2 >= r1 ? triadDiss(amps, r1, r2) : 0;
        values[yi * SIZE + xi] = d;
        if (d > maxD) maxD = d;
      }
    }

    // Mirror above diagonal
    for (let yi = 0; yi < SIZE; yi++) {
      const r2 = R_MIN + (R_MAX - R_MIN) * (1 - yi / (SIZE - 1));
      for (let xi = 0; xi < SIZE; xi++) {
        const r1 = R_MIN + (R_MAX - R_MIN) * (xi / (SIZE - 1));
        if (r2 < r1) {
          // Mirror: swap r1 and r2
          const mxi = Math.round(((r2 - R_MIN) / (R_MAX - R_MIN)) * (SIZE - 1));
          const myi = Math.round((1 - (r1 - R_MIN) / (R_MAX - R_MIN)) * (SIZE - 1));
          values[yi * SIZE + xi] = values[myi * SIZE + mxi] ?? 0;
        }
      }
    }

    // Render to image
    for (let i = 0; i < SIZE * SIZE; i++) {
      const t = values[i]! / maxD;
      const [r, g, b] = colormap(t);
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);

    // Draw interval grid lines
    ctx.strokeStyle = "rgba(147, 146, 147, 0.3)";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.font = "9px monospace";
    ctx.fillStyle = "rgba(147, 146, 147, 0.6)";

    for (const [ratio, label] of INTERVALS) {
      const x = ratioToPos(ratio);
      const y = SIZE - ratioToPos(ratio);
      // Vertical
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, SIZE);
      ctx.stroke();
      ctx.fillText(label, x + 2, SIZE - 3);
      // Horizontal
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(SIZE, y);
      ctx.stroke();
      ctx.fillText(label, 2, y - 2);
    }
    ctx.setLineDash([]);
  });

  return (
    <div class="dissonance-heatmap">
      <div class="dissonance-header">
        <span class="panel-label">3-note dissonance (base × r1 × r2)</span>
      </div>
      <canvas
        ref={canvas}
        width={SIZE}
        height={SIZE}
        onMouseDown={handleMouseDown}
        style={{ cursor: "crosshair" }}
      />
    </div>
  );
}
