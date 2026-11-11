"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, AtSign, Plus, Smile } from "lucide-react";
import { Critter } from "@/components/peeblo/critter";
import { onFrame, reducedMotion } from "@/lib/pointer";
import { site } from "@/content/site";
import s from "./Closing.module.css";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Examples", href: "#crew" },
      { label: "How it works", href: "#how" },
      { label: "Models", href: "#otari" },
      { label: "Self-host", href: "#self-host" },
      { label: "FAQ", href: "#faq" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: site.repoUrl },
      { label: "Docs (README)", href: site.docsUrl },
      { label: "Apache-2.0 licence", href: "https://www.apache.org/licenses/LICENSE-2.0" },
    ],
  },
  {
    title: "Built with",
    links: [
      { label: "Otari", href: site.otariUrl },
      { label: "Pi", href: site.piUrl },
      { label: "Open Bot Avatar", href: site.avatarsUrl },
    ],
  },
];

const external = (href: string) => href.startsWith("http");

// The crew waiting behind the composer; each leans toward the button by its own amount.
const crowd = [
  { id: "sprout", lean: 14 },
  { id: "book", lean: 12 },
  { id: "controller", lean: 10 },
  { id: "chat", lean: 8 },
  { id: "magnifier", lean: 4 },
];

// The giant wordmark's "o" has the brand character's eyes, and they follow the cursor.
function Eyes() {
  const box = useRef<HTMLSpanElement>(null);
  const look = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    if (box.current) io.observe(box.current);
    const at = { x: 0, y: 0 };
    const stop = onFrame((_, dt, ptr) => {
      const el = box.current;
      const eyes = look.current;
      if (!visible || !el || !eyes || !ptr.seen) return;
      const r = el.getBoundingClientRect();
      const dx = ptr.x - (r.left + r.width / 2);
      const dy = ptr.y - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 260);
      const tx = (dx / d) * reach;
      const ty = (dy / d) * reach;
      const k = Math.min(1, dt / 90);
      at.x += (tx - at.x) * k;
      at.y += (ty - at.y) * k;
      eyes.style.transform = `translate(${(at.x * 0.03).toFixed(4)}em, ${(at.y * 0.024).toFixed(4)}em)`;
    });
    return () => {
      stop();
      io.disconnect();
    };
  }, []);
  return (
    <span ref={box} className={s.eyes}>
      <span ref={look} className={s.look}>
        <i />
        <i />
      </span>
    </span>
  );
}

export function Closing() {
  return (
    <>
      <section className={s.cta} aria-labelledby="ot-close-title">
        <span className={s.dancer} aria-hidden="true">
          <Critter id="star" size={150} mood="happy" reach={300} />
        </span>
        <h2 id="ot-close-title">Just tag it.</h2>
        <Composer />
      </section>

      <footer className={s.footer}>
        <div className={s.backdrop} aria-hidden="true" />
        <div className={s.inner}>
          <div className={s.cols}>
            {columns.map((c) => (
              <div key={c.title} className={s.col}>
                <p>{c.title}</p>
                <ul>
                  {c.links.map((l) => (
                    <li key={l.label}>
                      <a href={l.href} {...(external(l.href) ? { target: "_blank", rel: "noreferrer" } : {})}>
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className={s.word} aria-hidden="true">
          {"peeblo".split("").map((ch, i) => (
            <span key={i} className={`${s.ch} ${i === 0 ? s.lift : ""}`} style={{ ["--i" as string]: i }}>
              {ch}
              {i === 5 && <Eyes />}
            </span>
          ))}
        </div>
      </footer>
    </>
  );
}

// The closing button sits in a Slack composer with "@" already typed; the crew leans in on hover.
function Composer() {
  const [near, setNear] = useState(false);
  return (
    <div className={`${s.composer} ${near ? s.near : ""}`} onPointerEnter={() => setNear(true)} onPointerLeave={() => setNear(false)} onFocus={() => setNear(true)} onBlur={() => setNear(false)}>
      <div className={s.crowd} aria-hidden="true">
        {crowd.map((c, i) => (
          <span key={c.id} className={s.mate} style={{ ["--lean" as string]: `${c.lean}deg`, ["--d" as string]: `${i * 45}ms` }}>
            <Critter id={c.id} size={52} mood={near ? "happy" : "idle"} bob={false} reach={260} />
          </span>
        ))}
      </div>
      <div className={s.box}>
        <div className={s.field} aria-hidden="true">
          <span className={s.at}>@</span>
          <i className={s.caret} />
        </div>
        <div className={s.row}>
          <span className={s.tools} aria-hidden="true">
            <Plus />
            <Smile />
            <AtSign />
          </span>
          <a className={s.btn} href={site.repoUrl} target="_blank" rel="noreferrer" data-magnetic>
            Get Peeblo on GitHub
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
