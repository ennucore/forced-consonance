import { onCleanup, onMount } from "solid-js";
import { getAnalyser } from "../audio";
import {
  dissHistory,
  dissWeight,
  energyLr,
  freqLr,
  matchHistory,
  matchWeight,
  running,
  setDissWeight,
  setEnergyLr,
  setFreqLr,
  setMatchWeight,
  setTargetDiss,
  startOptimizer,
  stopOptimizer,
  targetDiss,
} from "../optimizer";

// ---------------------------------------------------------------------------
// FFT dissonance display (from analyser node)
// ---------------------------------------------------------------------------

const KERNEL_A = 0.0023;

function kernel(x: number): number {
  const absx = Math.abs(x);
  return 50 * absx * Math.exp(-(x * x) / KERNEL_A);
}

const AMP_THRESHOLD = 8;
const MAX_FREQ = 8000;
const PEAK_RADIUS = 3;

function extractPeaks(
  data: Uint8Array,
  sampleRate: number,
  fftSize: number,
): { freq: number; amp: number }[] {
  const binHz = sampleRate / fftSize;
  const maxBin = Math.min(data.length, Math.floor(MAX_FREQ / binHz));
  const peaks: { freq: number; amp: number }[] = [];

  for (let i = PEAK_RADIUS; i < maxBin - PEAK_RADIUS; i++) {
    const value = data[i]!;
    if (value < AMP_THRESHOLD) continue;

    let isMax = true;
    for (let j = 1; j <= PEAK_RADIUS; j++) {
      if (data[i - j]! >= value || data[i + j]! >= value) {
        isMax = false;
        break;
      }
    }

    if (isMax) {
      peaks.push({ freq: i * binHz, amp: value / 255 });
    }
  }

  return peaks;
}

