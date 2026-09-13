// Seeds Stripe (test mode) from world.ts. Usage: node seed/apps/stripe.ts [--reset] [--verify]
import { loadEnv, requireEnv } from "../lib/env.ts";
import { request, HttpError } from "../lib/http.ts";
import { Manifest } from "../lib/manifest.ts";
import { PRODUCTS, ACCOUNTS, CONTACTS, SUBSCRIPTIONS, INVOICES, TODAY, lineTotal } from "../world/world.ts";
import type { Account, Invoice } from "../world/types.ts";

const env = loadEnv();
requireEnv(env, "STRIPE_SECRET_KEY");
if (!env.STRIPE_SECRET_KEY.startsWith("sk_test_") && !env.STRIPE_SECRET_KEY.startsWith("rk_test_")) throw new Error("refusing: STRIPE_SECRET_KEY is not a test key");
const m = new Manifest("stripe");
const API = "https://api.stripe.com/v1";

// Flattens nested objects/arrays into Stripe's bracket form encoding.
function flat(obj: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (obj === undefined || obj === null) return out;
  if (Array.isArray(obj)) obj.forEach((v, i) => flat(v, `${prefix}[${i}]`, out));
  else if (typeof obj === "object") for (const [k, v] of Object.entries(obj)) flat(v, prefix ? `${prefix}[${k}]` : k, out);
  else out[prefix] = String(obj);
  return out;
}

function stripe<T = any>(method: string, path: string, params?: Record<string, unknown>, idem?: string): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Stripe-Version": "2024-06-20" };
  if (idem) headers["Idempotency-Key"] = `peeblo-seed-${idem}`;
  const q = method === "GET" && params ? "?" + new URLSearchParams(flat(params)).toString() : "";
  return request<T>(`${API}${path}${q}`, { method, headers, form: method !== "GET" && params ? flat(params) : undefined, label: `${method} ${path}` });
}

async function batch<T>(items: T[], fn: (t: T) => Promise<void>, n = 8) {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map(fn));
}

const cents = (d: number) => Math.round(d * 100);
const ts = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const acct = (k: string) => ACCOUNTS.find((a) => a.key === k)!;
const subFor = (k: string) => SUBSCRIPTIONS.find((s) => s.accountKey === k);
const cardOk = (k: string) => subFor(k)?.paymentMethod === "card_ok";
const cardFails = (k: string) => subFor(k)?.paymentMethod === "card_fails";

async function all(path: string, params: Record<string, unknown> = {}) {
  const out: any[] = [];
  let starting_after: string | undefined;
  for (;;) {
    const r = await stripe("GET", path, { limit: 100, ...params, ...(starting_after ? { starting_after } : {}) });
    out.push(...r.data);
    if (!r.has_more) return out;
    starting_after = r.data[r.data.length - 1].id;
  }
}

// ---------- seed ----------
async function seedProducts() {
  await batch(PRODUCTS, async (p) => {
    const prodId = await m.ensure("product", p.key, async () =>
      (await stripe("POST", "/products", { name: p.name, metadata: { peeblo_key: p.key, sku: p.sku, unit: p.unit } }, `product-${p.key}`)).id);
    await m.ensure("price", p.key, async () =>
      (await stripe("POST", "/prices", {
        product: prodId, currency: "usd", unit_amount_decimal: String(p.unitAmount * 100),
        ...(p.recurring ? { recurring: { interval: p.recurring } } : {}),
        metadata: { peeblo_key: p.key },
      }, `price-${p.key}`)).id);
  });
}

function contactEmail(a: Account) {
  const cs = CONTACTS.filter((c) => c.accountKey === a.key && c.status !== "left_company");
  return (cs.find((c) => c.role === "billing") ?? cs.find((c) => c.role === "ap") ?? cs[0])?.email;
}

async function seedCustomers() {
  await batch(ACCOUNTS.filter((a) => a.stripe), async (a) => {
    await m.ensure("customer", a.key, async () => {
      const pm = cardOk(a.key) ? "pm_card_visa" : cardFails(a.key) ? "pm_card_chargeCustomerFail" : undefined;
      const c = await stripe("POST", "/customers", {
        name: a.name, email: contactEmail(a),
        address: { city: a.city, state: a.state, country: "US" },
        metadata: { peeblo_key: a.key, legal_name: a.legalName, domain: a.domain, tax_id: a.taxId ?? "" },
        ...(pm ? { payment_method: pm, invoice_settings: { default_payment_method: pm } } : {}),
      }, `customer-${a.key}`);
      return c.id;
    });
  });
}

