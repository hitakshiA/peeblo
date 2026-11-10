"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Critter } from "@/components/peeblo/critter";
import { Receipt } from "@/components/peeblo/receipt";
import { reducedMotion } from "@/lib/pointer";
import s from "./Faq.module.css";

// Eight questions, answered for Peeblo. Each answer comes from a teammate, like a
// reply in a thread: typing dots, then the text, signed with a receipt from a small, cheap model.
type Faq = { q: string; a: ReactNode; who: string; avatar: string; rc: string };
const faqs: Faq[] = [
  {
    q: "Can I use the models I already pay for?",
    a: "Yes. Every call goes through Otari, Mozilla.ai's open-source AI gateway, so you can add your own provider keys there or use the providers it hosts. Your teammates use open-weight models like DeepSeek, Kimi and Qwen, and never hold a key.",
    who: "scout",
    avatar: "magnifier",
    rc: "qwen3.8-27b · deepinfra · 1 call · $0.0002",
  },
  {
    q: "What do I need to run Peeblo?",
    a: (
      <>
        A server on your premises (or any box you own) with Docker, a Slack workspace and an Otari key. <code>./peeblo up</code> starts it, and a console in your browser walks you through the rest.
      </>
    ),
    who: "patch",
    avatar: "controller",
    rc: "deepseek-v4.1-flash · deepinfra · 1 call · $0.0001",
  },
  {
    q: "How does Peeblo work?",
    a: "You mention a teammate in a thread. Peeblo gives the job to that teammate, which works in a sandbox with only the tools its owner allowed, then answers in the thread with a receipt. Hand it a recurring job and it runs on a schedule, then posts to the channel.",
    who: "peeblo",
    avatar: "peeblo",
    rc: "qwen3.8-27b · together · 1 call · $0.0002",
  },
  {
    q: "What about data and privacy?",
    a: "Everything runs on your own servers, so your data stays on premise. Teammates never hold an API key: model calls go through Otari to the providers you allow, with a budget for each person. Jobs run in a sandbox with only the tools their owner allowed.",
    who: "warden",
    avatar: "shield",
    rc: "deepseek-v4.1-flash · fireworks · 1 call · $0.0002",
  },
  {
    q: "How much does Peeblo cost?",
    a: "Peeblo is free and open source (Apache-2.0). You pay only for model calls. Costly jobs show a price first, every answer shows what it cost, and each person has a monthly budget.",
    who: "ledger",
    avatar: "book",
    rc: "deepseek-v4.1-flash · deepinfra · 1 call · $0.0001",
  },
  {
    q: "Can my whole team use it?",
    a: "Yes. Anyone can make a teammate for any task. Each one has a name, an owner, a budget, its own tools and its own memory, and several people can work with it in the same thread.",
    who: "tend",
    avatar: "watering-can",
    rc: "qwen3.8-27b · deepinfra · 1 call · $0.0001",
  },
  {
    q: "Which chat apps does Peeblo support?",
    a: "Slack today. Support for Microsoft Teams, Discord, Google Chat, Mattermost, Lark and Rocket.Chat comes later.",
    who: "echo",
    avatar: "chat",
    rc: "qwen3.8-27b · together · 1 call · $0.0001",
  },
  {
    q: "What is Peeblo?",
    a: "An open-source way to make your own AI teammates in your team chat. A chatbot answers; a teammate delivers. You make one for any task, it takes ownership of the job, remembers what it learns, and hands work to the others, like a reviewer that checks another teammate's numbers with a different model.",
    who: "peeblo",
    avatar: "peeblo",
    rc: "deepseek-v4.1-flash · deepinfra · 1 call · $0.0003",
  },
];

type Phase = "closed" | "typing" | "said";

function Item({ f }: { f: Faq }) {
  const [phase, setPhase] = useState<Phase>("closed");
  useEffect(() => {
    if (phase !== "typing") return;
    const t = window.setTimeout(() => setPhase("said"), 720);
    return () => window.clearTimeout(t);
  }, [phase]);
  // Set the phase on click, before the panel opens, so the text never flashes in ahead of the dots.
  const open = (e: React.MouseEvent<HTMLElement>) => {
    const d = e.currentTarget.parentElement as HTMLDetailsElement;
    if (!d.open) setPhase(reducedMotion() ? "said" : "typing");
  };
  return (
    <details className={s.item} name="ot-faq" onToggle={(e) => !(e.currentTarget as HTMLDetailsElement).open && setPhase("closed")}>
      <summary onClick={open}>
        <span>{f.q}</span>
        <Plus aria-hidden="true" />
      </summary>
      <div className={s.answer} data-phase={phase}>
        <span className={s.who} aria-hidden="true">
          {phase !== "closed" && <Critter id={f.avatar} size={36} bob={false} mood={phase === "typing" ? "thinking" : "happy"} reach={140} />}
        </span>
        <div className={s.bubble}>
          <div className={s.name}>
            {f.who}
            <span className={s.app}>APP</span>
          </div>
          {phase === "typing" && (
            <span className={s.dots} aria-label={`${f.who} is typing`}>
              <i />
              <i />
              <i />
            </span>
          )}
          <p className={phase === "typing" ? s.wait : s.said}>{f.a}</p>
          {phase === "said" && <Receipt text={f.rc} className={s.rc} />}
        </div>
      </div>
    </details>
  );
}

export function Faq() {
  return (
    <section id="faq" className={s.section} aria-labelledby="ot-faq-title">
      <div className={s.intro}>
        <h2 id="ot-faq-title">FAQs</h2>
      </div>
      <div className={s.stage}>
        <span className={s.mascot} aria-hidden="true">
          <Critter id="lightbulb" size={112} reach={220} />
        </span>
        <div className={s.list}>
          {faqs.map((f) => (
            <Item key={f.q} f={f} />
          ))}
        </div>
      </div>
    </section>
  );
}
