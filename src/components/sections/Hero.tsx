"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Critter } from "@/components/peeblo/critter";
import { findModel } from "@/components/peeblo/sig-slip";
import { GitHubMark } from "@/components/peeblo/icons";
import { crew } from "@/content/crew";
import { site } from "@/content/site";
import { SlackHero } from "./SlackHero";
import s from "./Hero.module.css";

// Hero: centered title with a character inside the line, one lead, two buttons, then the Slack
// window with characters perched on it. Under it, a strip holds the crew.
export function Hero() {
  return (
    <>
      <section id="top" className={s.hero} aria-labelledby="ot-hero-title">
        <div className={s.copy}>
          <h1 id="ot-hero-title" className={s.title}>
            Your open-source{" "}
            <span className={s.mascot} aria-hidden="true">
              <Critter id="peeblo" size={72} mood="happy" reach={320} />
            </span>{" "}
            AI teammates.
          </h1>
          <p className={s.lead}>
            Hire a crew of AI employees for any task, right in Slack. Self-hosted on your servers, so your data, keys and AI budget stay under your control.
          </p>
          <div className={s.actions}>
            <span className={`${s.btn} ${s.soon}`} aria-disabled="true">
              Demo video <small>· soon</small>
            </span>
            <a className={`${s.btn} ${s.primary}`} href={site.repoUrl} target="_blank" rel="noreferrer" data-magnetic>
              <GitHubMark size={17} />
              Get it on GitHub
            </a>
          </div>
        </div>
        <div className={s.stage}>
          <SlackHero />
        </div>
      </section>

      <div id="lineup" className={s.crew}>
        <p className={s.crewLabel}>Give it a name, a face and a job.</p>
        <Ledge />
      </div>
    </>
  );
}

// The crew stands on pebbles that rise and dip along the row. Pointing at one prints its name
// tag, a little torn receipt that glides from face to face as you sweep across.
function Ledge() {
  const row = useRef<HTMLUListElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const [on, setOn] = useState<{ i: number; cx: number; top: number } | null>(null);
  const clear = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = (i: number, el: HTMLElement) => {
    const r = row.current?.parentElement?.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    if (r) setOn({ i, cx: m.left + m.width / 2 - r.left, top: m.top - r.top });
  };

  // Keep the tag inside the row: centered on the face unless that would push it off an edge.
  useLayoutEffect(() => {
    const el = tag.current;
    const W = row.current?.parentElement?.offsetWidth ?? 0;
    if (on && el) el.style.left = `${Math.max(el.offsetWidth / 2, Math.min(W - el.offsetWidth / 2, on.cx))}px`;
  }, [on]);

  const a = on ? crew[on.i] : null;
  const model = a ? findModel(a.model) : undefined;
  return (
    <div className={s.ledge}>
      <ul ref={row} className={s.row}>
        {crew.map((m, i) => (
          <li
            key={m.name}
            className={s.mate}
            aria-hidden="true"
            style={{ ["--y" as string]: `${(Math.sin(i * 0.62) * 7).toFixed(1)}px`, ["--w" as string]: `${40 + ((i * 7) % 5) * 3}px`, ["--d" as string]: `${-(i * 0.73).toFixed(2)}s` }}
            onPointerEnter={(e) => {
              clearTimeout(clear.current);
              show(i, e.currentTarget);
              if (e.pointerType !== "mouse") clear.current = setTimeout(() => setOn(null), 2600);
            }}
            onPointerLeave={(e) => e.pointerType === "mouse" && setOn(null)}
          >
            <span className={`${s.stone} pb-pebble`} />
            <Critter id={m.avatar} size={46} wave reach={160} />
          </li>
        ))}
      </ul>
      <span ref={tag} className={`${s.tag} ${on ? s.tagOn : ""}`} style={{ top: on?.top ?? 0 }} aria-hidden="true">
        <span className={`${s.tagIn} pb-torn`}>
          {a && (
            <>
              <b>@{a.name}</b> · {a.job.toLowerCase()} · on{" "}
              {model && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={model.logo} alt="" width={12} height={12} />
              )}
              {model?.name ?? a.model}
            </>
          )}
        </span>
      </span>
    </div>
  );
}