async function seedInvoice(inv: Invoice) {
  const st = inv.stripe!;
  const a = acct(inv.accountKey);
  if (!a?.stripe) { console.log(`skip ${inv.number}: ${inv.accountKey} has no Stripe customer`); return; }
  const customer = m.get("customer", a.key)!;
  const charge = st.state === "payment_failed";
  const invId = await m.ensure("invoice", inv.key, async () => {
    const custom_fields = [{ name: "Invoice ref", value: inv.number }, ...(inv.poNumber ? [{ name: "PO Number", value: inv.poNumber }] : [])];
    const base: Record<string, unknown> = {
      customer, currency: "usd", auto_advance: false, pending_invoice_items_behavior: "exclude",
      collection_method: charge ? "charge_automatically" : "send_invoice",
      ...(charge ? {} : { days_until_due: Math.max(days(inv.issueDate, inv.dueDate), 1) }),
      description: inv.memo, custom_fields,
      metadata: { peeblo_key: inv.key, invoice_number: inv.number, contract_key: inv.contractKey ?? "", subscription_key: st.subscriptionKey ?? "", paid_date: st.paidDate ?? "", issue_date: inv.issueDate, due_date: inv.dueDate },
    };
    let created;
    try {
      created = await stripe("POST", "/invoices", { ...base, effective_at: ts(inv.issueDate) }, `invoice-${inv.key}`);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400) throw e;
      created = await stripe("POST", "/invoices", base, `invoice-noeff-${inv.key}`);
    }
    for (const [i, l] of inv.lines.entries()) {
      await stripe("POST", "/invoiceitems", {
        customer, invoice: created.id, quantity: l.quantity, currency: "usd",
        price_data: { product: m.get("product", l.productKey)!, currency: "usd", unit_amount_decimal: String(Math.round(l.unitAmount * 10000) / 100) },
        ...(l.description ? { description: l.description } : {}),
        metadata: { peeblo_key: inv.key, product_key: l.productKey },
      }, `ii-${inv.key}-${i}`);
    }
    return created.id;
  });

  let cur = await stripe("GET", `/invoices/${invId}`);
  if (st.state === "draft") return;
  if (cur.status === "draft") cur = await stripe("POST", `/invoices/${invId}/finalize`, { auto_advance: false }, `finalize-${inv.key}`);
  if (st.state === "paid" && cur.status === "open") {
    if (cardOk(a.key)) cur = await stripe("POST", `/invoices/${invId}/pay`, { payment_method: m.get("customer_pm", a.key) ?? undefined }, `pay-${inv.key}`);
    else cur = await stripe("POST", `/invoices/${invId}/pay`, { paid_out_of_band: true }, `pay-${inv.key}`);
  } else if (st.state === "payment_failed" && cur.status === "open" && !cur.attempted) {
    try { await stripe("POST", `/invoices/${invId}/pay`, {}, `pay-${inv.key}`); console.warn(`WARN ${inv.number} unexpectedly paid`); }
    catch (e) { if (e instanceof HttpError && e.status === 402) console.log(`${inv.number}: payment declined as expected`); else throw e; }
  } else if (st.state === "void" && cur.status === "open") {
    await stripe("POST", `/invoices/${invId}/void`, {}, `void-${inv.key}`);
  } else if (st.state === "uncollectible" && cur.status === "open") {
    await stripe("POST", `/invoices/${invId}/mark_uncollectible`, {}, `uncollectible-${inv.key}`);
  }
}

// Subscriptions start on the next billing cycle (Oct 1) with no proration, so they don't duplicate the explicit invoices.
async function seedSubscriptions() {
  const anchor = ts("2026-10-01");
  await batch(SUBSCRIPTIONS.filter((s) => acct(s.accountKey).stripe), async (s) => {
    await m.ensure("subscription", s.key, async () => {
      const price = PRODUCTS.find((p) => p.key === s.productKey)!;
      const sub = await stripe("POST", "/subscriptions", {
        customer: m.get("customer", s.accountKey)!,
        items: [price.unitAmount === s.unitAmount
          ? { price: m.get("price", s.productKey)!, quantity: s.quantity }
          : { price_data: { product: m.get("product", s.productKey)!, currency: "usd", unit_amount: cents(s.unitAmount), recurring: { interval: s.interval } }, quantity: s.quantity }],
        billing_cycle_anchor: anchor, proration_behavior: "none",
        ...(s.paymentMethod === "send_invoice" ? { collection_method: "send_invoice", days_until_due: 30 } : { collection_method: "charge_automatically" }),
        metadata: { peeblo_key: s.key, contract_key: s.contractKey, world_status: s.status },
      }, `subscription-${s.key}`);
      return sub.id;
    });
  });
}

