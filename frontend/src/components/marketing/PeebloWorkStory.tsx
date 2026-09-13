import PeebloMark from "./PeebloMark";
import { useEffect, useRef, useState } from "react";
import { useInView } from "motion/react";
import gsap from "gsap";
import { Check, ArrowRight } from "lucide-react";
import {
  siStripe,
  siDropbox,
  siQuickbooks,
  siNotion,
  siHubspot,
  siJira,
} from "simple-icons";
import "./peeblo-work-story.css";

function Brand({ name }: { name: string }) {
  const icon = {
    Stripe: siStripe,
    Dropbox: siDropbox,
    QuickBooks: siQuickbooks,
    Notion: siNotion,
    HubSpot: siHubspot,
    Jira: siJira,
  }[name];
  return (
    <span className="story-brand">
      {icon ? (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
          <path d={icon.path} />
        </svg>
      ) : (
        <img
          src={`/images/${name.toLowerCase()}.svg`}
          width="15"
          height="15"
          alt=""
        />
      )}
      {name}
    </span>
  );
}
function Outline() {
  return (
    <svg className="story-outline" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="calc(100% - 2px)"
        height="calc(100% - 2px)"
        rx="12"
        pathLength="1"
      />
    </svg>
  );
}
function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`story-card ${className}`}>
      <Outline />
      <div className="story-card-content">{children}</div>
    </div>
  );
}
export default function PeebloWorkStory() {
  const host = useRef<HTMLDivElement>(null),
    timeline = useRef<gsap.core.Timeline | null>(null);
  const visible = useInView(host, { amount: 0.15 }),
    [reduced, setReduced] = useState(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!host.current) return;
    const root = host.current;
    const ctx = gsap.context(() => {
      const q = (s: string) => root.querySelector(s)!;
      const scenes = gsap.utils.toArray<HTMLElement>(".story-scene", root);
      gsap.set(scenes, { autoAlpha: 0 });
      gsap.set(".story-cursor", { autoAlpha: 0 });
      if (reduced) {
        gsap.set(scenes[3], { autoAlpha: 1 });

        return;
      }
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.4, paused: true });
      timeline.current = tl;
      tl.timeScale(0.85);
      const type = (
        selector: string,
        text: string,
        at: number,
        duration: number,
      ) => {
        const progress = { n: 0 };
        tl.set(q(selector), { textContent: "" }, 0);
        tl.fromTo(
          progress,
          { n: 0 },
          {
            n: text.length,
            duration,
            ease: "none",
            onUpdate: () => {
              q(selector).textContent = text.slice(0, Math.floor(progress.n));
            },
          },
          at,
        );
      };
      const cursor = (target: string, at: number, click = false) => {
        const position = () => {
          const r = q(target).getBoundingClientRect(),
            base = q(".story-stage").getBoundingClientRect();
          return {
            x: r.left - base.left + r.width * 0.68,
            y: r.top - base.top + r.height * 0.6,
          };
        };
        tl.to(
          q(".story-cursor"),
          {
            autoAlpha: 1,
            x: () => position().x - 18,
            y: () => position().y + 10,
            rotation: -7,
            duration: 0.65,
            ease: "power2.inOut",
          },
          at,
        ).to(
          q(".story-cursor"),
          {
            x: () => position().x,
            y: () => position().y,
            rotation: 0,
            duration: 0.3,
            ease: "power2.out",
          },
          at + 0.65,
        );
        if (click)
          tl.to(q(".story-pointer"), { scale: 0.82, duration: 0.12 }, at + 1)
            .to(q(".story-pointer"), { scale: 1, duration: 0.18 }, at + 1.12)
            .fromTo(
              q(".story-click"),
              { scale: 0.25, opacity: 0.7 },
              { scale: 2, opacity: 0, duration: 0.5 },
              at + 1,
            );
      };
      const enter = (index: number, at: number) => {
        if (index)
          tl.to(scenes[index - 1], { autoAlpha: 0, y: -10, duration: 0.3 }, at);

        tl.fromTo(
          scenes[index],
          { autoAlpha: 0, y: 14 },
          { autoAlpha: 1, y: 0, duration: 0.5 },
          at + 0.35,
        );
        tl.fromTo(
          scenes[index].querySelectorAll(".story-outline rect"),
          { strokeDasharray: 1, strokeDashoffset: 1 },
          {
            strokeDashoffset: 0,
            duration: 1.15,
            stagger: 0.16,
            ease: "power2.inOut",
          },
          at + 0.35,
        );
        tl.fromTo(
          scenes[index].querySelectorAll(".story-card"),
          { y: 22, scale: 0.97 },
          { y: 0, scale: 1, duration: 0.9, stagger: 0.25, ease: "power3.out" },
          at + 0.35,
        );
        tl.fromTo(
          scenes[index].querySelectorAll(".story-card-content"),
          { opacity: 0 },
          { opacity: 1, duration: 0.6, stagger: 0.14 },
          at + 0.75,
        );
        tl.fromTo(
          scenes[index].querySelectorAll(".story-connection path"),
          { strokeDasharray: 1, strokeDashoffset: 1 },
          { strokeDashoffset: 0, duration: 1.1 },
          at + 1.6,
        );
      };
      enter(0, 0);
      type(
        ".typed-issue",
        "Invoice overdue. Check before sending a reminder.",
        1.3,
        1.8,
      );
      cursor(".story-invoice", 2.1, true);
      tl.fromTo(
        q(".story-detected"),
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.4 },
        3.4,
      );
      enter(1, 5.3);
      cursor(".signed-fee", 6.2);
      tl.fromTo(
        q(".signed-fee"),
        { backgroundColor: "transparent" },
        { backgroundColor: "rgba(119,191,145,.12)", duration: 0.5 },
        7.3,
      );
      cursor(".payment-match", 8.3, true);
      type(
        ".typed-match",
        "Same customer. Same amount. Payment not yet applied.",
        9.5,
        1.7,
      );
      tl.fromTo(
        q(".story-crm-context"),
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.6 },
        10,
      );
      enter(2, 12);
      cursor(".credit-field", 12.9, true);
      type(".typed-credit", "$3,000.00", 14.05, 0.65);
      cursor(".payment-field", 14.7, true);
      type(".typed-payment", "$15,000.00", 15.85, 0.7);
      cursor(".apply-correction", 16.7, true);
      tl.set(q(".apply-label"), { textContent: "Correction applied" }, 17.9);
      tl.fromTo(
        q(".correction-check"),
        { opacity: 0, scale: 0.7 },
        { opacity: 1, scale: 1, duration: 0.3 },
        17.9,
      );
      enter(3, 19.7);
      type(
        ".typed-slack",
        "Northstar is reconciled. Applied the $3,000 credit under policy and matched the existing $15,000 payment. Balance verified: $0. Evidence attached; Jira case closed.",
        21,
        3.5,
      );
      cursor(".slack-post", 24.1, true);
      tl.set(
        q(".slack-post-label"),
        { textContent: "Posted to #finance" },
        25.3,
      );
      tl.fromTo(
        q(".story-final-check"),
        { opacity: 0, y: 7 },
        { opacity: 1, y: 0, duration: 0.5 },
        25.5,
      );
      tl.to(q(".story-cursor"), { autoAlpha: 0, duration: 0.4 }, 26.4);
      tl.to(scenes[3], { autoAlpha: 0, y: -12, duration: 0.65 }, 30);
      tl.set(q(".apply-label"), { textContent: "Apply correction" }, 30.6);
      tl.set(q(".slack-post-label"), { textContent: "Post update" }, 30.6);
    }, root);
    return () => {
      timeline.current = null;
      ctx.revert();
    };
  }, [reduced]);
  useEffect(() => {
    if (visible && documentVisible) timeline.current?.play();
    else timeline.current?.pause();
  }, [visible, documentVisible, reduced]);
  return (
    <div className="peeblo-story" id="demo" ref={host}>
      <div className="story-stage" aria-hidden="true">
        <div className="story-scene story-intake">
          <Card className="story-invoice">
            <Brand name="Stripe" />
            <div className="story-title-row">
              <h3>Northstar</h3>
              <span className="story-amber">7 days overdue</span>
            </div>
            <span className="story-record">Invoice INV–1042</span>
            <div className="story-money">
              $18,000<span>Outstanding</span>
            </div>
            <div className="story-separator" />
            <div className="story-fact">
              <span>Next reminder</span>
              <strong>Today, 10:00 AM</strong>
            </div>
          </Card>
          <div className="story-agent-note">
            <span className="story-agent-mark">
              <PeebloMark size={40} />
            </span>
            <p className="typed-issue" />
            <div className="story-detected">
              <Check size={14} /> Peeblo picked up the case
            </div>
          </div>
        </div>
        <div className="story-scene story-context">
          <svg
            className="story-connection"
            viewBox="0 0 1000 480"
            preserveAspectRatio="none"
          >
            <path
              d="M270 220 C390 220 380 290 500 290 S620 220 730 220"
              pathLength="1"
            />
          </svg>
          <Card>
            <Brand name="Dropbox" />
            <h3>The signed agreement</h3>
            <span className="story-record">Northstar · Amendment 02</span>
            <div className="story-contract-excerpt">
              “The annual subscription fee is amended to{" "}
              <strong>$15,000</strong>, effective September 1.”
            </div>
            <div className="story-fact signed-fee">
              <span>Agreed fee</span>
              <strong>$15,000</strong>
            </div>
            <div className="story-footnote">
              <Check size={13} /> Signed by both parties
            </div>
          </Card>
          <Card>
            <Brand name="QuickBooks" />
            <h3>A payment already received</h3>
            <span className="story-record">Northstar · Bank transfer</span>
            <div className="story-money payment-match">
              $15,000<span>Unmatched payment</span>
            </div>
            <p className="typed-match story-typed-note" />
          </Card>
          <div className="story-crm-context">
            <div>
              <Brand name="Salesforce" />
              <span>Northstar account matched · Amendment linked</span>
            </div>
            <div>
              <Brand name="HubSpot" />
              <span>Maya Chen · Billing contact confirmed</span>
            </div>
          </div>
        </div>
        <div className="story-scene">
          <svg
            className="story-connection"
            viewBox="0 0 1000 480"
            preserveAspectRatio="none"
          >
            <path d="M270 240 C420 240 580 240 730 240" pathLength="1" />
          </svg>
          <Card className="policy-card">
            <Brand name="Notion" />
            <h3>Check the authority.</h3>
            <p className="story-body">
              Signed amendments allow invoice corrections within the standing
              credit limit.
            </p>
            <div className="story-policy-row">
              <Check size={15} /> Contract discrepancy confirmed
            </div>
            <div className="story-policy-row">
              <Check size={15} /> $3,000 within credit authority
            </div>
            <div className="story-footnote">Policy reference · AR–07</div>
          </Card>
          <Card>
            <Brand name="Stripe" />
            <h3>Correct and reconcile</h3>
            <label>Credit for amended terms</label>
            <div className="story-field credit-field">
              <span className="typed-credit" />
            </div>
            <label>Apply existing payment</label>
            <div className="story-field payment-field">
              <span className="typed-payment" />
            </div>
            <div className="story-action apply-correction">
              <Check className="correction-check" size={15} />
              <span className="apply-label">Apply correction</span>
              <ArrowRight size={14} />
            </div>
          </Card>
        </div>
        <div className="story-scene">
          <svg
            className="story-connection"
            viewBox="0 0 1000 480"
            preserveAspectRatio="none"
          >
            <path d="M270 240 C420 240 580 240 730 240" pathLength="1" />
          </svg>
          <Card className="story-resolution">
            <span className="story-success">
              <Check size={15} /> Verified across systems
            </span>
            <h3>Northstar is settled.</h3>
            <div className="story-money">
              $0<span>Remaining balance</span>
            </div>
            <div className="story-fact">
              <span>Invoice corrected</span>
              <Check size={15} />
            </div>
            <div className="story-fact">
              <span>Existing payment matched</span>
              <Check size={15} />
            </div>
            <div className="story-fact">
              <Brand name="Jira" />
              <span>AR–1042 closed</span>
              <Check size={15} />
            </div>
          </Card>
          <Card>
            <Brand name="Slack" />
            <h3>Your team gets the result.</h3>
            <span className="story-record">#finance · Peeblo</span>
            <p className="typed-slack story-message">
              Northstar is reconciled. Applied the $3,000 credit under policy
              and matched the existing $15,000 payment. Balance verified: $0.
              Evidence attached; Jira case closed.
            </p>
            <div className="story-attachment">
              ↳ INV–1042 · Resolution record
            </div>
            <div className="story-action slack-post">
              <span className="slack-post-label">Post update</span>
              <ArrowRight size={14} />
            </div>
          </Card>
          <div className="story-final-check">
            <Check size={14} /> Resolved, verified, and reported.
          </div>
        </div>
        <div className="story-cursor">
          <span className="story-click" />
          <svg
            className="story-pointer"
            width="23"
            height="29"
            viewBox="0 0 23 29"
          >
            <path
              d="M2 2L20 17L12 18L8 26Z"
              fill="#e2f2e7"
              stroke="#16291d"
              strokeWidth="1.5"
            />
          </svg>
          <span className="cursor-label">Peeblo</span>
        </div>
      </div>
      <p className="story-sr">
        Illustrative Northstar case: Peeblo finds an overdue $18,000 invoice,
        checks a signed $15,000 agreement and existing payment, applies an
        authorized $3,000 credit, verifies a zero balance, closes the Jira case
        and reports in Slack.
      </p>
    </div>
  );
}
