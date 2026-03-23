import { onMount, onCleanup } from "solid-js";
import { getAnalyser, spectrum, referenceSpectrum, getPoolFreqs, SPECTRUM_SIZE } from "../audio";
import { optimizedPeaks, matchTargets, peakMatches } from "../optimizer";

const WIDTH = 400;
const HEIGHT = 200;
const MIN_FREQ = 50;
const MAX_FREQ = 8000;
const MID = HEIGHT / 2;

function freqToX(freq: number): number {
  return (Math.log2(freq / MIN_FREQ) / Math.log2(MAX_FREQ / MIN_FREQ)) * WIDTH;
}

function peakY(energy: number, direction: 1 | -1, maxValue: number): number {
  const amp = Math.sqrt(Math.max(energy, 0));
  const h = (amp / maxValue) * (MID - 8);
  return MID + direction * h;
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

    function drawSpectrumCurve(
      values: Float64Array,
      direction: 1 | -1,
      strokeStyle: string,
      fillStyle: string,
      maxValue: number,
    ) {
      ctx.beginPath();
      let started = false;

      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        const freq = poolFreqs[i]!;
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;

        const x = freqToX(freq);
        const h = (values[i]! / maxValue) * (MID - 6);
        const y = MID + direction * h;

        if (!started) {
          ctx.moveTo(x, MID);
          ctx.lineTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }

      if (!started) return;

      ctx.lineTo(WIDTH, MID);
      ctx.closePath();
      ctx.fillStyle = fillStyle;
      ctx.fill();

      ctx.beginPath();
      started = false;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        const freq = poolFreqs[i]!;
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;

        const x = freqToX(freq);
        const h = (values[i]! / maxValue) * (MID - 6);
        const y = MID + direction * h;

        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    function drawDot(x: number, y: number, radius: number, fillStyle: string, strokeStyle?: string) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fillStyle;
      ctx.fill();
      if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    function drawCross(x: number, y: number, size: number, strokeStyle: string) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - size, y - size);
      ctx.lineTo(x + size, y + size);
      ctx.moveTo(x - size, y + size);
      ctx.lineTo(x + size, y - size);
      ctx.stroke();
    }

    function drawMatches(maxValue: number) {
      const peaks = optimizedPeaks();
      const targets = matchTargets();
      const matches = peakMatches();
      if (peaks.length === 0 || matches.length === 0) return;

      ctx.save();
      ctx.setLineDash([3, 3]);

      for (const match of matches) {
        const peak = peaks[match.peakIndex];
        if (!peak || peak.energy <= 1e-6) continue;
        if (peak.centerFreq < MIN_FREQ || peak.centerFreq > MAX_FREQ) continue;

        const x1 = freqToX(peak.centerFreq);
        const y1 = peakY(peak.energy, -1, maxValue);

        if (match.targetIndex === null) {
          ctx.strokeStyle = "rgba(147, 146, 147, 0.32)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1, MID);
          ctx.stroke();
          continue;
        }

        const target = targets[match.targetIndex];
        if (!target) continue;

        const targetFreq = Math.pow(2, target.logFreq);
        if (targetFreq < MIN_FREQ || targetFreq > MAX_FREQ) continue;

        const x2 = freqToX(targetFreq);
        const y2 = peakY(target.energy, 1, maxValue);

        ctx.strokeStyle = "rgba(169, 220, 118, 0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      ctx.restore();

      for (const target of targets) {
        const freq = Math.pow(2, target.logFreq);
        if (freq < MIN_FREQ || freq > MAX_FREQ) continue;
        drawDot(
          freqToX(freq),
          peakY(target.energy, 1, maxValue),
          2.5,
          "rgba(255, 216, 102, 0.9)",
          "rgba(255, 216, 102, 0.5)",
        );
      }

      for (const match of matches) {
        const peak = peaks[match.peakIndex];
        if (!peak || peak.energy <= 1e-6) continue;
        if (peak.centerFreq < MIN_FREQ || peak.centerFreq > MAX_FREQ) continue;

        const x = freqToX(peak.centerFreq);
        const y = peakY(peak.energy, -1, maxValue);
        if (match.targetIndex === null) {
          drawCross(x, y, 2.5, "rgba(147, 146, 147, 0.8)");
        } else {
          drawDot(x, y, 2.5, "rgba(120, 220, 232, 0.9)", "rgba(120, 220, 232, 0.5)");
        }
      }
    }

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

      // Shared scale for rendered spectra
      const ref = referenceSpectrum();
      const playing = spectrum();
      let stemMax = 0.001;
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        stemMax = Math.max(stemMax, ref[i]!, playing[i]!);
      }

      drawSpectrumCurve(
        playing,
        -1,
        "#78dce8",
        "rgba(120, 220, 232, 0.18)",
        stemMax,
      );
      drawSpectrumCurve(
        ref,
        1,
        "#ffd866",
        "rgba(255, 216, 102, 0.18)",
        stemMax,
      );
      drawMatches(stemMax);

      // --- Labels ---
      ctx.fillStyle = "rgba(120, 220, 232, 0.5)";
      ctx.font = "9px monospace";
      ctx.fillText("playing", 4, 12);
      ctx.fillStyle = "rgba(255, 216, 102, 0.5)";
      ctx.fillText("reference", 4, HEIGHT - 4);
      ctx.fillStyle = "rgba(169, 220, 118, 0.5)";
      ctx.fillText("matches", WIDTH - 40, 12);

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
