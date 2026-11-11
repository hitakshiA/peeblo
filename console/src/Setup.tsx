// First-run setup: everything a new owner needs, in the browser, in order. Each step reads live state from
// GET /v1/setup/state; `next` says which one to do now, and done steps can be opened again.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, STEPS, friendly, get, money, post, when, type SetupState, type StepId } from "./api";
import { Face, PEEBLO_FACE } from "./Face";

// ---- state ---------------------------------------------------------------------------------------------------------

export type Setup = {
  state: SetupState | null;
  signedIn: boolean;
  person: string | null;
  /** false when this core has no /v1/setup/state yet (an older build): the console then works as before. */
  available: boolean;
  /** true when the state needs a sign-in to read (a password exists). */
  locked: boolean;
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
};

export function useSetup(): Setup {
  const [state, setState] = useState<SetupState | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const [s, me] = await Promise.allSettled([
      get<SetupState>("/v1/setup/state"),
      get<{ person: { display_name: string | null } | null }>("/v1/console/me"),
    ]);
    if (s.status === "fulfilled") {
      setState(s.value);
      setAvailable(true);
      setLocked(false);
      setError(null);
    } else if (s.reason instanceof ApiError && s.reason.status === 401) {
      setLocked(true);
      setError(null);
    } else if (s.reason instanceof ApiError && s.reason.status === 404) {
      setAvailable(false);
      setError(null);
    } else setError(friendly(s.reason));
    setSignedIn(me.status === "fulfilled");
    setPerson(me.status === "fulfilled" ? (me.value.person?.display_name ?? null) : null);
    setLoaded(true);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { state, signedIn, person, available, locked, error, loaded, reload };
}

// Waits for core to come back after a restart: first for it to go down (or a few seconds), then for /healthz to answer.
async function waitForCore(alive: () => boolean, onSlow: () => void): Promise<void> {
  const t0 = Date.now();
  let sawDown = false;
  let slow = false;
  while (alive()) {
    await new Promise((r) => setTimeout(r, 1000));
    const up = await fetch("/healthz", { cache: "no-store" }).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) sawDown = true;
    else if (sawDown || Date.now() - t0 > 5000) return;
    if (!slow && Date.now() - t0 > 30_000) {
      slow = true;
      onSlow();
    }
  }
}

// ---- small pieces --------------------------------------------------------------------------------------------------

const Ext = ({ href, children, className = "btn ghost" }: { href?: string | null; children: ReactNode; className?: string }) =>
  href ? (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
      <span className="ext" aria-hidden="true">
        ↗
      </span>
    </a>
  ) : null;
const Dot = ({ ok }: { ok: boolean | null | undefined }) => (
  <span className={`dot ${ok === true ? "ok" : ok === false ? "bad" : ""}`} aria-hidden="true" />
);
const Err = ({ msg }: { msg: string | null | undefined }) =>
  msg ? (
    <div className="err" role="alert">
      {msg}
    </div>
  ) : null;
