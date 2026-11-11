// The Otari features a teammate chooses to use. Reads run at once; otari_set_* are admin-only,
// always wait for a person's yes, and are read back from Otari before the tool reports success.
import { isOtariAdmin } from "../rules/authority.ts";
import { config } from "../config.ts";
import { guardMode, lakeraMandate, lakeraProject, setLakera } from "../rules/guard.ts";
import { routingPolicies, session, setWebSearch, upsertRoutingPolicy, webSearch, mcpServers } from "../otari/admin.ts";
import { estimateCost, isOpenWeight, modelFacts, models, openWeightModels, tierFile, tierOf } from "../otari/catalog.ts";
import { otari } from "../otari/client.ts";
import { links } from "../otari/links.ts";
import { tiers } from "../otari/people.ts";
import { policySpec, ROLES, waitUntilServing } from "../otari/routing.ts";
import { personSpend, teammateSpend, usd } from "../otari/spend.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const price = (n?: number) => (n === undefined ? "?" : `$${n}`);
const TIERS = ["S", "A", "B", "C", "D", "E"];
const rank = (id: string) => {
  const t = tierOf(id);
  return t ? TIERS.indexOf(t.tier) : TIERS.length;
};
const tierLabel = (id: string) => {
  const t = tierOf(id);
  return t ? `[${t.tier} ${t.aa_v5}]` : "[—]";
};
const adminOnly = (ctx: ToolContext) =>
  isOtariAdmin(ctx.person)
    ? null
    : "Only an Otari admin can change Otari settings. Use otari_prepare_change to show an admin exactly what to set.";

async function chatModel(id: string): Promise<string | null> {
  if (id in ROLES) return null;
  const m = (await models()).get(id);
  if (!m) return `${id} is not in Otari's catalog; use models_list to see the choices.`;
  if (!isOpenWeight(id)) return `${id} is not an open-weight model, and Peeblo uses open-weight models only.`;
  if (m.type && m.type !== "chat") return `${id} is a ${m.type} model, not a chat model.`;
  return null;
}

