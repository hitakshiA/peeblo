// A person's own Otari account. Otari's app sign-in (OAuth with PKCE, Otari 0.54+) lets any site ask a signed-in
// person for an API key: they approve on otari.ai, pick a workspace and, if they like, a spending limit and an
// expiry, and Otari issues a key that is theirs, listed on their keys page as "<Peeblo's host> (OAuth)".
// Peeblo is an unregistered app there, named by its public origin. With the key, that person's model calls go
// out on their own account: billed to it, held to its budgets, and not counted against the team's money. Tools
// (connectors, web pages Peeblo reads, the guardrail's screening) stay on the team's keys.
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.ts";
import { seal, unseal } from "../crypto.ts";
import { pool } from "../db.ts";

const CALLBACK_PATH = "/otari/callback"; // served by src/ingress/slack.ts
const LINK_MINUTES = 15;

// Otari wants the client id written exactly as a browser writes location.origin.
export function clientId(publicUrl = config.publicUrl): string | null {
  try {
    return publicUrl ? new URL(publicUrl).origin : null;
  } catch {
    return null;
  }
}
const redirectUri = () => `${clientId()}${CALLBACK_PATH}`;
// The authorization server: the API origin, without /api/v1.
const apiOrigin = () => new URL(config.otariBaseUrl).origin;
const b64url = (b: Buffer) => b.toString("base64url");
export const challengeFor = (verifier: string) => b64url(createHash("sha256").update(verifier, "ascii").digest());

// Starts a sign-in for this person and returns the otari.ai link to open. The link names Peeblo's suggestions
// for the key's limit and expiry; the person can change either on Otari's consent screen.
export async function startConnect(personId: string, suggest: { limitUsd?: number; expiration?: string } = {}): Promise<string> {
  const cid = clientId();
  if (!cid) throw new Error("Peeblo has no public address (PEEBLO_PUBLIC_URL), so Otari has nowhere to send the person back to");
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  await pool.query("DELETE FROM otari_connects WHERE created_at < now() - make_interval(mins => $1)", [LINK_MINUTES]);
  await pool.query("INSERT INTO otari_connects (state, person_id, verifier) VALUES ($1, $2, $3)", [state, personId, seal(verifier)]);
  const q = new URLSearchParams({
    client_id: cid,
    redirect_uri: redirectUri(),
    response_type: "code",
    state,
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
    ...(suggest.limitUsd ? { limit: suggest.limitUsd.toFixed(2) } : {}),
    expiration: suggest.expiration ?? "30-days",
  });
  return `${apiOrigin()}/api/v1/oauth/apps/authorize?${q}`;
}

export type Finished = { ok: true; personId: string } | { ok: false; personId: string | null; why: string };

// Otari sends the browser back here with code, state and iss (or error=access_denied when the person cancelled).
export async function finishConnect(params: URLSearchParams): Promise<Finished> {
  const state = params.get("state") ?? "";
  const { rows } = await pool.query<{ person_id: string; verifier: Buffer; fresh: boolean }>(
    `DELETE FROM otari_connects WHERE state = $1
     RETURNING person_id, verifier, created_at > now() - make_interval(mins => $2) AS fresh`,
    [state, LINK_MINUTES],
  );
  const pending = rows[0];
  if (!pending)
    return { ok: false, personId: null, why: "This sign-in link was already used or isn't Peeblo's. Ask Peeblo for a new one." };
  if (!pending.fresh) return { ok: false, personId: pending.person_id, why: "This sign-in link expired. Ask Peeblo for a new one." };
  if (params.get("error"))
    return {
      ok: false,
      personId: pending.person_id,
      why:
        params.get("error") === "access_denied"
          ? "You cancelled on otari.ai, so nothing was connected."
          : `Otari said: ${params.get("error")}.`,
    };
  // The issuer must be Otari's: a code that came from anywhere else is not spent.
  if (params.get("iss") !== (await issuer()))
    return { ok: false, personId: pending.person_id, why: "The sign-in came back from somewhere other than Otari, so it wasn't used." };
  const code = params.get("code");
  if (!code) return { ok: false, personId: pending.person_id, why: "Otari sent no sign-in code back." };
  const r = await fetch(`${apiOrigin()}/api/v1/oauth/apps/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId()!,
      redirect_uri: redirectUri(),
      code,
      code_verifier: unseal<string>(pending.verifier),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.access_token !== "string")
    return {
      ok: false,
      personId: pending.person_id,
      why: `Otari didn't issue a key: ${j.error_description ?? j.error ?? `HTTP ${r.status}`}.`,
    };
  await pool.query(
    `INSERT INTO person_otari (person_id, key, key_hint, scope, manage_url) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (person_id) DO UPDATE SET key = EXCLUDED.key, key_hint = EXCLUDED.key_hint, scope = EXCLUDED.scope,
       manage_url = EXCLUDED.manage_url, connected_at = now(), broken = NULL`,
    [pending.person_id, seal(j.access_token), j.access_token.slice(-4), j.scope ?? null, j.manage_url ?? null],
  );
  cache.delete(pending.person_id);
  return { ok: true, personId: pending.person_id };
}

