"use client";

// Thermal-receipt pieces shared by the sections that print one: a paper slip (mono, torn edge,
// optional print-in), its rows and rules, a count-up number, and helpers that read the compact
// receipt text the page data uses ("receipt · kimi-k3 · via together · 5 calls · … · $0.0063").

import { useEffect, useRef, useState } from "react";
import { models } from "@/content/models";
import { reducedMotion } from "@/lib/pointer";
import { cn } from "@/lib/utils";
import s from "./sig-slip.module.css";

const parts = (text: string) => text.split("·").map((p) => p.trim()).filter((p) => p && p !== "receipt");

export const receiptCost = (text: string) => {
  const p = parts(text).find((x) => x.startsWith("$") || x.startsWith("≈"));
  return p ? parseFloat(p.replace(/[^0-9.]/g, "")) || 0 : 0;
};

export const findModel = (token: string) =>
  models.find((x) => {
    const short = x.id.split("/")[1];
    return short === token || short.startsWith(token) || token.startsWith(short);
  });

export const modelName = (token: string) => findModel(token)?.name ?? token;

export const receiptModel = (text: string) => modelName(parts(text)[0] ?? "");
export const receiptCalls = (text: string) => parts(text).find((x) => /^\d+ calls?$/.test(x));

export function Slip({ children, print = true, className, style }: { children: React.ReactNode; print?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={cn(s.wrap, className)} style={style}>
      <div className={cn(s.slip, "pb-torn", print && "pb-print")}>{children}</div>
    </div>
  );
}

export function SlipRow({ left, right, dim, strong }: { left: React.ReactNode; right?: React.ReactNode; dim?: boolean; strong?: boolean }) {
  return (
    <div className={cn(s.row, dim && s.dim, strong && s.strong)}>
      <span className={s.l}>{left}</span>
      {right !== undefined && <span className={s.r}>{right}</span>}
    </div>
  );
}

export const SlipRule = () => <div className={s.rule} aria-hidden="true" />;

// Counts up to `to` the first time it scrolls into view (or at once under reduced motion).
export function CountUp({ to, decimals = 0, from = 0, ms = 1200, prefix = "", className }: { to: number; decimals?: number; from?: number; ms?: number; prefix?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  const fmt = (n: number) => prefix + n.toFixed(decimals);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !seen) return;
    if (reducedMotion()) {
      el.textContent = fmt(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = fmt(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // fmt only depends on prefix and decimals
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, to, from, ms]);
  return (
    <span ref={ref} className={cn(s.num, className)}>
      {fmt(from)}
    </span>
  );
}
