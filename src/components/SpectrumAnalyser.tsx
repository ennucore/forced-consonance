import { onMount, onCleanup } from "solid-js";
import { getAnalyser } from "../audio";

const WIDTH = 400;
const HEIGHT = 180;
const MIN_FREQ = 50;
const MAX_FREQ = 8000;

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

    function draw() {
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      ctx.beginPath();
      ctx.moveTo(0, HEIGHT);

      for (let x = 0; x < WIDTH; x++) {
        const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, x / WIDTH);
        const bin = Math.round((freq / sampleRate) * fftSize);
        const value = (data[bin] ?? 0) / 255;
        const y = HEIGHT - value * HEIGHT;
        ctx.lineTo(x, y);
      }

      ctx.lineTo(WIDTH, HEIGHT);
      ctx.closePath();

      ctx.fillStyle = "rgba(120, 220, 232, 0.3)";
      ctx.fill();

      ctx.beginPath();
      for (let x = 0; x < WIDTH; x++) {
        const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, x / WIDTH);
        const bin = Math.round((freq / sampleRate) * fftSize);
        const value = (data[bin] ?? 0) / 255;
        const y = HEIGHT - value * HEIGHT;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = "#78dce8";
      ctx.lineWidth = 1.5;
      ctx.stroke();

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
