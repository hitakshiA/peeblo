"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  AtSign,
  Bold,
  ChevronDown,
  ChevronLeft,
  Clock,
  Code,
  Hash,
  Headphones,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Lock,
  MessageCircle,
  Mic,
  Plus,
  Receipt,
  SendHorizontal,
  ShieldCheck,
  Smile,
  SquarePen,
  Strikethrough,
  Table,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/peeblo/avatar";
import { Critter } from "@/components/peeblo/critter";
import { extraPhotos, people } from "@/content/crew";
import s from "./shared.module.css";
import c from "./SlackDeep.module.css";
import { Receipt as ReceiptSlip } from "@/components/peeblo/receipt";
import { reportJob, Stamp } from "@/components/peeblo/signature";
import { Hands } from "@/components/peeblo/sig2-kit";
import { reducedMotion } from "@/lib/pointer";
import type { AvatarMotion } from "open-bot-avatar";

// "Built deep into Slack.": a behavior list kept in step with a #finance window that plays them.
type Mark = "react" | "status" | "stream" | "table" | "tasks" | "approve" | "receipt";

const items: { mark: Mark; icon: LucideIcon; title: string; body: React.ReactNode }[] = [
  { mark: "react", icon: Smile, title: "It reacts.", body: "👀 when it picks up your message, ✅ when the job is done." },
  { mark: "status", icon: Clock, title: "It shows its work.", body: "The status line under the composer says what it is doing, one step at a time." },
  { mark: "stream", icon: AlignLeft, title: "It streams.", body: "Long answers appear while they are written, so you can read along." },
  { mark: "table", icon: Table, title: "It uses real tables.", body: "When the answer is data, it comes back as a Slack table you can sort." },
  { mark: "tasks", icon: ListChecks, title: "It keeps a task list.", body: "A job with several steps shows a checklist that fills in while you watch." },
  { mark: "approve", icon: ShieldCheck, title: "It asks before it acts.", body: "Any send, post, merge or delete waits for a person to press Approve." },
  {
    mark: "receipt",
    icon: Receipt,
    title: "It signs every reply.",
    body: "A receipt ends each answer: the model, the provider, the attempts, any fallback and the cost.",
  },
];

const QUESTION = "@ledger which charges don't match an invoice?";
const REPLY = "Three charges don't match, $1,240 in total.";
const ROWS = [
  ["Bluefin Labs", "$430.00", "Taken twice"],
  ["Bluefin Labs", "$430.00", "Taken twice"],
  ["Orchard Health", "$380.00", "No invoice"],
];
const TASKS = ["Pull October charges from Stripe", "Match them to QuickBooks invoices", "Refund the second Bluefin capture"];
const RECEIPT = "receipt · deepseek-v4.1-flash · via deepinfra · 3 calls · no fallback · $0.0031";

type Ask = "none" | "asking" | "approved";
type View = {
  typed: string;
  asked: boolean;
  eyes: boolean;
  status: string | null;
  reply: number;
  rows: number;
  tasks: number;
  done: number;
  ask: Ask;
  receipt: boolean;
  check: boolean;
  mark: Mark | null;
};
const EMPTY: View = { typed: "", asked: false, eyes: false, status: null, reply: 0, rows: 0, tasks: 0, done: 0, ask: "none", receipt: false, check: false, mark: null };

