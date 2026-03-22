import { onMount, onCleanup } from "solid-js";
import { getAnalyser, spectrum, referenceSpectrum, getPoolFreqs, SPECTRUM_SIZE } from "../audio";

const WIDTH = 400;
const HEIGHT = 200;
const MIN_FREQ = 50;
const MAX_FREQ = 8000;
const MID = HEIGHT / 2;

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

      // --- Center line ---
      ctx.strokeStyle = "rgba(147, 146, 147, 0.2)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, MID);
      ctx.lineTo(WIDTH, MID);
      ctx.stroke();

      // --- FFT spectrum (cyan fill, top half) ---
      ctx.beginPath();
      ctx.moveTo(0, MID);
      for (let x = 0; x < WIDTH; x++) {
        const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, x / WIDTH);
        const bin = Math.round((freq / sampleRate) * fftSize);
        const value = (data[bin] ?? 0) / 255;
        ctx.lineTo(x, MID - value * MID);
      }
      ctx.lineTo(WIDTH, MID);
      ctx.closePath();
      ctx.fillStyle = "rgba(120, 220, 232, 0.1)";
      ctx.fill();

      // Shared scale for stems
      const ref = referenceSpectrum();
      const playing = spectrum();
      let stemMax = 0.001;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        stemMax = Math.max(stemMax, ref[i]!, playing[i]!);
      }

      // --- Playing spectrum (blue stems, going UP from center) ---
      ctx.strokeStyle = "#78dce8";
      ctx.lineWidth = 2;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        const a = playing[i]!;
        if (a < 1e-6) continue;
        const freq = poolFreqs[i]!;
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
        const x = freqToX(freq);
        const h = (a / stemMax) * (MID - 6);
        ctx.beginPath();
        ctx.moveTo(x, MID);
        ctx.lineTo(x, MID - h);
        ctx.stroke();
      }

      // --- Reference spectrum (yellow stems, going DOWN from center) ---
      ctx.strokeStyle = "#ffd866";
      ctx.lineWidth = 2;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        const a = ref[i]!;
        if (a < 1e-6) continue;
        const freq = poolFreqs[i]!;
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
        const x = freqToX(freq);
        const h = (a / stemMax) * (MID - 6);
        ctx.beginPath();
        ctx.moveTo(x, MID);
        ctx.lineTo(x, MID + h);
        ctx.stroke();
      }

      // --- Labels ---
      ctx.fillStyle = "rgba(120, 220, 232, 0.5)";
      ctx.font = "9px monospace";
      ctx.fillText("playing", 4, 12);
      ctx.fillStyle = "rgba(255, 216, 102, 0.5)";
      ctx.fillText("reference", 4, HEIGHT - 4);

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
