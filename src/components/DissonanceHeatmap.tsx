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

// Gradient descent to find nearest local minimum in the dissonance landscape
function findLocalMinimum(
  amps: number[],
  startR1: number,
  startR2: number,
  maxIter: number = 100,
  stepSize: number = 0.002,
  eps: number = 1e-6
): [number, number] {
  let r1 = startR1;
  let r2 = startR2;
  const h = 1e-5;

  for (let i = 0; i < maxIter; i++) {
    const d = triadDiss(amps, r1, r2);

    // Numerical gradient
    const dr1 = (triadDiss(amps, r1 + h, r2) - d) / h;
    const dr2 = (triadDiss(amps, r1, r2 + h) - d) / h;

    const gradNorm = Math.sqrt(dr1 * dr1 + dr2 * dr2);
    if (gradNorm < eps) break;

    // Step downhill
    r1 -= stepSize * dr1 / gradNorm;
    r2 -= stepSize * dr2 / gradNorm;

    // Clamp to valid range
    r1 = Math.max(R_MIN, Math.min(R_MAX, r1));
    r2 = Math.max(R_MIN, Math.min(R_MAX, r2));
  }

  return [r1, r2];
}

export default function DissonanceHeatmap() {
  let canvas!: HTMLCanvasElement;
  let overlayCanvas!: HTMLCanvasElement;
  const clickedMinima: [number, number][] = [];

  function ratiosFromMouse(e: MouseEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const r1 = R_MIN + (R_MAX - R_MIN) * x;
    const r2 = R_MIN + (R_MAX - R_MIN) * (1 - y);
    return [r1, r2];
  }

  function drawOverlay(currentR1?: number, currentR2?: number) {
    const ctx = overlayCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Draw all previously clicked minima
    for (const [mr1, mr2] of clickedMinima) {
      const mx = ratioToPos(mr1);
      const my = SIZE - ratioToPos(mr2);
      ctx.fillStyle = "rgba(171, 157, 242, 0.7)"; // purple dot
      ctx.beginPath();
      ctx.arc(mx, my, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw current active marker
    if (currentR1 !== undefined && currentR2 !== undefined) {
      const x = ratioToPos(currentR1);
      const y = SIZE - ratioToPos(currentR2);

      ctx.strokeStyle = "#fcfcfa";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = "#fcfcfa";
      ctx.font = "9px monospace";
      const label = `${currentR1.toFixed(3)} × ${currentR2.toFixed(3)}`;
      ctx.fillText(label, Math.min(x + 10, SIZE - 80), Math.max(y - 8, 12));
    }
  }

  function handleMouseDown(e: MouseEvent) {
    const [clickR1, clickR2] = ratiosFromMouse(e);
    const amps = overtoneAmps();

    // Snap to local minimum
    const [r1, r2] = findLocalMinimum(amps, clickR1, clickR2);
    clickedMinima.push([r1, r2]);
    playTriad(BASE_FREQ, r1, r2);
    drawOverlay(r1, r2);

    const onMove = (ev: MouseEvent) => {
      const [cr1, cr2] = ratiosFromMouse(ev);
      const [r1, r2] = findLocalMinimum(amps, cr1, cr2);
      playTriad(BASE_FREQ, r1, r2);
      drawOverlay(r1, r2);
    };
    const onUp = () => {
      stopInterval();
      drawOverlay(); // keep dots, remove active marker
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
        <span class="panel-label">3-note dissonance (base × r1 × r2) — click snaps to local min</span>
      </div>
      <div style={{ position: "relative", width: "400px", height: "400px" }}>
        <canvas
          ref={canvas}
          width={SIZE}
          height={SIZE}
          style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", "border-radius": "4px", "image-rendering": "pixelated" }}
        />
        <canvas
          ref={overlayCanvas}
          width={SIZE}
          height={SIZE}
          onMouseDown={handleMouseDown}
          style={{ position: "absolute", top: "0", left: "0", width: "100%", height: "100%", cursor: "crosshair", "border-radius": "4px" }}
        />
      </div>
    </div>
  );
}
