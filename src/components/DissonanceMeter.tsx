import { onMount, onCleanup } from "solid-js";
import { getAnalyser } from "../audio";

const HISTORY_LEN = 200;
const WIDTH = 200;
const HEIGHT = 48;
const SAMPLE_INTERVAL = 50; // ms

// Sethares roughness kernel (same as overtones.ts)
const KERNEL_A = 0.0023;
function kernel(x: number): number {
  const absx = Math.abs(x);
  return 50 * absx * Math.exp(-(x * x) / KERNEL_A);
}

// Minimum amplitude (0-255 scale) to consider a bin significant
const AMP_THRESHOLD = 8;
// Only look at frequencies up to this
const MAX_FREQ = 8000;
// Peak must be a local maximum within this many bins
const PEAK_RADIUS = 3;

/**
 * Extract prominent spectral peaks from FFT data.
 * Returns array of { freq, amp } (amp normalized 0-1).
 */
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

    // Check local maximum
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

/**
 * Compute dissonance from actual FFT peaks using pairwise Sethares roughness.
 */
function spectralDissonance(peaks: { freq: number; amp: number }[]): number {
  if (peaks.length < 2) return 0;

  let total = 0;
  for (let i = 0; i < peaks.length; i++) {
    const pi = peaks[i]!;
    for (let j = i + 1; j < peaks.length; j++) {
      const pj = peaks[j]!;
      const x = pj.freq / pi.freq - 1;
      total += pi.amp * pj.amp * kernel(x);
    }
  }
  return total;
}

export default function DissonanceMeter() {
  let canvas!: HTMLCanvasElement;
  let valueEl!: HTMLSpanElement;

  const history: number[] = [];
  let maxSeen = 0.001;
  let intervalId: number;

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

      // Track max with slow decay so scale adjusts
      if (d > maxSeen) maxSeen = d;
      else maxSeen = maxSeen * 0.999 + d * 0.001;
      maxSeen = Math.max(maxSeen, 0.001);

      // Update value display
      valueEl.textContent = d > 0.01 ? d.toFixed(2) : "—";

      // Draw sparkline
      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      if (history.length < 2) return;

      // Fill area
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
      const lastX = WIDTH;
      ctx.lineTo(lastX, HEIGHT);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 97, 136, 0.15)";
      ctx.fill();

      // Stroke line
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

  onCleanup(() => clearInterval(intervalId));

  return (
    <div class="dissonance-meter">
      <div class="meter-header">
        <span class="panel-label">dissonance</span>
        <span class="meter-value" ref={valueEl}>—</span>
      </div>
      <canvas ref={canvas} width={WIDTH} height={HEIGHT} />
    </div>
  );
}
