"use client";
/* eslint-disable @next/next/no-img-element -- small local logos inside the stage */

// "How it works": a pinned scroll scene in four beats.
// A 500vh section holds a sticky stage. Scroll progress p (0..1 while pinned) drives every value:
// title -> orb with orbiting chips -> chips sink in, orb grows into a disc -> a card lands on the
// disc -> the orb floods the screen. Reduced motion renders the four beats as still frames.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Critter } from "@/components/peeblo/critter";
import { integrationById } from "@/content/integrations";
import { modelByShort } from "@/content/models";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "./motion";
import { human } from "./shared";
import s from "./How.module.css";
import { Receipt } from "@/components/peeblo/receipt";
import { Hands, Slip, useTyper } from "@/components/peeblo/sig2-kit";
import { reportJob } from "@/components/peeblo/signature";
import { onFrame, reducedMotion } from "@/lib/pointer";

const logo = (id: string) => integrationById(id)?.src ?? "";
const PI = "/brands/pi/pi-logo.svg";
const OTARI = "/brands/otari/otari-mark.svg";
const flash = modelByShort("deepseek-v4.1-flash")!;
const kimi = modelByShort("kimi-k3")!;
const maya = human("maya");

// `at` is the scroll progress where each beat rests (used by the pager and the still frames).
const beats = [
  { label: "Self-host", h3: "Run it on a server you own.", at: 0.255 },
  { label: "Hire your crew", h3: "Give it a name, a face and a job.", at: 0.56 },
  { label: "Pick models", h3: "Pick open models. Set a budget.", at: 0.755 },
  { label: "Tag it", h3: "Tag it in any thread.", at: 0.985 },
];

const later = ["microsoft-teams", "discord", "google-chat", "mattermost", "lark", "rocket-chat"].map((id) => integrationById(id)!);

// Beat 1: what starts on your server. Polar positions around the stage centre (640px stage).
type Chip = { text: string; icon?: string; dot?: string; mono?: boolean; r: number; a: number; ph: number };
const chips: Chip[] = [
  { icon: logo("docker"), text: "./peeblo up", mono: true, r: 262, a: -55, ph: 0 },
  { icon: logo("postgresql"), text: "Postgres · ready", r: 292, a: 17, ph: 2.2 },
  { dot: "var(--moss)", text: "Peeblo daemon · running", r: 196, a: 89, ph: 4.1 },
  { dot: "var(--ember)", text: "Keys stay on your box", r: 270, a: 161, ph: 1.1 },
  { dot: "var(--ink-3)", text: "On premise", r: 248, a: 206, ph: 3.3 },
];

// Beat 2: the teammate being filled in, inside the disc.
const rows = [
  { icon: logo("slack"), text: "Made in Slack: sprout" },
  { icon: maya.photo, text: "Growth analyst for Maya", photo: true },
  { icon: logo("posthog"), text: "Tools: PostHog, Sheets" },
  { icon: PI, text: "Runs on Pi", pi: true },
];

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const out3 = (t: number) => 1 - (1 - t) ** 3;
const inOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: string, b: string, t: number) => `color-mix(in oklab, ${b} ${(clamp(t) * 100).toFixed(1)}%, ${a})`;
const rad = (d: number) => (d * Math.PI) / 180;
const back = (t: number) => (t <= 0 ? 0 : 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2);
const arc = (t: number) => Math.sin(Math.PI * clamp(t));

// Peeblo's orb is a pebble, not a circle: four edge splits wander around 50%, pushed along by scroll
// and by a slow clock, so the outline breathes as you scroll and keeps breathing when you stop.
function pebble(p: number, now: number, amp: number) {
  const w = (i: number, f: number) => 50 + amp * Math.sin(i * 1.9 + p * 9 * f + now * 0.00052 * (0.7 + i * 0.23));
  const a = w(0, 1);
  const b = w(1, -0.8);
  const c = w(2, 0.9);
  const d = w(3, -1.1);
  const f = (x: number) => `${x.toFixed(2)}%`;
  return `${f(a)} ${f(100 - a)} ${f(b)} ${f(100 - b)} / ${f(c)} ${f(d)} ${f(100 - d)} ${f(100 - c)}`;
}
const pebbleAmp = (p: number) => lerp(9, 5.5, seg(p, 0.3, 0.42));