// The script: each event waits `wait` ms after the one before, then patches the view.
type Ev = { wait: number; mark?: Mark; patch: Partial<View> };
function script(): Ev[] {
  const ev: Ev[] = [{ wait: 0, patch: EMPTY }];
  for (let i = 4; i <= QUESTION.length + 3; i += 4) ev.push({ wait: i === 4 ? 400 : 60, patch: { typed: QUESTION.slice(0, i) } });
  ev.push({ wait: 600, patch: { typed: "", asked: true } });
  ev.push({ wait: 1000, mark: "react", patch: { eyes: true } });
  ev.push({ wait: 1500, mark: "status", patch: { status: "ledger is checking Stripe" } });
  ev.push({ wait: 1700, patch: { status: "ledger is matching invoices in QuickBooks" } });
  for (let i = 10; i < REPLY.length + 10; i += 10) ev.push({ wait: i === 10 ? 1700 : 150, mark: i === 10 ? "stream" : undefined, patch: { status: null, reply: i } });
  ROWS.forEach((_, i) => ev.push({ wait: i === 0 ? 1700 : 260, mark: i === 0 ? "table" : undefined, patch: { rows: i + 1 } }));
  ev.push({ wait: 2000, mark: "tasks", patch: { tasks: TASKS.length } });
  ev.push({ wait: 900, patch: { done: 1 } });
  ev.push({ wait: 900, patch: { done: 2 } });
  ev.push({ wait: 1200, mark: "approve", patch: { ask: "asking" } });
  ev.push({ wait: 2200, patch: { ask: "approved" } });
  ev.push({ wait: 800, patch: { done: 3 } });
  ev.push({ wait: 1400, mark: "receipt", patch: { receipt: true } });
  ev.push({ wait: 1700, mark: "react", patch: { check: true } });
  ev.push({ wait: 4700, patch: { mark: null } });
  return ev.map((e) => (e.mark ? { ...e, patch: { ...e.patch, mark: e.mark } } : e));
}
const EVENTS = script();
const fold = (upto: number) => EVENTS.slice(0, upto + 1).reduce<View>((v, e) => ({ ...v, ...e.patch }), EMPTY);

const priya = people.priya;

// Peeblo sits on the window's corner and acts out whatever the thread is doing right now.
const acts: Record<Mark, { mood: AvatarMotion; say?: string }> = {
  react: { mood: "happy" },
  status: { mood: "thinking", say: "hmm…" },
  stream: { mood: "idle" },
  table: { mood: "idle" },
  tasks: { mood: "happy" },
  approve: { mood: "idle", say: "your call, Priya" },
  receipt: { mood: "happy" },
};

function Mascot({ mark, done }: { mark: Mark | null; done: number }) {
  const act = mark ? acts[mark] : null;
  return (
    <div className={c.mascot} data-act={mark ?? "idle"} aria-hidden="true">
      {act?.say && (
        <span key={mark} className={c.say}>
          {act.say}
        </span>
      )}
      {mark === "stream" && (
        <span className={`${c.say} ${c.sayDots}`}>
          <i />
          <i />
          <i />
        </span>
      )}
      {mark === "tasks" && (
        <span className={c.ticks}>
          {Array.from({ length: done }, (_, i) => (
            <i key={i}>✓</i>
          ))}
        </span>
      )}
      <span className={c.mascotBody}>
        <Critter id="peeblo" size={60} mood={act?.mood ?? "idle"} reach={220} />
      </span>
      {mark === "receipt" && (
        <span className={c.held}>
          <span className={`${c.heldSlip} pb-torn`}>
            <i />
            <i />
            <i />
            <i />
          </span>
          <Hands gap={14} size={10} className={c.heldHands} />
        </span>
      )}
    </div>
  );
}

// "It signs every reply.": the receipt line prints out on a strip of thermal paper and gets stamped.
function Signed() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(
      () => {
        setOn(true);
        reportJob({ id: "slack-ledger-charges", agent: "ledger", what: "matched October charges to invoices", cost: 0.0031, model: "deepseek-v4.1-flash" });
      },
      reducedMotion() ? 0 : 1150,
    );
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className={c.ctx}>
      <div className={`${c.paper} pb-torn pb-print`}>
        <Avatar id="book" size={14} still className={c.ctxAv} />
        <ReceiptSlip text={RECEIPT} />
      </div>
      <Stamp on={on} tone="moss" className={c.signStamp}>
        signed
      </Stamp>
    </div>
  );
}

