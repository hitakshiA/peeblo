"use client";

import { useEffect } from "react";
import { onFrame, reducedMotion, spring } from "@/lib/pointer";

// Page-wide tactile effects, driven by data attributes:
//   data-magnetic  buttons lean toward the cursor and spring back
//   data-tilt      cards tilt in 3D with a paper sheen under the cursor
//   data-slowable  marquee rows ease down to a crawl while hovered
type Spring = { x: number; v: number };

export function CursorFx() {
  useEffect(() => {
    if (reducedMotion()) return;
    const mags = new Map<HTMLElement, { x: Spring; y: Spring }>();
    const tilts = new Map<HTMLElement, { rx: Spring; ry: Spring }>();
    const scan = () => {
      document.querySelectorAll<HTMLElement>("[data-magnetic]").forEach((el) => {
        if (!mags.has(el)) mags.set(el, { x: { x: 0, v: 0 }, y: { x: 0, v: 0 } });
      });
      document.querySelectorAll<HTMLElement>("[data-tilt]").forEach((el) => {
        if (!tilts.has(el)) tilts.set(el, { rx: { x: 0, v: 0 }, ry: { x: 0, v: 0 } });
      });
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    const stop = onFrame((_now, dt, p) => {
      if (!p.fine || !p.seen) return;
      mags.forEach((s, el) => {
        if (!el.isConnected) return void mags.delete(el);
        const r = el.getBoundingClientRect();
        const pad = 40;
        const inside = p.x > r.left - pad && p.x < r.right + pad && p.y > r.top - pad && p.y < r.bottom + pad;
        const tx = inside ? (p.x - (r.left + r.width / 2)) * 0.22 : 0;
        const ty = inside ? (p.y - (r.top + r.height / 2)) * 0.3 : 0;
        const a = spring(s.x, tx, dt, 200, 14);
        const b = spring(s.y, ty, dt, 200, 14);
        if (a || b || inside) el.style.translate = `${s.x.x.toFixed(2)}px ${s.y.x.toFixed(2)}px`;
      });
      tilts.forEach((s, el) => {
        if (!el.isConnected) return void tilts.delete(el);
        const r = el.getBoundingClientRect();
        const inside = p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
        const nx = (p.x - r.left) / r.width - 0.5;
        const ny = (p.y - r.top) / r.height - 0.5;
        const a = spring(s.ry, inside ? nx * 5 : 0, dt, 120, 16);
        const b = spring(s.rx, inside ? -ny * 4 : 0, dt, 120, 16);
        if (a || b || inside) {
          el.style.transform = `perspective(1100px) rotateX(${s.rx.x.toFixed(2)}deg) rotateY(${s.ry.x.toFixed(2)}deg)`;
          el.style.setProperty("--mx", `${((nx + 0.5) * 100).toFixed(1)}%`);
          el.style.setProperty("--my", `${((ny + 0.5) * 100).toFixed(1)}%`);
          el.style.setProperty("--sheen", inside ? "1" : "0");
        }
      });
    });

    // Marquees slow down under the cursor instead of stopping dead.
    const rows = [...document.querySelectorAll<HTMLElement>("[data-slowable]")];
    const ease = (el: HTMLElement, to: number) => {
      el.getAnimations().forEach((a) => {
        const from = a.playbackRate;
        const t0 = performance.now();
        const step = (now: number) => {
          const k = Math.min(1, (now - t0) / 500);
          a.updatePlaybackRate(from + (to - from) * (1 - (1 - k) ** 3));
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    };
    const offs = rows.map((el) => {
      const enter = () => ease(el, 0.15);
      const leave = () => ease(el, 1);
      el.addEventListener("pointerenter", enter);
      el.addEventListener("pointerleave", leave);
      return () => {
        el.removeEventListener("pointerenter", enter);
        el.removeEventListener("pointerleave", leave);
      };
    });

    return () => {
      stop();
      mo.disconnect();
      offs.forEach((f) => f());
    };
  }, []);
  return null;
}

