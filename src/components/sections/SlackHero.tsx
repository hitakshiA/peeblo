/* eslint-disable @next/next/no-img-element -- small local logos and portraits inside a scaled mock */
"use client";

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Clock,
  Ellipsis,
  EllipsisVertical,
  Headphones,
  House,
  MessagesSquare,
  Mic,
  PanelLeft,
  Plus,
  Search,
  SendHorizontal,
  Smile,
  SquareSlash,
  ThumbsDown,
  ThumbsUp,
  Video,
  X,
} from "lucide-react";
import type { AvatarMotion } from "open-bot-avatar";
import { Avatar } from "@/components/peeblo/avatar";
import { Critter } from "@/components/peeblo/critter";
import { cn } from "@/lib/utils";
import { channels, richText, T, threadTimeline, type Reply, type Rich, type Thread } from "./heroData";
import { clock, useReducedMotion } from "./motion";
import { allPhotos, avatarOf, human, svc, svcName } from "./shared";
import s from "./SlackHero.module.css";
import { Receipt } from "@/components/peeblo/receipt";
import { money, reportJob, Stamp, totalCost, useVisitJobs } from "@/components/peeblo/signature";
import { receiptCalls, receiptCost, receiptModel, Slip, SlipRow, SlipRule } from "@/components/peeblo/sig-slip";

const NEVER = 1e12;
const I = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn(s.i, className)} aria-hidden="true">
    {children}
  </span>
);

