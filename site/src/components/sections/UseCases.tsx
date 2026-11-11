"use client";
/* eslint-disable @next/next/no-img-element -- small local logos and portraits inside mocks */

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  ChartColumn,
  CodeXml,
  EllipsisVertical,
  Mic,
  Paintbrush,
  PenLine,
  Plus,
  Search,
  SendHorizontal,
  Smile,
  Sprout,
  SquareSlash,
  Video,
  X,
} from "lucide-react";
import type { AvatarMotion } from "open-bot-avatar";
import { Critter } from "@/components/peeblo/critter";
import { findModel, receiptCost, receiptModel } from "@/components/peeblo/sig-slip";
import { reportJob } from "@/components/peeblo/signature";
import { agentByName, people } from "@/content/crew";
import { onFrame, reducedMotion, spring } from "@/lib/pointer";
import { useCycle } from "./motion";
import { avatarOf, human, svc, svcName } from "./shared";
import { useCases, type UseCase } from "./useCasesData";
import s from "./UseCases.module.css";
import { Receipt } from "@/components/peeblo/receipt";

const DUR = 10000;
const durs = useCases.map(() => DUR);
const icons = { search: Search, pen: PenLine, code: CodeXml, chart: ChartColumn, sprout: Sprout, brush: Paintbrush };

// Typing, sending and the teammate's answer, as times (ms) after the tab opens.
const TYPE_AT = 1100;
const PER_CHAR = 38;

// The teammate's hiring badge, hung on a lanyard. It swings in when the tab changes and sways
// with the cursor going past; the photo is the live character.
function Badge({ u, mood }: { u: UseCase; mood: AvatarMotion }) {
  const card = useRef<HTMLDivElement>(null);
  const a = agentByName(u.agent);
  const owner = people[a.owner];
  const model = findModel(a.model);

  useEffect(() => {
    if (reducedMotion()) return;
    const ang = { x: 9, v: 0 };
    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    if (card.current) io.observe(card.current);
    const stop = onFrame((_now, dt, ptr) => {
      const el = card.current;
      if (!el || !visible) return;
      const r = el.getBoundingClientRect();
      const dx = ptr.x - (r.left + r.width / 2);
      const dy = ptr.y - (r.top + r.height / 2);
      const near = ptr.seen && ptr.fine ? Math.max(0, 1 - Math.hypot(dx, dy) / 420) : 0;
      ang.v -= ptr.vx * near * 1.6;
      const moving = spring(ang, Math.max(-5, Math.min(5, dx / 70)) * near, dt, 55, 3.2);
      if (moving) el.style.rotate = `${ang.x.toFixed(2)}deg`;
    });
    return () => {
      stop();
      io.disconnect();
    };
  }, []);

  return (
    <div className={s.hang} aria-hidden="true">
      <div ref={card} className={s.swing}>
        <span className={s.strap} />
        <span className={s.clip} />
        <div className={s.idCard} style={{ ["--tint" as string]: owner.tint }}>
          <div className={s.idTop}>
            <span className={s.hole} />
            <span className={s.org}>
              <Critter id="peeblo" size={16} bob={false} still reach={0} />
              acme · peeblo
            </span>
            <span className={s.kind}>AI EMPLOYEE</span>
          </div>
          <div className={s.idBody}>
            <span className={s.photo}>
              <Critter id={a.avatar} size={64} mood={mood} reach={220} />
            </span>
            <span className={s.who}>
              <b className={s.handle}>@{a.name}</b>
              <span className={s.role}>{a.job}</span>
            </span>
          </div>
          <dl className={s.fields}>
            <div>
              <dt>ID</dt>
              <dd>PB-{String(100 + idNo(a.name)).padStart(4, "0")}</dd>
            </div>
            <div>
              <dt>Hired by</dt>
              <dd>{owner.name}</dd>
            </div>
            <div>
              <dt>Budget</dt>
              <dd>{u.budget}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd className={s.model}>
                {model && <img src={model.logo} alt="" width={11} height={11} />}
                {model?.name ?? a.model}
              </dd>
            </div>
          </dl>
          <div className={s.idFoot}>
            <span className={s.barcode} />
            <span className={s.holo} />
          </div>
        </div>
      </div>
    </div>
  );
}

// A stable badge number per teammate.
const idNo = (name: string) => [...name].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 900, 7);

