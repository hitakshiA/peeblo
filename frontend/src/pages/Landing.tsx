import DraggableMarquee from "../components/marketing/DraggableMarquee";
import Mark from "../components/marketing/PeebloMark";
import {
  lazy,
  useEffect,
  Suspense,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion, useInView, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Activity,
} from "lucide-react";
import {
  siStripe,
  siQuickbooks,
  siHubspot,
  siNotion,
  siJira,
  siDropbox,
} from "simple-icons";
import { useLockedTheme } from "@/lib/theme";
import "./landing.css";
import PeebloWorkStory from "@/components/marketing/PeebloWorkStory";
import { LoopAsset } from "@/components/marketing/LoopAsset";

const Arc = lazy(() => import("@/components/marketing/PeebloArcScene"));
const Living = lazy(() => import("@/components/marketing/PeebloLivingScene"));
const apps = [
  {
    name: "Stripe",
    icon: siStripe,
    job: "Invoices & payments",
    detail:
      "Notice an overdue invoice, check its balance, and stop an inappropriate reminder.",
  },
  {
    name: "QuickBooks",
    icon: siQuickbooks,
    job: "Books & reconciliation",
    detail:
      "Find an existing payment and reconcile it against the right customer and invoice.",
  },
  {
    name: "Salesforce",
    icon: null,
    job: "Commercial context",
    detail:
      "Read the account history and commercial terms before deciding what the customer owes.",
  },
  {
    name: "HubSpot",
    icon: siHubspot,
    job: "Customer relationships",
    detail:
      "Find the account owner and payment commitments without losing the customer context.",
  },
  {
    name: "Slack",
    icon: null,
    job: "Your team, in the loop",
    detail:
      "Ask a focused question when judgment is needed, then report the verified result in the right channel.",
  },
  {
    name: "Notion",
    icon: siNotion,
    job: "Policies & authority",
    detail:
      "Check credit thresholds and standing permissions before making a financial change.",
  },
  {
    name: "Jira",
    icon: siJira,
    job: "Exception ownership",
    detail:
      "Track a billing exception, attach evidence, and close it only after verification.",
  },
  {
    name: "Dropbox",
    icon: siDropbox,
    job: "Signed source documents",
    detail:
      "Read the signed amendment that explains why the invoice and the contract disagree.",
  },
];
function AppIcon({ name, size = 20 }: { name: string; size?: number }) {
  const app = apps.find((a) => a.name === name);
  if (app?.icon)
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={app.icon.path} />
      </svg>
    );
  return (
    <img
      className="app-brand-logo"
      src={`/images/${name.toLowerCase()}.svg`}
      width={size}
      height={size}
      alt=""
    />
  );
}
function Reveal({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.7, ease: [0.25, 1, 0.5, 1] }}
    >
      {children}
    </motion.div>
  );
}
function SceneFrame({
  kind,
  paused,
}: {
  kind: "arc" | "living";
  paused: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref, { margin: "120px" });
  return (
    <div ref={ref} className={`shader-frame shader-${kind}`}>
      {visible && !paused ? (
        <Suspense fallback={<div className="scene-loading" />}>
          {kind === "arc" ? <Arc /> : <Living />}
        </Suspense>
      ) : (
        <img src="/images/peeblo-ledger-orbit.png" alt="" />
      )}
    </div>
  );
}
export default function Landing() {
  useLockedTheme("dark");
  const reduced = useReducedMotion(),
    [selectedApp, setSelectedApp] = useState(0),
    [selectedJob, setSelectedJob] = useState(0);
  const motionPaused = !!reduced;
  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) setSelectedApp((i) => (i + 1) % apps.length);
    }, 3800);
    return () => window.clearInterval(timer);
  }, [reduced]);

  const jobs = [
    {
      name: "Match payments to invoices.",
      detail:
        "Match payments to the right account, explain discrepancies, and verify that the invoice and the books agree.",
      app: "QuickBooks",
      signal: "Payment received · invoice still open",
      outcome: "Payment matched. Balance verified.",
    },
    {
      name: "Stay on top of payment promises.",
      detail:
        "Know who promised to pay, when they promised it, and whether anything changed before following up. Keep the account owner in the loop.",
      app: "HubSpot",
      signal: "Customer promised payment Friday",
      outcome: "Follow-up scheduled. Owner informed.",
    },
    {
      name: "Resolve billing issues.",
      detail:
        "Investigate a disputed amount against signed terms and policy. Make an authorized correction, or bring a precise decision to the right person.",
      app: "Jira",
      signal: "Contract terms don’t match the invoice",
      outcome: "Correction verified. Exception closed.",
    },
  ];
  return (
    <div
      className="peeblo-landing"
      data-motion={motionPaused ? "paused" : "running"}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="p-nav" aria-label="Main navigation">
        <a href="#" className="p-brand">
          <Mark />
          peeblo
        </a>
        <div className="nav-center">
          <a href="#how">How it works</a>
          <a href="#apps">Integrations</a>
        </div>
        <a className="button button-light nav-cta" href="/room">
          Try Peeblo <ArrowUpRight size={15} />
        </a>
      </nav>
      <main id="main">
        <section className="p-hero">
          <LoopAsset
            className="hero-art"
            name="orbit"
            paused={motionPaused}
            alt="A folded ivory ledger ribbon forming a continuous loop on green stone"
            eager
          />

          <Reveal className="hero-copy">
            <h1>
              Your AI teammate for
              <br />
              <em>accounts receivable.</em>
            </h1>
            <p>
              Peeblo handles payment follow-ups, reconciliation, and billing
              exceptions across your existing systems. Keep cash moving without
              adding more work to your team.
            </p>
            <div className="hero-actions">
              <a href="/room" className="button button-green">
                Try Peeblo <ArrowRight size={17} />
              </a>
              <a href="#how" className="text-link">
                See how it works <ChevronDown size={14} />
              </a>
            </div>
          </Reveal>
          <div className="hero-stage">
            <Reveal className="demo-wrap">
              <PeebloWorkStory />
            </Reveal>
          </div>
        </section>
        <section className="manifesto p-container">
          <Reveal>
            <h2>
              Keep every receivable moving.
              <br />
              <em>Without chasing every detail.</em>
            </h2>
            <p>
              Your team spends hours matching payments, checking contracts, and
              tracking down the reason an invoice is still open.
              <br />
              <span>
                Peeblo brings that context together, resolves the issue, and
                updates the systems your team already uses.
              </span>
            </p>
          </Reveal>
        </section>
        <section id="apps" className="apps-section p-container">
          <div className="apps-world">
            <SceneFrame kind="arc" paused={motionPaused} />
            <div className="apps-copy">
              <h2>
                Connect the tools
                <br />
                <em>your team already uses.</em>
              </h2>
              <p>
                Billing, accounting, customer history, and signed terms. The
                context Peeblo needs to take the next step.
              </p>
            </div>
            <DraggableMarquee>
              <div className="app-marquee-track">
                {[0, 1, 2].map((copy) => (
                  <div
                    className="app-marquee-group"
                    key={copy}
                    aria-hidden={copy > 0 ? true : undefined}
                  >
                    {apps.map((app, i) => (
                      <button
                        key={app.name}
                        tabIndex={copy > 0 ? -1 : 0}
                        className={selectedApp === i ? "active" : ""}
                        aria-pressed={selectedApp === i}
                        onClick={() => setSelectedApp(i)}
                      >
                        <AppIcon name={app.name} />
                        <span>{app.name}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </DraggableMarquee>
          </div>
          <div className="app-detail" aria-live="polite">
            <div>
              <AppIcon name={apps[selectedApp].name} />
              <strong>{apps[selectedApp].job}</strong>
            </div>
            <p>{apps[selectedApp].detail}</p>
            <span className="micro">TARGET INTEGRATION</span>
          </div>
        </section>
        <section id="how" className="role-section p-container">
          <Reveal className="section-heading">
            <h2>
              Less manual work.
              <br />
              <em>More accounts covered.</em>
            </h2>
            <p>
              Peeblo monitors open receivables, picks up new issues, and follows
              through on each account. You set the policies and decide when your
              team should step in.
            </p>
          </Reveal>
          <div className="role-layout">
            <div className="job-list">
              {jobs.map((job, i) => (
                <button
                  key={job.name}
                  className={selectedJob === i ? "active" : ""}
                  aria-expanded={selectedJob === i}
                  onClick={() => setSelectedJob(i)}
                >
                  <span className="micro">0{i + 1}</span>
                  <div>
                    <h3>{job.name}</h3>
                    {selectedJob === i && <p>{job.detail}</p>}
                  </div>
                  <ArrowUpRight size={19} />
                </button>
              ))}
            </div>
            <div className="job-visual">
              <div className="job-art">
                <LoopAsset name="orbit" paused={motionPaused} alt="" />
              </div>
              <div className="job-receipt" aria-live="polite">
                <span className="micro">A DAY ON PEEBLO’S DESK</span>
                <div className="job-signal">
                  <AppIcon name={jobs[selectedJob].app} />
                  {jobs[selectedJob].signal}
                </div>
                <div className="receipt-line" />
                <span className="job-thinking">
                  <Activity size={16} /> Investigate → act within policy →
                  verify
                </span>
                <strong>
                  <Check size={17} />
                  {jobs[selectedJob].outcome}
                </strong>
              </div>
            </div>
          </div>
        </section>
        <section className="closing p-container">
          <div className="closing-scene">
            <SceneFrame kind="living" paused={motionPaused} />
          </div>
          <Reveal className="closing-copy">
            <h2>
              Put your receivables
              <br />
              <em>in capable hands.</em>
            </h2>
            <p>
              See how Peeblo takes an open invoice through to resolution.
              <br />
              Across your apps, under your rules.
            </p>
            <a className="button button-light" href="/room">
              Try Peeblo <ArrowRight size={17} />
            </a>
          </Reveal>
        </section>
      </main>
      <footer className="p-footer p-container">
        <div className="footer-top">
          <a href="#" className="p-brand" aria-label="Peeblo home">
            <Mark />
          </a>
          <p>
            Your accounts receivable teammate.
            <br />
            <em>Payment follow-ups, reconciliation, and billing support.</em>
          </p>
          <div>
            <a href="#how">How it works</a>
            <a href="#apps">Integrations</a>
          </div>
        </div>
        <div className="footer-word" aria-hidden="true">
          peeblo
        </div>
      </footer>
    </div>
  );
}