export const otariTools: AgentTool[] = [
  {
    name: "models_list",
    description:
      "List the open-weight models available through Otari, with their quality tier (S best, then A to E, from Artificial Analysis's Intelligence Index), context window and price per million tokens (input / output). Also lists Peeblo's role policies.",
    input_schema: object({
      max_output_price_per_million: {
        type: ["number", "null"],
        description: "Only models at or under this output price (USD per million tokens), or null for all.",
      },
    }),
    kind: "read",
    async run(_ctx, a) {
      const list = (await openWeightModels())
        .filter((m) => (m.type ?? "chat") === "chat" && m.pricing?.output_price_per_million !== undefined)
        .filter(
          (m) => a.max_output_price_per_million === null || (m.pricing!.output_price_per_million ?? 0) <= a.max_output_price_per_million,
        )
        // Tiered models first (S to E), cheapest first within a tier; models with no score yet after them.
        .sort((x, y) => rank(x.id) - rank(y.id) || (x.pricing!.output_price_per_million ?? 0) - (y.pricing!.output_price_per_million ?? 0));
      const lines = list
        .slice(0, 30)
        .map(
          (m) =>
            `${tierLabel(m.id)} ${m.id} · ${m.context_window ? `${Math.round(m.context_window / 1000)}k` : "?"} context · ${price(m.pricing?.input_price_per_million)} in / ${price(m.pricing?.output_price_per_million)} out per 1M · ${modelFacts(m.id)}`,
        );
      const roles = [
        ...Object.entries(ROLES).map(
          ([n, r]) => `${n}: ${r.default} (${tierOf(r.default)?.tier ?? "unscored"}) → ${r.fallback.join(", ")} (${r.purpose})`,
        ),
        `heavy work (not a policy; a price card first): ${tierFile.heavy.model} (${tierOf(tierFile.heavy.model)?.tier}) — ${tierFile.heavy.purpose}`,
      ];
      return {
        text: `${list.length} open-weight chat models${list.length > 30 ? " (first 30 shown)" : ""}. Tier: S best → E; "—" means no score yet.\n${lines.join("\n")}\n\nRole policies (use the name as a model):\n${roles.join("\n")}`,
      };
    },
  },
  {
    name: "price_estimate",
    description: "Work out what a model call or job would cost from Otari's catalog prices, before running it.",
    input_schema: object({
      model: { type: "string", description: "A catalog model id (see models_list) or a role policy name." },
      input_tokens: { type: "integer", minimum: 0 },
      output_tokens: { type: "integer", minimum: 0 },
    }),
    kind: "read",
    async run(_ctx, a) {
      const model = a.model in ROLES ? ROLES[a.model].default : a.model;
      const est = await estimateCost(model, a.input_tokens, a.output_tokens);
      if (est === null) return { text: `No price for ${a.model} in Otari's catalog. Use models_list for priced models.`, isError: true };
      const card = est > config.priceCardUsd;
      return {
        text: `About ${usd(est)} for ${a.input_tokens.toLocaleString()} tokens in and ${a.output_tokens.toLocaleString()} out on ${model}.${card ? ` That is over ${usd(config.priceCardUsd)}, so a person sees a price card before it runs.` : ""}`,
        data: { usd: est, model, needs_price_card: card },
      };
    },
  },
  {
    name: "budget_status",
    description:
      "How much of this teammate's monthly budget is used and left, and how much the person asking has left of their own allowance.",
    input_schema: object({}),
    kind: "read",
    async run(ctx) {
      const t = await teammateSpend(ctx.teammate);
      const lines = [
        `${ctx.teammate.config.name}: ${usd(t.spent)} of ${usd(t.cap)} used this month (${usd(Math.max(0, t.cap - t.spent))} left; enforced by ${t.mode === "key" ? "its own Otari key" : "Peeblo, by tag"}).`,
      ];
      const { session, wallet } = await import("../otari/admin.ts");
      if (await session()) {
        const w = await wallet().catch(() => null);
        if (w)
          lines.push(
            `The org's Otari balance: ${usd(Number(w.available))} available${Number(w.available) < 1 ? "; when it reaches $0 every call stops until an admin adds funds" : ""}.`,
          );
      }
      if (ctx.endUser) {
        const p = await personSpend(ctx.endUser);
        lines.push(
          p.cap === null
            ? `You: ${usd(p.spent)} spent, no cap.`
            : `You: ${usd(p.spent)} of ${usd(p.cap)} on the ${p.tier} allowance (${usd(Math.max(0, p.cap - p.spent))} left).`,
        );
      }
      return { text: lines.join("\n") };
    },
  },
  {
    name: "usage_report",
    description:
      'Who and what spent money this month (or since a date), straight from Otari\'s usage: each teammate, each model, each person (admins only), and spend per day. For "how much has everyone spent", "who\'s the most expensive", a spend chart (pass the daily rows to show_data).',
    input_schema: object({ since: { type: ["string", "null"], description: "ISO date; empty for this month." } }),
    kind: "read",
    async run(ctx, a) {
      const { orgUsage } = await import("../otari/spend.ts");
      const since = a.since ? new Date(a.since).toISOString() : undefined;
      const u = await orgUsage(since).catch((e) => {
        throw new Error(`Otari's usage couldn't be read: ${(e as Error).message}`);
      });
      if (!u)
        return {
          text: "Reading the whole org's usage needs Otari's dashboard session (an admin connects it in the console). Per teammate, budget_status works now.",
          isError: true,
        };
      const { listTeammates } = await import("../store/teammates.ts");
      const names = new Map((await listTeammates()).map((t) => [t.slug, t.config.name]));
      const { readableModel } = await import("../slack/look.ts");
      const top = (g: { label: string; cost: number; requests: number }[], n = 8) =>
        g
          .filter((x) => x.cost > 0)
          .sort((x, y) => y.cost - x.cost)
          .slice(0, n)
          .map((x) => `- ${x.label}: ${usd(x.cost)} (${x.requests} calls)`)
          .join("\n");
      // By key: every teammate calls on its own Otari key, so its key's usage is its spend (a tag can be missing).
      const { pool: db } = await import("../db.ts");
      const keyNames = new Map(
        (
          await db.query<{ key_id: string; slug: string }>(
            "SELECT k.key_id, t.slug FROM teammate_keys k JOIN teammates t ON t.id = k.teammate_id",
          )
        ).rows.map((r) => [r.key_id, names.get(r.slug) ?? r.slug]),
      );
      const { config } = await import("../config.ts");
      const { readScreenKey } = await import("../rules/guard.ts");
      const screenKey = readScreenKey()?.id;
      const isCore = (g: { label: string | null }) => Boolean(coreLabel && g.label === coreLabel);
      const coreLabel = await (async () => {
        try {
          const { admin } = await import("../otari/admin.ts");
          const r: any = await admin("GET", "/organizations/me/keys", undefined, "listing keys", "");
          return (
            ((r.data ?? r) as any[]).find(
              (k) => k.key_prefix && config.otariKey.startsWith(k.key_prefix) && config.otariKey.endsWith(k.key_suffix ?? ""),
            )?.key_name ?? null
          );
        } catch {
          return null;
        }
      })();
      const mine = u.by_api_key.filter((g) => g.key && (keyNames.has(g.key) || g.key === screenKey || isCore(g)));
      const crewTotal = mine.reduce((x, g) => x + g.cost, 0);
      const crew = top(
        mine.map((g) => ({
          label: keyNames.get(g.key!) ?? (g.key === screenKey ? "Guardrail screening" : "Peeblo (setup and checks, core key)"),
          cost: g.cost,
          requests: g.requests,
        })),
      );
      const models = new Map<string, { label: string; cost: number; requests: number }>();
      for (const g of u.by_model) {
        const n = readableModel(String(g.key ?? "")).name;
        const m = models.get(n) ?? { label: n, cost: 0, requests: 0 };
        m.cost += g.cost;
        m.requests += g.requests;
        models.set(n, m);
      }
      let people = "";
      if (isOtariAdmin(ctx.person)) {
        const { pool } = await import("../db.ts");
        const who = new Map(
          (
            await pool.query<{ end_user_id: string; display_name: string }>(
              "SELECT end_user_id, display_name FROM people WHERE end_user_id IS NOT NULL",
            )
          ).rows.map((r) => [r.end_user_id, r.display_name]),
        );
        const per = new Map<string, { label: string; cost: number; requests: number }>();
        for (const g of u.by_user) {
          const id = String(g.label ?? "");
          if (!who.has(id)) continue;
          const p = per.get(id) ?? { label: who.get(id)!, cost: 0, requests: 0 };
          p.cost += g.cost;
          p.requests += g.requests;
          per.set(id, p);
        }
        people = `\nBy person:\n${top([...per.values()])}`;
      }
      const days = u.series
        .filter((d) => d.cost > 0)
        .map((d) => ({ day: d.bucket_start.slice(0, 10), usd: Number(d.cost.toFixed(4)), calls: d.requests }));
      return {
        text: `From Otari's usage since ${(since ?? "the start of the month").slice(0, 10)}. Peeblo's crew: ${usd(crewTotal)} (by each teammate's own Otari key). The whole Otari org, including keys that aren't Peeblo's: ${usd(u.totals.cost)}, ${u.totals.request_count} calls; report the crew's number unless asked about the org.\nBy teammate:\n${crew || "- none yet"}\nBy model:\n${top([...models.values()], 6)}${people}\nPer day (for show_data): ${JSON.stringify(days.slice(-31))}`,
        data: { days },
      };
    },
  },
  {
    name: "otari_read_setting",
    description:
      "Read one of the team's Otari settings: whether web search and code execution are on, the guardrail, the routing policies (Otari's plan for each role), the connected MCP servers, the budget tiers, or fallbacks (for each model the team used lately: its providers in order, how often Otari fell back, and how many calls were pinned to one provider, which gets no automatic fallback).",
    input_schema: object({
      what: {
        type: "string",
        enum: ["web_search", "code_execution", "guardrail", "routing_policies", "mcp_servers", "budget_tiers", "fallbacks"],
      },
    }),
    kind: "read",
    async run(_ctx, a) {
      const s = await session();
      switch (a.what) {
        case "web_search":
        case "code_execution": {
          const t = (await otari<{ data: { id: string; available: boolean; reason: string | null }[] }>("GET", "/tools")).data.data;
          const ids = a.what === "web_search" ? ["otari_web_search", "otari_web_fetch"] : ["otari_code_execution"];
          const lines = ids.map((id) => {
            const x = t.find((y) => y.id === id);
            return `${id}: ${x?.available ? "on" : `off (${x?.reason ?? "unknown"})`}`;
          });
          if (a.what === "web_search" && s) {
            const w = await webSearch();
            lines.push(
              `workspace domain lists: allowed ${JSON.stringify(w.allowed_domains ?? [])}, blocked ${JSON.stringify(w.blocked_domains ?? [])}`,
            );
          }
          return { text: lines.join("\n") };
        }
        case "guardrail": {
          const mode = guardMode();
          if (mode !== "lakera")
            return {
              text:
                mode === "open" ? `The open guard model ${config.guardModel} screens messages and tool results.` : "No guardrail is on.",
            };
          if (!s)
            return {
              text: `Otari's org guardrail (Lakera) is the guard; its state can't be read without an admin's dashboard session. See ${links.guardrails()}.`,
            };
          const m = await lakeraMandate();
          const p = await lakeraProject();
          return {
            text: `Otari's org guardrail (Lakera, profile ${config.guardProfile}) is ${m?.enabled ? "on, in block mode" : "defined but off"}${p?.projectId ? `, using Lakera project ${p.projectId}` : ", using Lakera's default policy"}.`,
          };
        }
        case "routing_policies": {
          if (!s)
            return {
              text: `Peeblo's role policies: ${Object.keys(ROLES).join(", ")}. Their targets can't be read without an admin's dashboard session (${links.routing()}).`,
            };
          const list = await routingPolicies();
          const mine = ((list.data ?? list) as { name: string; spec: any }[]).filter((p) => p.name in ROLES);
          // Otari's own plan for each role (explain dispatches nothing), and for a role that steps down, the plan at 80%.
          const { explainPolicy } = await import("../otari/admin.ts");
          const plan = async (name: string, pct?: number) => {
            const r = await explainPolicy({ name, budgetUsedPct: pct }).catch(() => null);
            return r ? r.candidates.map((c) => String(c.model ?? c.selector ?? "?")).join(" → ") || "nothing can serve it" : null;
          };
          const lines = await Promise.all(
            mine.map(async (p) => {
              const now = await plan(p.name);
              const step = ROLES[p.name]?.step_down ? await plan(p.name, ROLES[p.name].step_down!.at_budget_pct) : null;
              return `${p.name}: ${now ?? p.spec?.select?.map((x: any) => x.default ?? x.target).join(", ")}${step ? ` (at ${ROLES[p.name].step_down!.at_budget_pct}% of a key's budget: ${step})` : ""}`;
            }),
          );
          return {
            text: lines.join("\n") || "No Peeblo role policies in Otari yet.",
          };
        }
        case "mcp_servers": {
          const listed = (await otari<{ servers: { name: string; purpose_hint?: string }[] }>("GET", "/mcp/servers")).data.servers;
          let health = new Map<string, string>();
          if (s) health = new Map(((await mcpServers()).data ?? []).map((x: any) => [x.name, x.health?.status ?? "unknown"]));
          return {
            text: listed
              .map(
                (x) =>
                  `${x.name}${health.size ? ` (${health.get(x.name) ?? "unknown"})` : ""}${x.purpose_hint ? `: ${x.purpose_hint}` : ""}`,
              )
              .join("\n"),
          };
        }
        case "fallbacks": {
          if (!s) return { text: `Fallbacks can't be read without an admin's dashboard session (${links.routing()}).` };
          const { admin } = await import("../otari/admin.ts");
          const r = await admin<{
            window_days: number;
            models: { id: string; name: string; offerings: { selector: string }[]; requests: number; fell_back: number; pinned: number }[];
          }>(
            "GET",
            `/organizations/me/automatic-fallbacks?workspace_id=${s.workspaceId}`,
            undefined,
            "reading automatic fallbacks",
            links.routing(),
          );
          const lines = r.models
            .filter((m) => m.requests > 0)
            .slice(0, 12)
            .map(
              (m) =>
                `${m.name || m.id}: ${m.requests} calls, ${m.fell_back} fell back; ${m.offerings.length} provider${m.offerings.length === 1 ? "" : "s"} (${m.offerings.map((o) => o.selector.split(":")[0]).join(" → ")})${m.pinned ? `; ${m.pinned} pinned to one provider (no automatic fallback; a role policy's own fallback covers those)` : ""}`,
            );
          return { text: `The last ${r.window_days} days:\n${lines.join("\n") || "No traffic yet."}` };
        }
        default: {
          const t = await tiers();
          return {
            text: t
              .map(
                (x) =>
                  `${x.name}: $${x.max_budget} per ${x.reset_alignment ?? `${Math.round((x.budget_duration_sec ?? 0) / 3600)} h`}${x.is_default ? " (new people start here)" : ""}`,
              )
              .join("\n"),
          };
        }
      }
    },
  },
  {
    name: "otari_prepare_change",
    description:
      "The exact Otari dashboard page, field and value for a change to web search, the guardrail or a routing policy, without changing anything. Use it whenever someone asks how to change one of these or what to set, rather than answering from memory: dashboard pages change.",
    input_schema: object({
      what: { type: "string", enum: ["web_search", "guardrail", "routing_policy"] },
      value: {
        type: "string",
        description:
          'The wanted value, e.g. "on", "off", or for a routing policy "peeblo-worker: <default model id> then <fallback model id>" (ids from models_list).',
      },
    }),
    kind: "read",
    async run(ctx, a) {
      const where = a.what === "web_search" ? links.webSearch() : a.what === "guardrail" ? links.guardrails() : links.routing();
      const field =
        a.what === "web_search"
          ? "Web search → Enabled"
          : a.what === "guardrail"
            ? `Organization → Guardrails → ${config.guardProfile} → Enabled (block mode)`
            : "Routing → the policy → default target, then on-failure targets (pinned provider names)";
      const can = Boolean(await session()) && isOtariAdmin(ctx.person);
      return {
        text: `In Otari: open ${where} and set ${field} to: ${a.value}.${can ? " You're an admin and Peeblo has a dashboard session, so I can also make this change for you (it asks you to approve first)." : ""}`,
        data: { link: where, field, value: a.value },
      };
    },
  },
  {
    name: "otari_set_web_search",
    description: "Turn Otari web search on or off for the team's workspace. Admins only; a person approves before it changes.",
    input_schema: object({ enabled: { type: "boolean" }, reason: { type: "string" } }),
    kind: "write",
    authorize: (ctx) => adminOnly(ctx),
    async describe(_ctx, a) {
      return {
        summary: `Turn ${a.enabled ? "on" : "off"} web search in Otari`,
        setting: "web_search",
        from: (await webSearch()).enabled,
        to: a.enabled,
        reason: a.reason,
      };
    },
    async run(_ctx, a) {
      const before = (await webSearch()).enabled;
      await setWebSearch(a.enabled);
      const after = (await webSearch()).enabled;
      if (after !== a.enabled)
        return { text: `Otari still shows web search ${after ? "on" : "off"} after the change; nothing else was touched.`, isError: true };
      return { text: `Web search: ${before ? "on" : "off"} → ${after ? "on" : "off"} (read back from Otari).`, data: { before, after } };
    },
  },
  {
    name: "otari_set_guardrail",
    description:
      "Turn Otari's org-wide guardrail (Lakera, block mode) on or off. When on, it screens every model call in the org, including teammates' own instructions, and it can block ordinary work as a false alarm; Peeblo already screens text from outside the company without it. Say that before turning it on. Admins only; a person approves before it changes.",
    input_schema: object({ enabled: { type: "boolean" }, reason: { type: "string" } }),
    kind: "write",
    authorize: (ctx) =>
      adminOnly(ctx) ??
      (guardMode() === "lakera"
        ? null
        : `Peeblo's guard setting is "${guardMode()}", not Otari's org guardrail; it is changed by an operator, not here.`),
    async describe(_ctx, a) {
      return {
        summary: `Turn ${a.enabled ? "on" : "off"} Otari's guardrail for every call in the org`,
        setting: "guardrail",
        from: (await lakeraMandate())?.enabled ?? null,
        to: a.enabled,
        reason: a.reason,
      };
    },
    async run(_ctx, a) {
      const before = (await lakeraMandate())?.enabled ?? null;
      await setLakera(a.enabled);
      const after = (await lakeraMandate())?.enabled ?? null;
      if (after !== a.enabled) return { text: "Otari did not take the change; the guardrail is as it was.", isError: true };
      return { text: `Org guardrail: ${before ? "on" : "off"} → ${after ? "on" : "off"} (read back from Otari).`, data: { before, after } };
    },
  },
  {
    name: "otari_share_trace",
    description:
      'Share what this conversation said with the team\'s admins in Otari, when someone wants it looked at ("this answer was wrong, show the team", "flag this for the admins"), with a one-line note. An admin can instead open the conversation themselves (open: true), which Otari records with the reason. Works when the team keeps conversation content in Otari.',
    input_schema: object({
      note: { type: "string", description: "Why it should be looked at, in a line." },
      open: {
        type: ["boolean", "null"],
        description: "An admin opening the content for themselves, recorded with the note as the reason.",
      },
    }),
    kind: "read",
    authorize: (ctx, a) =>
      a.open && isOtariAdmin(ctx.person) === false
        ? "Only an Otari admin can open a conversation's content; anyone in it can share it with the admins."
        : null,
    async run(ctx, a) {
      if (!config.traceContent)
        return {
          text: "This team doesn't keep conversation content in Otari (only the call records), so there's nothing to share. An admin can turn it on in the console's settings (keep trace content).",
          isError: true,
        };
      const { traceOfSession } = await import("../otari/traces.ts");
      const trace = await traceOfSession(ctx.sessionId);
      if (!trace)
        return { text: "Otari has no record of this conversation yet, or no admin is signed in to Otari in the console.", isError: true };
      const { admin, session: sess } = await import("../otari/admin.ts");
      const s = await sess();
      if (a.open) {
        await admin(
          "POST",
          `/organizations/me/traces/${trace}/break-glass`,
          { reason: String(a.note).slice(0, 500) },
          "opening a conversation's content",
          links.session(trace, s?.workspaceId),
        );
        return { text: `Opened for you, and recorded in Otari's audit with your reason: ${links.session(trace, s?.workspaceId)}` };
      }
      await admin(
        "POST",
        `/organizations/me/traces/${trace}/shares`,
        { audience: "organization_admins", note: String(a.note).slice(0, 500) },
        "sharing a conversation with the admins",
        links.session(trace, s?.workspaceId),
      );
      return { text: `Shared with the team's Otari admins, with your note. They see it here: ${links.session(trace, s?.workspaceId)}` };
    },
  },
  {
    name: "otari_forget_traces",
    description:
      'Delete what the team\'s conversations said from Otari (the stored prompts and replies), keeping the records of each call (model, cost, time). For "forget everything we said" or a privacy request. Admins only; a person approves first.',
    input_schema: object({ reason: { type: "string" } }),
    kind: "write",
    authorize: (ctx) => adminOnly(ctx),
    describe(_ctx, a) {
      return {
        summary: "Delete the stored content of every conversation in this Otari workspace (call records stay)",
        setting: "trace_content",
        reason: a.reason,
      };
    },
    async run() {
      const { admin, session: sess } = await import("../otari/admin.ts");
      const s = await sess();
      if (!s) return { text: `Needs an admin signed in to Otari in the console (${links.usage()}).`, isError: true };
      await admin("DELETE", `/workspaces/${s.workspaceId}/trace-content`, undefined, "deleting stored conversation content", links.usage());
      return { text: "Otari no longer holds what this workspace's conversations said; the records of each call (model, cost, time) stay." };
    },
  },
  {
    name: "otari_set_crew_cap",
    description:
      "Cap the whole crew's AI spend for the month: one ceiling in Otari over everything this Peeblo spends (every teammate, Peeblo and the guard together), on top of each teammate's own budget. Admins only; a person approves before it changes.",
    input_schema: object({
      monthly_usd: { type: "number", minimum: 1, maximum: 100000, description: "The most the whole crew may spend in a calendar month." },
      monthly_requests: {
        type: ["integer", "null"],
        minimum: 100,
        description: "Also the most AI calls the crew may make in the month, if asked for a count.",
      },
      reason: { type: "string" },
    }),
    kind: "write",
    authorize: (ctx) => adminOnly(ctx),
    describe(_ctx, a) {
      return {
        summary: `Cap the whole crew at $${a.monthly_usd} a month${a.monthly_requests ? ` and ${Number(a.monthly_requests).toLocaleString("en-US")} AI calls` : ""}`,
        setting: "crew_cap",
        monthly_usd: a.monthly_usd,
        monthly_requests: a.monthly_requests ?? null,
        reason: a.reason,
      };
    },
    async run(_ctx, a) {
      const { budgets, createBudget, updateBudget, createWorkspaceCeiling, spendCeilings, session } = await import("../otari/admin.ts");
      const NAME = "peeblo-crew-monthly";
      const s = await session();
      if (!s) return { text: `Capping the crew needs an admin signed in to Otari in the console (${links.budgets()}).`, isError: true };
      const existing = (await budgets()).find((b) => b.name === NAME);
      const limits = { requests: a.monthly_requests ?? null };
      const budget = existing
        ? await updateBudget(existing.id, a.monthly_usd, limits)
        : await createBudget(NAME, a.monthly_usd, "month", limits);
      const ceilings = await spendCeilings();
      if (!ceilings.some((c) => c.scope_type === "workspace" && c.scope_id === s.workspaceId && c.budget_id === budget.id))
        await createWorkspaceCeiling(budget.id, NAME);
      return {
        text: `The whole crew is capped at $${a.monthly_usd} a month${a.monthly_requests ? ` and ${Number(a.monthly_requests).toLocaleString("en-US")} AI calls` : ""} in Otari (budget ${NAME}, on the workspace). Each teammate's own budget still applies under it.`,
      };
    },
  },
  {
    name: "otari_set_routing_policy",
    description:
      "Set which models one of Peeblo's role policies uses: a default model and up to 3 fallbacks, all open-weight. Admins only; a person approves before it changes.",
    input_schema: object({
      name: { type: "string", enum: Object.keys(ROLES) },
      default_model: { type: "string", description: "A catalog model id from models_list." },
      fallback_models: { type: "array", items: { type: "string" }, maxItems: 3 },
      reason: { type: "string" },
    }),
    kind: "write",
    async authorize(ctx, a) {
      const admin = adminOnly(ctx);
      if (admin) return admin;
      for (const m of [a.default_model, ...a.fallback_models]) {
        const bad = await chatModel(m);
        if (bad) return bad;
      }
      // Otari compiles the draft without sending anything: a target it can't serve is named now, not after saving.
      const { explainPolicy } = await import("../otari/admin.ts");
      const spec = await policySpec({ ...ROLES[a.name], default: a.default_model, fallback: a.fallback_models });
      const plan = await explainPolicy({ name: a.name, spec }).catch(() => null);
      if (plan && !plan.candidates.length)
        return `Otari can't serve that policy: ${plan.dropped.map((d) => `${d.selector} (${d.reason}${d.detail ? `: ${d.detail}` : ""})`).join("; ") || "no target is available"}.`;
      return null;
    },
    async describe(_ctx, a) {
      const { readableModel } = await import("../slack/look.ts");
      const role = String(a.name).replace(/^peeblo-/, "");
      return {
        summary: `Run the ${role} role on ${readableModel(a.default_model).name}${a.fallback_models.length ? `, falling back to ${a.fallback_models.map((m: string) => readableModel(m).name).join(", ")}` : ""}`,
        setting: "routing_policy",
        name: a.name,
        default: a.default_model,
        fallbacks: a.fallback_models,
        reason: a.reason,
      };
    },
    async run(_ctx, a) {
      // Keeps the role's budget step-down. Start-up leaves this change in place until config/model-tiers.json changes.
      const spec = await policySpec({ ...ROLES[a.name], default: a.default_model, fallback: a.fallback_models });
      await upsertRoutingPolicy(a.name, spec);
      const w = await waitUntilServing(a.name);
      const list = await routingPolicies();
      const p = ((list.data ?? list) as { name: string; spec: any }[]).find((x) => x.name === a.name);
      const want = (spec.select.find((x) => "default" in x) as { default: string }).default;
      if (!p || !(p.spec?.select ?? []).some((x: any) => x.default === want))
        return { text: `Otari doesn't show the new targets for ${a.name}; check ${links.routingPolicy(a.name)}.`, isError: true };
      return {
        text: `${a.name} now runs ${a.default_model}${a.fallback_models.length ? `, then ${a.fallback_models.join(", ")}` : ""} (read back from Otari; serving steadily after ${Math.round(w.waitedMs / 1000)} s).`,
        data: { spec },
      };
    },
  },
];