const Head = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="step-head">
    <h2>{title}</h2>
    {children && <p className="lead">{children}</p>}
  </div>
);
const Status = ({ ok, children }: { ok: boolean | null; children: ReactNode }) => (
  <div className={`status ${ok === true ? "ok" : ok === false ? "bad" : ""}`}>
    <Dot ok={ok} />
    <div>{children}</div>
  </div>
);
// A fixed list written in the page itself: its order never changes, so the position is a stable key.
const Howto = ({ steps }: { steps: ReactNode[] }) => (
  <ol className="howto">
    {steps.map((s, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: static list
      <li key={i}>{s}</li>
    ))}
  </ol>
);

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setErr(null);
    try {
      return await f();
    } catch (e) {
      setErr(friendly(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, setErr, run };
}

// ---- sign in -------------------------------------------------------------------------------------------------------

function LoginForm({ onIn }: { onIn: () => void }) {
  const [pw, setPw] = useState("");
  const { busy, err, run } = useBusy();
  const go = (e: FormEvent) => {
    e.preventDefault();
    run(() =>
      post("/v1/console/login", { password: pw }).catch((x) => {
        throw x instanceof ApiError && x.status === 401 ? new ApiError(400, "That password isn't right.") : x;
      }),
    ).then((r) => {
      if (r) onIn();
    });
  };
  return (
    <form className="stack" onSubmit={go}>
      <label>
        Console password
        <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      </label>
      <Err msg={err} />
      <div>
        <button type="submit" className="moss" disabled={busy || !pw}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}

export function Login({ onIn }: { onIn: () => void }) {
  return (
    <div className="login">
      <div className="card stack">
        <div className="brand">
          <Face slug="peeblo" face={PEEBLO_FACE} size={34} />
          peeblo
        </div>
        <p className="muted">The console runs on your machine, never on the public address.</p>
        <LoginForm onIn={onIn} />
      </div>
    </div>
  );
}

// Connect Otari: one sign-in to the owner's Otari dashboard. The password is used once and never stored; Peeblo keeps
// the session (sealed) and sets itself up with it.
export function ConnectOtari({ onDone, compact = false }: { onDone: () => void; compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, err, setErr, run } = useBusy();
  const [msg, setMsg] = useState<string | null>(null);
  const go = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    run(() => post<any>("/v1/otari/session", { email, password })).then((r) => {
      if (!r) return;
      if (r.ok === false) return setErr(r.error ? friendly(new ApiError(400, r.error)) : "Otari didn't accept that sign-in.");
      setPassword("");
      const keys =
        typeof r.teammate_keys === "number"
          ? ` ${r.teammate_keys} teammate key${r.teammate_keys === 1 ? "" : "s"} with spend ceilings.`
          : "";
      setMsg(`Connected. Peeblo is setting itself up in your Otari.${keys}`);
      onDone();
    });
  };
  return (
    <form className={compact ? "stack" : "card stack"} onSubmit={go}>
      {!compact && (
        <>
          <h3>Connect Otari</h3>
          <div className="muted">
            Sign in once with your Otari dashboard login. Peeblo sets up its routing, a key and budget per teammate, the guardrail, and
            connector access for you. The password isn't stored.
          </div>
        </>
      )}
      <div className="form two">
        <label>
          Otari email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Otari password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <Err msg={err} />
      {msg && <Status ok>{msg}</Status>}
      <div>
        <button type="submit" className="moss" disabled={busy || !email || !password}>
          {busy ? "Connecting…" : "Connect Otari"}
        </button>
      </div>
    </form>
  );
}

// ---- steps ---------------------------------------------------------------------------------------------------------

type StepProps = { s: SetupState; reload: () => Promise<void>; advance: () => void; restart: (note?: string) => void };
const Continue = ({ advance, label = "Continue" }: { advance: () => void; label?: string }) => (
  <div className="step-foot">
    <button type="button" className="moss" onClick={advance}>
      {label}
    </button>
  </div>
);

function PasswordStep({ s, signedIn, reload, advance }: StepProps & { signedIn: boolean }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const { busy, err, setErr, run } = useBusy();
  if (signedIn)
    return (
      <>
        <Head title="Console password">This console is yours: it runs on your machine and asks for this password.</Head>
        <Status ok>You're signed in.</Status>
        <Continue advance={advance} />
      </>
    );
  if (s.password_set)
    return (
      <>
        <Head title="Welcome back">Sign in to carry on where you left off.</Head>
        <LoginForm
          onIn={() => {
            reload();
            advance();
          }}
        />
      </>
    );
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return setErr("Use at least 8 characters.");
    if (pw !== again) return setErr("The two passwords don't match.");
    run(() => post("/v1/setup/password", { password: pw })).then((r) => {
      if (r) {
        reload();
        advance();
      }
    });
  };
  return (
    <>
      <Head title="Choose a console password">
        This console runs on your machine and never on the public address. The password keeps it yours.
      </Head>
      <form className="stack" onSubmit={go}>
        <div className="form two">
          <label>
            Password
            <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          </label>
          <label>
            Again, to confirm
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
        </div>
        <Err msg={err} />
        <div>
          <button type="submit" className="moss" disabled={busy || !pw || !again}>
            {busy ? "Saving…" : "Set password"}
          </button>
        </div>
      </form>
    </>
  );
}

