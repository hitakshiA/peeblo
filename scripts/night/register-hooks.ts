// Points Stripe (test mode) and PagerDuty at Peeblo's provider endpoints (/hooks/source/<name>) once, and stores
// each service's signing secret in .env as PEEBLO_HOOK_SECRET_<NAME>. Idempotent: an existing endpoint for the
// same URL is kept (its secret can't be read back, so if .env lacks it the endpoint is replaced). Prints no secrets.
//   node scripts/night/register-hooks.ts
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRETS = process.env.PEEBLO_SECRETS_DIR ?? join(import.meta.dirname, "..", "..", "..", "peeblo", "local", "secrets");
const ENV = join(import.meta.dirname, "..", "..", ".env");
const env = readFileSync(ENV, "utf8");
const base = /^PEEBLO_PUBLIC_URL=(.+)$/m.exec(env)?.[1]?.trim();
if (!base) throw new Error("PEEBLO_PUBLIC_URL is not set");
const key = (f: string) => readFileSync(join(SECRETS, f), "utf8").trim();
const setEnv = (name: string, value: string) => {
  const text = readFileSync(ENV, "utf8");
  if (new RegExp(`^${name}=`, "m").test(text)) writeFileSync(ENV, text.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`));
  else appendFileSync(ENV, `\n${name}=${value}\n`);
};

// Stripe (test mode only: refuses a live key).
{
  const sk = key("stripe-test-secret.key");
  if (!sk.startsWith("sk_test_") && !sk.startsWith("rk_test_")) throw new Error("not a Stripe test key");
  const url = `${base}/hooks/source/stripe`;
  const auth = { authorization: `Bearer ${sk}` };
  const list = await (await fetch("https://api.stripe.com/v1/webhook_endpoints?limit=100", { headers: auth })).json() as any;
  const existing = (list.data ?? []).filter((e: any) => e.url === url);
  if (existing.length && /^PEEBLO_HOOK_SECRET_STRIPE=whsec_/m.test(env)) console.log(`stripe: kept ${existing[0].id}`);
  else {
    for (const e of existing) await fetch(`https://api.stripe.com/v1/webhook_endpoints/${e.id}`, { method: "DELETE", headers: auth });
    const events = ["charge.dispute.created", "charge.dispute.updated", "charge.refunded", "invoice.payment_failed", "invoice.paid", "customer.subscription.deleted", "customer.subscription.updated", "payment_intent.payment_failed"];
    const body = new URLSearchParams({ url, description: "Peeblo triggers (test)" });
    events.forEach((ev, i) => body.append(`enabled_events[${i}]`, ev));
    const r = await (await fetch("https://api.stripe.com/v1/webhook_endpoints", { method: "POST", headers: auth, body })).json() as any;
    if (!r.secret) throw new Error(`stripe: ${r.error?.message ?? "no secret returned"}`);
    setEnv("PEEBLO_HOOK_SECRET_STRIPE", r.secret);
    console.log(`stripe: made ${r.id} (${events.length} event types, livemode ${r.livemode})`);
  }
}

// PagerDuty (v3 webhook subscription on the account).
{
  const token = key("pagerduty.token");
  const url = `${base}/hooks/source/pagerduty`;
  const h = { authorization: `Token token=${token}`, accept: "application/vnd.pagerduty+json;version=2", "content-type": "application/json" };
  const list = await (await fetch("https://api.pagerduty.com/webhook_subscriptions?limit=100", { headers: h })).json() as any;
  const existing = (list.webhook_subscriptions ?? []).filter((w: any) => w.delivery_method?.url === url);
  if (existing.length && /^PEEBLO_HOOK_SECRET_PAGERDUTY=./m.test(env)) console.log(`pagerduty: kept ${existing[0].id}`);
  else {
    for (const w of existing) await fetch(`https://api.pagerduty.com/webhook_subscriptions/${w.id}`, { method: "DELETE", headers: h });
    const r = await (await fetch("https://api.pagerduty.com/webhook_subscriptions", { method: "POST", headers: h, body: JSON.stringify({ webhook_subscription: {
      type: "webhook_subscription", description: "Peeblo triggers", delivery_method: { type: "http_delivery_method", url },
      events: ["incident.triggered", "incident.acknowledged", "incident.resolved", "incident.escalated", "incident.annotated"],
      filter: { type: "account_reference" },
    } }) })).json() as any;
    const secret = r.webhook_subscription?.delivery_method?.secret;
    if (!secret) throw new Error(`pagerduty: ${JSON.stringify(r.error ?? r).slice(0, 200)}`);
    setEnv("PEEBLO_HOOK_SECRET_PAGERDUTY", secret);
    console.log(`pagerduty: made ${r.webhook_subscription.id}`);
  }
}
