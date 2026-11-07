"use client";

import { useEffect, useRef, useState } from "react";
import type { AvatarMotion } from "open-bot-avatar";
import { Brain, CalendarClock, Cpu, FileText, Plug, Receipt, ScanSearch, ShieldCheck, UserRound, Wallet, type LucideIcon } from "lucide-react";
import { GazeCritter, type Look } from "@/components/peeblo/sig-gaze";
import s from "./shared.module.css";
import c from "./Anatomy.module.css";

// "Everything a teammate comes with.": a core character with dashed spokes to its parts.
type Part = { name: string; body: string; icon: LucideIcon; color: string; mood: AvatarMotion };

const parts: Part[] = [
  { name: "Instructions", body: "What it does, how it talks, and what it may never do. Plain text its owner can change.", icon: FileText, color: "#E67A2E", mood: "idle" },
  { name: "Model", body: "An open-weight model through Otari, pinned per teammate. Small and fast, or large.", icon: Cpu, color: "#E4552F", mood: "thinking" },
  { name: "Budget", body: "A monthly budget, split per person. It shows a price before a costly job.", icon: Wallet, color: "#C98A1B", mood: "idle" },
  { name: "Approvals", body: "It asks a person before any send, post, merge or delete.", icon: ShieldCheck, color: "#5C6BC9", mood: "thinking" },
  { name: "Tools", body: "Only the tools its owner allows. It never holds the API key.", icon: Plug, color: "#3E9AA6", mood: "idle" },
  { name: "Memory", body: "What it has learned so far. One memory per teammate, readable and editable by its owner.", icon: Brain, color: "#D0679C", mood: "thinking" },
  { name: "Schedules", body: "Recurring or one-time jobs. It runs on its own and posts to a channel.", icon: CalendarClock, color: "#4F8FD6", mood: "idle" },
  { name: "Owner", body: "The person who made it. They set its job, its tools and its budget.", icon: UserRound, color: "#C9536A", mood: "happy" },
  { name: "Reviewer", body: "It can hand its work to a teammate on a different model to check.", icon: ScanSearch, color: "#5FB79A", mood: "thinking" },
  { name: "Receipts", body: "Every answer ends with the model, provider, attempts, fallback and cost.", icon: Receipt, color: "#A96BB0", mood: "happy" },
];

// One spoke per part on an ellipse, offset half a step so none sits on the vertical axis.
const step = 360 / parts.length;
const spots = parts.map((_, i) => {
  const t = ((-90 - step / 2 + i * step) * Math.PI) / 180;
  return { x: +(50 + 38 * Math.cos(t)).toFixed(1), y: +(50 + 39 * Math.sin(t)).toFixed(1) };
});

export function Anatomy() {
  const [alive, setAlive] = useState(false);
  const [hop, setHop] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const core = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [look, setLook] = useState<Look>(null);
  const [hovering, setHovering] = useState(false);
  // Pointing at Peeblo itself lights every part at once.
  const [all, setAll] = useState(false);
  const held = useRef(false);

  // Point Peeblo's eyes at a part, measured from the page so it works in every layout.
  const focus = (i: number) => {
    const node = root.current?.querySelectorAll<HTMLElement>("[data-part]")[i]?.querySelector<HTMLElement>("[data-ico]");
    const from = core.current?.getBoundingClientRect();
    const to = node?.getBoundingClientRect();
    setActive(i);
    if (!from || !to) return;
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    setLook({ x: +((dx / d) * 0.95).toFixed(2), y: +((dy / d) * 0.85).toFixed(2) });
  };

  const focusRef = useRef(focus);
  useEffect(() => {
    focusRef.current = focus;
  });

  // While nobody is pointing at a part, Peeblo walks through them one by one.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let seen = false;
    let i = -1;
    const io = new IntersectionObserver(([e]) => (seen = e.isIntersecting), { threshold: 0.3 });
    if (root.current) io.observe(root.current);
    const id = window.setInterval(() => {
      if (!seen || held.current || document.hidden) return;
      i = (i + 1) % parts.length;
      focusRef.current(i);
    }, 2400);
    return () => {
      clearInterval(id);
      io.disconnect();
    };
  }, []);

  const poke = () => {
    if (hop || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setHop(true);
    setAlive(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAlive(false), 1150);
  };

  return (
    <section className={s.story} id="anatomy" aria-labelledby="anatomy-h">
      <div className={s.shell}>
        <div className={s.headC}>
          <h2 id="anatomy-h">Everything a teammate comes with.</h2>
        </div>
        <div
          ref={root}
          className={`${c.anat} ${alive ? c.alive : ""} ${hovering ? c.hovering : ""}`}
          onPointerLeave={() => {
            held.current = false;
            setHovering(false);
            setAll(false);
          }}
        >
          <svg className={c.lines} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {spots.map((p, i) => (
              <line key={i} x1="50" y1="50" x2={p.x} y2={p.y} />
            ))}
            {all
              ? spots.map((p, i) => (
                  <line key={`all-${i}`} className={c.path} x1="50" y1="50" x2={p.x} y2={p.y} style={{ stroke: parts[i].color, animationDelay: `${i * 45}ms` }} />
                ))
              : active !== null && (
                  <line key={`path-${active}`} className={c.path} x1="50" y1="50" x2={spots[active].x} y2={spots[active].y} style={{ stroke: parts[active].color }} />
                )}
          </svg>
          <div className={c.core} ref={core}>
            <span
              className={`${c.pea} ${hop ? c.hop : ""}`}
              onPointerEnter={() => {
                held.current = true;
                setHovering(true);
                setAll(true);
                setLook(null);
                poke();
              }}
              onPointerLeave={() => setAll(false)}
              onClick={poke}
              onAnimationEnd={(e) => e.animationName.includes("hop") && setHop(false)}
            >
              <GazeCritter id="peeblo" size={200} mood={alive ? "happy" : active !== null ? parts[active].mood : "idle"} look={look} lean={9} bob={false} />
            </span>
          </div>
          {parts.map((p, i) => {
            const Icon = p.icon;
            return (
              <div
                className={`${c.node} ${all || active === i ? c.on : ""}`}
                key={p.name}
                data-part
                onPointerEnter={() => {
                  held.current = true;
                  setHovering(true);
                  focus(i);
                }}
                style={{ left: `${spots[i].x}%`, top: `${spots[i].y}%`, "--c": p.color } as React.CSSProperties}
              >
                <span className={c.ico} aria-hidden="true" data-ico>
                  <Icon strokeWidth={1.6} key={all || active === i ? "on" : "off"} />
                </span>
                <b>{p.name}</b>
                <p>{p.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
