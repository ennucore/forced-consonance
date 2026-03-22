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
// 1D Optimal Transport: displacement interpolation
// ---------------------------------------------------------------------------
//
// Instead of using a loss function for closeness, directly compute the
// optimal transport map between current and reference, then move each
// mass particle a fraction of the way toward its destination.
// This physically slides peaks along the frequency axis.

function transportStep(
  current: Float64Array,
  ref: Float64Array,
  alpha: number // fraction to move toward reference (0 = stay, 1 = snap)
): Float64Array {
  const n = current.length;

  let totalCur = 0, totalRef = 0;
  for (let i = 0; i < n; i++) {
    totalCur += current[i]!;
    totalRef += ref[i]!;
  }

  // Edge cases: one or both empty
  if (totalCur < 1e-10 && totalRef < 1e-10) return new Float64Array(n);
  if (totalCur < 1e-10) {
    // No current mass — fade in reference
    const result = new Float64Array(n);
    for (let i = 0; i < n; i++) result[i] = ref[i]! * alpha;
    return result;
  }
  if (totalRef < 1e-10) {
    // No reference — fade out current
    const result = new Float64Array(n);
    for (let i = 0; i < n; i++) result[i] = current[i]! * (1 - alpha);
    return result;
  }

  // Normalize to equal mass for quantile matching
  const curNorm = new Float64Array(n);
  const refNorm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    curNorm[i] = current[i]! / totalCur;
    refNorm[i] = ref[i]! / totalRef;
  }

  // Build CDFs
  const cdfCur = new Float64Array(n);
  const cdfRef = new Float64Array(n);
  cdfCur[0] = curNorm[0]!;
  cdfRef[0] = refNorm[0]!;
  for (let i = 1; i < n; i++) {
    cdfCur[i] = cdfCur[i - 1]! + curNorm[i]!;
    cdfRef[i] = cdfRef[i - 1]! + refNorm[i]!;
  }

  // For each bin with mass in current, find its transport destination
  // via quantile matching, then interpolate position
  const result = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    if (curNorm[i]! < 1e-12) continue;

    // Quantile midpoint of this bin's mass
    const qMid = (i > 0 ? cdfCur[i - 1]! : 0) + curNorm[i]! / 2;

    // Find target: inverse CDF of reference at this quantile
    let target = 0;
    for (let j = 0; j < n; j++) {
      if (cdfRef[j]! >= qMid) { target = j; break; }
      target = j;
    }

    // Interpolate position between current and target
    const newPos = (1 - alpha) * i + alpha * target;

    // Distribute mass to nearest bins (linear interpolation on grid)
    const lo = Math.floor(newPos);
    const hi = lo + 1;
    const frac = newPos - lo;
    const mass = curNorm[i]!;

    if (lo >= 0 && lo < n) result[lo] += mass * (1 - frac);
    if (hi >= 0 && hi < n) result[hi] += mass * frac;
  }

  // Scale to interpolated total mass
  const targetTotal = (1 - alpha) * totalCur + alpha * totalRef;
  for (let i = 0; i < n; i++) result[i] *= targetTotal;

  return result;
}

// Amplitude MSE for display only
function ampMSE(a: Float64Array, b: Float64Array): number {
  let mse = 0;
  for (let i = 0; i < SPECTRUM_SIZE; i++) {
    const diff = a[i]! - b[i]!;
    mse += diff * diff;
  }
  return mse / SPECTRUM_SIZE;
}

// ---------------------------------------------------------------------------
// Adam optimizer — dissonance reduction only
// ---------------------------------------------------------------------------
//
// Closeness is handled by the transport step (no gradient needed).
// Adam only optimizes the dissonance term, so there are no competing
// objectives and no oscillation.

const GRAD_DELTA = 1e-4;
const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPS = 1e-8;

let adamM: Float64Array | null = null;
let adamV: Float64Array | null = null;
let adamT = 0;

function resetAdam() {
  adamM = new Float64Array(SPECTRUM_SIZE);
  adamV = new Float64Array(SPECTRUM_SIZE);
  adamT = 0;
}

// ---------------------------------------------------------------------------
// Mode A: Transport + dissonance-only Adam (no competing objectives)
// ---------------------------------------------------------------------------

