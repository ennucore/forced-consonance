import { createEffect } from "solid-js";
import { lossHistory, type LossRecord } from "../overtones";

const W = 280;
const H = 120;
const PAD = 24;

const COLORS = {
  total: "#ab9df2",
  dissonance: "#ff6188",
  wasserstein: "#78dce8",
};

function drawCurve(
  ctx: CanvasRenderingContext2D,
  data: number[],
  maxVal: number,
  color: string
) {
  if (data.length < 2 || maxVal === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = PAD + (i / (data.length - 1)) * (W - PAD * 2);
    const y = H - PAD - (data[i]! / maxVal) * (H - PAD * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export default function LossCurve() {
  let canvas!: HTMLCanvasElement;

  createEffect(() => {
    const history = lossHistory();
    const ctx = canvas.getContext("2d");
    if (!ctx || history.length === 0) return;

    ctx.clearRect(0, 0, W, H);

    const totals = history.map((h) => h.total);
    const diss = history.map((h) => h.dissonance);
    const wass = history.map((h) => h.wasserstein);
    const maxVal = Math.max(...totals, ...diss, ...wass, 1e-9);

    // Axes
    ctx.strokeStyle = "rgba(147,146,147,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, PAD);
    ctx.lineTo(PAD, H - PAD);
    ctx.lineTo(W - PAD, H - PAD);
    ctx.stroke();

    // Step labels
    ctx.fillStyle = "rgba(147,146,147,0.6)";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    ctx.fillText("0", PAD, H - PAD + 12);
    ctx.fillText(String(history.length - 1), W - PAD, H - PAD + 12);
    ctx.textAlign = "left";
    ctx.fillText("step", W / 2 - 8, H - 2);

    // Curves
    drawCurve(ctx, totals, maxVal, COLORS.total);
    drawCurve(ctx, diss, maxVal, COLORS.dissonance);
    drawCurve(ctx, wass, maxVal, COLORS.wasserstein);

    // Legend
    const legend: [string, string][] = [
      ["total", COLORS.total],
      ["diss", COLORS.dissonance],
      ["W1", COLORS.wasserstein],
    ];
    let lx = PAD + 4;
    for (const [label, color] of legend) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, 4, 10, 3);
      ctx.fillStyle = "rgba(147,146,147,0.8)";
      ctx.font = "8px monospace";
      ctx.textAlign = "left";
      ctx.fillText(label, lx + 13, 9);
      lx += 44;
    }
  });

  return (
    <div class="loss-curve">
      <span class="panel-label">loss curves</span>
      <canvas ref={canvas} width={W} height={H} />
    </div>
  );
}
