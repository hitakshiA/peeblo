// Client-only helpers for the playing mocks.
import { useEffect, useReducer, useRef, useSyncExternalStore, type RefObject } from "react";

// Handlers read the clock through this so playback can restart from "now".
export const clock = () => performance.now();

const motionQuery = "(prefers-reduced-motion: reduce)";
const subscribeMotion = (cb: () => void) => {
  const m = window.matchMedia(motionQuery);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(motionQuery).matches,
    () => false,
  );
}

type Cycle = { i: number; t0: number; now: number; round: number };
type CycleAct = { type: "tick"; now: number; live: boolean; paused: boolean; durs: number[] } | { type: "go"; i: number; now: number };

function cycle(c: Cycle, a: CycleAct): Cycle {
  if (a.type === "go") return { i: a.i, t0: a.now, now: a.now, round: c.round + 1 };
  // Off screen or hidden, time stands still for the playback.
  if (!a.live) return { ...c, t0: c.t0 + (a.now - c.now), now: a.now };
  if (!a.paused && a.now - c.t0 >= a.durs[c.i]) return { i: (c.i + 1) % a.durs.length, t0: a.now, now: a.now, round: c.round + 1 };
  return { ...c, now: a.now };
}

// Steps through a list of timed scenes while `root` is on screen. Reduced motion: no clock, t is huge.
export function useCycle(durs: number[], root: RefObject<HTMLElement | null>, paused = false, tickMs = 60) {
  const rm = useReducedMotion();
  const [c, dispatch] = useReducer(cycle, { i: 0, t0: 0, now: 0, round: 0 });
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    if (rm) return;
    let seen = false;
    const io = new IntersectionObserver(([e]) => (seen = e.isIntersecting), { threshold: 0.2 });
    if (root.current) io.observe(root.current);
    dispatch({ type: "go", i: 0, now: clock() });
    const id = setInterval(() => dispatch({ type: "tick", now: clock(), live: seen && !document.hidden, paused: pausedRef.current, durs }), tickMs);
    return () => {
      clearInterval(id);
      io.disconnect();
    };
  }, [rm, root, durs, tickMs]);
  const go = (i: number) => dispatch({ type: "go", i, now: clock() });
  return { i: c.i, t: rm ? 1e9 : c.now - c.t0, round: c.round, rm, go };
}