async function seed() {
  if (ts(TODAY) > Date.now() / 1000 + 86400 * 2) console.warn("WARN: world TODAY is in the future relative to clock");
  await seedProducts();
  console.log(`products: ${Object.keys(m.all("product")).length}, prices: ${Object.keys(m.all("price")).length}`);
  await seedCustomers();
  console.log(`customers: ${Object.keys(m.all("customer")).length}`);
  await batch(INVOICES.filter((i) => i.stripe), seedInvoice);
  console.log(`invoices: ${Object.keys(m.all("invoice")).length}`);
  await seedSubscriptions();
  console.log(`subscriptions: ${Object.keys(m.all("subscription")).length}`);
}

// ---------- reset ----------
async function reset() {
  await batch(Object.entries(m.all("subscription")), async ([k, id]) => {
    try { await stripe("DELETE", `/subscriptions/${id}`); } catch (e) { if (!(e instanceof HttpError) || e.status !== 404) console.warn(`sub ${k}: ${(e as Error).message}`); }
    m.delete("subscription", k);
  });
  await batch(Object.entries(m.all("invoice")), async ([k, id]) => {
    try {
      const inv = await stripe("GET", `/invoices/${id}`);
      if (inv.status === "draft") await stripe("DELETE", `/invoices/${id}`);
      else if (inv.status === "open" || inv.status === "uncollectible") await stripe("POST", `/invoices/${id}/void`);
    } catch (e) { if (!(e instanceof HttpError) || e.status !== 404) console.warn(`invoice ${k}: ${(e as Error).message}`); }
    m.delete("invoice", k);
  });
  await batch(Object.entries(m.all("customer")), async ([k, id]) => {
    try { await stripe("DELETE", `/customers/${id}`); } catch (e) { if (!(e instanceof HttpError) || e.status !== 404) console.warn(`customer ${k}: ${(e as Error).message}`); }
    m.delete("customer", k);
  });
  await batch(Object.entries(m.all("price")), async ([k, id]) => { await stripe("POST", `/prices/${id}`, { active: false }).catch(() => {}); m.delete("price", k); });
  await batch(Object.entries(m.all("product")), async ([k, id]) => { await stripe("POST", `/products/${id}`, { active: false }).catch(() => {}); m.delete("product", k); });
  console.log("reset done (paid invoices cannot be removed; products/prices archived)");
}

// ---------- verify (read-only) ----------
async function verify() {
  const invs = (await all("/invoices")).filter((i) => i.metadata?.peeblo_key);
  const counts: Record<string, number> = {};
  for (const i of invs) counts[i.status] = (counts[i.status] ?? 0) + 1;
  console.log("invoice status counts:", counts, "total", invs.length);
  const byNum = (n: string) => invs.find((i) => i.metadata.invoice_number === n);
  const custs = await all("/customers");
  const cname = (id: string) => custs.find((c) => c.id === id)?.name;
  for (const n of ["INV-2381", "INV-2390", "INV-2392", "INV-2377", "INV-2318", "INV-2366"]) {
    const i = byNum(n);
    if (!i) { console.log(n, "MISSING"); continue; }
    const world = INVOICES.find((w) => w.number === n)!;
    console.log(n, i.status, cname(i.customer), `$${i.total / 100}`, `world $${lineTotal(world.lines)}`,
      `attempted=${i.attempted} attempts=${i.attempt_count}`, "fields:", JSON.stringify(i.custom_fields),
      "effective_at:", i.effective_at ? new Date(i.effective_at * 1000).toISOString().slice(0, 10) : null);
  }
  const subs = await all("/subscriptions", { status: "all" });
  console.log("subscriptions:", subs.filter((s) => s.metadata?.peeblo_key).map((s) => `${s.metadata.peeblo_key}:${s.status}`).join(", "));
  console.log("customers:", custs.filter((c) => c.metadata?.peeblo_key).length, "products:", (await all("/products")).filter((p) => p.metadata?.peeblo_key).length);
}

const args = process.argv.slice(2);
if (args.includes("--reset")) await reset();
else if (args.includes("--verify")) await verify();
else { await seed(); await verify(); }
