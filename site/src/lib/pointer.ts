// One pointer listener and one animation loop for the whole page.
// Characters and cursor effects subscribe here instead of each running their own.

export type PointerState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  lastMove: number;
  seen: boolean;
  fine: boolean;
};

type Frame = (now: number, dt: number, p: PointerState) => void;

export const pointer: PointerState = { x: -9999, y: -9999, vx: 0, vy: 0, speed: 0, lastMove: 0, seen: false, fine: true };

const subscribers = new Set<Frame>();
let raf = 0;
let last = 0;
let started = false;

function loop(now: number) {
  const dt = Math.min(48, now - (last || now));
  last = now;
  // Velocity decays when the pointer stops.
  pointer.vx *= 0.86;
  pointer.vy *= 0.86;
  pointer.speed = Math.hypot(pointer.vx, pointer.vy);
  subscribers.forEach((f) => f(now, dt, pointer));
  raf = subscribers.size ? requestAnimationFrame(loop) : 0;
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  pointer.fine = window.matchMedia("(pointer: fine)").matches;
  let px = 0;
  let py = 0;
  let pt = 0;
  window.addEventListener(
    "pointermove",
    (e) => {
      const now = performance.now();
      if (pointer.seen && now - pt > 0) {
        const k = 1 / Math.max(8, now - pt);
        pointer.vx = pointer.vx * 0.5 + (e.clientX - px) * k * 0.5;
        pointer.vy = pointer.vy * 0.5 + (e.clientY - py) * k * 0.5;
      }
      px = e.clientX;
      py = e.clientY;
      pt = now;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.lastMove = now;
      pointer.seen = true;
      if (e.pointerType === "mouse" || e.pointerType === "pen") pointer.fine = true;
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (subscribers.size && !raf) raf = requestAnimationFrame(loop);
  });
}

export function onFrame(f: Frame) {
  start();
  subscribers.add(f);
  if (!raf && !document.hidden) raf = requestAnimationFrame(loop);
  return () => {
    subscribers.delete(f);
  };
}

export const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A damped spring step (semi-implicit Euler). Returns true while still moving.
export function spring(s: { v: number; x: number }, target: number, dt: number, k = 170, c = 16) {
  const t = dt / 1000;
  const a = -k * (s.x - target) - c * s.v;
  s.v += a * t;
  s.x += s.v * t;
  return Math.abs(s.v) > 0.01 || Math.abs(s.x - target) > 0.01;
}
