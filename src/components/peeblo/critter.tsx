"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AvatarMotion } from "open-bot-avatar";
import type { MountedAvatar } from "open-bot-avatar/dom";
import { onFrame, reducedMotion, spring } from "@/lib/pointer";
import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";

// How each character reacts to the cursor. Shy ones back away, curious ones lean in,
// heavy ones barely move, sleepy ones doze off when nobody moves the mouse.
type Personality = { lean: number; tilt: number; stretch: number; shy?: boolean; curious?: boolean; sleepy?: boolean };

const base: Personality = { lean: 10, tilt: 7, stretch: 0.06 };
const personalities: Record<string, Partial<Personality>> = {
  ghost: { lean: -16, tilt: -10, shy: true, sleepy: true },
  cat: { lean: -12, tilt: -8, shy: true, sleepy: true },
  bunny: { lean: -12, tilt: -6, shy: true, sleepy: true },
  magnifier: { lean: 18, tilt: 12, curious: true },
  camera: { lean: 16, tilt: 10, curious: true },
  lightbulb: { lean: 14, tilt: 9, curious: true },
  brain: { lean: 14, tilt: 6, curious: true, sleepy: true },
  bull: { lean: 5, tilt: 3, stretch: 0.03 },
  barbell: { lean: 3, tilt: 2, stretch: 0.02 },
  book: { lean: 5, tilt: 4, sleepy: true },
  mug: { lean: 6, tilt: 5, sleepy: true },
  cloud: { lean: 9, tilt: 4, sleepy: true },
  sprout: { lean: 12, tilt: 10, stretch: 0.12 },
  rocket: { lean: 12, tilt: 12, stretch: 0.1 },
  star: { lean: 11, tilt: 14, stretch: 0.1 },
  controller: { lean: 12, tilt: 9, stretch: 0.1 },
};

const HOP: Keyframe[] = [
  { transform: "scale(1)" },
  { transform: "scale(1.12, 0.84)", offset: 0.18 },
  { transform: "translateY(-26%) scale(0.94, 1.1) rotate(-4deg)", offset: 0.42 },
  { transform: "translateY(0) scale(1.08, 0.9) rotate(2deg)", offset: 0.6 },
  { transform: "scale(0.97, 1.04)", offset: 0.76 },
  { transform: "scale(1)" },
];
const BOOP: Keyframe[] = [
  { transform: "scale(1)" },
  { transform: "scale(1.18, 0.8)", offset: 0.3 },
  { transform: "scale(0.92, 1.1)", offset: 0.6 },
  { transform: "scale(1)" },
];

type Props = {
  id: string;
  size?: number;
  mood?: AvatarMotion;
  still?: boolean;
  bob?: boolean;
  wave?: boolean;
  reach?: number;
  className?: string;
  label?: string;
  // Something the character wears (a hat, a prop); it moves with every lean, hop and squash.
  wear?: React.ReactNode;
};

