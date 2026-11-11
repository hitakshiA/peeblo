"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Critter } from "@/components/peeblo/critter";
import { GitHubMark } from "@/components/peeblo/icons";
import { useInView } from "@/components/peeblo/sig2-kit";
import { reducedMotion } from "@/lib/pointer";
import { site } from "@/content/site";
import s from "./SelfHost.module.css";

// Until the repo is public, site.repoUrl is just github.com, so the clone line shows a placeholder.
const repo = /github\.com\/[^/]+\/[^/]+/.test(site.repoUrl) ? site.repoUrl : "<repo-url>";
const commands = [`git clone ${repo} peeblo && cd peeblo`, "./peeblo up"];

// The terminal plays a real start-up: each command typed out, then what ./peeblo up prints. Then the console
// it points to rises over the terminal and ticks through the setup steps (the same ones the real console shows).
// Everything is a function of one clock (ms since the card came into view), so it renders the same
// way every time and reduced motion just shows the end.
type Line = { cmd?: string; text?: string; done?: string; at: number; doneAt?: number; tone?: "dim" | "head" };
const TYPE_MS = 26;
const lines: Line[] = [];
let clockAt = 300;
const cmd = (text: string) => {
  lines.push({ cmd: text, at: clockAt });
  clockAt += text.length * TYPE_MS + 380;
};
const out = (text: string, wait = 120, tone?: Line["tone"]) => {
  lines.push({ text, at: clockAt, tone });
  clockAt += wait;
};
// A line with a spinner that turns into a tick after `ms`.
const job = (text: string, done: string, ms: number, gap = 160) => {
  lines.push({ text, done, at: clockAt, doneAt: clockAt + ms });
  clockAt += gap;
};
cmd(commands[0]);
out("Cloning into 'peeblo'...", 520, "dim");
out("Receiving objects: 100% (1,284/1,284), done.", 420, "dim");
cmd(commands[1]);
out("[+] Building 2/2", 100, "head");
job("peeblo            Building", "peeblo            Built    38.2s", 1300);
job("computer image    Building", "computer image    Ready    41.0s", 1500, 1700);
out("[+] Running 2/2", 100, "head");
job("Container peeblo-db-1      Starting", "Container peeblo-db-1      Healthy   5.8s", 1200);
job("Container peeblo-peeblo-1  Starting", "Container peeblo-peeblo-1  Healthy   9.4s", 1700, 1900);
out("peeblo: up. Open the console to set up or look around: http://127.0.0.1:7340/console/", 700);
const TERM_END = clockAt;
// The console's setup, one step after another; the last line is the hand-off to Slack.
const STEP_MS = 650;
const steps = ["Console password", "Your Otari key", "Otari dashboard", "A public address", "Add Peeblo to Slack"].map((label, i) => ({ label, doneAt: TERM_END + 500 + (i + 1) * STEP_MS }));
const END = steps[steps.length - 1].doneAt + 700;

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function useClock(on: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!on) return;
    if (reducedMotion()) {
      const id = setTimeout(() => setT(END), 0);
      return () => clearTimeout(id);
    }
    const t0 = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now() - t0;
      setT(now);
      if (now > END) window.clearInterval(id);
    }, 40);
    return () => window.clearInterval(id);
  }, [on]);
  return t;
}

// A little construction helmet for Peeblo while it watches the install.
function HardHat() {
  return (
    <svg className={s.hat} width="46" height="28" viewBox="0 0 46 28" aria-hidden="true">
      <path d="M6 21C6 10.5 13.5 3.5 23 3.5S40 10.5 40 21Z" fill="oklch(0.8 0.15 85)" stroke="oklch(0.27 0.02 60 / 0.55)" strokeWidth="1.4" />
      <path d="M20 4.2h6V21h-6z" fill="oklch(0.86 0.13 88)" />
      <path d="M13 9.5c1.6-1.8 3.4-3 5.4-3.7" stroke="oklch(1 0 0 / 0.6)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <rect x="1.5" y="19.5" width="43" height="5.5" rx="2.75" fill="oklch(0.74 0.15 75)" stroke="oklch(0.27 0.02 60 / 0.55)" strokeWidth="1.4" />
    </svg>
  );
}