function optimizeStepTransport(
  current: Float64Array,
  ref: Float64Array,
  lr: number,
  transportAlpha: number,
  dissWeight: number
): Float64Array {
  const n = current.length;

  // Step 1: Transport — slide spectrum toward reference
  const transported = transportStep(current, ref, transportAlpha);

  // Step 2: Dissonance gradient (Adam) on the transported result
  if (dissWeight <= 0) return transported;

  if (!adamM || adamM.length !== n) resetAdam();
  adamT++;

  const baseDiss = poolDissonance(transported);
  const grad = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    if (transported[i]! < 1e-6) continue;

    const perturbed = new Float64Array(transported);
    perturbed[i] += GRAD_DELTA;
    grad[i] = (poolDissonance(perturbed) - baseDiss) / GRAD_DELTA;
  }

  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    adamM![i] = ADAM_BETA1 * adamM![i]! + (1 - ADAM_BETA1) * grad[i]!;
    adamV![i] = ADAM_BETA2 * adamV![i]! + (1 - ADAM_BETA2) * grad[i]! * grad[i]!;

    const mHat = adamM![i]! / (1 - Math.pow(ADAM_BETA1, adamT));
    const vHat = adamV![i]! / (1 - Math.pow(ADAM_BETA2, adamT));

    result[i] = Math.max(0, transported[i]! - lr * mHat / (Math.sqrt(vHat) + ADAM_EPS));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Mode B: Joint loss (dissonance + MSE closeness) with Adam
// ---------------------------------------------------------------------------

function jointLoss(
  amps: Float64Array,
  ref: Float64Array,
  closenessWeight: number,
  dissWeight: number
): number {
  return dissWeight * poolDissonance(amps) + closenessWeight * ampMSE(amps, ref);
}