export function Critter({ id, size = 64, mood = "idle", still = false, bob = true, wave = false, reach = 240, className, label = "", wear }: Props) {
  const outer = useRef<HTMLSpanElement>(null);
  const lean = useRef<HTMLSpanElement>(null);
  const act = useRef<HTMLSpanElement>(null);
  const api = useRef<MountedAvatar | null>(null);
  const [dizzy, setDizzy] = useState(false);
  const [dozing, setDozing] = useState(false);
  const [happy, setHappy] = useState(false);
  const state = useRef({ dizzy: false, dozing: false });

  const play = useCallback((frames: Keyframe[], ms: number) => {
    act.current?.animate(frames, { duration: ms, easing: "cubic-bezier(.34,1.3,.64,1)" });
  }, []);

  const cheer = useCallback(() => {
    play(BOOP, 450);
    setHappy(true);
    setTimeout(() => setHappy(false), 1400);
  }, [play]);

  useEffect(() => {
    if (reducedMotion()) return;
    const p = { ...base, ...personalities[id] };
    const sx = { x: 0, v: 0 };
    const sy = { x: 0, v: 0 };
    const sr = { x: 0, v: 0 };
    const ss = { x: 1, v: 0 };
    const yaw = { x: 0, v: 0 };
    const pitch = { x: 0, v: 0 };
    const drag = { on: false, x0: 0, y0: 0, moved: false, yaw: 0, pitch: 0 };
    const reversals: number[] = [];
    let lastSign = 0;
    let prevPx = -9999;
    let hopReady = 0;
    let visible = false;
    const sleepy = p.sleepy && Math.random() < 0.85;

    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    if (outer.current) io.observe(outer.current);

    const setDizzyOnce = (v: boolean) => {
      if (state.current.dizzy !== v) {
        state.current.dizzy = v;
        setDizzy(v);
      }
    };
    const setDozeOnce = (v: boolean) => {
      if (state.current.dozing !== v) {
        state.current.dozing = v;
        setDozing(v);
        if (!v) play(HOP, 800);
      }
    };

    const stop = onFrame((now, dt, ptr) => {
      const el = outer.current;
      const target = lean.current;
      if (!el || !target || !visible) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = ptr.x - cx;
      const dy = ptr.y - cy;
      const d = Math.hypot(dx, dy);
      const near = ptr.seen && ptr.fine ? Math.max(0, 1 - d / reach) : 0;
      const ease = near * near * (3 - 2 * near);
      const ux = d ? dx / d : 0;
      const uy = d ? dy / d : 0;
      const close = p.shy && d < r.width * 0.9;

      // Lean toward (or away from) the cursor, tilt, and stretch on a spring.
      let tx = ux * p.lean * ease;
      let ty = uy * p.lean * 0.55 * ease;
      let tr = ux * p.tilt * ease;
      let ts = 1 + (uy < 0 ? p.stretch : -p.stretch * 0.5) * ease;
      if (close) {
        ty += r.height * 0.14;
        ts = 0.9;
      }
      if (p.curious && d < r.width) ts = 1.08;
      if (state.current.dozing) {
        tx = 0;
        ty = 0;
        tr = Math.sin(now / 900) * 4;
        ts = 1;
      }
      const moving = [spring(sx, tx, dt), spring(sy, ty, dt), spring(sr, tr, dt), spring(ss, ts, dt, 220, 14)].some(Boolean);
      if (moving || near > 0) {
        target.style.transform = `translate(${sx.x.toFixed(2)}px, ${sy.x.toFixed(2)}px) rotate(${sr.x.toFixed(2)}deg) scale(${(2 - ss.x).toFixed(3)}, ${ss.x.toFixed(3)})`;
      }

      // Shaking the cursor nearby makes them dizzy.
      if (d < reach * 1.15 && Math.abs(ptr.vx) > 0.9) {
        const sign = Math.sign(ptr.vx);
        if (sign !== lastSign) {
          reversals.push(now);
          lastSign = sign;
        }
      }
      while (reversals.length && now - reversals[0] > 700) reversals.shift();
      if (reversals.length >= 4 && !state.current.dizzy) {
        setDizzyOnce(true);
        reversals.length = 0;
        setTimeout(() => setDizzyOnce(false), 1700);
      }

      // Nobody has moved the mouse for a while: the sleepy ones doze off.
      const idle = ptr.seen && now - ptr.lastMove > 7000;
      if (sleepy && idle) setDozeOnce(true);
      else if (!idle) setDozeOnce(false);

      // Sweeping across a row makes each one hop as the cursor passes.
      if (wave && prevPx !== -9999 && (prevPx - cx) * (ptr.x - cx) < 0 && Math.abs(dy) < r.height * 1.3 && Math.abs(ptr.vx) > 0.35 && now > hopReady) {
        hopReady = now + 900;
        play(HOP, 820);
      }
      prevPx = ptr.x;

      // Drag to turn, then spring back.
      const ty0 = drag.on ? drag.yaw : 0;
      const tp0 = drag.on ? drag.pitch : 0;
      const turning = spring(yaw, ty0, dt, 120, 12) || spring(pitch, tp0, dt, 120, 12);
      if ((turning || drag.on) && api.current) api.current.update({ view: { yaw: yaw.x, pitch: pitch.x } });
    });

    const el = outer.current;
    const down = (e: PointerEvent) => {
      drag.on = true;
      drag.moved = false;
      drag.x0 = e.clientX;
      drag.y0 = e.clientY;
      el?.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag.on) return;
      const mx = e.clientX - drag.x0;
      const my = e.clientY - drag.y0;
      if (Math.hypot(mx, my) > 6) drag.moved = true;
      drag.yaw = Math.max(-1.2, Math.min(1.2, mx * 0.018));
      drag.pitch = Math.max(-0.6, Math.min(0.6, my * 0.012));
    };
    const up = () => {
      if (drag.on && !drag.moved) cheer();
      drag.on = false;
    };
    el?.addEventListener("pointerdown", down);
    el?.addEventListener("pointermove", move);
    el?.addEventListener("pointerup", up);
    el?.addEventListener("pointercancel", up);
    return () => {
      stop();
      io.disconnect();
      el?.removeEventListener("pointerdown", down);
      el?.removeEventListener("pointermove", move);
      el?.removeEventListener("pointerup", up);
      el?.removeEventListener("pointercancel", up);
    };
  }, [id, reach, wave, play, cheer]);

  const shown: AvatarMotion = happy ? "happy" : dozing || dizzy ? "thinking" : mood;

  return (
    <span ref={outer} className={cn("pb-critter", className)} style={{ width: size, height: size }}>
      <span ref={lean} className="pb-critter__lean">
        <span ref={act} className={cn("pb-critter__act", dizzy && "is-dizzy")}>
          <span className={cn("pb-critter__idle", bob && "is-bob")}>
            <Avatar id={id} size={size} mood={shown} still={still} label={label} onMount={(a) => (api.current = a)} />
            {wear}
          </span>
        </span>
      </span>
      {dozing && (
        <span className="pb-zzz" aria-hidden="true">
          <i>z</i>
          <i>z</i>
          <i>z</i>
        </span>
      )}
    </span>
  );
}