// What Otari names as the issuer for Peeblo's client (its public origin, which differs from the API host).
let issuerSeen: string | null = null;
async function issuer(): Promise<string> {
  if (issuerSeen) return issuerSeen;
  const q = new URLSearchParams({ client_id: clientId()!, redirect_uri: redirectUri() });
  const r = await fetch(`${apiOrigin()}/api/v1/oauth/apps/clients?${q}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.issuer !== "string") throw new Error(`Otari didn't describe Peeblo as an app (HTTP ${r.status})`);
  issuerSeen = j.issuer;
  return j.issuer;
}

export type OwnAccount = { key: string; hint: string; manageUrl: string | null; connectedAt: string; broken: string | null };
const cache = new Map<string, { at: number; v: OwnAccount | null }>();

export async function ownAccount(personId: string): Promise<OwnAccount | null> {
  const hit = cache.get(personId);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const { rows } = await pool.query("SELECT key, key_hint, manage_url, connected_at, broken FROM person_otari WHERE person_id = $1", [
    personId,
  ]);
  const r = rows[0];
  const v = r
    ? {
        key: unseal<string>(r.key),
        hint: r.key_hint,
        manageUrl: r.manage_url,
        connectedAt: new Date(r.connected_at).toISOString(),
        broken: r.broken,
      }
    : null;
  cache.set(personId, { at: Date.now(), v });
  return v;
}

// The key a person's model calls go out on: theirs while it works. A key Otari stopped accepting (revoked on their
// keys page, or past its expiry) is set aside, and their calls go back to the team's budget until they reconnect.
async function ownKey(personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const a = await ownAccount(personId);
  return a && !a.broken ? a.key : null;
}

// For work a person started themselves; a schedule or a webhook pays from its own budget, on the team's keys.
const startedBy = new Map<string, boolean>();
export async function ownKeyForRun(personId: string | null, runId: string | null): Promise<string | null> {
  if (!personId || !runId) return null;
  let byPerson = startedBy.get(runId);
  if (byPerson === undefined) {
    const { rows } = await pool
      .query("SELECT s.source FROM runs r JOIN submissions s ON s.id = r.submission_id WHERE r.id = $1", [runId])
      .catch(() => ({ rows: [] as any[] }));
    byPerson = Boolean(rows[0]) && !["schedule", "webhook"].includes(rows[0].source);
    startedBy.set(runId, byPerson);
    if (startedBy.size > 2000) startedBy.delete(startedBy.keys().next().value!);
  }
  return byPerson ? ownKey(personId).catch(() => null) : null;
}

export async function markBroken(personId: string, why: string): Promise<void> {
  await pool.query("UPDATE person_otari SET broken = $2 WHERE person_id = $1", [personId, why.slice(0, 300)]);
  cache.delete(personId);
}

// Revokes the key at Otari (any key may revoke itself) and forgets it.
export async function disconnect(personId: string): Promise<boolean> {
  const a = await ownAccount(personId);
  if (!a) return false;
  await fetch(`${apiOrigin()}/api/v1/oauth/apps/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: a.key, token_type_hint: "access_token" }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => console.error("otari revoke:", (e as Error).message));
  await pool.query("DELETE FROM person_otari WHERE person_id = $1", [personId]);
  cache.delete(personId);
  return true;
}

// Whether Otari's answer means the person's key no longer works (as opposed to a refusal of this one call).
export const keyStopped = (status: number, body: string) =>
  status === 401 || (status === 403 && /revoked|expired|inactive|invalid api key/i.test(body));
