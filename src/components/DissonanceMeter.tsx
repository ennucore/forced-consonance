import { onMount, onCleanup } from "solid-js";
import { overtoneAmps } from "../overtones";
import { computeChordDissonance } from "../overtones";
import { getActiveFundamentals } from "../audio";

const HISTORY_LEN = 200;
const WIDTH = 200;
const HEIGHT = 48;
const SAMPLE_INTERVAL = 50; // ms

export default function DissonanceMeter() {
  let canvas!: HTMLCanvasElement;
  let valueEl!: HTMLSpanElement;

  const history: number[] = [];
  let maxSeen = 0.001;
  let intervalId: number;

  onMount(() => {
    const ctx = canvas.getContext("2d")!;

    intervalId = window.setInterval(() => {
      const fundamentals = getActiveFundamentals();
      const amps = overtoneAmps();
      const d = computeChordDissonance(amps, fundamentals);

      history.push(d);
      if (history.length > HISTORY_LEN) history.shift();

      // Track max with slow decay so scale adjusts
      if (d > maxSeen) maxSeen = d;
      else maxSeen = maxSeen * 0.999 + d * 0.001;
      maxSeen = Math.max(maxSeen, 0.001);

      // Update value display
      valueEl.textContent = d > 0 ? d.toFixed(2) : "—";

      // Draw sparkline
      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      if (history.length < 2) return;

      // Fill area
      ctx.beginPath();
      ctx.moveTo(WIDTH, HEIGHT);
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
      ctx.lineTo(
        WIDTH - 0 * (WIDTH / (HISTORY_LEN - 1)),
        HEIGHT
      );
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
