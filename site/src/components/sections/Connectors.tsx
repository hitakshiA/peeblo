"use client";

import { useRef, useState } from "react";
import { Critter } from "@/components/peeblo/critter";
import { Hands, useCountUp, useInView } from "@/components/peeblo/sig2-kit";
import { avatarById } from "@/avatars";
import { crew } from "@/content/crew";
import { connectors, FEATURED } from "./connectorList";
import s from "./shared.module.css";
import c from "./Connectors.module.css";

const cast = crew.map((a) => a.avatar);

// "Works with the tools you already use.": a head, a grid of 28 tiles, then the rest on demand.
// Peeblo's layer: hover a tile and a teammate climbs up from behind it to hold it; tiles get a pebble outline,
// and the "See all" count rolls up when it comes into view.
export function Connectors() {
  const [all, setAll] = useState(false);
  const [peek, setPeek] = useState<{ i: number; id: string; n: number } | null>(null);
  const last = useRef("");
  const turn = useRef(0);
  const more = useRef<HTMLParagraphElement>(null);
  const seen = useInView(more, 0.6, true);
  const count = useCountUp(connectors.length, seen, 1100);
  const list = all ? connectors : connectors.slice(0, FEATURED);

  const show = (i: number) => {
    // A shuffled-feeling pick: steps through the crew by a stride, so neighbours rarely repeat.
    turn.current += 1;
    let id = cast[(turn.current * 7 + i * 3) % cast.length];
    if (id === last.current) id = cast[(cast.indexOf(id) + 1) % cast.length];
    last.current = id;
    setPeek((p) => (p?.i === i ? p : { i, id, n: (p?.n ?? 0) + 1 }));
  };

  return (
    <section className={`${s.story} ${c.wrap}`} id="connectors" aria-labelledby="connectors-h">
      <div className={s.shell}>
        <div className={c.head}>
          <h3 id="connectors-h">Works with the tools you already use.</h3>
        </div>
        <ul className={c.grid} role="list" aria-label="Some of the tools teammates can use" onPointerLeave={() => setPeek(null)}>
          {list.map((t, i) => (
            <li className={`${c.tile} ${i >= FEATURED ? c.late : ""}`} key={t.name} title={t.name} onPointerEnter={() => show(i)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t.src} alt="" width={26} height={26} loading="lazy" decoding="async" />
              <span>{t.label}</span>
              {peek?.i === i && (
                <div key={peek.n} className={c.peek} aria-hidden="true">
                  <span className={c.peekClip}>
                    <span className={c.peekBody}>
                      <Critter id={peek.id} size={46} mood="happy" bob={false} reach={120} />
                    </span>
                  </span>
                  <Hands color={avatarById(peek.id)?.color} gap={20} size={10} className={c.peekHands} />
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className={c.more} ref={more}>
          <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} aria-label={all ? "Show fewer" : `See all ${connectors.length}`}>
            {all ? "Show fewer" : `See all ${count}`}
          </button>
        </p>
      </div>
    </section>
  );
}
