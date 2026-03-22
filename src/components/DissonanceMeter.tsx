import { createSignal, onMount, onCleanup } from "solid-js";
import {
  getAnalyser,
  spectrum,
  referenceSpectrum,
  updateSpectrum,
  setOnSpectrumReset,
  type SpectralLine,
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
// Dissonance + closeness computed on the spectrum directly
// ---------------------------------------------------------------------------

// Weight by energy (amp² × freq) so higher-pitch partials contribute more,
// matching the closeness metric's energy model.
function spectrumDissonance(lines: SpectralLine[]): number {
  if (lines.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const li = lines[i]!;
    if (li.freq === 0) continue;
    const ei = li.amp * li.amp * li.freq;
    for (let j = i + 1; j < lines.length; j++) {
      const lj = lines[j]!;
      const ej = lj.amp * lj.amp * lj.freq;
      total += ei * ej * kernel(lj.freq / li.freq - 1);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Wasserstein W1 distance on log-energy spectra
// ---------------------------------------------------------------------------
//
// Maps spectral lines to a log-frequency grid (semitone bins).
// Energy = amp² * freq (acoustic power: same amplitude at higher pitch
// carries more energy). Compared in log scale.
// W1 = ∫ |CDF_a(f) - CDF_b(f)| df, computed on the semitone grid.

const GRID_SIZE = 128; // semitones (~10 octaves)
const LOG_ENERGY_EPS = 1e-12;

function toLogEnergyGrid(lines: SpectralLine[], minFreq: number): Float64Array {
  const grid = new Float64Array(GRID_SIZE);
  if (minFreq <= 0) return grid;
  for (const l of lines) {
    if (l.freq <= 0 || l.amp === 0) continue;
    const semitone = 12 * Math.log2(l.freq / minFreq);
    const bin = Math.round(semitone);
    if (bin >= 0 && bin < GRID_SIZE) {
      // Energy = amp² * freq (pitch-dependent power)
      grid[bin] += l.amp * l.amp * l.freq;
    }
  }
  // Convert to log scale
  for (let i = 0; i < GRID_SIZE; i++) {
    grid[i] = Math.log(grid[i]! + LOG_ENERGY_EPS);
  }
  return grid;
}

function spectralWasserstein(a: SpectralLine[], b: SpectralLine[]): number {
  // Find global min freq for consistent grid
  let minFreq = Infinity;
  for (const l of a) if (l.freq > 0 && l.freq < minFreq) minFreq = l.freq;
  for (const l of b) if (l.freq > 0 && l.freq < minFreq) minFreq = l.freq;
  if (!isFinite(minFreq)) return 0;

  const gridA = toLogEnergyGrid(a, minFreq);
  const gridB = toLogEnergyGrid(b, minFreq);

  // Shift both grids so they're non-negative (W1 needs a distribution)
  let minVal = 0;
  for (let i = 0; i < GRID_SIZE; i++) {
    minVal = Math.min(minVal, gridA[i]!, gridB[i]!);
  }

  let sumA = 0, sumB = 0;
  for (let i = 0; i < GRID_SIZE; i++) {
    gridA[i] = gridA[i]! - minVal;
    gridB[i] = gridB[i]! - minVal;
    sumA += gridA[i]!;
    sumB += gridB[i]!;
  }

  if (sumA === 0 || sumB === 0) return 0;

  // W1 = sum of |CDF_a - CDF_b| over bins
  let cdfA = 0, cdfB = 0, dist = 0;
  for (let i = 0; i < GRID_SIZE; i++) {
    cdfA += gridA[i]! / sumA;
    cdfB += gridB[i]! / sumB;
    dist += Math.abs(cdfA - cdfB);
  }
  return dist / GRID_SIZE;
}

// ---------------------------------------------------------------------------
// Optimizer: gradient descent on spectral line amplitudes
// ---------------------------------------------------------------------------

const GRAD_DELTA = 1e-4;

function computeLoss(
  lines: SpectralLine[],
  ref: SpectralLine[],
  closenessWeight: number
): number {
  return spectrumDissonance(lines) + closenessWeight * spectralWasserstein(lines, ref);
}

function optimizeStep(
  current: SpectralLine[],
  ref: SpectralLine[],
  lr: number,
  closenessWeight: number
): SpectralLine[] {
  const n = current.length;
  const loss = computeLoss(current, ref, closenessWeight);

  const grad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const perturbed = current.map((l) => ({ ...l }));
    perturbed[i]!.amp += GRAD_DELTA;
    grad[i] = (computeLoss(perturbed, ref, closenessWeight) - loss) / GRAD_DELTA;
  }

  return current.map((l, i) => ({
    freq: l.freq,
    amp: Math.max(0, l.amp - lr * grad[i]!),
  }));
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

    optimizeIntervalId = window.setInterval(() => {
      const current = spectrum();
      const ref = referenceSpectrum();
      if (current.length < 2) return;

      const updated = optimizeStep(current, ref, lr(), closeness());
      updateSpectrum(updated);
    }, OPTIMIZE_INTERVAL);
  }

  function stopOptimize() {
    setOptimizing(false);
    clearInterval(optimizeIntervalId);
  }

  // Reset optimizer when keys change
  onMount(() => {
    setOnSpectrumReset(() => {
      if (optimizing()) {
        // Restart optimizer with new reference
        clearInterval(optimizeIntervalId);
        optimizeIntervalId = window.setInterval(() => {
          const current = spectrum();
          const ref = referenceSpectrum();
          if (current.length < 2) return;

          const updated = optimizeStep(current, ref, lr(), closeness());
          updateSpectrum(updated);
        }, OPTIMIZE_INTERVAL);
      }
    });
  });

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
    setOnSpectrumReset(null);
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
