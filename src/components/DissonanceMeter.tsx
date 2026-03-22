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
// Sinkhorn divergence for closeness (smooth optimal transport)
// ---------------------------------------------------------------------------
//
// Entropy-regularized OT: smooth gradients that "know" how to slide peaks.
// Cost = squared semitone distance. ε controls blur (larger = smoother).
// Includes total mass penalty so amplitude changes are penalized.

const SINKHORN_EPS = 4;     // regularization strength (semitones²)
const SINKHORN_ITERS = 15;
const MASS_PENALTY = 5;

// Precompute log-kernel: logK[i*n+j] = -(i-j)² / eps
const _logK = new Float64Array(SPECTRUM_SIZE * SPECTRUM_SIZE);
for (let i = 0; i < SPECTRUM_SIZE; i++) {
  for (let j = 0; j < SPECTRUM_SIZE; j++) {
    const d = i - j;
    _logK[i * SPECTRUM_SIZE + j] = -(d * d) / SINKHORN_EPS;
  }
}

function sinkhornDivergence(a: Float64Array, b: Float64Array): number {
  const n = SPECTRUM_SIZE;
  const bg = 1e-8;

  // Build measures with background, track total mass
  const mu = new Float64Array(n);
  const nu = new Float64Array(n);
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) {
    mu[i] = a[i]! + bg;
    nu[i] = b[i]! + bg;
    sumA += mu[i]!;
    sumB += nu[i]!;
  }
  // Normalize to probability for Sinkhorn
  for (let i = 0; i < n; i++) {
    mu[i] /= sumA;
    nu[i] /= sumB;
  }

  // Log-domain Sinkhorn iterations
  const f = new Float64Array(n);
  const g = new Float64Array(n);

  for (let iter = 0; iter < SINKHORN_ITERS; iter++) {
    // Update f: f_i = -eps * logsumexp_j((g_j + logK_ij)/eps + log(nu_j))
    //         simplified: f_i = -eps * logsumexp_j(g_j/eps + logK_ij/eps ... )
    // Actually: f_i = -eps * logsumexp_j( (g_j - C_ij)/eps + log(nu_j) )
    // where logK_ij = -C_ij/eps, so (g_j - C_ij)/eps = g_j/eps + logK_ij
    for (let i = 0; i < n; i++) {
      let mx = -Infinity;
      for (let j = 0; j < n; j++) {
        const v = g[j]! / SINKHORN_EPS + _logK[i * n + j]! + Math.log(nu[j]!);
        if (v > mx) mx = v;
      }
      let s = 0;
      for (let j = 0; j < n; j++) {
        s += Math.exp(g[j]! / SINKHORN_EPS + _logK[i * n + j]! + Math.log(nu[j]!) - mx);
      }
      f[i] = -SINKHORN_EPS * (Math.log(s) + mx);
    }

    // Update g
    for (let j = 0; j < n; j++) {
      let mx = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = f[i]! / SINKHORN_EPS + _logK[i * n + j]! + Math.log(mu[i]!);
        if (v > mx) mx = v;
      }
      let s = 0;
      for (let i = 0; i < n; i++) {
        s += Math.exp(f[i]! / SINKHORN_EPS + _logK[i * n + j]! + Math.log(mu[i]!) - mx);
      }
      g[j] = -SINKHORN_EPS * (Math.log(s) + mx);
    }
  }

  // OT_eps(mu, nu) = <f, mu> + <g, nu>
  let ot = 0;
  for (let i = 0; i < n; i++) {
    ot += f[i]! * mu[i]! + g[i]! * nu[i]!;
  }

  // Total mass penalty (unnormalized)
  const massDiff = sumA - sumB;
  return ot + MASS_PENALTY * massDiff * massDiff;
}

// ---------------------------------------------------------------------------
// Optimizer: gradient descent on pool amplitudes
// ---------------------------------------------------------------------------

const GRAD_DELTA = 1e-4;

function computeLoss(
  amps: Float64Array,
  ref: Float64Array,
  closenessWeight: number,
  dissWeight: number
): number {
  return dissWeight * poolDissonance(amps) + closenessWeight * sinkhornDivergence(amps, ref);
}

function optimizeStep(
  current: Float64Array,
  ref: Float64Array,
  lr: number,
  closenessWeight: number,
  dissWeight: number
): Float64Array {
  const n = current.length;
  const loss = computeLoss(current, ref, closenessWeight, dissWeight);

  const grad = new Float64Array(n);

  // Only compute gradients for bins that are active or in the reference
  for (let i = 0; i < n; i++) {
    if (current[i]! < 1e-6 && ref[i]! < 1e-6) continue;

    const perturbed = new Float64Array(current);
    perturbed[i] += GRAD_DELTA;
    grad[i] = (computeLoss(perturbed, ref, closenessWeight, dissWeight) - loss) / GRAD_DELTA;
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
  let dissCanvas!: HTMLCanvasElement;
  let closeCanvas!: HTMLCanvasElement;
  let dissValueEl!: HTMLSpanElement;
  let closeValueEl!: HTMLSpanElement;

  const [optimizing, setOptimizing] = createSignal(false);
  const [lr, setLr] = createSignal(0.1);
  const [closeness, setCloseness] = createSignal(50);
  const [dissOn, setDissOn] = createSignal(true);

  let optimizeIntervalId = 0;

  const dissHistory: number[] = [];
  const closeHistory: number[] = [];
  let dissMax = 0.001;
  let closeMax = 0.001;
  let intervalId: number;

  const OPTIMIZE_INTERVAL = 125; // ~8 steps/sec

  function startOptimize() {
    setOptimizing(true);
    setOptimizerActive(true);

    optimizeIntervalId = window.setInterval(() => {
      const current = spectrum();
      const ref = referenceSpectrum();
      const updated = optimizeStep(current, ref, lr(), closeness(), dissOn() ? 1 : 0);
      updateSpectrum(updated);
    }, OPTIMIZE_INTERVAL);
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
      const w = sinkhornDivergence(spectrum(), referenceSpectrum());
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