// Beat 2: the faces the picker flips through before it lands on sprout.
const faces = ["peeblo", "controller", "cat", "rocket", "magnifier", "book", "sprout"];

// Beat 1: what the server says once it is up, typed into the left column.
const status = [
  { dot: true, t: "peeblo-db healthy" },
  { dot: true, t: "daemon :8787" },
  { dot: false, t: "keys: local only" },
];
// Where each segment starts in the typed string (" · " before every segment but the first).
const statusAt = status.map((_, i) => status.slice(0, i).reduce((n, x) => n + (x.dot ? 2 : 0) + x.t.length + 3, 0));
const statusLen = statusAt[status.length - 1] + (status[status.length - 1].dot ? 2 : 0) + status[status.length - 1].t.length;

function StatusStrip({ on }: { on: boolean }) {
  const n = useTyper(statusLen, on, 24, 260);
  return (
    <p className={s.status} aria-label="peeblo-db healthy, daemon on port 8787, keys: local only">
      {status.map((x, i) => {
        const sep = i ? 3 : 0;
        const full = (x.dot ? 2 : 0) + x.t.length;
        const at = statusAt[i] - sep;
        const sepShown = clamp(n - at, 0, sep);
        const shown = clamp(n - at - sep, 0, full);
        if (!sepShown && !shown) return null;
        const dotShown = x.dot && shown > 0;
        const text = x.t.slice(0, Math.max(0, shown - (x.dot ? 2 : 0)));
        return (
          <span key={x.t} className={s.statusSeg} aria-hidden="true">
            {sepShown > 0 && <span className={s.statusSep}>{" · ".slice(0, sepShown)}</span>}
            {dotShown && <i className={cn(s.statusDot, shown === full && s.statusDotLive)} />}
            {text}
          </span>
        );
      })}
      {n < statusLen && <span className={s.statusCaret} aria-hidden="true" />}
    </p>
  );
}

type Box = { w: number; h: number };

function layout(box: Box, leftBottom: number) {
  const mobile = box.w < 900 && box.w / box.h < 1.1;
  if (!mobile) {
    const k = Math.min(1, box.h / 952, box.w / 1524);
    return { mobile, k, cx: box.w * 0.713, cy: box.h / 2, sx: 1, sy: 1 };
  }
  const top = leftBottom + 8;
  const avail = Math.max(320, box.h - top - 12);
  const k = Math.min(0.8, box.w / 500, avail / 560);
  return { mobile, k, cx: box.w / 2, cy: top + avail / 2, sx: 0.5, sy: 0.82 };
}

const Pal = memo(Critter);

