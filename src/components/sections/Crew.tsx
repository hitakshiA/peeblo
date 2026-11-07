"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Repeat, Zap } from "lucide-react";
import { Critter } from "@/components/peeblo/critter";
import { crew, agentByName, people } from "@/content/crew";
import { integrationById } from "@/content/integrations";
import { reducedMotion } from "@/lib/pointer";
import { live, type Live } from "./crewData";
import { work } from "./CrewArtifacts";
import s from "./shared.module.css";
import c from "./Crew.module.css";
import { Receipt } from "@/components/peeblo/receipt";
import { reportJob, Stamp } from "@/components/peeblo/signature";
import { receiptCost, receiptModel } from "@/components/peeblo/sig-slip";

// Example cards (tinted stage with a floating mini window, dark toast pill, "@mention · context" row,
// title, body) with a self-running job window inside each stage.
// Every card plays its own job when it scrolls into view, holds the finished state, then replays.

const HOLD = 6500;

function useBeats(beats: number[], delay: number) {
  const ref = useRef<HTMLLIElement>(null);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timers: number[] = [];
    let seen = false;
    const clear = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const run = (lead: number) => {
      clear();
      setStep(0);
      beats.forEach((t, i) => timers.push(window.setTimeout(() => setStep(i + 1), lead + t)));
      timers.push(window.setTimeout(() => seen && run(500), lead + beats[beats.length - 1] + HOLD));
    };
    const io = new IntersectionObserver(
      ([e]) => {
        if (reducedMotion()) {
          setStep(beats.length);
          return;
        }
        if (e.isIntersecting && !seen) {
          seen = true;
          run(delay);
        } else if (!e.isIntersecting && seen) {
          seen = false;
          clear();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clear();
    };
  }, [beats, delay]);
  return { ref, step };
}

const TriggerIcon = ({ t }: { t: string }) =>
  t.startsWith("Noticed") ? <Eye size={14} /> : t.startsWith("When") ? <Zap size={14} /> : <Repeat size={14} />;

function LiveCard({ card, index }: { card: Live; index: number }) {
  const final = card.beats.length;
  const { ref, step } = useBeats(card.beats, 250 + (index % 3) * 450);
  const a = agentByName(card.agent);
  const owner = people[a.owner];
  const st = card.status[step] ?? card.status[final];
  const Work = work[card.agent];
  const done = step >= final;
  useEffect(() => {
    if (done) reportJob({ id: `crew-${card.agent}`, agent: card.agent, what: card.title.replace(/\.$/, "").toLowerCase(), cost: receiptCost(card.receipt), model: receiptModel(card.receipt) });
  }, [done, card]);
  return (
    <li ref={ref} className={c.card} style={{ "--tint": owner.tint } as React.CSSProperties}>
      <div className={c.stage}>
        <div className={c.win}>
          <div className={c.head}>
            <Critter id={a.avatar} size={30} bob={false} reach={150} className={c.av} mood={done ? "happy" : step > 0 ? "thinking" : "idle"} />
            <div className={c.ht}>
              <b>{card.window}</b>
              <span>
                {a.where} · <time>{card.clock[step]}</time>
              </span>
            </div>
            <span className={c.status} data-tone={st.tone} aria-live="polite">
              <i aria-hidden="true" />
              {st.label}
            </span>
          </div>
          <div className={c.bar} aria-hidden="true">
            <i style={{ transform: `scaleX(${step / final})` }} />
          </div>
          <div className={c.body}>
            <Work step={step} />
          </div>
          <span className={c.stampAt} aria-hidden="true">
            <Stamp on={done} tone={card.stamp.tone}>
              {card.stamp.label}
            </Stamp>
          </span>
        </div>
        <p className={`${c.toast} ${done ? `${c.on} ${c.printed}` : ""}`}>
          <Receipt text={card.receipt} tone="dark" />
        </p>
      </div>
      <div className={c.copy}>
        <p className={c.trig}>
          <span className={c.at}>@{a.name}</span>
          <TriggerIcon t={card.trigger} />
          <span>{card.trigger}</span>
        </p>
        <h3>{card.title}</h3>
        <p className={c.desc}>{card.body}</p>
      </div>
      <div className={c.foot}>
        <span className={c.owner}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={owner.photo} alt="" width={22} height={22} />
          <span>
            <b>{owner.name}&apos;s</b> {a.job.toLowerCase()}
          </span>
        </span>
        <ul className={c.tools} role="list" aria-label="Tools it uses">
          {card.tools.map((id) => {
            const t = integrationById(id)!;
            return (
              <li key={id} title={t.name}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.src} alt={t.name} width={18} height={18} />
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );
}

export function Crew() {
  const shown = new Set(live.map((x) => x.agent));
  const rest = crew.filter((a) => !shown.has(a.name));
  return (
    <section className={`${s.story} ${s.tight}`} id="crew" aria-labelledby="crew-h">
      <div className={s.shell}>
        <h2 id="crew-h" className={c.h}>
          A few that people are using right now.
        </h2>
        <ul className={c.grid} role="list">
          {live.map((card, i) => (
            <LiveCard key={card.agent} card={card} index={i} />
          ))}
        </ul>
        <div className={c.more}>
          <ul className={c.crowd} role="list" aria-label={`${rest.length} more teammates`}>
            {rest.map((a) => (
              <li key={a.name} title={`@${a.name} · ${a.job.toLowerCase()} · ${people[a.owner].name}'s`}>
                <Critter id={a.avatar} size={44} wave reach={160} />
              </li>
            ))}
          </ul>
          <p>
            <b>Or make your own.</b> Any task, any name, anywhere.
          </p>
        </div>
      </div>
    </section>
  );
}
