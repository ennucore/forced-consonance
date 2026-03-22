import { onMount, onCleanup } from "solid-js";
import { getAnalyser, spectrum, referenceSpectrum, getPoolFreqs, SPECTRUM_SIZE } from "../audio";

const WIDTH = 400;
const HEIGHT = 180;
const MIN_FREQ = 50;
const MAX_FREQ = 8000;

function freqToX(freq: number): number {
  return (Math.log2(freq / MIN_FREQ) / Math.log2(MAX_FREQ / MIN_FREQ)) * WIDTH;
}

export default function SpectrumAnalyser() {
  let canvasRef: HTMLCanvasElement | undefined;
  let rafId: number;

  onMount(() => {
    const canvas = canvasRef!;
    const ctx = canvas.getContext("2d")!;
    const analyser = getAnalyser();
    const data = new Uint8Array(analyser.frequencyBinCount);
    const sampleRate = analyser.context.sampleRate;
    const fftSize = analyser.fftSize;
    const poolFreqs = getPoolFreqs();

    function draw() {
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      // --- FFT spectrum (cyan fill) ---
      ctx.beginPath();
      ctx.moveTo(0, HEIGHT);
      for (let x = 0; x < WIDTH; x++) {
        const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, x / WIDTH);
        const bin = Math.round((freq / sampleRate) * fftSize);
        const value = (data[bin] ?? 0) / 255;
        ctx.lineTo(x, HEIGHT - value * HEIGHT);
      }
      ctx.lineTo(WIDTH, HEIGHT);
      ctx.closePath();
      ctx.fillStyle = "rgba(120, 220, 232, 0.15)";
      ctx.fill();

      // --- Reference spectrum (yellow stems, dashed) ---
      const ref = referenceSpectrum();
      let refMax = 0;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        if (ref[i]! > refMax) refMax = ref[i]!;
      }

      // --- Playing spectrum (blue stems) ---
      const playing = spectrum();
      let playMax = 0;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        if (playing[i]! > playMax) playMax = playing[i]!;
      }

      const stemMax = Math.max(refMax, playMax, 0.001);

      // Draw reference as thin dashed lines
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#ffd866";
      ctx.lineWidth = 1;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        const a = ref[i]!;
        if (a < 1e-6) continue;
        const freq = poolFreqs[i]!;
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
        const x = freqToX(freq);
        const h = (a / stemMax) * (HEIGHT - 10);
        ctx.beginPath();
        ctx.moveTo(x, HEIGHT);
        ctx.lineTo(x, HEIGHT - h);
        ctx.stroke();
      }
      ctx.restore();

      // Draw playing spectrum as solid blue lines
      ctx.strokeStyle = "#78dce8";
      ctx.lineWidth = 2;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        const a = playing[i]!;
        if (a < 1e-6) continue;
        const freq = poolFreqs[i]!;
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
        const x = freqToX(freq);
        const h = (a / stemMax) * (HEIGHT - 10);
        ctx.beginPath();
        ctx.moveTo(x, HEIGHT);
        ctx.lineTo(x, HEIGHT - h);
        ctx.stroke();
      }

      rafId = requestAnimationFrame(draw);
    }

    rafId = requestAnimationFrame(draw);
  });

  onCleanup(() => {
    cancelAnimationFrame(rafId);
  });

  return (
    <div class="spectrum-analyser">
      <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
    </div>
  );
}
