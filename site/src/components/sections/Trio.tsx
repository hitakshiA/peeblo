/* eslint-disable @next/next/no-img-element -- small local logos inside illustrations */
import { Critter } from "@/components/peeblo/critter";
import { DockerMark } from "@/components/peeblo/icons";
import { models } from "@/content/models";
import { svc } from "./shared";
import s from "./Trio.module.css";

function ModelsArt() {
  const [a, b, c] = [models[0], models[2], models[4]];
  return (
    <div className={s.art} aria-hidden="true">
      <span className={s.dot} style={{ left: 50, top: 2, width: 62, height: 62 }}>
        <img src={a.logo} alt="" />
      </span>
      <span className={s.dot} style={{ left: 6, top: 52, width: 52, height: 52 }}>
        <img src={b.logo} alt="" />
      </span>
      <span className={s.dot} style={{ left: 100, top: 56, width: 52, height: 52 }}>
        <img src={c.logo} alt="" />
      </span>
      <span className={s.pos} style={{ left: 44, top: 92 }}>
        <Critter id="brain" size={70} mood="thinking" reach={160} />
      </span>
    </div>
  );
}

function MachineArt() {
  return (
    <div className={s.art} aria-hidden="true">
      <div className={s.laptop}>
        <div className={s.screen}>
          <span />
          <span />
          <span />
        </div>
        <div className={s.base} />
        <span className={s.whale}>
          <DockerMark size={20} />
        </span>
      </div>
      <span className={s.pos} style={{ left: 96, top: 84 }}>
        <Critter id="controller" size={62} reach={160} />
      </span>
      <span className={s.chip} style={{ left: 4, top: 126 }}>
        <i /> running
      </span>
    </div>
  );
}

function CrewArt() {
  return (
    <div className={s.art} aria-hidden="true">
      <span className={s.tile}>
        <img src={svc("slack")} alt="" />
      </span>
      <span className={s.pos} style={{ left: 0, top: 14 }}>
        <Critter id="sprout" size={56} reach={160} />
      </span>
      <span className={s.pos} style={{ left: 104, top: 10 }}>
        <Critter id="shield" size={54} reach={160} />
      </span>
      <span className={s.pos} style={{ left: 18, top: 96 }}>
        <Critter id="chat" size={56} reach={160} />
      </span>
      <span className={s.pos} style={{ left: 90, top: 96 }}>
        <Critter id="book" size={56} reach={160} />
      </span>
    </div>
  );
}

// Each card has a torn receipt edge, and a teammate peeks over its top.
const items = [
  {
    art: <ModelsArt />,
    title: "Open models.",
    line: "No lock-in.",
    peek: "lightbulb",
  },
  {
    art: <MachineArt />,
    title: "Your machine.",
    line: "Self-hosted, on premise.",
    peek: "ghost",
  },
  {
    art: <CrewArt />,
    title: "Your crew.",
    line: "An AI employee for any task.",
    peek: "bunny",
  },
];

// Trio of value cards.
export function Trio() {
  return (
    <section className={s.section}>
      <div className={s.intro}>
        <h2>Your AI employees.</h2>
      </div>
      <div className={s.grid}>
        {items.map((it) => (
          <article key={it.title} className={s.item}>
            <span className={s.peek} aria-hidden="true">
              <Critter id={it.peek} size={56} reach={200} />
            </span>
            <div className={`${s.card} pb-torn`}>
              {it.art}
              <h3>{it.title}</h3>
              <p>{it.line}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
