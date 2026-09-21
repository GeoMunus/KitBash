/* ================= sample project (unsaved until memorized) ================= */
const SAMPLE_GOAL = 'Starfield screensaver: stars flying toward the camera, a glowing title and a star counter';
const SAMPLE_FILES = [
  {
    path: 'index.html', text: `<!doctype html>
<html><head><title>Starfield</title><link rel="stylesheet" href="css/theme.css"></head>
<body>
<div class="stage"><canvas id="sky"></canvas></div>
<h1 class="title">Starfield</h1>
<div class="hud" id="hud">stars <b>400</b></div>
<script type="module">
import { createStars, stepStars, drawStars } from './js/stars.js';
import { createLoop } from './js/loop.js';

const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');
function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
addEventListener('resize', resize);
resize();

const stars = createStars(400);
createLoop(dt => { stepStars(stars, dt); drawStars(ctx, stars); }).start();
<\/script>
</body></html>
` },
  {
    path: 'css/theme.css', text: `:root { --space: #070b1a; --star: #e8f0ff; --nova: #ffb86b; --hud: #7fd6c2; }

/* Full-screen stage that hosts a canvas. */
.stage { position: fixed; inset: 0; background: var(--space); }
.stage canvas { display: block; width: 100%; height: 100%; }

/* Small monospace read-out pinned to the corner. */
.hud { position: fixed; left: 16px; bottom: 16px; font: 12px/1.4 ui-monospace, monospace; color: var(--hud); letter-spacing: .08em; text-transform: uppercase; }
.hud b { color: var(--nova); }

@keyframes twinkle { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }

/* Big centred title that gently pulses. */
.title { position: fixed; top: 12%; width: 100%; margin: 0; text-align: center; color: var(--star); font: 600 clamp(28px, 6vw, 64px)/1 system-ui, sans-serif; text-shadow: 0 0 24px var(--nova); animation: twinkle 4s ease-in-out infinite; }
` },
  {
    path: 'js/math.js', text: `/** Clamp a number between lo and hi. */
export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/** Linear interpolation between a and b. */
export function lerp(a, b, t) { return a + (b - a) * t; }

/** Random float in [lo, hi). */
export function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
` },
  {
    path: 'js/loop.js', text: `import { clamp } from './math.js';

/** Animation loop that calls tick(dt) every frame with dt in seconds (capped at 50ms). */
export function createLoop(tick) {
  let last = performance.now(), id = 0, running = false;
  function frame(now) {
    const dt = clamp((now - last) / 1000, 0, 0.05);
    last = now;
    tick(dt);
    if (running) id = requestAnimationFrame(frame);
  }
  return {
    start() { if (running) return; running = true; last = performance.now(); id = requestAnimationFrame(frame); },
    stop() { running = false; cancelAnimationFrame(id); }
  };
}
` },
  {
    path: 'js/stars.js', text: `import { rand, lerp } from './math.js';

export const STAR_COLORS = ['#e8f0ff', '#ffd9a8', '#a8c8ff', '#ffb86b'];

/** Scatter n stars through 3D space (z is depth, 0 = at the camera). */
export function createStars(n) {
  return Array.from({ length: n }, () => ({
    x: rand(-1, 1), y: rand(-1, 1), z: rand(0.05, 1),
    c: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0]
  }));
}

/** Move stars toward the camera and recycle any that pass it. */
export function stepStars(stars, dt, speed = 0.35) {
  for (const s of stars) {
    s.z -= dt * speed;
    if (s.z <= 0.02) { s.z = 1; s.x = rand(-1, 1); s.y = rand(-1, 1); }
  }
}

/** Draw the stars onto a 2D canvas context with simple perspective. */
export function drawStars(ctx, stars) {
  const { width: w, height: h } = ctx.canvas;
  ctx.fillStyle = '#070b1a';
  ctx.fillRect(0, 0, w, h);
  for (const s of stars) {
    const k = 1 / s.z;
    const px = w / 2 + s.x * k * w * 0.25, py = h / 2 + s.y * k * h * 0.25;
    ctx.fillStyle = s.c;
    ctx.beginPath();
    ctx.arc(px, py, lerp(2.4, 0.3, s.z), 0, Math.PI * 2);
    ctx.fill();
  }
}
` },
  { path: 'assets/logo.png', text: null, skip: 'binary image' }
];
