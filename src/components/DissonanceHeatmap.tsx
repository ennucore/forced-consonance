import { createEffect } from "solid-js";
import { overtoneAmps } from "../overtones";
import { playTriad, stopInterval } from "../audio";

const SIZE = 200; // resolution
const SQRT2 = Math.SQRT2;
const SQRT6 = Math.sqrt(6);

// Range in octaves on each axis (±RANGE)
const RANGE = 1.0;

const KERNEL_A = 0.0023;
function kernel(x: number): number {
  const absx = Math.abs(x);
  return 50 * absx * Math.exp(-(x * x) / KERNEL_A);
}

// Pairwise dissonance between two notes at a given frequency ratio
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

// ---------------------------------------------------------------------------
// Sum-zero log-frequency plane: log2(f1) + log2(f2) + log2(f3) = 0
// ---------------------------------------------------------------------------
// Orthonormal basis on this plane:
//   e1 = (1, -1,  0) / √2
//   e2 = (1,  1, -2) / √6
//
// So: log2(f1) = x/√2 + y/√6
//     log2(f2) = -x/√2 + y/√6
//     log2(f3) = -2y/√6

function xyToLogFreqs(x: number, y: number): [number, number, number] {
  const lf1 = x / SQRT2 + y / SQRT6;
  const lf2 = -x / SQRT2 + y / SQRT6;
  const lf3 = -2 * y / SQRT6;
  return [lf1, lf2, lf3];
}

// Triad dissonance from (x, y) on the sum-zero plane
function planeDiss(amps: number[], x: number, y: number): number {
  const [lf1, lf2, lf3] = xyToLogFreqs(x, y);
  // Ratios: f2/f1, f3/f1, f3/f2
  const r12 = Math.pow(2, lf2 - lf1);
  const r13 = Math.pow(2, lf3 - lf1);
  const r23 = Math.pow(2, lf3 - lf2);
  return pairDiss(amps, r12) + pairDiss(amps, r13) + pairDiss(amps, r23);
}

// Viridis-like colormap
function colormap(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 * t - 0.1)));
  const g = Math.round(255 * Math.min(1, Math.max(0, -2 * (t - 0.55) * (t - 0.55) + 0.7)));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1 - 1.5 * t)));
  return [r, g, b];
}

// Pixel <-> plane coords
function pixToXY(px: number, py: number): [number, number] {
  const x = (px / (SIZE - 1)) * 2 * RANGE - RANGE;
  const y = RANGE - (py / (SIZE - 1)) * 2 * RANGE; // y=top is positive
  return [x, y];
}

function xyToPix(x: number, y: number): [number, number] {
  const px = ((x + RANGE) / (2 * RANGE)) * (SIZE - 1);
  const py = ((RANGE - y) / (2 * RANGE)) * (SIZE - 1);
  return [px, py];
}

// Gradient descent to local minimum
function findLocalMinimum(
  amps: number[],
  startX: number,
  startY: number,
  maxIter: number = 100,
  stepSize: number = 0.003,
  eps: number = 1e-6
): [number, number] {
  let x = startX;
  let y = startY;
  const h = 1e-5;

  for (let i = 0; i < maxIter; i++) {
    const d = planeDiss(amps, x, y);
    const dx = (planeDiss(amps, x + h, y) - d) / h;
    const dy = (planeDiss(amps, x, y + h) - d) / h;
    const norm = Math.sqrt(dx * dx + dy * dy);
    if (norm < eps) break;
    x -= stepSize * dx / norm;
    y -= stepSize * dy / norm;
    x = Math.max(-RANGE, Math.min(RANGE, x));
    y = Math.max(-RANGE, Math.min(RANGE, y));
  }
  return [x, y];
}

const BASE_FREQ = 220;