function fftDissonance(peaks: { freq: number; amp: number }[]): number {
  if (peaks.length < 2) return 0;

  let total = 0;
  for (let i = 0; i < peaks.length; i++) {
    const a = peaks[i]!;
    for (let j = i + 1; j < peaks.length; j++) {
      const b = peaks[j]!;
      total += a.amp * b.amp * kernel(b.freq / a.freq - 1);
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SAMPLE_INTERVAL = 50;
const SPARKLINE_W = 200;
const SPARKLINE_H = 48;
const HISTORY_LEN = 200;

export default function DissonanceMeter() {
  let dissCanvas!: HTMLCanvasElement;
  let matchCanvas!: HTMLCanvasElement;
  let lossCanvas!: HTMLCanvasElement;
  let dissValueEl!: HTMLSpanElement;
  let matchValueEl!: HTMLSpanElement;

  const dissHist: number[] = [];
  const matchHistLocal: number[] = [];
  let dissMax = 0.001;
  let matchMax = 0.001;
  let intervalId: number;

  function drawSparkline(
    canvas: HTMLCanvasElement,
    history: number[],
    maxValue: number,
    fillColor: string,
    strokeColor: string,
  ) {
    const ctx = canvas.getContext("2d")!;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (history.length < 2) return;

    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = width - (history.length - 1 - i) * (width / (HISTORY_LEN - 1));
      const y = height - (history[i]! / maxValue) * (height - 4);
      if (i === 0) {
        ctx.moveTo(x, height);
        ctx.lineTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = width - (history.length - 1 - i) * (width / (HISTORY_LEN - 1));
      const y = height - (history[i]! / maxValue) * (height - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawLossCurves(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d")!;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const diss = dissHistory();
    const match = matchHistory();
    if (diss.length < 2 && match.length < 2) return;

    let dissMaxLocal = 0.001;
    let matchMaxLocal = 0.001;
    for (const value of diss) if (value > dissMaxLocal) dissMaxLocal = value;
    for (const value of match) if (value > matchMaxLocal) matchMaxLocal = value;

    if (match.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < match.length; i++) {
        const x = (i / (match.length - 1)) * width;
        const y = height - (match[i]! / matchMaxLocal) * (height - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#a9dc76";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (diss.length >= 2) {
      ctx.beginPath();
      for (let i = 0; i < diss.length; i++) {
        const x = (i / (diss.length - 1)) * width;
        const y = height - (diss[i]! / dissMaxLocal) * (height - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#ff6188";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.font = "9px monospace";
    ctx.fillStyle = "#ff6188";
    ctx.fillText("diss", 4, 12);
    ctx.fillStyle = "#a9dc76";
    ctx.fillText("match", 4, 24);
  }

  onMount(() => {
    const analyserNode = getAnalyser();
    const data = new Uint8Array(analyserNode.frequencyBinCount);

    startOptimizer();

    intervalId = window.setInterval(() => {
      analyserNode.getByteFrequencyData(data);

      const peaks = extractPeaks(
        data,
        analyserNode.context.sampleRate,
        analyserNode.fftSize,
      );

      const currentDiss = fftDissonance(peaks);
      dissHist.push(currentDiss);
      if (dissHist.length > HISTORY_LEN) dissHist.shift();
      if (currentDiss > dissMax) dissMax = currentDiss;
      else dissMax = dissMax * 0.999 + currentDiss * 0.001;
      dissMax = Math.max(dissMax, 0.001);
      dissValueEl.textContent = currentDiss > 0.01 ? currentDiss.toFixed(2) : "—";

      const currentMatch = matchHistory().at(-1) ?? 0;
      matchHistLocal.push(currentMatch);
      if (matchHistLocal.length > HISTORY_LEN) matchHistLocal.shift();
      if (currentMatch > matchMax) matchMax = currentMatch;
      else matchMax = matchMax * 0.999 + currentMatch * 0.001;
      matchMax = Math.max(matchMax, 0.001);
      matchValueEl.textContent = currentMatch > 0.0001 ? currentMatch.toFixed(4) : "—";

      drawSparkline(
        dissCanvas,
        dissHist,
        dissMax,
        "rgba(255, 97, 136, 0.15)",
        "#ff6188",
      );
      drawSparkline(
        matchCanvas,
        matchHistLocal,
        matchMax,
        "rgba(169, 220, 118, 0.15)",
        "#a9dc76",
      );
      drawLossCurves(lossCanvas);
    }, SAMPLE_INTERVAL);
  });

  onCleanup(() => {
    clearInterval(intervalId);
    stopOptimizer();
  });

  return (
    <div class="dissonance-meter">
      <div class="meter-charts">
        <div class="meter-chart">
          <div class="meter-header">
            <span class="panel-label">dissonance</span>
            <span class="meter-value" ref={dissValueEl}>—</span>
          </div>
          <canvas ref={dissCanvas} width={SPARKLINE_W} height={SPARKLINE_H} />
        </div>
        <div class="meter-chart">
          <div class="meter-header">
            <span class="panel-label">match</span>
            <span class="meter-value closeness-value" ref={matchValueEl}>—</span>
          </div>
          <canvas ref={matchCanvas} width={SPARKLINE_W} height={SPARKLINE_H} />
        </div>
      </div>

      <div class="loss-plot">
        <span class="panel-label">optimizer losses</span>
        <canvas ref={lossCanvas} width={416} height={80} />
      </div>

      <div class="optimize-controls">
        <button
          class={`optimize-btn ${running() ? "active" : ""}`}
          onClick={() => (running() ? stopOptimizer() : startOptimizer())}
        >
          {running() ? "stop" : "optimize"}
        </button>

        <label class="lr-control">
          energy lr:
          <input
            type="range"
            min="-4"
            max="0"
            step="0.1"
            value={Math.log10(energyLr())}
            onInput={(e) => setEnergyLr(Math.pow(10, parseFloat(e.currentTarget.value)))}
          />
          <span class="lr-value">{energyLr().toFixed(4)}</span>
        </label>
      </div>

      <div class="optimize-controls">
        <label class="lr-control">
          diss:
          <input
            type="range"
            min="0"
            max="5"
            step="0.1"
            value={dissWeight()}
            onInput={(e) => setDissWeight(parseFloat(e.currentTarget.value))}
          />
          <span class="lr-value">{dissWeight().toFixed(1)}</span>
        </label>

        <label class="lr-control">
          match:
          <input
            type="range"
            min="-3"
            max="3"
            step="0.1"
            value={Math.log10(matchWeight())}
            onInput={(e) => setMatchWeight(Math.pow(10, parseFloat(e.currentTarget.value)))}
          />
          <span class="lr-value">{matchWeight().toPrecision(3)}</span>
        </label>

        <label class="lr-control">
          freq lr:
          <input
            type="range"
            min="-4"
            max="0"
            step="0.1"
            value={Math.log10(freqLr())}
            onInput={(e) => setFreqLr(Math.pow(10, parseFloat(e.currentTarget.value)))}
          />
          <span class="lr-value">{freqLr().toFixed(4)}</span>
        </label>

        <label class="lr-control">
          target:
          <input
            type="range"
            min="0"
            max="10"
            step="0.1"
            value={targetDiss()}
            onInput={(e) => setTargetDiss(parseFloat(e.currentTarget.value))}
          />
          <span class="lr-value">{targetDiss().toFixed(1)}</span>
        </label>
      </div>
    </div>
  );
}