// "@echo" inside an ask is shown as a mention too.
function AskText({ agent, ask }: { agent: string; ask: string }) {
  const parts = ask.split(/(@[a-z]+)/g);
  return (
    <>
      <span className={s.men}>@{agent}</span>{" "}
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className={s.men}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

function Typed({ rich, chars }: { rich: Rich; chars: number }) {
  const texts = rich.map((p) => (typeof p === "string" ? p : p.link));
  const offsets = texts.map((_, i) => texts.slice(0, i).join("").length);
  return (
    <>
      {rich.map((p, i) => {
        const left = chars - offsets[i];
        if (left <= 0) return null;
        const shown = texts[i].slice(0, left);
        return typeof p === "string" ? <span key={i}>{shown}</span> : <i key={i}>{shown}</i>;
      })}
    </>
  );
}

function Pointer() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 2.2 19 12.6l-5.9.5 3.2 6.6-2.8 1.4-3.2-6.7-4.3 3.6z" fill="#fff" stroke="#1d1c1d" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

type Tl = ReturnType<typeof threadTimeline>;

function ReplyMsg({ r, tl, el, k, num0, time }: { r: Reply; tl: Tl["replies"][number]; el: number; k: number; num0: number; time: string }) {
  const local = el - tl.start;
  if (local < 0) return null;
  const allDone = tl.steps.length === 0 || local >= tl.steps[tl.steps.length - 1].done;
  const current = tl.steps.findIndex((st) => local < st.done);
  const chars = Math.max(0, Math.floor((local - tl.answerAt) / T.typePerChar));
  const typing = local >= tl.answerAt && chars < richText(r.answer).length;
  const summary = r.steps.map((st, i) => (i === 0 ? st.verb : st.verb[0].toLowerCase() + st.verb.slice(1))).join(", ");

  return (
    <div className={cn(s.m, s.in)}>
      <span className={s.agentAv}>
        <Critter id={avatarOf(r.agent)} size={Math.round(34 * k)} bob={false} reach={140} />
      </span>
      <div className={s.mc}>
        <div className={s.mh}>
          <span className={s.name}>{r.agent}</span>
          <span className={s.badge}>APP</span>
          <span className={s.time}>{time}</span>
        </div>
        <div className={s.mb}>
          {allDone ? (
            <div className={cn(s.ctx, s.sum)}>
              <span className={s.sumIcon} />
              <span>{summary}</span>
              <span className={s.sumChev} />
            </div>
          ) : (
            <div className={cn(s.ctx, s.sum, s.work)}>
              <span className={s.workMark}>
                <Avatar id={avatarOf(r.agent)} size={Math.round(14 * k)} still />
              </span>
              <span>
                Working on it · step {Math.max(1, current + 1)} of {r.steps.length}
              </span>
            </div>
          )}
          {r.steps.map((st, i) => {
            const t = tl.steps[i];
            if (local < t.start) return null;
            const done = local >= t.done;
            const w = st.write;
            const approved = w && t.approveAt !== undefined && local >= t.approveAt + (T.approved - T.approveShow);
            const pressing = w && t.approveAt !== undefined && local >= t.approveAt + (T.press - T.approveShow) && !approved;
            const cursorOn = w && t.approveAt !== undefined && local >= t.approveAt + 200;
            return (
              <div key={i} className={s.mb}>
                <div className={cn(s.ctx, s.step)}>
                  <span>
                    <span className={cn(s.stepMark, done ? s.done : s.spin)} />
                    <span>{st.verb}</span>
                  </span>
                  {done && (
                    <span className={s.stepOut}>
                      <span className={cn(s.num, s.numPing)}>{num0 + i + 1}</span>
                      <img src={svc(st.svc)} alt="" />
                      <b>{st.result}</b>
                    </span>
                  )}
                </div>
                {w && t.approveAt !== undefined && local >= t.approveAt && (
                  <div className={s.ask}>
                    <div className={s.askH}>
                      <span className={s.askIc}>
                        <img src={svc(st.svc)} alt="" />
                      </span>
                      <div>
                        <div className={s.askT}>Okay to write to {svcName[st.svc] ?? st.svc}?</div>
                        <div className={s.askM}>
                          {w.what} · <span className={s.price}>{w.price}</span>
                        </div>
                      </div>
                    </div>
                    {approved ? (
                      <div className={s.okd}>
                        <I>
                          <Check />
                        </I>
                        Approved by {human(w.who).name}
                        <span>· just now</span>
                      </div>
                    ) : (
                      <div className={s.acts}>
                        <span className={cn(s.btn, s.btnPrimary, pressing && s.btnDown)}>Approve</span>
                        <span className={s.btn}>Not now</span>
                        {cursorOn && (
                          <span className={cn(s.cursor, pressing && s.cursorPress)}>
                            <Pointer />
                            <b>{human(w.who).name}</b>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {local >= tl.answerAt && (
            <div className={s.txt}>
              <Typed rich={r.answer} chars={chars} />
              {typing && <span className={s.caret} />}
            </div>
          )}
          {local >= tl.receiptAt && <div className={s.rcpt}><Receipt text={r.receipt} /></div>}
          {local >= tl.receiptAt + 150 && (
            <div className={s.fb}>
              <I>
                <ThumbsUp />
              </I>
              <I>
                <ThumbsDown />
              </I>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The thread's receipt, printed: it feeds out under the window when the last answer lands,
// rests for a moment with a DONE stamp, then tucks back in before the next thread.
function PrintedSlip({ th, chan, tucked }: { th: Thread; chan: string; tucked: boolean }) {
  const total = th.replies.reduce((n, r) => n + receiptCost(r.receipt), 0);
  return (
    <div className={cn(s.slipFeed, tucked && s.slipTucked)} aria-hidden="true">
      <Slip className={s.slip}>
        <SlipRow left={<b>acme · #{chan}</b>} right={th.time} />
        <div className={s.slipMore}>
          <SlipRow dim left={`@${th.agent} ${th.ask}`} />
        </div>
        <SlipRule />
        {th.replies.map((r, i) => (
          <div key={i}>
            <SlipRow left={`@${r.agent} · ${receiptModel(r.receipt)}`} right={money(receiptCost(r.receipt))} />
            <div className={s.slipMore}>
              <SlipRow dim left={`${r.receipt.match(/via ([a-z]+)/)?.[1] ?? ""} · ${receiptCalls(r.receipt) ?? ""}`} />
            </div>
          </div>
        ))}
        <SlipRule />
        <SlipRow strong left="TOTAL" right={money(total)} />
        <div className={s.slipFoot}>
          <span>
            0 keys shared
            <br />
            self-hosted
          </span>
          <Stamp on tone="moss" className={s.slipStamp}>
            Done
          </Stamp>
        </div>
      </Slip>
    </div>
  );
}

// Everything finished on this page so far, ticking up as teammates finish.
function Tally() {
  const jobs = useVisitJobs();
  return (
    <p className={s.tally}>
      <i aria-hidden="true" />
      today ·{" "}
      <b key={jobs.length} className={s.tick}>
        {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
      </b>{" "}
      · <b key={`c${jobs.length}`} className={s.tick}>{money(totalCost(jobs))}</b>
    </p>
  );
}

function Composer({ placeholder, also }: { placeholder: string; also?: string }) {
  return (
    <div className={s.comp}>
      <div className={s.field}>
        <span className={s.ph}>{placeholder}</span>
      </div>
      {also && (
        <div className={s.also}>
          <i />
          <span>
            Also send to <b># {also}</b>
          </span>
        </div>
      )}
      <div className={s.cbar}>
        <span className={s.cplus}>
          <I>
            <Plus />
          </I>
        </span>
        <span className={s.cb}>
          <span className={s.aa}>Aa</span>
        </span>
        <span className={s.cb}>
          <I>
            <Smile />
          </I>
        </span>
        <span className={s.cb}>
          <I>
            <AtSign />
          </I>
        </span>
        <em />
        <span className={s.cb}>
          <I>
            <Video />
          </I>
        </span>
        <span className={s.cb}>
          <I>
            <Mic />
          </I>
        </span>
        <em />
        <span className={s.cb}>
          <I>
            <SquareSlash />
          </I>
        </span>
        <span className={s.send}>
          <span>
            <I>
              <SendHorizontal />
            </I>
          </span>
          <em />
          <span>
            <I>
              <ChevronDown />
            </I>
          </span>
        </span>
      </div>
    </div>
  );
}

type Play = { now: number; c0: number; t0: number; chan: number; active: number | null; auto: boolean; openedAt: number };
type Act =
  | { type: "tick"; now: number; narrow: boolean }
  | { type: "pick"; i: number; now: number }
  | { type: "channel"; i: number; now: number }
  | { type: "close"; now: number }
  | { type: "auto"; on: boolean };

const timelines = channels.map((c) => c.threads.map(threadTimeline));
const introEnd = (chan: number) => 400 + channels[chan].threads.length * T.introMsg + 500;

function open(p: Play, i: number | null, now: number): Play {
  return { ...p, active: i, t0: now, openedAt: p.active === null && i !== null ? now : p.openedAt };
}

// Auto-cycle lives in the reducer: open each thread in turn, then move to the next channel.
function play(p: Play, a: Act): Play {
  switch (a.type) {
    case "tick": {
      const q = { ...p, now: a.now };
      if (!q.auto) return q;
      // With only the thread pane on screen there is no channel intro to watch.
      if (q.active === null) return a.narrow || a.now - q.c0 > introEnd(q.chan) ? open(q, 0, a.now) : q;
      if (a.now - q.t0 <= timelines[q.chan][q.active].end) return q;
      if (q.active + 1 < channels[q.chan].threads.length) return open(q, q.active + 1, a.now);
      return { ...q, chan: (q.chan + 1) % channels.length, c0: a.now, active: null };
    }
    case "pick":
      return a.i === p.active ? { ...p, auto: false } : open({ ...p, auto: false, now: a.now }, a.i, a.now);
    case "channel":
      return a.i === p.chan ? p : { ...p, chan: a.i, c0: a.now, now: a.now, active: null, auto: true };
    case "close":
      return { ...p, active: null, auto: false, now: a.now };
    case "auto":
      return { ...p, auto: a.on };
  }
}

export function SlackHero() {
  const scene = useRef<HTMLDivElement>(null);
  const tlist = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(0.88);
  const [narrow, setNarrow] = useState(false);
  const rm = useReducedMotion();
  const [p, dispatch] = useReducer(play, { now: 0, c0: 0, t0: 0, chan: 0, active: null, auto: true, openedAt: -1e9 });
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const narrowRef = useRef(false);

  // Scale: the window is drawn on a 1037-wide grid (420 when only the thread pane fits).
  useLayoutEffect(() => {
    const el = scene.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      const n = w < 640;
      narrowRef.current = n;
      setNarrow(n);
      setK(w / (n ? 420 : 1037));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One clock drives the whole playback; it only ticks while the window is on screen.
  useEffect(() => {
    if (rm) return;
    let seen = false;
    const io = new IntersectionObserver(([e]) => (seen = e.isIntersecting));
    if (scene.current) io.observe(scene.current);
    const id = setInterval(() => {
      if (seen && !document.hidden) dispatch({ type: "tick", now: clock(), narrow: narrowRef.current });
    }, 50);
    return () => {
      clearInterval(id);
      io.disconnect();
    };
  }, [rm]);

  // Keep the newest line of the thread in view, like Slack does.
  useEffect(() => {
    const el = tlist.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const { now, chan } = p;
  // Reduced motion: show the first thread, finished, and let clicks pick others.
  const active = rm && p.active === null ? 0 : p.active;
  const ch = channels[chan];
  const tls = timelines[chan];
  const chanEl = rm ? NEVER : now - p.c0;
  const el = rm ? NEVER : now - p.t0;
  const opening = !rm && now - p.openedAt < 450;

  const pause = () => {
    if (idle.current) clearTimeout(idle.current);
    dispatch({ type: "auto", on: false });
  };
  const resumeLater = () => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => dispatch({ type: "auto", on: true }), 4000);
  };
  const pick = (i: number) => {
    if (idle.current) clearTimeout(idle.current);
    dispatch({ type: "pick", i, now: clock() });
  };
  const switchChannel = (i: number) => dispatch({ type: "channel", i, now: clock() });

  const th: Thread | null = active === null ? null : ch.threads[active];
  const tl = active === null ? null : tls[active];

  // Who is busy right now, for the perched characters and the sidebar.
  const runningReply = th && tl ? tl.replies.findIndex((r) => el >= r.start && el < r.start + r.end) : -1;
  const lastReply = th && tl ? tl.replies.length - 1 : -1;
  const finished = !!(th && tl && el >= tl.replies[lastReply].start + tl.replies[lastReply].end);
  const busyAgent = th && runningReply >= 0 ? th.replies[runningReply].agent : null;
  // The reviewer sits on the right edge, so the left perch keeps the thread's main teammate.
  const leadAgent = busyAgent && busyAgent !== "warden" ? busyAgent : th ? th.agent : ch.threads[0].agent;
  const leadMood: AvatarMotion = busyAgent && busyAgent !== "warden" ? "thinking" : finished || busyAgent === "warden" ? "happy" : "idle";
  const finishAt = th && tl ? tl.replies[lastReply].start + tl.replies[lastReply].end : NEVER;
  const tucked = !rm && el >= finishAt + 2900;
  const wardenReply = th?.replies.findIndex((r) => r.agent === "warden") ?? -1;
  const wardenMood: AvatarMotion =
    th && tl && wardenReply >= 0 && el >= tl.replies[wardenReply].start ? (runningReply === wardenReply ? "thinking" : "happy") : "idle";

  // Floating cards: the first three results of the open thread, lit as their step completes.
  const cards = useMemo(() => {
    if (!th || !tl) return [];
    const out: { svc: string; result: string; at: number; start: number; n: number }[] = [];
    th.replies.forEach((r, ri) =>
      r.steps.forEach((st, si) => {
        if (out.length < 3)
          out.push({ svc: st.svc, result: st.result, at: tl.replies[ri].start + tl.replies[ri].steps[si].done, start: tl.replies[ri].start + tl.replies[ri].steps[si].start, n: out.length + 1 });
      }),
    );
    return out;
  }, [th, tl]);
  // Side tiles: only the tools the open thread uses, in order of first use. Each one glows while
  // a step on it runs and stays lit once that step is done. With no thread open, the channel's tools sit dim.
  const tiles = useMemo(() => {
    if (!th || !tl) return ch.tools.map((svc) => ({ svc, spans: [] as { start: number; done: number }[] }));
    const by = new Map<string, { start: number; done: number }[]>();
    th.replies.forEach((r, ri) =>
      r.steps.forEach((st, si) => {
        const span = { start: tl.replies[ri].start + tl.replies[ri].steps[si].start, done: tl.replies[ri].start + tl.replies[ri].steps[si].done };
        by.set(st.svc, [...(by.get(st.svc) ?? []), span]);
      }),
    );
    return [...by].slice(0, 4).map(([svc, spans]) => ({ svc, spans }));
  }, [th, tl, ch.tools]);
  // Each thread that finishes counts once toward the visitor's receipt.
  useEffect(() => {
    if (!finished || !th) return;
    reportJob({
      id: `hero-${ch.id}-${active}`,
      agent: th.agent,
      what: th.ask,
      cost: th.replies.reduce((n, r) => n + receiptCost(r.receipt), 0),
      model: receiptModel(th.replies[0].receipt),
    });
  }, [finished, th, ch.id, active]);

  const approving = !!(th && tl && th.replies.some((r, ri) => r.steps.some((st, si) => st.write && el >= tl.replies[ri].start + tl.replies[ri].steps[si].start && el < tl.replies[ri].start + tl.replies[ri].steps[si].done)));

  const appAgents = Array.from(new Set(ch.threads.flatMap((t) => t.replies.map((r) => r.agent))));
  const shownAsks = ch.threads.filter((_, i) => chanEl >= 400 + i * T.introMsg).length;

  return (
    <div ref={scene} className={cn(s.scene, narrow && s.narrow)} style={{ ["--k" as string]: `${k}px` }}>
      <span className={cn(s.perch, s.perchL)} key={`lead-${leadAgent}`}>
        <span className={cn(s.perchSwap, finished && s.cheer)} style={{ display: "block" }}>
          <Critter id={avatarOf(leadAgent)} size={narrow ? 72 : 104} mood={finished ? "happy" : leadMood} reach={260} />
        </span>
        <span className={s.perchTile}>
          <img src={svc("slack")} alt="" />
        </span>
      </span>
      <span className={cn(s.perch, s.perchR)}>
        <span className={cn(s.perchIn, finished && s.cheer)} style={{ animationDelay: "90ms" }}>
          <Critter id="shield" size={92} mood={finished ? "happy" : wardenMood} reach={260} />
        </span>
      </span>
      <span className={cn(s.perch, s.perchB)}>
        <span className={cn(s.perchIn, finished && s.cheer)} style={{ animationDelay: "180ms" }}>
          <Critter id="lightbulb" size={100} mood={approving ? "thinking" : finished ? "happy" : "idle"} reach={260} />
        </span>
      </span>

      {tiles.map((tile, i) => {
        const live = tile.spans.some((sp) => el >= sp.start && el < sp.done);
        const used = tile.spans.some((sp) => el >= sp.done);
        const shown = th ? el >= tile.spans[0].start - 400 : chanEl >= 200 + i * 260;
        return (
          <div
            key={`${ch.id}-${active}-${tile.svc}`}
            aria-hidden="true"
            className={cn(s.tile, shown && s.tileOn, !th && s.tileDim, live && s.tileLive, used && !live && s.tileUsed)}
            style={{ top: `${14 + i * 19}%` }}
          >
            <div>
              <img src={svc(tile.svc)} alt="" />
            </div>
          </div>
        );
      })}
      {[0, 1, 2].map((i) => {
        const c = cards[i];
        return (
          <div key={`${active}-${i}`} aria-hidden="true" className={cn(s.card, c && el >= c.at && s.cardOn)} style={{ top: `${18 + i * 16}%` }}>
            {c && (
              <div>
                <span className={s.cardNum}>{c.n}</span>
                <span className={s.cardIc}>
                  <img src={svc(c.svc)} alt="" />
                </span>
                <span className={s.cardT}>
                  <b>{c.result}</b>
                  <span>{svcName[c.svc] ?? c.svc}</span>
                </span>
              </div>
            )}
          </div>
        );
      })}

      <div className={s.box}>
        <div className={s.win} role="group" aria-label="Peeblo teammates working in a Slack workspace" onMouseLeave={resumeLater}>
          <div className={s.lights}>
            <i />
            <i />
            <i />
          </div>
          <span className={cn(s.tb, s.tbSide)}>
            <I>
              <PanelLeft />
            </I>
          </span>
          <span className={cn(s.tb, s.tbBack)}>
            <I>
              <ArrowLeft />
            </I>
          </span>
          <span className={cn(s.tb, s.tbFwd)}>
            <I>
              <ArrowRight />
            </I>
          </span>
          <span className={cn(s.tb, s.tbHist)}>
            <I>
              <Clock />
            </I>
          </span>
          <div className={s.search}>
            <I>
              <Search />
            </I>
            <span>Search acme</span>
          </div>
          <span className={cn(s.tb, s.tbHelp)}>
            <I>
              <CircleHelp />
            </I>
          </span>

          <div className={s.rail}>
            <div className={s.ws}>
              <Critter id="peeblo" size={Math.round(30 * k)} bob={false} reach={120} />
            </div>
            {[
              { label: "Home", icon: <House />, top: 110 },
              { label: "DMs", icon: <MessagesSquare />, top: 178 },
              { label: "Activity", icon: <Bell />, top: 246 },
              { label: "More", icon: <Ellipsis />, top: 314 },
            ].map((r, i) => (
              <div key={r.label} className={cn(s.ri, i === 0 && s.riOn)} style={{ top: `calc(${r.top} * var(--k))` }}>
                <b>
                  <I>{r.icon}</I>
                </b>
                {r.label}
              </div>
            ))}
            <div className={s.plus}>
              <I>
                <Plus />
              </I>
            </div>
            <div className={s.me}>
              <img src={human("priya").photo} alt="" />
              <i />
            </div>
          </div>

          <div className={s.side}>
            <div className={s.wsName}>
              acme
              <I>
                <ChevronDown />
              </I>
            </div>
            <div className={s.sideH}>
              <I>
                <ChevronDown />
              </I>
              Channels
            </div>
            <div role="tablist" aria-label="Channels">
              {channels.map((c, i) => (
                <button key={c.id} type="button" role="tab" aria-selected={i === chan} className={s.chanBtn} onClick={() => switchChannel(i)}>
                  <span>#</span>
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
            <div className={s.sideH}>
              <I>
                <ChevronDown />
              </I>
              Apps
            </div>
            {appAgents.map((a) => (
              <div key={a} className={cn(s.app, busyAgent === a && s.appBusy)}>
                <span className={s.appFace}>
                  <Avatar id={avatarOf(a)} size={Math.round(18 * k)} still />
                  <i />
                </span>
                {a}
              </div>
            ))}
          </div>

          <div className={s.main}>
            <div className={s.chan}>
              <div className={s.hdr}>
                <h3>
                  # {ch.name}
                  <I>
                    <ChevronDown />
                  </I>
                </h3>
                <span className={s.sp} />
                <div className={s.faces}>
                  <span>
                    {allPhotos.slice(chan * 2, chan * 2 + 3).map((p) => (
                      <img key={p} src={p} alt="" />
                    ))}
                  </span>
                  {ch.members}
                </div>
                <div className={s.huddle}>
                  <I>
                    <Headphones />
                  </I>
                  <em />
                  <I>
                    <ChevronDown />
                  </I>
                </div>
                <I className={s.kebab}>
                  <EllipsisVertical />
                </I>
              </div>
              <div className={s.list}>
                <div className={s.listIn} key={ch.id}>
                  {ch.filler.map((f, i) => (
                    <div key={i} className={s.m}>
                      <img className={s.av} src={human(f.who).photo} alt="" />
                      <div className={s.mc}>
                        <div className={s.mh}>
                          <span className={s.name}>{human(f.who).name}</span>
                          <span className={s.time}>{f.time}</span>
                        </div>
                        <div className={s.txt}>{f.text}</div>
                      </div>
                    </div>
                  ))}
                  {ch.threads.slice(0, shownAsks).map((t, i) => (
                    <div
                      key={i}
                      className={cn(s.m, s.mHot, s.in, active === i && s.mOpen)}
                      onMouseEnter={() => pick(i)}
                      onClick={() => pick(i)}
                      onFocus={() => pick(i)}
                      tabIndex={0}
                      role="button"
                      aria-label={`Open the thread: ${human(t.who).name} asks @${t.agent} ${t.ask}`}
                    >
                      <img className={s.av} src={human(t.who).photo} alt="" />
                      <div className={s.mc}>
                        <div className={s.mh}>
                          <span className={s.name}>{human(t.who).name}</span>
                          <span className={s.time}>{t.time}</span>
                        </div>
                        <div className={s.txt}>
                          <AskText agent={t.agent} ask={t.ask} />
                        </div>
                        {chanEl >= 400 + i * T.introMsg + 260 && (
                          <div className={cn(s.thr, s.in)}>
                            <span className={s.thrFaces}>
                              {Array.from(new Set(t.replies.map((r) => r.agent))).map((a) => (
                                <span key={a} className={s.thrFace}>
                                  <Avatar id={avatarOf(a)} size={Math.round(22 * k)} still />
                                </span>
                              ))}
                            </span>
                            <b>
                              {t.replies.length} {t.replies.length === 1 ? "reply" : "replies"}
                            </b>
                            <span>Last reply today at {t.time}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <Composer placeholder={`Message #${ch.name}`} />
            </div>

            {(th || narrow) && (
              <div className={cn(s.tpane, opening && !narrow && s.opening)}>
                <div className={s.tpaneIn}>
                  <div className={s.thdr}>
                    <div>
                      <h3>Thread</h3>
                      <small># {ch.name}</small>
                    </div>
                    <I className={s.thdrPop}>
                      <EllipsisVertical />
                    </I>
                    <button
                      type="button"
                      className={s.thdrX}
                      aria-label="Close thread"
                      onClick={() => {
                        pause();
                        dispatch({ type: "close", now: clock() });
                        resumeLater();
                      }}
                    >
                      <X />
                    </button>
                  </div>
                  {th && tl ? (
                    <div className={s.tlist} ref={tlist}>
                      <div className={s.listIn} key={`${chan}-${active}`}>
                        <div className={cn(s.m, s.in)}>
                          <img className={s.av} src={human(th.who).photo} alt="" />
                          <div className={s.mc}>
                            <div className={s.mh}>
                              <span className={s.name}>{human(th.who).name}</span>
                              <span className={s.time}>{th.time}</span>
                            </div>
                            <div className={s.txt}>
                              <AskText agent={th.agent} ask={th.ask} />
                            </div>
                          </div>
                        </div>
                        {el >= T.head - 150 && (
                          <div className={cn(s.sep, s.in)}>
                            {th.replies.length} {th.replies.length === 1 ? "reply" : "replies"}
                          </div>
                        )}
                        {th.replies.map((r, ri) => (
                          <ReplyMsg
                            key={ri}
                            r={r}
                            tl={tl.replies[ri]}
                            el={el}
                            k={k}
                            time={th.time}
                            num0={th.replies.slice(0, ri).reduce((n, x) => n + x.steps.length, 0)}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className={s.empty}>Pick a message to open its thread</div>
                  )}
                  <Composer placeholder="Reply…" also={ch.name} />
                </div>
              </div>
            )}
          </div>
        </div>
        {th && finished && <PrintedSlip key={`${ch.id}-${active}`} th={th} chan={ch.name} tucked={tucked} />}
      </div>
      <Tally />
    </div>
  );
}
