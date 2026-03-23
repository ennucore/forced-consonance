import { createEffect, createSignal } from "solid-js";
import { overtoneAmps } from "../overtones";
import { playTetrad, stopInterval } from "../audio";

const R_MIN = 1.0;
const R_MAX = 2.5;
const SIZE = 150;
const BASE_FREQ = 220;

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

function pairDiss(amps: number[], ratio: number): number {
  let total = 0;
  for (let i = 0; i < amps.length; i++) {
    const wi = amps[i]!;
    if (wi === 0) continue;
    const fi = i + 1;
    for (let j = 0; j < amps.length; j++) {
      const wj = amps[j]!;
      if (wj === 0) continue;
      total += wi * wj * kernel((j + 1) * ratio / fi - 1);
    }
  }
  return total;
}

// Four-note dissonance: 6 pairs
function tetradDiss(amps: number[], r1: number, r2: number, r3: number): number {
  return (
    pairDiss(amps, r1) +
    pairDiss(amps, r2) +
    pairDiss(amps, r3) +
    pairDiss(amps, r2 / r1) +
    pairDiss(amps, r3 / r1) +
    pairDiss(amps, r3 / r2)
  );
}

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

export default function DissonanceVolume() {
  let canvas!: HTMLCanvasElement;
  const [r3, setR3] = createSignal(1.5);

  function ratiosFromMouse(e: MouseEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return [
      R_MIN + (R_MAX - R_MIN) * x,
      R_MIN + (R_MAX - R_MIN) * (1 - y),
    ];
  }

  function handleMouseDown(e: MouseEvent) {
    const [r1, r2] = ratiosFromMouse(e);
    // Play four notes: base, r1, r2, r3
    // playTriad only does 3, so play base+r1+r2 and add r3 via another interval
    // For simplicity, just play the three variable ratios
    playTetrad(BASE_FREQ, r1, r2, r3());

    const onMove = (ev: MouseEvent) => {
      const [r1, r2] = ratiosFromMouse(ev);
      playTetrad(BASE_FREQ, r1, r2, r3());
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
    const r3Val = r3();
    const ctx = canvas.getContext("2d")!;
    const imgData = ctx.createImageData(SIZE, SIZE);
    const data = imgData.data;

    let maxD = 0.001;
    const values = new Float64Array(SIZE * SIZE);

    for (let yi = 0; yi < SIZE; yi++) {
      const r2 = R_MIN + (R_MAX - R_MIN) * (1 - yi / (SIZE - 1));
      for (let xi = 0; xi < SIZE; xi++) {
        const r1 = R_MIN + (R_MAX - R_MIN) * (xi / (SIZE - 1));
        const d = tetradDiss(amps, r1, r2, r3Val);
        values[yi * SIZE + xi] = d;
        if (d > maxD) maxD = d;
      }
    }

    for (let i = 0; i < SIZE * SIZE; i++) {
      const [r, g, b] = colormap(values[i]! / maxD);
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);

    // Grid lines
    ctx.strokeStyle = "rgba(147, 146, 147, 0.3)";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.font = "9px monospace";
    ctx.fillStyle = "rgba(147, 146, 147, 0.6)";

    for (const [ratio, label] of INTERVALS) {
      const x = ratioToPos(ratio);
      const y = SIZE - ratioToPos(ratio);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, SIZE);
      ctx.stroke();
      ctx.fillText(label, x + 2, SIZE - 3);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(SIZE, y);
      ctx.stroke();
      ctx.fillText(label, 2, y - 2);
    }
    ctx.setLineDash([]);

    // Mark r3 position on the axes
    const r3Label = r3Val.toFixed(2);
    const nearest = INTERVALS.find(([r]) => Math.abs(r - r3Val) < 0.02);
    ctx.fillStyle = "rgba(255, 216, 102, 0.8)";
    ctx.fillText(`r3=${nearest ? nearest[1] : r3Label}`, SIZE - 60, 12);
  });

  return (
    <div class="dissonance-heatmap">
      <div class="dissonance-header">
        <span class="panel-label">4-note dissonance (r1 × r2, slice at r3)</span>
        <span class="base-freq-control">
          r3:
          {INTERVALS.map(([ratio, label]) => (
            <button
              class={`preset-btn ${Math.abs(r3() - ratio) < 0.01 ? "active" : ""}`}
              onClick={() => setR3(ratio)}
              style={{ padding: "2px 5px", "font-size": "0.6rem" }}
            >
              {label}
            </button>
          ))}
          <input
            type="range"
            min={R_MIN}
            max={R_MAX}
            step="0.01"
            value={r3()}
            onInput={(e) => setR3(parseFloat(e.currentTarget.value))}
          />
          {r3().toFixed(2)}
        </span>
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
