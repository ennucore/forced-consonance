import { createSignal, onMount, onCleanup } from "solid-js";
import {
  getAnalyser,
  spectrum,
  referenceSpectrum,
  updateSpectrum,
  setOptimizerActive,
  getPoolFreqs,
  SPECTRUM_SIZE,
} from "../audio";

const HISTORY_LEN = 200;
const WIDTH = 200;
const HEIGHT = 48;
const SAMPLE_INTERVAL = 50; // ms

// ---------------------------------------------------------------------------
// Sethares roughness kernel
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

function fftDissonance(peaks: { freq: number; amp: number }[]): number {
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
// Dissonance on the pool spectrum
// ---------------------------------------------------------------------------

function poolDissonance(amps: Float64Array): number {
  const freqs = getPoolFreqs();
  // Collect active bins
  const active: { freq: number; amp: number }[] = [];
  for (let i = 0; i < amps.length; i++) {
    if (amps[i]! > 1e-6) active.push({ freq: freqs[i]!, amp: amps[i]! });
  }
  if (active.length < 2) return 0;

  let total = 0;
  for (let i = 0; i < active.length; i++) {
    const ai = active[i]!;
    for (let j = i + 1; j < active.length; j++) {
      const aj = active[j]!;
      total += ai.amp * aj.amp * kernel(aj.freq / ai.freq - 1);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Wasserstein W1 on log-energy for closeness
// ---------------------------------------------------------------------------

const LOG_ENERGY_EPS = 1e-12;

function toLogEnergy(amps: Float64Array): Float64Array {
  const freqs = getPoolFreqs();
  const grid = new Float64Array(SPECTRUM_SIZE);
  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    grid[i] = Math.log(amps[i]! * amps[i]! * freqs[i]! + LOG_ENERGY_EPS);
  }
  return grid;
}

function wasserstein(a: Float64Array, b: Float64Array): number {
  const logA = toLogEnergy(a);
  const logB = toLogEnergy(b);

  // Shift to non-negative
  let minVal = 0;
  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    minVal = Math.min(minVal, logA[i]!, logB[i]!);
  }

  let sumA = 0, sumB = 0;
  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    logA[i] = logA[i]! - minVal;
    logB[i] = logB[i]! - minVal;
    sumA += logA[i]!;
    sumB += logB[i]!;
  }

  if (sumA === 0 || sumB === 0) return 0;

  let cdfA = 0, cdfB = 0, dist = 0;
  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    cdfA += logA[i]! / sumA;
    cdfB += logB[i]! / sumB;
    dist += Math.abs(cdfA - cdfB);
  }
  return dist / SPECTRUM_SIZE;
}

// ---------------------------------------------------------------------------
// Optimizer: gradient descent on pool amplitudes
// ---------------------------------------------------------------------------

const GRAD_DELTA = 1e-4;

function computeLoss(
  amps: Float64Array,
  ref: Float64Array,
  closenessWeight: number
): number {
  return poolDissonance(amps) + closenessWeight * wasserstein(amps, ref);
}

function optimizeStep(
  current: Float64Array,
  ref: Float64Array,
  lr: number,
  closenessWeight: number
): Float64Array {
  const n = current.length;
  const loss = computeLoss(current, ref, closenessWeight);

  const grad = new Float64Array(n);

  // Only compute gradients for bins that are active or in the reference
  for (let i = 0; i < n; i++) {
    if (current[i]! < 1e-6 && ref[i]! < 1e-6) continue;

    const perturbed = new Float64Array(current);
    perturbed[i] += GRAD_DELTA;
    grad[i] = (computeLoss(perturbed, ref, closenessWeight) - loss) / GRAD_DELTA;
  }

  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = Math.max(0, current[i]! - lr * grad[i]!);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DissonanceMeter() {
  let canvas!: HTMLCanvasElement;
  let valueEl!: HTMLSpanElement;

  const [optimizing, setOptimizing] = createSignal(false);
  const [lr, setLr] = createSignal(0.01);
  const [closeness, setCloseness] = createSignal(50);

  let optimizeIntervalId = 0;

  const history: number[] = [];
  let maxSeen = 0.001;
  let intervalId: number;

  const OPTIMIZE_INTERVAL = 125; // ~8 steps/sec

  function startOptimize() {
    setOptimizing(true);
    setOptimizerActive(true);

    optimizeIntervalId = window.setInterval(() => {
      const current = spectrum();
      const ref = referenceSpectrum();
      const updated = optimizeStep(current, ref, lr(), closeness());
      updateSpectrum(updated);
    }, OPTIMIZE_INTERVAL);
  }

  function stopOptimize() {
    setOptimizing(false);
    setOptimizerActive(false);
    clearInterval(optimizeIntervalId);
  }

  onMount(() => {
    const ctx = canvas.getContext("2d")!;
    const analyserNode = getAnalyser();
    const data = new Uint8Array(analyserNode.frequencyBinCount);

    intervalId = window.setInterval(() => {
      analyserNode.getByteFrequencyData(data);

      const peaks = extractPeaks(data, analyserNode.context.sampleRate, analyserNode.fftSize);
      const d = fftDissonance(peaks);

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
    setOptimizerActive(false);
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
        <label class="lr-control">
          close:
          <input
            type="range"
            min="0"
            max="200"
            step="1"
            value={closeness()}
            onInput={(e) => setCloseness(parseFloat(e.currentTarget.value))}
          />
          <span class="lr-value">{closeness().toFixed(0)}</span>
        </label>
      </div>
    </div>
  );
}
