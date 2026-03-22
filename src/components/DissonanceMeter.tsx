import { createSignal, onMount, onCleanup } from "solid-js";
import { getAnalyser, getActiveFundamentals } from "../audio";
import {
  overtoneAmps,
  setOvertoneAmps,
  computeChordDissonance,
} from "../overtones";

const HISTORY_LEN = 200;
const WIDTH = 200;
const HEIGHT = 48;
const SAMPLE_INTERVAL = 50; // ms

// ---------------------------------------------------------------------------
// Sethares roughness kernel (mirrors overtones.ts)
// ---------------------------------------------------------------------------

const KERNEL_A = 0.0023;
function kernel(x: number): number {
  const absx = Math.abs(x);
  return 50 * absx * Math.exp(-(x * x) / KERNEL_A);
}

// ---------------------------------------------------------------------------
// FFT peak extraction + spectral dissonance (for display)
// ---------------------------------------------------------------------------

const AMP_THRESHOLD = 8;
const MAX_FREQ = 8000;
const PEAK_RADIUS = 3;

function extractPeaks(
  data: Uint8Array,
  sampleRate: number,
  fftSize: number
): { freq: number; amp: number }[] {
  const binHz = sampleRate / fftSize;
  const maxBin = Math.min(data.length, Math.floor(MAX_FREQ / binHz));
  const peaks: { freq: number; amp: number }[] = [];

  for (let i = PEAK_RADIUS; i < maxBin - PEAK_RADIUS; i++) {
    const val = data[i]!;
    if (val < AMP_THRESHOLD) continue;

    let isMax = true;
    for (let j = 1; j <= PEAK_RADIUS; j++) {
      if (data[i - j]! >= val || data[i + j]! >= val) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;

    peaks.push({ freq: i * binHz, amp: val / 255 });
  }
  return peaks;
}

function spectralDissonance(peaks: { freq: number; amp: number }[]): number {
  if (peaks.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < peaks.length; i++) {
    const pi = peaks[i]!;
    for (let j = i + 1; j < peaks.length; j++) {
      const pj = peaks[j]!;
      total += pi.amp * pj.amp * kernel(pj.freq / pi.freq - 1);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Gaussian-blurred MSE on a semitone grid (closeness regularizer)
// ---------------------------------------------------------------------------

// Map overtone amplitudes to a semitone-spaced grid.
// Harmonic n is at 12*log2(n) semitones above fundamental.
const GRID_SIZE = 49; // 0..48 semitones covers up to harmonic 16

function toSemitoneGrid(amps: number[]): Float64Array {
  const grid = new Float64Array(GRID_SIZE);
  for (let i = 0; i < amps.length; i++) {
    const semitone = 12 * Math.log2(i + 1);
    const bin = Math.round(semitone);
    if (bin >= 0 && bin < GRID_SIZE) {
      grid[bin] += amps[i]!;
    }
  }
  return grid;
}

function gaussianBlur(grid: Float64Array, sigma: number): Float64Array {
  const result = new Float64Array(grid.length);
  const radius = Math.ceil(sigma * 3);
  for (let i = 0; i < grid.length; i++) {
    let sum = 0;
    let wsum = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = i + j;
      if (idx < 0 || idx >= grid.length) continue;
      const w = Math.exp(-(j * j) / (2 * sigma * sigma));
      sum += grid[idx]! * w;
      wsum += w;
    }
    result[i] = sum / wsum;
  }
  return result;
}

function blurredMSE(ampsA: number[], ampsB: number[]): number {
  const gridA = gaussianBlur(toSemitoneGrid(ampsA), 1);
  const gridB = gaussianBlur(toSemitoneGrid(ampsB), 1);
  let mse = 0;
  for (let i = 0; i < GRID_SIZE; i++) {
    const diff = gridA[i]! - gridB[i]!;
    mse += diff * diff;
  }
  return mse / GRID_SIZE;
}

// ---------------------------------------------------------------------------
// Optimizer: gradient descent on overtone amps
// ---------------------------------------------------------------------------

// Balance between dissonance reduction and staying close to original.
// The closeness term is scaled up so it meaningfully competes with dissonance.
const CLOSENESS_WEIGHT = 50;
const GRAD_DELTA = 1e-4;

function computeLoss(
  amps: number[],
  originalAmps: number[],
  fundamentals: number[]
): number {
  const diss = computeChordDissonance(amps, fundamentals);
  const close = blurredMSE(amps, originalAmps);
  return diss + CLOSENESS_WEIGHT * close;
}

function optimizeStep(
  currentAmps: number[],
  originalAmps: number[],
  fundamentals: number[],
  lr: number
): number[] {
  const n = currentAmps.length;
  const loss = computeLoss(currentAmps, originalAmps, fundamentals);

  const grad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const perturbed = [...currentAmps];
    perturbed[i]! += GRAD_DELTA;
    const lossP = computeLoss(perturbed, originalAmps, fundamentals);
    grad[i] = (lossP - loss) / GRAD_DELTA;
  }

  return currentAmps.map((a, i) =>
    Math.max(0, Math.min(1, a - lr * grad[i]!))
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DissonanceMeter() {
  let canvas!: HTMLCanvasElement;
  let valueEl!: HTMLSpanElement;

  const [optimizing, setOptimizing] = createSignal(false);
  const [lr, setLr] = createSignal(0.01);

  // Snapshot of amps when optimize was started
  let originalAmps: number[] = [];
  let optimizeIntervalId = 0;

  const history: number[] = [];
  let maxSeen = 0.001;
  let intervalId: number;

  // Throttle optimization to ~5 steps/sec so audio crossfades settle
  const OPTIMIZE_INTERVAL = 50;

  function startOptimize() {
    originalAmps = [...overtoneAmps()];
    setOptimizing(true);

    optimizeIntervalId = window.setInterval(() => {
      const fundamentals = getActiveFundamentals();
      if (fundamentals.length >= 2) {
        const updated = optimizeStep(
          overtoneAmps(),
          originalAmps,
          fundamentals,
          lr()
        );
        setOvertoneAmps(updated);
      }
    }, OPTIMIZE_INTERVAL);
  }

  function stopOptimize() {
    setOptimizing(false);
    clearInterval(optimizeIntervalId);
  }

  onMount(() => {
    const ctx = canvas.getContext("2d")!;
    const analyser = getAnalyser();
    const data = new Uint8Array(analyser.frequencyBinCount);

    intervalId = window.setInterval(() => {
      analyser.getByteFrequencyData(data);

      const peaks = extractPeaks(data, analyser.context.sampleRate, analyser.fftSize);
      const d = spectralDissonance(peaks);

      history.push(d);
      if (history.length > HISTORY_LEN) history.shift();

      if (d > maxSeen) maxSeen = d;
      else maxSeen = maxSeen * 0.999 + d * 0.001;
      maxSeen = Math.max(maxSeen, 0.001);

      valueEl.textContent = d > 0.01 ? d.toFixed(2) : "—";

      // Draw sparkline
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      if (history.length < 2) return;

      ctx.beginPath();
      for (let i = 0; i < history.length; i++) {
        const x = WIDTH - (history.length - 1 - i) * (WIDTH / (HISTORY_LEN - 1));
        const y = HEIGHT - (history[i]! / maxSeen) * (HEIGHT - 4);
        if (i === 0) {
          ctx.moveTo(x, HEIGHT);
          ctx.lineTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.lineTo(WIDTH, HEIGHT);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 97, 136, 0.15)";
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < history.length; i++) {
        const x = WIDTH - (history.length - 1 - i) * (WIDTH / (HISTORY_LEN - 1));
        const y = HEIGHT - (history[i]! / maxSeen) * (HEIGHT - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#ff6188";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }, SAMPLE_INTERVAL);
  });

  onCleanup(() => {
    clearInterval(intervalId);
    clearInterval(optimizeIntervalId);
  });

  return (
    <div class="dissonance-meter">
      <div class="meter-header">
        <span class="panel-label">dissonance</span>
        <span class="meter-value" ref={valueEl}>—</span>
      </div>
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} />
      <div class="optimize-controls">
        <button
          class={`optimize-btn ${optimizing() ? "active" : ""}`}
          onClick={() => (optimizing() ? stopOptimize() : startOptimize())}
        >
          {optimizing() ? "stop" : "optimize"}
        </button>
        <label class="lr-control">
          lr:
          <input
            type="range"
            min="-4"
            max="0"
            step="0.1"
            value={Math.log10(lr())}
            onInput={(e) => setLr(Math.pow(10, parseFloat(e.currentTarget.value)))}
          />
          <span class="lr-value">{lr().toFixed(4)}</span>
        </label>
      </div>
    </div>
  );
}