function optimizeStepJoint(
  current: Float64Array,
  ref: Float64Array,
  lr: number,
  closenessWeight: number,
  dissWeight: number
): Float64Array {
  const n = current.length;

  if (!adamM || adamM.length !== n) resetAdam();
  adamT++;

  const loss = jointLoss(current, ref, closenessWeight, dissWeight);
  const grad = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    if (current[i]! < 1e-6 && ref[i]! < 1e-6) continue;

    const perturbed = new Float64Array(current);
    perturbed[i] += GRAD_DELTA;
    grad[i] = (jointLoss(perturbed, ref, closenessWeight, dissWeight) - loss) / GRAD_DELTA;
  }

  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    adamM![i] = ADAM_BETA1 * adamM![i]! + (1 - ADAM_BETA1) * grad[i]!;
    adamV![i] = ADAM_BETA2 * adamV![i]! + (1 - ADAM_BETA2) * grad[i]! * grad[i]!;

    const mHat = adamM![i]! / (1 - Math.pow(ADAM_BETA1, adamT));
    const vHat = adamV![i]! / (1 - Math.pow(ADAM_BETA2, adamT));

    result[i] = Math.max(0, current[i]! - lr * mHat / (Math.sqrt(vHat) + ADAM_EPS));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DissonanceMeter() {
  let dissCanvas!: HTMLCanvasElement;
  let closeCanvas!: HTMLCanvasElement;
  let dissValueEl!: HTMLSpanElement;
  let closeValueEl!: HTMLSpanElement;

  const [optimizing, setOptimizing] = createSignal(false);
  const [lr, setLr] = createSignal(0.1);
  const [closeness, setCloseness] = createSignal(0.1);
  const [dissOn, setDissOn] = createSignal(true);
  const [mode, setMode] = createSignal<"transport" | "joint">("transport");
  const [stepsPerSec, setStepsPerSec] = createSignal(8);

  let optimizeIntervalId = 0;

  const dissHistory: number[] = [];
  const closeHistory: number[] = [];
  let dissMax = 0.001;
  let closeMax = 0.001;
  let intervalId: number;

  function runStep() {
    const current = spectrum();
    const ref = referenceSpectrum();
    const dw = dissOn() ? 1 : 0;
    const updated = mode() === "transport"
      ? optimizeStepTransport(current, ref, lr(), closeness(), dw)
      : optimizeStepJoint(current, ref, lr(), closeness(), dw);
    updateSpectrum(updated);
  }

  function restartInterval() {
    clearInterval(optimizeIntervalId);
    optimizeIntervalId = window.setInterval(runStep, Math.round(1000 / stepsPerSec()));
  }

  function startOptimize() {
    setOptimizing(true);
    setOptimizerActive(true);
    resetAdam();
    restartInterval();
  }

  function stopOptimize() {
    setOptimizing(false);
    setOptimizerActive(false);
    clearInterval(optimizeIntervalId);
  }

  function drawSparkline(
    cvs: HTMLCanvasElement,
    hist: number[],
    maxVal: number,
    fillColor: string,
    strokeColor: string
  ) {
    const ctx = cvs.getContext("2d")!;
    const w = cvs.width;
    const h = cvs.height;
    ctx.clearRect(0, 0, w, h);
    if (hist.length < 2) return;

    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = w - (hist.length - 1 - i) * (w / (HISTORY_LEN - 1));
      const y = h - (hist[i]! / maxVal) * (h - 4);
      if (i === 0) { ctx.moveTo(x, h); ctx.lineTo(x, y); }
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = w - (hist.length - 1 - i) * (w / (HISTORY_LEN - 1));
      const y = h - (hist[i]! / maxVal) * (h - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  onMount(() => {
    const analyserNode = getAnalyser();
    const data = new Uint8Array(analyserNode.frequencyBinCount);

    intervalId = window.setInterval(() => {
      analyserNode.getByteFrequencyData(data);

      // Dissonance from FFT
      const peaks = extractPeaks(data, analyserNode.context.sampleRate, analyserNode.fftSize);
      const d = fftDissonance(peaks);
      dissHistory.push(d);
      if (dissHistory.length > HISTORY_LEN) dissHistory.shift();
      if (d > dissMax) dissMax = d;
      else dissMax = dissMax * 0.999 + d * 0.001;
      dissMax = Math.max(dissMax, 0.001);
      dissValueEl.textContent = d > 0.01 ? d.toFixed(2) : "—";

      // Closeness (Wasserstein)
      const w = ampMSE(spectrum(), referenceSpectrum());
      closeHistory.push(w);
      if (closeHistory.length > HISTORY_LEN) closeHistory.shift();
      if (w > closeMax) closeMax = w;
      else closeMax = closeMax * 0.999 + w * 0.001;
      closeMax = Math.max(closeMax, 0.001);
      closeValueEl.textContent = w > 0.0001 ? w.toFixed(4) : "—";

      // Draw both sparklines
      drawSparkline(dissCanvas, dissHistory, dissMax,
        "rgba(255, 97, 136, 0.15)", "#ff6188");
      drawSparkline(closeCanvas, closeHistory, closeMax,
        "rgba(169, 220, 118, 0.15)", "#a9dc76");
    }, SAMPLE_INTERVAL);
  });

  onCleanup(() => {
    clearInterval(intervalId);
    clearInterval(optimizeIntervalId);
    setOptimizerActive(false);
  });

  return (
    <div class="dissonance-meter">
      <div class="meter-charts">
        <div class="meter-chart">
          <div class="meter-header">
            <span class="panel-label">dissonance</span>
            <span class="meter-value" ref={dissValueEl}>—</span>
          </div>
          <canvas ref={dissCanvas} width={WIDTH} height={HEIGHT} />
        </div>
        <div class="meter-chart">
          <div class="meter-header">
            <span class="panel-label">closeness</span>
            <span class="meter-value closeness-value" ref={closeValueEl}>—</span>
          </div>
          <canvas ref={closeCanvas} width={WIDTH} height={HEIGHT} />
        </div>
      </div>
      <div class="optimize-controls">
        <button
          class={`optimize-btn ${optimizing() ? "active" : ""}`}
          onClick={() => (optimizing() ? stopOptimize() : startOptimize())}
        >
          {optimizing() ? "stop" : "optimize"}
        </button>
        <button
          class={`optimize-btn ${dissOn() ? "active" : ""}`}
          onClick={() => setDissOn(!dissOn())}
        >
          diss
        </button>
        <button
          class="optimize-btn"
          onClick={() => { setMode(mode() === "transport" ? "joint" : "transport"); resetAdam(); }}
        >
          {mode() === "transport" ? "OT" : "MSE"}
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
          {mode() === "transport" ? "slide:" : "close:"}
          <input
            type="range"
            min="0"
            max={mode() === "transport" ? "1" : "200"}
            step={mode() === "transport" ? "0.01" : "1"}
            value={closeness()}
            onInput={(e) => setCloseness(parseFloat(e.currentTarget.value))}
          />
          <span class="lr-value">
            {mode() === "transport" ? closeness().toFixed(2) : closeness().toFixed(0)}
          </span>
        </label>
        <label class="lr-control">
          hz:
          <input
            type="range"
            min="1"
            max="30"
            step="1"
            value={stepsPerSec()}
            onInput={(e) => {
              setStepsPerSec(parseInt(e.currentTarget.value));
              if (optimizing()) restartInterval();
            }}
          />
          <span class="lr-value">{stepsPerSec()}</span>
        </label>
      </div>
    </div>
  );
}