export default function DissonanceHeatmap() {
  let canvas!: HTMLCanvasElement;
  let overlayCanvas!: HTMLCanvasElement;
  const clickedMinima: [number, number][] = [];

  function coordsFromMouse(e: MouseEvent): [number, number] {
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * SIZE;
    const py = (e.clientY - rect.top) / rect.height * SIZE;
    return pixToXY(px, py);
  }

  function playFromXY(x: number, y: number) {
    const [lf1, lf2, lf3] = xyToLogFreqs(x, y);
    // Anchor geometric mean at BASE_FREQ
    const f1 = BASE_FREQ * Math.pow(2, lf1);
    const f2 = BASE_FREQ * Math.pow(2, lf2);
    const f3 = BASE_FREQ * Math.pow(2, lf3);
    // playTriad(base, r1, r2) plays base, base*r1, base*r2
    playTriad(f1, f2 / f1, f3 / f1);
  }

  function drawOverlay(cx?: number, cy?: number) {
    const ctx = overlayCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Draw clicked minima
    for (const [mx, my] of clickedMinima) {
      const [px, py] = xyToPix(mx, my);
      ctx.fillStyle = "rgba(171, 157, 242, 0.7)";
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw active marker
    if (cx !== undefined && cy !== undefined) {
      const [px, py] = xyToPix(cx, cy);
      ctx.strokeStyle = "#fcfcfa";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.stroke();

      // Show ratios
      const [lf1, lf2, lf3] = xyToLogFreqs(cx, cy);
      const r12 = Math.pow(2, lf2 - lf1);
      const r13 = Math.pow(2, lf3 - lf1);
      ctx.fillStyle = "#fcfcfa";
      ctx.font = "9px monospace";
      ctx.fillText(
        `${r12.toFixed(3)} ${r13.toFixed(3)}`,
        Math.min(px + 10, SIZE - 70),
        Math.max(py - 8, 12)
      );
    }
  }

  function handleMouseDown(e: MouseEvent) {
    const [cx, cy] = coordsFromMouse(e);
    const amps = overtoneAmps();
    const [x, y] = findLocalMinimum(amps, cx, cy);
    clickedMinima.push([x, y]);
    playFromXY(x, y);
    drawOverlay(x, y);

    const onMove = (ev: MouseEvent) => {
      const [cx, cy] = coordsFromMouse(ev);
      const [x, y] = findLocalMinimum(amps, cx, cy);
      playFromXY(x, y);
      drawOverlay(x, y);
    };
    const onUp = () => {
      stopInterval();
      drawOverlay();
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

    // Compute heatmap on the sum-zero plane
    let maxD = 0.001;
    const values = new Float64Array(SIZE * SIZE);

    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const [x, y] = pixToXY(px, py);
        const d = planeDiss(amps, x, y);
        values[py * SIZE + px] = d;
        if (d > maxD) maxD = d;
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

    // Draw reference lines for common triads
    // Major triad: ratios 1:5/4:3/2 → log2 offsets from geometric mean
    // Minor triad: ratios 1:6/5:3/2
    const triads: { ratios: [number, number]; label: string; color: string }[] = [
      { ratios: [5 / 4, 3 / 2], label: "Maj", color: "rgba(169, 220, 118, 0.6)" },
      { ratios: [6 / 5, 3 / 2], label: "min", color: "rgba(120, 220, 232, 0.6)" },
      { ratios: [4 / 3, 3 / 2], label: "sus4", color: "rgba(252, 152, 103, 0.5)" },
      { ratios: [5 / 4, 5 / 3], label: "Maj6", color: "rgba(255, 216, 102, 0.5)" },
    ];

    ctx.font = "9px monospace";
    for (const triad of triads) {
      // Convert triad ratios to (x, y) on the plane
      // f1=1, f2=r1, f3=r2 → log2 values
      const l1 = 0;
      const l2 = Math.log2(triad.ratios[0]);
      const l3 = Math.log2(triad.ratios[1]);
      // Shift so sum = 0: subtract mean
      const mean = (l1 + l2 + l3) / 3;
      const c1 = l1 - mean, c2 = l2 - mean, c3 = l3 - mean;
      // Project onto basis: x = (c1 - c2) * √2/2, y = (c1 + c2 - 2*c3) * √6/6
      // Since e1 = (1,-1,0)/√2: x = c1/√2 + c2*(-1/√2) = (c1-c2)/√2
      // Since e2 = (1,1,-2)/√6: y = (c1+c2-2*c3)/√6
      const tx = (c1 - c2) / SQRT2;
      // c1+c2-2*c3 = c1+c2-2c3, but c1+c2+c3=0 so c1+c2=-c3, thus = -c3-2c3 = -3c3
      const ty = -3 * c3 / SQRT6;
      const [px, py] = xyToPix(tx, ty);

      // Draw all 6 permutations (symmetric group S3 acts on the plane)
      // Permuting (f1,f2,f3) gives 6 rotated/reflected copies
      const perms = [
        [c1, c2, c3], [c1, c3, c2], [c2, c1, c3],
        [c2, c3, c1], [c3, c1, c2], [c3, c2, c1],
      ];

      ctx.fillStyle = triad.color;
      for (const [p1, p2, p3] of perms) {
        const sx = (p1! - p2!) / SQRT2;
        const sy = -3 * p3! / SQRT6;
        const [spx, spy] = xyToPix(sx, sy);
        if (spx >= 0 && spx < SIZE && spy >= 0 && spy < SIZE) {
          ctx.beginPath();
          ctx.arc(spx, spy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Label only the primary position
      if (px >= 0 && px < SIZE && py >= 0 && py < SIZE) {
        ctx.fillText(triad.label, px + 5, py - 3);
      }
    }

    // Draw axes through origin
    const [ox, oy] = xyToPix(0, 0);
    ctx.strokeStyle = "rgba(147, 146, 147, 0.25)";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(ox, 0); ctx.lineTo(ox, SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, oy); ctx.lineTo(SIZE, oy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label axes
    ctx.fillStyle = "rgba(147, 146, 147, 0.5)";
    ctx.font = "8px monospace";
    ctx.fillText(`-${RANGE}oct`, 2, oy - 3);
    ctx.fillText(`+${RANGE}oct`, SIZE - 35, oy - 3);
  });

  return (
    <div class="dissonance-heatmap">
      <div class="dissonance-header">
        <span class="panel-label">3-note dissonance (log f₁+f₂+f₃=0 plane) — click snaps to min</span>
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
