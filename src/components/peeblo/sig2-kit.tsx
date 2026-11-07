"use client";

// Small helpers shared by the lower sections' Peeblo layers (How it works, Slack, self-host, FAQ, closing):
//   - useInView / useCountUp / useTyper: scroll- and time-driven reveals that respect reduced motion;
//   - <Slip>: a thermal receipt that feeds out of a printer slot (.pb-print + .pb-torn), then gets stamped;
//   - <Hands>: two small mitts in a character's colour, for "holding" or "gripping" an edge.

import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { reducedMotion } from "@/lib/pointer";
import { Stamp } from "./signature";
import k from "./sig2-kit.module.css";

export function useInView(ref: RefObject<Element | null>, threshold = 0.3, once = false) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          if (once) io.disconnect();
        } else if (!once) setSeen(false);
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, threshold, once]);
  return seen;
}

// Eases a number from 0 up to `to` once `on` turns true. Reduced motion jumps straight there.
export function useCountUp(to: number, on: boolean, ms = 900) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    if (reducedMotion()) {
      const t = setTimeout(() => setN(to), 0);
      return () => clearTimeout(t);
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const x = Math.min(1, (now - t0) / ms);
      setN(Math.round(to * (1 - (1 - x) ** 3)));
      if (x < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, on, ms]);
  return n;
}

// Types `length` characters one by one while `on`; resets to 0 when `on` goes false.
export function useTyper(length: number, on: boolean, msPerChar = 28, delay = 0) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) {
      const t = setTimeout(() => setN(0), 0);
      return () => clearTimeout(t);
    }
    if (reducedMotion()) {
      const t = setTimeout(() => setN(length), 0);
      return () => clearTimeout(t);
    }
    let i = 0;
    let id: number | undefined;
    const start = window.setTimeout(() => {
      id = window.setInterval(() => {
        i += 1;
        setN(i);
        if (i >= length) window.clearInterval(id);
      }, msPerChar);
    }, delay);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(id);
    };
  }, [length, on, msPerChar, delay]);
  return n;
}

export type SlipRow = { k: string; v: string };

// A thermal-paper receipt. Mounting it prints it (top-anchored feed with a torn bottom); when the
// feed finishes the stamp thumps on and `onStamped` fires once. `still` skips straight to stamped.
export function Slip({
  title,
  rows,
  total,
  stamp = "DONE",
  foot = "0 keys shared",
  tone = "moss",
  still = false,
  onStamped,
  className,
}: {
  title: string;
  rows: SlipRow[];
  total: string;
  stamp?: string;
  foot?: string;
  tone?: "moss" | "ember" | "ink";
  still?: boolean;
  onStamped?: () => void;
  className?: string;
}) {
  const [stamped, setStamped] = useState(still);
  const done = useRef(onStamped);
  useEffect(() => {
    done.current = onStamped;
  }, [onStamped]);
  useEffect(() => {
    const ms = still || reducedMotion() ? 0 : 1150;
    const t = setTimeout(() => {
      setStamped(true);
      done.current?.();
    }, ms);
    return () => clearTimeout(t);
  }, [still]);
  return (
    <div className={cn(k.slipWrap, className)}>
      <div className={cn(k.slip, "pb-torn", !still && "pb-print")}>
        <div className={k.slipHead}>{title}</div>
        {rows.map((r) => (
          <div key={r.k} className={k.slipRow}>
            <span>{r.k}</span>
            <span>{r.v}</span>
          </div>
        ))}
        <div className={k.slipTotal}>
          <span>total</span>
          <b>{total}</b>
        </div>
        <div className={k.slipFoot}>{foot}</div>
      </div>
      <Stamp on={stamped} tone={tone} className={k.slipStamp}>
        {stamp}
      </Stamp>
    </div>
  );
}

// Two little mitts, drawn in the character's colour with a soft ink outline.
export function Hands({ color = "#b6dfc5", gap = 22, size = 11, className, style }: { color?: string; gap?: number; size?: number; className?: string; style?: React.CSSProperties }) {
  return (
    <span className={cn(k.hands, className)} style={{ ...style, gap, ["--mitt" as string]: color, ["--mitt-size" as string]: `${size}px` }} aria-hidden="true">
      <i />
      <i />
    </span>
  );
}