export function SlackDeep() {
  // The view is the script folded up to `step`; playback just advances `step` on a timer.
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [still, setStill] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // Reduced motion: show the finished thread, no playback.
      const t = window.setTimeout(() => {
        setStill(true);
        setStep(EVENTS.length - 2);
      }, 0);
      return () => window.clearTimeout(t);
    }
    const io = new IntersectionObserver(([e]) => setPlaying(e.isIntersecting), { threshold: 0.35 });
    if (wrap.current) io.observe(wrap.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || still) return;
    const next = (step + 1) % EVENTS.length;
    const t = window.setTimeout(() => setStep(next), EVENTS[next].wait);
    return () => window.clearTimeout(t);
  }, [step, playing, still]);

  // Clicking a behavior jumps the thread to the moment it first happens.
  const playFrom = (mark: Mark) => {
    const at = EVENTS.findIndex((e) => e.mark === mark);
    if (at >= 0) setStep(at);
  };

  const view = useMemo(() => fold(step), [step]);
  const v = view;
  return (
    <section className={s.story} id="slack" aria-labelledby="slack-h">
      <div className={s.shell}>
        <div className={s.headSplit}>
          <h2 id="slack-h">Built deep into Slack.</h2>
        </div>
        <div className={c.craft}>
          <div className={c.list}>
            {items.map((it) => {
              const Icon = it.icon;
              return (
                <button key={it.title} type="button" className={`${c.item} ${v.mark === it.mark ? c.on : ""}`} onClick={() => playFrom(it.mark)}>
                  <Icon strokeWidth={1.7} aria-hidden="true" />
                  <div>
                    <b>{it.title}</b>
                    <div className={c.more}>
                      <p>{it.body}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className={c.slackWrap} ref={wrap}>
            <Mascot mark={v.mark} done={v.done} />
            <div className={c.slack}>
              <div className={c.title} aria-hidden="true">
                <div className={c.lights}>
                  <span />
                  <span />
                  <span />
                </div>
                <span className={c.url}>acme.slack.com</span>
                <span />
              </div>
              <div className={c.body}>
                <aside className={c.side} aria-hidden="true">
                  <div className={c.ws}>
                    <b>
                      acme <ChevronDown size={14} strokeWidth={2.4} />
                    </b>
                    <span className={c.wsIc}>
                      <SquarePen size={16} />
                    </span>
                  </div>
                  <nav className={c.nav}>
                    <span className={c.it}>
                      <MessageCircle />
                      Threads
                    </span>
                    <span className={c.sec}>
                      <ChevronDown />
                      Channels
                    </span>
                    {["eng", "finance", "growth", "support"].map((ch) => (
                      <span key={ch} className={`${c.it} ${ch === "finance" ? c.itOn : ""}`}>
                        {ch === "finance" ? <Lock /> : <Hash />}
                        {ch}
                      </span>
                    ))}
                    <span className={c.sec}>
                      <ChevronDown />
                      Direct messages
                    </span>
                    {(["maya", "sam"] as const).map((p) => (
                      <span key={p} className={c.it}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className={c.ini} src={people[p].photo} alt="" width={20} height={20} />
                        <span className={c.presence} />
                        {people[p].name}
                      </span>
                    ))}
                    <span className={c.sec}>
                      <ChevronDown />
                      Apps
                    </span>
                    {[
                      ["book", "ledger"],
                      ["shield", "warden"],
                    ].map(([id, name]) => (
                      <span key={name} className={c.it}>
                        <Avatar id={id} size={20} still className={c.navAv} />
                        {name}
                      </span>
                    ))}
                  </nav>
                </aside>
                <div className={c.pane}>
                  <div className={c.head}>
                    <b>
                      <span className={c.back}>
                        <ChevronLeft />
                      </span>
                      🔒 finance
                    </b>
                    <div className={c.right}>
                      <span className={c.members}>
                        <span className={c.stack}>
                          {[priya.photo, people.theo.photo, extraPhotos[0]].map((src) => (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={src} src={src} alt="" width={20} height={20} />
                          ))}
                        </span>
                        7
                      </span>
                      <span className={c.hp}>
                        <Headphones />
                      </span>
                    </div>
                  </div>
                  <div className={c.msgs} aria-live="polite">
                    <div className={c.day}>Today</div>
                    {v.asked && (
                      <div className={c.msg}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className={c.ava} src={priya.photo} alt="" width={36} height={36} />
                        <div>
                          <div className={c.who}>
                            <b>Priya</b>
                            <time>4:29 PM</time>
                          </div>
                          <div className={c.txt}>
                            <span className={c.m}>@ledger</span> which charges don&apos;t match an invoice?
                          </div>
                          {v.eyes && (
                            <div className={c.reacts}>
                              <span className={c.react}>
                                👀 <span>1</span>
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {v.reply > 0 && (
                      <div className={c.msg}>
                        <Critter id="book" size={36} bob={false} reach={150} className={c.botAv} />
                        <div>
                          <div className={c.who}>
                            <b>ledger</b>
                            <span className={c.app}>APP</span>
                            <time>4:29 PM</time>
                          </div>
                          <div className={c.txt}>
                            {REPLY.slice(0, v.reply)}
                            {v.reply < REPLY.length && <span className={c.caret} />}
                          </div>
                          {v.rows > 0 && (
                            <div className={c.tbl}>
                              <table>
                                <thead>
                                  <tr>
                                    <th>Customer</th>
                                    <th className={c.num}>
                                      Amount<span className={c.srt} />
                                    </th>
                                    <th>Issue</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {ROWS.slice(0, v.rows).map((r, i) => (
                                    <tr key={i}>
                                      <td>{r[0]}</td>
                                      <td className={c.num}>{r[1]}</td>
                                      <td>{r[2]}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {v.tasks > 0 && (
                            <div className={c.tasks}>
                              {TASKS.map((t, i) => (
                                <div key={t} className={`${c.task} ${i < v.done ? c.done : ""}`}>
                                  <span className={c.box} />
                                  <span>{t}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {v.ask === "asking" && (
                            <div className={c.ask}>
                              <div className={c.askTxt}>
                                Refund <b>$430.00</b> to Bluefin Labs?
                              </div>
                              <div className={c.btns}>
                                <span className={`${c.btnSl} ${c.primary}`}>Approve</span>
                                <span className={c.btnSl}>Not now</span>
                              </div>
                            </div>
                          )}
                          {v.ask === "approved" && (
                            <div className={c.approved}>
                              <span className={c.okDot}>✓</span>
                              <span>
                                Refund of $430.00 approved by <b>Priya</b> · 4:31 PM
                              </span>
                            </div>
                          )}
                          {v.receipt && <Signed />}
                          {v.check && (
                            <div className={c.reacts}>
                              <span className={c.react}>
                                ✅ <span>1</span>
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className={c.comp}>
                    <div className={c.tools}>
                      <i>
                        <Bold />
                      </i>
                      <i>
                        <Italic />
                      </i>
                      <i>
                        <Strikethrough />
                      </i>
                      <span className={c.sp} />
                      <i>
                        <Link />
                      </i>
                      <span className={c.sp} />
                      <i>
                        <ListOrdered />
                      </i>
                      <i>
                        <List />
                      </i>
                      <span className={c.sp} />
                      <i>
                        <Code />
                      </i>
                    </div>
                    <div className={c.in}>
                      <span className={c.typed} data-ph="Message #finance">
                        {v.typed}
                      </span>
                    </div>
                    <div className={c.bot}>
                      <span className={c.l}>
                        <i>
                          <Plus />
                        </i>
                        <i className={c.aa}>Aa</i>
                        <i>
                          <Smile />
                        </i>
                        <i>
                          <AtSign />
                        </i>
                        <i>
                          <Video />
                        </i>
                        <i>
                          <Mic />
                        </i>
                      </span>
                      <span className={`${c.send} ${v.typed ? "" : c.idle}`}>
                        <SendHorizontal />
                      </span>
                    </div>
                  </div>
                  <div className={`${c.status} ${v.status ? c.statusOn : ""}`}>
                    <Avatar id="book" size={14} still className={c.ctxAv} />
                    <span>{v.status ?? ""}</span>
                    <span className={c.dots}>
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
