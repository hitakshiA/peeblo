"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { GazeCritter, type Look } from "@/components/peeblo/sig-gaze";
import { GitHubMark } from "@/components/peeblo/icons";
import { site } from "@/content/site";
import { cn } from "@/lib/utils";
import s from "./Nav.module.css";

const links = [
  { href: "#crew", label: "Examples" },
  { href: "#how", label: "How it works" },
  { href: "#otari", label: "Models" },
  { href: "#self-host", label: "Self-host" },
  { href: "#faq", label: "FAQ" },
];

// Header: a split layout (a pill with logo and links, plus a solid action beside it) that moves from
// an open bar at the top of the page to a tighter floating glass pill on scroll.
export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [look, setLook] = useState<Look>(null);
  const logo = useRef<HTMLSpanElement>(null);

  // The logo character turns to whatever link the pointer or keyboard is on.
  const lookAt = (e: React.SyntheticEvent<HTMLElement>) => {
    const from = logo.current?.getBoundingClientRect();
    const to = e.currentTarget.getBoundingClientRect();
    if (!from) return;
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    setLook({ x: Math.max(-1, Math.min(1, dx / 560)), y: 0.2 });
  };
  const eyes = { onPointerEnter: lookAt, onFocus: lookAt, onPointerLeave: () => setLook(null), onBlur: () => setLook(null) };

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header className={cn(s.header, scrolled && s.scrolled)}>
      <div className={s.row}>
        <div className={s.pill}>
          <a className={s.brand} href="#top" aria-label="Peeblo, back to top">
            <span ref={logo} className={s.logo}>
              <GazeCritter id="peeblo" size={28} bob={false} look={look} lean={3} />
            </span>
            peeblo
          </a>
          <nav className={cn(s.nav, open && s.open)} aria-label="Main navigation">
            {links.map((l) => (
              <a key={l.href} href={l.href} onClick={() => setOpen(false)} {...eyes}>
                {l.label}
              </a>
            ))}
          </nav>
          <span className={s.divider} aria-hidden="true" />
          <a className={s.gh} href={site.repoUrl} target="_blank" rel="noreferrer" {...eyes}>
            <GitHubMark size={16} />
            Open source
          </a>
          <button type="button" className={s.menu} aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
        <a className={s.cta} href="#self-host" data-magnetic {...eyes}>
          Self-host it
        </a>
      </div>
    </header>
  );
}