// The halftone dot field behind the orb: faint ink dots,
// moss dots that gather around the orb's edge.
function Dots({ w, h, cx, cy, r }: { w: number; h: number; cx: number; cy: number; r: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const gap = 22;
    for (let y = gap / 2; y < h; y += gap) {
      for (let x = gap / 2; x < w; x += gap) {
        const hash = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
        const d = Math.hypot(x - cx, y - cy);
        const near = clamp(1 - Math.abs(d - r * 1.05) / (r * 0.9 + 140));
        const spark = hash > 0.9 ? 0.22 : 0;
        const a = 0.07 + near * 0.32 + spark * (0.4 + near);
        ctx.fillStyle = near > 0.15 || spark ? `rgba(52, 92, 68, ${a.toFixed(3)})` : `rgba(70, 58, 44, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, 1 + near * 0.45 + (spark ? 0.35 : 0), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [w, h, cx, cy, r]);
  return <canvas ref={ref} className={s.canvas} aria-hidden="true" />;
}

type SceneProps = { p: number; box: Box; still?: number; onPip?: (i: number) => void };

function Scene({ p, box, still, onPip }: SceneProps) {
  const left = useRef<HTMLDivElement>(null);
  const headA = useRef<HTMLDivElement>(null);
  const ctxIn = useRef<HTMLDivElement>(null);
  const faceB = useRef<HTMLDivElement>(null);
  const meterEl = useRef<HTMLDivElement>(null);
  const core = useRef<HTMLSpanElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const pNow = useRef(p);
  const [m, setM] = useState({ leftBottom: 300, headA: 150, ctx: 196, b: 330, meter: 170 });
  const [stamped, setStamped] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const l = left.current;
      setM({
        // Phones: the stage starts under the h3s (the beat-4 app strip may overlap the empty top of the stage).
        leftBottom: l ? l.offsetTop + Math.max(0, ...[...l.querySelectorAll("h3")].map((h) => h.offsetTop + h.offsetHeight)) : 300,
        headA: headA.current?.offsetHeight ?? 150,
        ctx: ctxIn.current?.offsetHeight ?? 196,
        b: faceB.current?.offsetHeight ?? 330,
        meter: meterEl.current && ctxIn.current ? meterEl.current.offsetTop - ctxIn.current.offsetTop + meterEl.current.offsetHeight / 2 : 170,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [left.current, headA.current, ctxIn.current, faceB.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const L = layout(box, m.leftBottom);
  const intro = still === undefined;

  // The pebble keeps breathing on the shared frame loop, without re-rendering the scene.
  useLayoutEffect(() => {
    pNow.current = p;
  }, [p]);
  useEffect(() => {
    if (!intro || reducedMotion()) return;
    return onFrame((now) => {
      const q = pNow.current;
      if (q < -0.05 || q > 0.88) return;
      const r = pebble(q, now, pebbleAmp(q));
      if (core.current) core.current.style.borderRadius = r;
      if (ring.current) ring.current.style.borderRadius = r;
    });
  }, [intro]);
  const stillShape = intro ? undefined : pebble(p, 0, pebbleAmp(p));

  // Beat transitions, each scrubbed over its own stretch of scroll.
  const t12 = inOut(seg(p, 0.33, 0.42));
  const t23 = inOut(seg(p, 0.58, 0.68));
  const t34 = inOut(seg(p, 0.83, 0.92));
  const step = t12 + t23 + t34;
  const cur = Math.round(step);

  // Intro: the hand-drawn arrow draws and Peeblo pops in as the section arrives, then the title leaves.
  const draw = out3(seg(p, -0.17, -0.04));
  const pop = out3(seg(p, -0.06, 0));
  const tOut = out3(seg(p, 0.06, 0.13));

  // Orb: rises in, grows into the disc, settles under the card, then floods the screen.
  const oIn = out3(seg(p, 0.09, 0.18));
  const flood = (Math.hypot(box.w, box.h) * 2.7) / L.k;
  let size = lerp(lerp(232, 290, oIn), 530, t12);
  size = lerp(size, 456, t23);
  size = lerp(size, flood, t34 ** 2.4);
  const rise = 140 * (1 - oIn);
  const orbPx = size * L.k;
  // At the very end the flood fades back to paper, so the next section follows with no edge.
  const drain = inOut(seg(p, 0.965, 1));
  const orbOp = oIn * (1 - 0.12 * t23 * (1 - t34)) * (1 - drain);

  const leftIn = out3(seg(p, 0.14, 0.185));
  const ink = mix("var(--ink)", "var(--moss-ink)", t34 * (1 - drain));

  // Beat 2 rows tick in one by one; the newest one is the big, bright one.
  const rowIn = rows.map((_, i) => out3(seg(p, 0.4 + i * 0.03, 0.43 + i * 0.03)));
  const discOut = 1 - seg(p, 0.58, 0.625);
  const palIn = out3(seg(p, 0.37, 0.43));

  // Beat 3 card.
  const cardIn = out3(seg(p, 0.6, 0.68));
  const ctxT = out3(seg(p, 0.655, 0.71));
  const meter = out3(seg(p, 0.7, 0.82));
  // Beat 4: the card turns into the Slack thread with its receipt.
  const tB = out3(seg(p, 0.84, 0.885));
  const ask = out3(seg(p, 0.865, 0.9));
  const typing = seg(p, 0.89, 0.9) * (1 - seg(p, 0.92, 0.928));
  const reply = out3(seg(p, 0.922, 0.952));
  const rcpt = out3(seg(p, 0.948, 0.975));
  const facesH = lerp(m.headA + 16 * ctxT + m.ctx * ctxT, m.b, tB);

  // Card geometry in stage units (it scales about its centre), for the things that cling to it.
  const cs = lerp(0.9, 1.03, t34);
  const cardCY = 320 + 40 * (1 - cardIn);
  const cardH = 56 + facesH;
  const meterY = cardCY + (28 + m.headA + 16 + m.meter - cardH / 2) * cs;
  const edgeX = 320 + 230 * cs;

  // Beat 4: once the reply is in, a receipt feeds out of the card's bottom and gets stamped.
  const slipOn = intro ? p >= 0.955 : still === 3;
  if (!slipOn && stamped) setStamped(false);

  // Peeblo rides the pebble: drops onto it holding the docker chip, dives into the disc and turns
  // into the face picker, pops back out beside sprout, grips Maya's budget meter, then slides down
  // the card's edge to wait for the receipt.
  const R = size / 2;
  const land = back(seg(p, 0.15, 0.205));
  const dive = seg(p, 0.33, 0.372);
  const popOut = back(seg(p, 0.425, 0.465));
  const toCard = inOut(seg(p, 0.6, 0.68));
  const toSlip = inOut(seg(p, 0.85, 0.91));
  const seat0 = 320 - 145 - 26;
  let rx = 320;
  let ry = 320 - R - 26 - 220 * (1 - land);
  let rs = 1;
  let rr = 0;
  let rOp = seg(p, 0.15, 0.165);
  if (p >= 0.33) {
    const up = out3(seg(dive, 0, 0.3));
    const down = seg(dive, 0.3, 1) ** 1.6;
    ry = lerp(lerp(seat0, seat0 - 36, up), 206, down);
    rr = lerp(-10 * up, 180, down);
    rs = lerp(1, 0.45, down);
    rOp = 1 - seg(dive, 0.82, 1);
  }
  if (p >= 0.42) {
    rx = lerp(320, 404, popOut);
    ry = lerp(206, 242, popOut) - 46 * arc(seg(p, 0.425, 0.465));
    rs = lerp(0.45, 0.72, clamp(popOut));
    rr = 0;
    rOp = seg(p, 0.42, 0.428);
  }
  if (p >= 0.6) {
    rx = lerp(404, edgeX + (L.mobile ? 10 : 20), toCard);
    ry = lerp(242, meterY, toCard) - 80 * arc(toCard);
    rs = lerp(0.72, 0.78, toCard);
    rr = -14 * arc(toCard);
  }
  if (p >= 0.85) {
    // Phones have no room right of the card, so Peeblo waits on the slip's left instead.
    rx = lerp(edgeX + (L.mobile ? 10 : 20), 320 + (L.mobile ? -36 : 226) * cs, toSlip);
    ry = lerp(meterY, cardCY + (cardH / 2 + 58) * cs, toSlip);
    rr = 8 * arc(toSlip);
  }
  const handsUp = 1 - seg(p, 0.322, 0.335);
  const handsSide = seg(p, 0.66, 0.68) * (1 - arc(toSlip)) * (L.mobile ? 1 - seg(toSlip, 0.4, 0.5) : 1);
  const handsRight = L.mobile ? seg(toSlip, 0.6, 1) : 0;
  const riderMood = p < 0.33 ? "idle" : p < 0.6 ? "happy" : p < 0.85 ? "thinking" : stamped ? "happy" : "idle";

  // The docker chip is carried, not orbited: it sits on Peeblo's mitts, then sinks in with the rest.
  const heldX = 320;
  const heldY = lerp((p < 0.33 ? ry : seat0) - 57, 320, t12);

  // Splash where Peeblo breaks the surface; the face picker spins while it is inside.
  const splash = seg(p, 0.356, 0.392);
  const pickT = seg(p, 0.365, 0.418);
  const fx = out3(pickT) * (faces.length - 1);
  const face = faces[Math.min(faces.length - 1, Math.floor(fx + 1e-4))];
  const frac = fx - Math.floor(fx);
  const flip = pickT <= 0 || pickT >= 1 ? 1 : 0.78 + 0.22 * Math.min(frac, 1 - frac) * 2;

  const stageT = `translate(-50%, -50%) translateY(${rise.toFixed(1)}px) scale(${L.k.toFixed(4)})`;
  const pos = { left: L.cx, top: L.cy };

  return (
    <div className={cn(s.scene, L.mobile && s.mobile, !intro && s.stillScene)} data-flood={(t34 > 0.5 && drain < 0.5) || undefined}>
      <div className={s.glow} style={{ ...pos, opacity: lerp(0.35, 1, oIn) * (1 - t34) }} aria-hidden="true" />
      <Dots w={box.w} h={box.h} cx={Math.round(L.cx)} cy={Math.round(L.cy + rise)} r={Math.round((orbPx * 0.37) / 2) * 2} />
      <div
        className={s.orb}
        aria-hidden="true"
        style={{ ...pos, width: orbPx, height: orbPx, opacity: orbOp, transform: `translate(-50%, -50%) translateY(${rise.toFixed(1)}px)` }}
      >
        <span ref={core} className={s.orbCore} style={stillShape ? { borderRadius: stillShape } : undefined} />
      </div>
      <div
        ref={ring}
        className={s.ripple}
        aria-hidden="true"
        style={{ ...pos, width: orbPx * 0.74, height: orbPx * 0.74, opacity: Math.sin(Math.PI * t34) * 0.85, borderRadius: stillShape }}
      />


      {intro && (
        <h2
          id="how-title"
          className={s.title}
          style={{ opacity: 1 - tOut, transform: `translate(-50%, -50%) translateY(${(-64 * tOut).toFixed(1)}px) scale(${(1 - 0.08 * tOut).toFixed(4)})` }}
        >
          How it{" "}
          <span className={s.word}>
            works
            <svg width="64" height="48" viewBox="0 0 64 48" className={s.arrow} aria-hidden="true">
              <path
                d="M4 44 C 9 32, 20 27, 23 34 C 26 41, 14 43, 15 32 C 16 20, 36 10, 57 8"
                pathLength="1"
                fill="none"
                stroke="var(--ember)"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeDasharray="1"
                strokeDashoffset={(1 - draw).toFixed(3)}
              />
              <path d="M50 3 L58 8 L51 14" fill="none" stroke="var(--ember)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity={draw > 0.96 ? 1 : 0} />
            </svg>
            <span className={s.tag} aria-hidden="true" style={{ opacity: pop, transform: `translateX(${(6 * (1 - pop)).toFixed(1)}px) scale(${lerp(0.8, 1, pop).toFixed(3)})` }}>
              <Pal id="peeblo" size={L.mobile ? 46 : 68} mood="happy" reach={260} />
            </span>
          </span>
        </h2>
      )}

      <div ref={left} className={s.left} style={{ color: ink }}>
        <div className={s.steps} style={intro ? { opacity: leftIn, transform: `translateY(${(18 * (1 - leftIn)).toFixed(1)}px)` } : undefined}>
          <div className={s.pager}>
            {beats.map((b, i) => {
              const on = Math.max(0, 1 - Math.abs(step - i));
              const style = {
                width: 8 + 20 * on,
                background: mix(mix("var(--line-2)", "oklch(1 0 0 / 0.35)", t34), mix("var(--ink)", "var(--moss-ink)", t34), on),
              };
              return onPip ? (
                <button key={b.label} type="button" className={s.pip} aria-label={b.label} aria-current={cur === i ? "step" : undefined} style={style} onClick={() => onPip(i)} />
              ) : (
                <span key={b.label} className={s.pip} style={style} />
              );
            })}
          </div>
          <span className={s.label}>{beats[cur].label}</span>
        </div>
        <div className={s.copy} style={intro ? { opacity: leftIn, transform: `translateY(${(18 * (1 - leftIn)).toFixed(1)}px)` } : undefined}>
          {beats.map((b, i) => {
            if (still !== undefined && still !== i) return null;
            const d = step - i;
            const op = clamp(1 - Math.abs(d) * 1.9) ** 2;
            return (
              <div key={b.label} className={s.copyItem} style={{ opacity: op, transform: `translateY(${(-d * 28).toFixed(1)}px)` }} aria-hidden={op < 0.5 || undefined}>
                <h3 className={s.h3}>{b.h3}</h3>
                {i === 0 && <StatusStrip on={intro ? cur === 0 && leftIn > 0.9 && op > 0.6 : still === 0} />}
                {i === 3 && (
                  <div className={s.apps}>
                    <span className={cn(s.app, s.appOn)}>
                      <img src={logo("slack")} alt="Slack" />
                    </span>
                    {later.map((a) => (
                      <span key={a.id} className={s.app} title={`${a.name}, coming later`}>
                        <img src={a.src} alt={`${a.name} (coming later)`} />
                      </span>
                    ))}
                    <span className={s.appsNote}>Slack today. The rest are coming.</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className={s.stage} aria-hidden="true" style={{ ...pos, transform: stageT }}>
        {chips.map((c, i) => {
          if (i === 0) return null;
          const appear = out3(seg(p, 0.13 + i * 0.009, 0.18 + i * 0.009));
          const ang = rad(c.a + 82 * (Math.min(p, 0.33) - 0.2));
          const depth = 0.5 + 0.5 * Math.cos(c.ph + 13 * (Math.min(p, 0.33) - 0.2));
          const x = lerp(320 + c.r * L.sx * Math.cos(ang), 320, t12);
          const y = lerp(320 + c.r * L.sy * Math.sin(ang) * 0.94, 320, t12);
          const op = appear * lerp(0.55, 1, depth) * (1 - seg(t12, 0, 0.62));
          return (
            <div
              key={c.text}
              className={s.chip}
              style={{ left: x, top: y, opacity: op, transform: `translate(-50%, -50%) scale(${lerp(1, 0.4, t12).toFixed(3)})` }}
            >
              <span className={s.chipIc}>{c.icon ? <img src={c.icon} alt="" /> : <span className={s.chipDot} style={{ background: c.dot }} />}</span>
              <span className={cn(s.chipText, c.mono && s.chipMono)} style={{ color: mix("var(--ink-3)", "var(--ink)", depth) }}>
                {c.text}
              </span>
            </div>
          );
        })}

        {(() => {
          const c = chips[0];
          const appear = out3(seg(p, 0.15, 0.2));
          return (
            <div
              className={cn(s.chip, s.held)}
              style={{ left: heldX, top: heldY, opacity: appear * (1 - seg(t12, 0, 0.62)), transform: `translate(-50%, -50%) rotate(${(-3 * (1 - t12)).toFixed(2)}deg) scale(${lerp(1, 0.4, t12).toFixed(3)})` }}
            >
              <span className={s.chipIc}>
                <img src={c.icon} alt="" />
              </span>
              <span className={cn(s.chipText, s.chipMono)}>{c.text}</span>
            </div>
          );
        })()}

        <div className={s.splash} style={{ top: 320 - R, opacity: Math.sin(Math.PI * splash) * 0.9, transform: `translate(-50%, -50%) scale(${lerp(0.3, 1.5, out3(splash)).toFixed(3)})` }} />

        <div className={s.pal} style={{ opacity: palIn * discOut, transform: `translate(-50%, -50%) translateY(${(10 * (1 - palIn)).toFixed(1)}px) scale(${lerp(0.7, 1, palIn).toFixed(3)})` }}>
          <span className={s.palFace} style={{ transform: `scale(${flip.toFixed(3)})` }}>
            <Pal id={face} size={84} mood={pickT < 1 ? "thinking" : rowIn[3] > 0.5 ? "happy" : "idle"} reach={200} />
          </span>
          <span className={s.palTick} style={{ opacity: pickT > 0 && pickT < 1 ? 1 : 0 }} />
        </div>
        {rows.map((r, i) => {
          const em = rowIn[i] * (1 - (rowIn[i + 1] ?? 0));
          return (
            <div
              key={r.text}
              className={s.thought}
              style={{
                top: 314 + i * 44,
                opacity: rowIn[i] * lerp(0.6, 1, em) * discOut,
                fontSize: lerp(17, 21, em),
                transform: `translate(-50%, -50%) translateY(${(9 * (1 - rowIn[i])).toFixed(1)}px)`,
              }}
            >
              <span className={cn(s.thoughtIc, r.photo && s.thoughtPhoto, r.pi && s.thoughtPi)} style={{ width: lerp(24, 29, em), height: lerp(24, 29, em) }}>
                <img src={r.icon} alt="" />
              </span>
              {r.text}
            </div>
          );
        })}

        <div
          className={s.card}
          style={{ opacity: cardIn, transform: `translate(-50%, -50%) translateY(${(40 * (1 - cardIn)).toFixed(1)}px) scale(${lerp(0.9, 1.03, t34).toFixed(4)})` }}
        >
          <div className={s.faces} style={{ height: facesH }}>
            <div className={s.faceA} style={{ opacity: 1 - tB }}>
              <div ref={headA} className={s.headA}>
                <div className={s.meta}>
                  <img src={OTARI} alt="" className={s.metaIc} />
                  Otari · open-weight models
                </div>
                <div className={s.cardTitle}>sprout runs on open models.</div>
                <div className={s.cardBody}>Maya gets a monthly AI budget. sprout never holds an API key.</div>
              </div>
              <div className={s.ctx} style={{ height: m.ctx * ctxT, marginTop: 16 * ctxT }}>
                <div ref={ctxIn} className={s.ctxBox}>
                  {[
                    { k: "Model", img: flash.logo, v: flash.name },
                    { k: "Fallback", img: kimi.logo, v: kimi.name },
                  ].map((row, i) => (
                    <div key={row.k} className={s.ctxRow} style={{ opacity: out3(seg(p, 0.67 + i * 0.012, 0.7 + i * 0.012)) }}>
                      <span className={s.ctxKey}>{row.k}</span>
                      <img src={row.img} alt="" className={s.ctxLogo} />
                      {row.v}
                    </div>
                  ))}
                  <div className={s.ctxRow} style={{ opacity: out3(seg(p, 0.694, 0.724)) }}>
                    <span className={s.ctxKey}>Budget</span>
                    <img src={maya.photo} alt="" className={cn(s.ctxLogo, s.ctxFace)} />
                    Maya · $40 a month
                  </div>
                  <div ref={meterEl} className={s.meter} style={{ opacity: out3(seg(p, 0.7, 0.73)) }}>
                    <span className={s.meterBar}>
                      <span style={{ width: `${(32 * meter).toFixed(1)}%` }} />
                    </span>
                    <span className={s.meterText}>${(12.8 * meter).toFixed(2)} used</span>
                  </div>
                </div>
              </div>
            </div>

            <div ref={faceB} className={s.faceB} style={{ opacity: tB }}>
              <div className={s.meta}>
                <img src={logo("slack")} alt="" className={s.metaIc} />
                #growth · thread
              </div>
              <div className={s.msg} style={{ opacity: ask, transform: `translateY(${(8 * (1 - ask)).toFixed(1)}px)` }}>
                <img src={maya.photo} alt="" className={s.msgAv} />
                <div>
                  <div className={s.msgName}>
                    Maya <time>10:42</time>
                  </div>
                  <div className={s.msgText}>
                    <span className={s.mention}>@sprout</span> why did signups dip on Tuesday?
                  </div>
                </div>
              </div>
              <div className={s.msg} style={{ opacity: Math.max(typing, reply), transform: `translateY(${(8 * (1 - Math.max(typing, reply))).toFixed(1)}px)` }}>
                <span className={s.msgAv}>
                  <Pal id="sprout" size={34} reach={120} />
                </span>
                <div>
                  <div className={s.msgName}>
                    sprout <span className={s.appTag}>APP</span> <time>10:43</time>
                  </div>
                  <div className={s.replyBox}>
                    <span className={s.dots} style={{ opacity: typing }}>
                      <i />
                      <i />
                      <i />
                    </span>
                    <span className={s.msgText} style={{ opacity: reply }}>
                      The pricing page was down for three hours after Monday&apos;s deploy. Signups from it fell 41%.
                    </span>
                  </div>
                  <div className={cn(s.rcpt, rcpt > 0.98 && s.rcptLive)} style={{ opacity: rcpt, transform: `translateY(${(6 * (1 - rcpt)).toFixed(1)}px)` }}>
                    <Receipt text={`${flash.id.split("/")[1]} · deepinfra · $0.0021`} />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <span className={s.slot} style={{ opacity: tB }} />
          {slipOn && (
            <Slip
              className={s.slip}
              still={!intro}
              title="sprout · #growth"
              rows={[
                { k: "model", v: "deepseek-v4.1-flash" },
                { k: "via", v: "deepinfra · 1 call" },
                { k: "budget", v: "Maya · $12.80 / $40" },
              ]}
              total="$0.0021"
              onStamped={() => {
                setStamped(true);
                reportJob({ id: "how-sprout-signups", agent: "sprout", what: "why signups dipped on Tuesday", cost: 0.0021, model: "deepseek-v4.1-flash" });
              }}
            />
          )}
        </div>

        <div className={s.rider} style={{ left: rx, top: ry, opacity: rOp, transform: `translate(-50%, -50%) rotate(${rr.toFixed(2)}deg) scale(${rs.toFixed(3)})` }}>
          <div className={cn(s.riderBob, stamped && s.riderHop)}>
            <Pal id="peeblo" size={72} mood={riderMood} bob={false} reach={180} />
            <Hands className={s.handsUp} gap={18} style={{ opacity: handsUp }} />
            <Hands className={s.handsSide} gap={7} size={10} style={{ opacity: handsSide }} />
            <Hands className={cn(s.handsSide, s.handsRight)} gap={7} size={10} style={{ opacity: handsRight }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Pinned() {
  const root = useRef<HTMLElement>(null);
  const stick = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(-0.3);
  const [box, setBox] = useState<Box>({ w: 1440, h: 900 });

  useEffect(() => {
    const el = root.current;
    const st = stick.current;
    if (!el || !st) return;
    const target = () => {
      const r = el.getBoundingClientRect();
      return clamp(-r.top / Math.max(1, r.height - st.offsetHeight), -0.3, 1);
    };
    let cur = target();
    let raf = 0;
    let live = false;
    const tick = () => {
      raf = 0;
      const t = target();
      const d = t - cur;
      cur = Math.abs(d) < 0.0004 ? t : cur + d * 0.2;
      setP(cur);
      if (live) raf = requestAnimationFrame(tick);
    };
    const size = () => setBox({ w: st.clientWidth, h: st.offsetHeight });
    size();
    setP(cur);
    const io = new IntersectionObserver(
      ([e]) => {
        live = e.isIntersecting;
        if (live && !raf) raf = requestAnimationFrame(tick);
      },
      { rootMargin: "40% 0px" },
    );
    io.observe(el);
    const ro = new ResizeObserver(size);
    ro.observe(st);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  const goTo = useCallback((i: number) => {
    const el = root.current;
    const st = stick.current;
    if (!el || !st) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + beats[i].at * (el.offsetHeight - st.offsetHeight), behavior: "smooth" });
  }, []);

  return (
    <section ref={root} id="how" className={s.section} aria-labelledby="how-title">
      <div ref={stick} className={s.stick}>
        <Scene p={p} box={box} onPip={goTo} />
      </div>
    </section>
  );
}

function StillFrame({ i }: { i: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ w: 1440, h: 760 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = () => setBox({ w: el.clientWidth, h: el.offsetHeight });
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={cn(s.still, i === 3 && s.stillFlood)}>
      <Scene p={beats[i].at} box={box} still={i} />
    </div>
  );
}

// Reduced motion: no pinning, no scrubbing. The four beats stand stacked at their resting state.
function Stacked() {
  return (
    <section id="how" className={s.stacked} aria-labelledby="how-title">
      <h2 id="how-title" className={s.stackTitle}>
        How it works
      </h2>
      {beats.map((b, i) => (
        <StillFrame key={b.label} i={i} />
      ))}
    </section>
  );
}

export function How() {
  const rm = useReducedMotion();
  return rm ? <Stacked /> : <Pinned />;
}