function OtariStep({ s, reload, advance, restart }: StepProps) {
  const o = s.otari;
  const [key, setKey] = useState("");
  const [region, setRegion] = useState((o.region || "us").toLowerCase());
  // Otari keys name their region (otk_v1_us_…); the menu only shows for a key that doesn't.
  const keyRegion = key.trim().match(/^otk_v\d+_(us|eu)_/)?.[1];
  const { busy, err, setErr, run } = useBusy();
  const go = (e: FormEvent) => {
    e.preventDefault();
    run(() =>
      post<{ ok: boolean; error?: string; restarting?: boolean; region?: string }>("/v1/setup/otari", {
        key: key.trim(),
        region: keyRegion ?? region,
      }),
    ).then((r) => {
      if (!r) return;
      if (!r.ok) return setErr(r.error ? friendly(new ApiError(400, r.error)) : "Otari didn't accept that key.");
      setKey("");
      if (r.restarting) restart(`The key works (Otari ${(r.region ?? "us").toUpperCase()}).`);
      else {
        reload();
        advance();
      }
    });
  };
  return (
    <>
      <Head title="Your Otari key">
        Otari is the gateway every model, tool and budget goes through. Peeblo needs one service key to reach it; it stays on this machine,
        in a settings file only Peeblo can read.
      </Head>
      {o.key_set &&
        (o.key_ok ? (
          <Status ok>
            The key works{o.org ? ` for ${o.org}` : ""}.
            {o.used_usd != null && (
              <span className="muted">
                {" "}
                {money(o.used_usd)}
                {o.limit_usd != null ? ` of ${money(o.limit_usd)}` : ""} used.
              </span>
            )}
          </Status>
        ) : (
          <Status ok={false}>
            {o.key_error ? friendly(new ApiError(400, o.key_error)) : "The saved key doesn't work. Paste a new one."}
          </Status>
        ))}
      <Howto
        steps={[
          <>
            In Otari's dashboard, open <b>API keys</b> and choose <b>Create key</b>.
          </>,
          <>
            Name it (say, peeblo), open <b>Advanced</b> and tick <b>Service key</b>. A service key lets Otari bill and cap each person
            separately.
          </>,
          <>
            Leave the budget fields as they are: when you connect in the next step, Peeblo gives each person $2 a day, which you can change
            in Otari's Budgets.
          </>,
          <>
            Choose <b>Create key</b>, copy the key and paste it below.
          </>,
        ]}
      />
      <div>
        <Ext href={o.links?.keys}>Open Otari API keys</Ext>
      </div>
      <form className="stack" onSubmit={go}>
        <div className="form key">
          <label>
            Service key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={o.key_set ? "Paste a new key to replace it" : "Paste your key"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          {!keyRegion && (
            <label>
              Region
              <select value={region} onChange={(e) => setRegion(e.target.value)}>
                <option value="us">US</option>
                <option value="eu">EU</option>
              </select>
            </label>
          )}
        </div>
        <Err msg={err} />
        <div className="row">
          <button type="submit" className="moss" disabled={busy || !key.trim()}>
            {busy ? "Checking…" : "Save key"}
          </button>
          {o.key_set && o.key_ok && (
            <button type="button" className="ghost" onClick={advance}>
              Keep the current key
            </button>
          )}
        </div>
      </form>
    </>
  );
}

function ConnectStep({ s, reload, advance }: StepProps) {
  const o = s.otari;
  const [again, setAgain] = useState(false);
  return (
    <>
      <Head title="Connect your Otari dashboard">
        The service key can call models, but it can't make keys, budgets or routing. Sign in once with your Otari dashboard login and Peeblo
        sets those up for you: a key and budget per teammate, a budget per person, its model routing, the guardrail, and connector access.
      </Head>
      <div className="muted">
        The password is used for this one sign-in and isn't stored. Peeblo keeps the session (about a week) sealed on this machine and asks
        again when it ends. Signed up with Google or GitHub?{" "}
        <Ext className="" href={o.links?.set_password}>
          Set an Otari password
        </Ext>{" "}
        first (same email).
      </div>
      {o.connected && !again ? (
        <>
          <Status ok>
            Connected
            {o.signed_in_as ? (
              <>
                {" "}
                as <b>{o.signed_in_as}</b>
              </>
            ) : null}
            {o.session_expires_at ? `, until ${when(o.session_expires_at)}` : ""}.
          </Status>
          <div className="step-foot">
            <button type="button" className="moss" onClick={advance}>
              Continue
            </button>
            <button type="button" className="ghost" onClick={() => setAgain(true)}>
              Sign in again
            </button>
          </div>
        </>
      ) : (
        <ConnectOtari
          compact
          onDone={() => {
            setAgain(false);
            reload().then(advance);
          }}
        />
      )}
    </>
  );
}

function ReadinessStep({ s, reload, advance, restart }: StepProps) {
  const [busy, setBusy] = useState(false);
  const switchGuard = (mode: string) => {
    setBusy(true);
    post<{ ok: boolean; restarting?: boolean }>("/v1/setup/guard", { mode })
      .then((r) => {
        if (r?.restarting) restart(mode === "open" ? "Switched to the open guard model." : "Switched to Lakera.");
      })
      .finally(() => setBusy(false));
  };
  const items = s.readiness ?? [];
  const ready = items.filter((i) => i.ok === true).length;
  const passed = STEPS.indexOf(s.next) > STEPS.indexOf("readiness");
  const check = () => {
    setBusy(true);
    reload().finally(() => setBusy(false));
  };
  return (
    <>
      <Head title="Your Otari checklist">A few things only you can switch on in Otari. Fix any that aren't ready, then check again.</Head>
      {items.length === 0 ? (
        <Status ok={null}>Connect Otari first, then this list fills in.</Status>
      ) : (
        <>
          <div className="muted">
            {ready} of {items.length} ready
          </div>
          <ul className="checklist">
            {items.map((i) => (
              <li key={i.id} className={i.ok === false ? "todo" : ""}>
                <Dot ok={i.ok} />
                <div className="check-text">
                  <b>{i.label}</b>
                  {i.detail && <span className="muted">{i.detail}</span>}
                </div>
                {i.ok !== true && i.fix_url && (
                  <Ext href={i.fix_url} className="btn ghost small">
                    {i.fix_text || "Fix in Otari"}
                  </Ext>
                )}
                {(i as any).alt && (
                  <button type="button" className="ghost small" disabled={busy} onClick={() => switchGuard((i as any).alt.mode)}>
                    {(i as any).alt.text}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="step-foot">
        <button type="button" className={passed ? "ghost" : "moss"} disabled={busy} onClick={check}>
          {busy ? "Checking…" : "Check again"}
        </button>
        {passed && (
          <button type="button" className="moss" onClick={advance}>
            Continue
          </button>
        )}
      </div>
    </>
  );
}

function PublicUrlStep({ s, reload, advance, restart }: StepProps) {
  const p = s.public_url;
  const [url, setUrl] = useState(p.value ?? "");
  const [warn, setWarn] = useState<string | null>(null);
  const { busy, err, setErr, run } = useBusy();
  const go = (e: FormEvent) => {
    e.preventDefault();
    setWarn(null);
    run(() =>
      post<{ ok: boolean; reachable?: boolean; error?: string; restarting?: boolean }>("/v1/setup/public-url", { url: url.trim() }),
    ).then((r) => {
      if (!r) return;
      if (!r.ok) return setErr(r.error ? friendly(new ApiError(400, r.error)) : "That address didn't work.");
      if (r.restarting) return restart();
      if (!r.reachable) {
        setWarn(`Saved, but Slack can't reach it yet${r.error ? `: ${r.error.replace(/\.$/, "")}` : ""}.`);
        reload();
        return;
      }
      reload();
      advance();
    });
  };
  return (
    <>
      <Head title="A public address">
        Slack must be able to reach Peeblo, so Peeblo needs one public HTTPS address. Only Slack's messages and sign-ins use it; this
        console stays private on your machine.
      </Head>
      {p.value ? (
        <Status ok={p.reachable}>
          <span className="mono">{p.value}</span>{" "}
          <span className="muted">
            {p.reachable ? "Slack can reach it." : `Slack can't reach it yet${p.error ? `: ${p.error.replace(/\.$/, "")}` : ""}.`}
          </span>
        </Status>
      ) : (
        <Status ok={null}>No public address yet.</Status>
      )}
      {p.hint && <div className="tip">{p.hint}</div>}
      <form className="stack" onSubmit={go}>
        <label>
          Public address
          <input
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder="https://peeblo.example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <Err msg={err} />
        {warn && <Status ok={false}>{warn}</Status>}
        <div className="row">
          <button type="submit" className="moss" disabled={busy || !url.trim()}>
            {busy ? "Testing…" : "Test and save"}
          </button>
          {p.value && p.reachable && (
            <button type="button" className="ghost" onClick={advance}>
              Keep this address
            </button>
          )}
        </div>
      </form>
    </>
  );
}

function SlackStep({ s, reload, advance }: StepProps) {
  const sl = s.slack;
  const tokenOk = sl.token_set && sl.token_ok;
  const [replace, setReplace] = useState(false);
  const [access, setAccess] = useState("");
  const [refresh, setRefresh] = useState("");
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const tok = useBusy();
  const app = useBusy();

  // While the install link is out, watch for Peeblo arriving in Slack.
  const waiting = tokenOk && sl.app_created && !sl.installed;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      reload();
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, reload]);

  const saveToken = (e: FormEvent) => {
    e.preventDefault();
    tok
      .run(() => post<{ ok: boolean; error?: string }>("/v1/setup/slack", { access_token: access.trim(), refresh_token: refresh.trim() }))
      .then((r) => {
        if (!r) return;
        if (!r.ok) return tok.setErr(r.error ? friendly(new ApiError(400, r.error)) : "Slack didn't accept those tokens.");
        setAccess("");
        setRefresh("");
        setReplace(false);
        reload();
      });
  };
  const createApp = () =>
    app
      .run(() => post<{ install_url: string }>("/v1/setup/slack-app"))
      .then((r) => {
        if (r) {
          setInstallUrl(r.install_url);
          reload();
        }
      });
  const admins = (s.admins ?? []).map((a) => a.display_name).filter(Boolean);

  return (
    <>
      <Head title="Add Peeblo to Slack">Peeblo makes its own Slack app. It needs a configuration token from Slack to do that, once.</Head>
      {tokenOk && !replace ? (
        <Status ok>
          Slack token saved
          {sl.workspace ? (
            <>
              {" "}
              for <b>{sl.workspace}</b>
            </>
          ) : null}
          .{" "}
          <button type="button" className="linkish" onClick={() => setReplace(true)}>
            Replace it
          </button>
        </Status>
      ) : (
        <>
          {sl.token_set && !sl.token_ok && <Status ok={false}>Slack didn't accept the saved token. Generate a new one.</Status>}
          <Howto
            steps={[
              <>Open Slack's app page.</>,
              <>
                Under <b>Your App Configuration Tokens</b>, choose <b>Generate Token</b> and pick your workspace.
              </>,
              <>
                Copy both tokens here. Already have a token for this workspace (Generate is greyed out)? Use its two <b>Copy</b> buttons.
              </>,
            ]}
          />
          <div>
            <Ext href="https://api.slack.com/apps">Open Slack apps</Ext>
          </div>
          <form className="stack" onSubmit={saveToken}>
            <div className="form two">
              <label>
                Access token
                <input type="password" autoComplete="off" spellCheck={false} value={access} onChange={(e) => setAccess(e.target.value)} />
              </label>
              <label>
                Refresh token
                <input type="password" autoComplete="off" spellCheck={false} value={refresh} onChange={(e) => setRefresh(e.target.value)} />
              </label>
            </div>
            <Err msg={tok.err} />
            <div className="row">
              <button type="submit" className="moss" disabled={tok.busy || !access.trim() || !refresh.trim()}>
                {tok.busy ? "Checking…" : "Save tokens"}
              </button>
              {replace && (
                <button type="button" className="ghost" onClick={() => setReplace(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        </>
      )}

      {tokenOk && !replace && (
        <div className="slack-stage">
          {!sl.app_created && (
            <>
              <button type="button" className="big moss" disabled={app.busy} onClick={createApp}>
                {app.busy ? "Creating Peeblo's app…" : "Create Peeblo's Slack app"}
              </button>
              <Err msg={app.err} />
            </>
          )}
          {sl.app_created && !sl.installed && (
            <>
              <Ext href={sl.install_url ?? installUrl} className="btn big moss">
                Add Peeblo to Slack
              </Ext>
              <div className="muted">The person who adds Peeblo becomes its first admin.</div>
              <div className="waiting">
                <span className="pulse" aria-hidden="true" />
                After you allow it in Slack, this page moves on by itself.
              </div>
            </>
          )}
          {sl.installed && (
            <>
              <div className="arrived">
                <Face slug="peeblo" face={PEEBLO_FACE} size={64} mood="happy" />
                <div>
                  <b>Peeblo is in Slack: it's sent you a DM.</b>
                  {admins.length > 0 && <div className="muted">Admin: {admins.join(", ")}</div>}
                </div>
              </div>
              <div className="step-foot">
                {sl.peeblo_dm_url && (
                  <Ext href={sl.peeblo_dm_url} className="btn moss">
                    Open Peeblo in Slack
                  </Ext>
                )}
                <button type="button" className={sl.peeblo_dm_url ? "ghost" : "moss"} onClick={advance}>
                  Continue
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

function DoneStep({ s }: StepProps) {
  return (
    <div className="done-step">
      <Face slug="peeblo" face={PEEBLO_FACE} size={128} mood="happy" />
      <h2>You're all set.</h2>
      <p className="lead">Peeblo is in Slack and ready to hire your crew.</p>
      <ol className="next-cards">
        <li className="card">
          <div>
            <h3>Hire your first teammate</h3>
            <p className="muted">
              DM Peeblo in Slack: “I need a teammate who…”. It proposes the role, tools and budget, and you approve its ID card.
            </p>
          </div>
          <div className="row">
            {s.slack.peeblo_dm_url ? (
              <Ext href={s.slack.peeblo_dm_url} className="btn moss">
                Open Peeblo in Slack
              </Ext>
            ) : (
              <span className="muted">Find Peeblo under Apps in Slack.</span>
            )}
          </div>
        </li>
        <li className="card">
          <div>
            <h3>Add connectors</h3>
            <p className="muted">
              Add the services your teammates use, like Linear, GitHub or Notion, in Otari. Then give one to a teammate by asking Peeblo.
            </p>
          </div>
          <div className="row">
            <Ext href={s.otari.links?.mcp}>Add in Otari</Ext>
            <a className="btn ghost" href="#/connectors">
              Your connectors
            </a>
          </div>
        </li>
        <li className="card">
          <div>
            <h3>Meet your crew</h3>
            <p className="muted">See every teammate, talk to one, and read what each job cost.</p>
          </div>
          <div className="row">
            <a className="btn ghost" href="#/crew">
              Open the console
            </a>
          </div>
        </li>
      </ol>
    </div>
  );
}

// ---- the wizard ----------------------------------------------------------------------------------------------------

const LABELS: Record<StepId, [string, string]> = {
  password: ["Console password", "Keeps this console yours"],
  otari: ["Otari key", "One service key"],
  connect: ["Connect Otari", "Sign in once"],
  readiness: ["Otari checklist", "What to switch on"],
  public_url: ["Public address", "So Slack can reach Peeblo"],
  slack: ["Slack", "Add Peeblo to your workspace"],
  done: ["Done", "What's next"],
};

export function Wizard({ setup }: { setup: Setup }) {
  const { state: s, signedIn, reload, error } = setup;
  const [sel, setSel] = useState<StepId | null>(null);
  const [restarting, setRestarting] = useState<"no" | "yes" | "slow">("no");
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const panel = useRef<HTMLElement>(null);

  const restart = (n?: string) => {
    setNote(n ?? null);
    setRestarting("yes");
    waitForCore(
      () => alive.current,
      () => setRestarting("slow"),
    ).then(async () => {
      await reload();
      setSel(null);
      setRestarting("no");
      setNote(null);
    });
  };

  if (!s)
    return (
      <div className="setup">
        <div className="setup-empty card stack">
          <Face slug="peeblo" face={PEEBLO_FACE} size={72} mood="thinking" />
          <Err msg={error ?? "Couldn't load setup."} />
          <div>
            <button type="button" className="moss" onClick={() => reload()}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );

  const next: StepId = signedIn ? s.next : "password";
  const nextIdx = STEPS.indexOf(s.next);
  const current: StepId = signedIn ? (sel ?? next) : "password";
  const advance = () => {
    setSel(null);
    panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const props: StepProps = { s, reload, advance, restart };
  const finished = s.next === "done";

  return (
    <div className="setup">
      <header className="setup-top">
        <span className="brand">
          <Face slug="peeblo" face={PEEBLO_FACE} size={34} />
          peeblo
        </span>
        {signedIn && (
          <a className={finished ? "btn ghost" : "quiet"} href="#/crew">
            {finished ? "Open the console" : "Skip to the console"}
          </a>
        )}
      </header>
      <div className="setup-body">
        <aside className="steps">
          <div className="hello">
            <Face slug="peeblo" face={PEEBLO_FACE} size={88} mood={restarting !== "no" ? "thinking" : finished ? "happy" : "idle"} />
            <div>
              <h1>{finished ? "All set." : "Let's set me up."}</h1>
              <p className="muted">{finished ? "You can open any step again." : "A few short steps, all in your browser."}</p>
            </div>
          </div>
          <ol className="step-list">
            {STEPS.map((id, i) => {
              const done = signedIn ? i < nextIdx || (id === "done" && finished) : id !== "password" && i < nextIdx;
              const isNext = id === next;
              const open = signedIn ? done || isNext : id === "password";
              const mark = done ? "✓" : String(i + 1);
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={`step ${current === id ? "on" : ""} ${done ? "done" : isNext ? "next" : "todo"}`}
                    disabled={!open || restarting !== "no"}
                    onClick={() => setSel(id === next ? null : id)}
                    aria-current={current === id ? "step" : undefined}
                  >
                    <span className="mark" aria-hidden="true">
                      {mark}
                    </span>
                    <span className="step-label">
                      {LABELS[id][0]}
                      <small>{LABELS[id][1]}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
        <section ref={panel} className="step-panel card" aria-live="polite">
          {restarting !== "no" ? (
            <div className="restarting">
              <Face slug="peeblo" face={PEEBLO_FACE} size={72} mood="thinking" />
              {note && <Status ok>{note}</Status>}
              <h2>Restarting Peeblo…</h2>
              <p className="muted">
                {restarting === "slow"
                  ? "Still restarting. Keep this page open; it carries on when Peeblo is back."
                  : "This takes a few seconds."}
              </p>
            </div>
          ) : (
            <>
              {current === "password" && <PasswordStep {...props} signedIn={signedIn} />}
              {current === "otari" && <OtariStep {...props} />}
              {current === "connect" && <ConnectStep {...props} />}
              {current === "readiness" && <ReadinessStep {...props} />}
              {current === "public_url" && <PublicUrlStep {...props} />}
              {current === "slack" && <SlackStep {...props} />}
              {current === "done" && <DoneStep {...props} />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