export function UseCases() {
  const [paused, setPaused] = useState(false);
  const root = useRef<HTMLElement>(null);
  const { i: tab, t: el, round, rm, go: choose } = useCycle(durs, root, paused);

  const u = useCases[tab];
  const full = `@${u.agent} ${u.ask}`;
  const typed = Math.max(0, Math.min(full.length, Math.floor((el - TYPE_AT) / PER_CHAR)));
  const sentAt = TYPE_AT + full.length * PER_CHAR + 450;
  const sent = el >= sentAt;
  const replyAt = sentAt + 600;
  const answerAt = replyAt + 1300;
  const shownAnswer = u.answer.slice(0, Math.max(0, Math.floor((el - answerAt) / 14)));
  const answered = el >= answerAt + u.answer.length * 14;

  useEffect(() => {
    if (answered) reportJob({ id: `uses-${u.agent}`, agent: u.agent, what: u.ask, cost: receiptCost(u.receipt), model: receiptModel(u.receipt) });
  }, [answered, u]);

  return (
    <section ref={root} className={s.section} aria-labelledby="ot-uses-title">
      <div className={s.inner}>
        <h2 id="ot-uses-title" className={s.h2}>
          What teams hand off.
        </h2>
        <div className={s.tabs} role="tablist" aria-label="Jobs" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          {useCases.map((c, i) => {
            const TabIcon = icons[c.icon];
            return (
              <button key={c.tab} type="button" role="tab" aria-selected={i === tab} className={s.tab} onClick={() => choose(i)}>
                <TabIcon aria-hidden="true" />
                {c.tab}
                {i === tab && !rm && !paused && <span className={s.fill} style={{ ["--dur" as string]: `${DUR}ms` }} key={round} />}
              </button>
            );
          })}
        </div>

        <div className={s.grid} role="tabpanel" aria-label={u.title}>
          <div className={s.copy} key={`c-${tab}`}>
            <Badge u={u} mood={sent && !answered ? "thinking" : answered ? "happy" : "idle"} />
            <h3>{u.title}</h3>
            <p>{u.body}</p>
            <ul className={s.chips}>
              {u.tools.map((id) => (
                <li key={id}>
                  <img src={svc(id)} alt="" />
                  {svcName[id] ?? id}
                </li>
              ))}
            </ul>
          </div>

          <div className={s.winWrap}>
            <div className={s.win} key={`w-${tab}`} aria-hidden="true">
              <div className={s.bar}>
                <i />
                <i />
                <i />
                <ArrowLeft />
                <ArrowRight />
                <div className={s.search}>
                  <Search />
                  Search acme
                </div>
              </div>
              <div className={s.panel}>
                <div className={s.thdr}>
                  <div>
                    <b>Thread</b>
                    <small># {u.channel}</small>
                  </div>
                  <EllipsisVertical />
                  <X />
                </div>
                <div className={s.list}>
                  {u.thread.map((m, i) => (
                    <div key={i} style={{ display: "contents" }}>
                      <div className={s.m} style={{ animationDelay: `${i * 120}ms` }}>
                        <img className={s.av} src={human(m.who).photo} alt="" />
                        <div className={s.mc}>
                          <div className={s.mh}>
                            <b>{human(m.who).name}</b>
                            <span>{m.time}</span>
                          </div>
                          <div className={s.txt}>{m.text}</div>
                        </div>
                      </div>
                      {i === 0 && <div className={s.sep}>{u.thread.length - 1 + (sent ? 1 : 0) + (el >= replyAt ? 1 : 0)} replies</div>}
                    </div>
                  ))}
                  {sent && (
                    <div className={s.m}>
                      <img className={s.av} src={human(u.asker).photo} alt="" />
                      <div className={s.mc}>
                        <div className={s.mh}>
                          <b>{human(u.asker).name}</b>
                          <span>now</span>
                        </div>
                        <div className={s.txt}>
                          <span className={s.men}>@{u.agent}</span> {u.ask}
                        </div>
                      </div>
                    </div>
                  )}
                  {el >= replyAt && (
                    <div className={s.m}>
                      <span className={s.agentAv}>
                        <Critter id={avatarOf(u.agent)} size={30} bob={false} reach={140} />
                      </span>
                      <div className={s.mc}>
                        <div className={s.mh}>
                          <b>{u.agent}</b>
                          <span className={s.badge}>APP</span>
                          <span>now</span>
                        </div>
                        {el < answerAt ? <div className={s.work}>Working on it…</div> : <div className={s.txt}>{shownAnswer}</div>}
                        {answered && (
                          <div className={s.rcpt}>
                            <div className="pb-print">
                              <Receipt text={u.receipt} />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className={s.comp}>
                  <div className={s.field}>
                    {sent || typed === 0 ? (
                      <span className={s.ph}>Reply…</span>
                    ) : (
                      <>
                        <span className={s.men}>{full.slice(0, Math.min(typed, u.agent.length + 1))}</span>
                        {full.slice(u.agent.length + 1, typed)}
                        <span className={s.caret} />
                      </>
                    )}
                  </div>
                  <div className={s.also}>
                    <i />
                    <span>
                      Also send to <b># {u.channel}</b>
                    </span>
                  </div>
                  <div className={s.cbar}>
                    <span className={s.cplus}>
                      <Plus />
                    </span>
                    <span className={s.aa}>Aa</span>
                    <Smile />
                    <AtSign />
                    <em />
                    <Video />
                    <Mic />
                    <em />
                    <SquareSlash />
                    <span className={`${s.send} ${typed > 0 && !sent ? s.ready : ""}`}>
                      <SendHorizontal />
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