// The terminal card, holding the three start commands.
export function SelfHost() {
  const [copied, setCopied] = useState(false);
  const term = useRef<HTMLDivElement>(null);
  const seen = useInView(term, 0.5, true);
  const t = useClock(seen);
  const done = t >= END;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  // The line still being typed gets the caret; once everything has run, a fresh prompt holds it.
  const typing = lines.findIndex((l) => l.cmd && t >= l.at && t < l.at + l.cmd.length * TYPE_MS);

  return (
    <section id="self-host" className={s.section} aria-labelledby="ot-self-title">
      <div className={s.head}>
        <h2 id="ot-self-title">Self-hosted, on your own servers.</h2>
        <a className={s.pill} href={site.repoUrl} target="_blank" rel="noreferrer" data-magnetic>
          <GitHubMark size={16} />
          Open on GitHub
        </a>
      </div>
      <div className={s.card}>
        <div className={s.copy}>
          <h3>One command. The rest happens in your browser.</h3>
          <p>Clone the repo and run <code>./peeblo up</code>. A console on your machine walks you through your Otari key, Slack and a public address. Your teammates never see the key.</p>
        </div>
        <div className={s.term} ref={term}>
          <span className={`${s.foreman} ${done ? s.foremanDone : ""}`} aria-hidden="true">
            <Critter id="peeblo" size={58} mood={done ? "happy" : seen ? "thinking" : "idle"} bob={false} reach={1} wear={<HardHat />} />
          </span>
          <div className={s.termBody}>
            <pre aria-label={commands.join("\n")}>
              <code aria-hidden="true">
                {lines.map((l, i) => {
                  const on = t >= l.at;
                  if (l.cmd) {
                    const n = Math.max(0, Math.min(l.cmd.length, Math.floor((t - l.at) / TYPE_MS)));
                    return (
                      <div key={i} className={on ? undefined : s.ghost}>
                        <span>$ </span>
                        {on ? l.cmd.slice(0, n) : l.cmd}
                        {i === typing && <i className={s.caret} />}
                      </div>
                    );
                  }
                  const finished = l.doneAt !== undefined && t >= l.doneAt;
                  const mark = l.done ? (finished ? "✔" : SPIN[Math.floor(t / 80) % SPIN.length]) : "";
                  return (
                    <div key={i} className={`${on ? "" : s.ghost} ${l.tone === "dim" ? s.dim : ""} ${l.tone === "head" ? s.headLine : ""}`}>
                      {l.done && <b className={finished ? s.ok : s.spin}> {mark} </b>}
                      {finished ? l.done : l.text}
                    </div>
                  );
                })}
                <div className={done ? undefined : s.ghost}>
                  <span>$ </span>
                  <i className={s.caret} />
                </div>
              </code>
            </pre>
            <div className={`${s.console} ${t >= TERM_END ? s.consoleOn : ""}`} aria-label="Setup in the console">
              <div className={s.consoleBar} aria-hidden="true">
                <i />
                <i />
                <i />
                <span>127.0.0.1:7340/console</span>
              </div>
              <ol>
                {steps.map((st, i) => {
                  const ok = t >= st.doneAt;
                  const now = !ok && (i === 0 ? t >= TERM_END : t >= steps[i - 1].doneAt);
                  return (
                    <li key={st.label} className={ok ? s.stepOk : now ? s.stepNow : undefined}>
                      <b aria-hidden="true">{ok ? "✓" : now ? SPIN[Math.floor(t / 80) % SPIN.length] : "○"}</b>
                      {st.label}
                    </li>
                  );
                })}
              </ol>
              <p className={done ? s.helloOn : undefined}>Say hello to Peeblo in Slack</p>
            </div>
            <p className={`${s.board} ${done ? s.boardOn : ""}`} aria-live="polite">
              {done && (
                <>
                  <span className={s.boardDot} />
                  <span>
                    on premise <span className={s.boardSep}>·</span> 0 keys left your server
                  </span>
                </>
              )}
            </p>
          </div>
          <button type="button" className={s.copyBtn} onClick={copy} aria-label={copied ? "Copied" : "Copy commands"}>
            {copied ? <Check /> : <Copy />}
            {copied && "Copied"}
          </button>
        </div>
      </div>
    </section>
  );
}
