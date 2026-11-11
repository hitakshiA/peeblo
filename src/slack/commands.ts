// Commands, shortcuts and the settings modal. Code draws the surfaces; work still goes through
// teammates' runs and the same authority checks as anywhere else.
// - /peeblo (Peeblo's own app only): crew (a carousel of the crew), hire (a form that starts a hire with Peeblo),
//   budget, settings @teammate.
// - Shortcuts on every teammate app: "Ask X about this" and "Hand this to X" on a message, "New job for X" anywhere.
// - The settings modal (from App Home, the hire card or /peeblo settings): owner or admin; saves a new version.
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { startRun } from "../durable/runs.ts";
import { getApp } from "../ingress/apps.ts";
import { teammateSpend, usd } from "../otari/spend.ts";
import { personForSlack, type Person } from "../store/people.ts";
import { openSession, submit } from "../store/sessions.ts";
import { getTeammate, listTeammates, updateTeammate, type Teammate } from "../store/teammates.ts";
import { displayName, slack } from "./api.ts";
import { modelLabel } from "./look.ts";

const respond = (url: string, body: Record<string, unknown>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
const face = (slug: string) =>
  config.publicUrl ? { type: "image", image_url: `${config.publicUrl}/faces/${slug}.png`, alt_text: slug } : undefined;

async function appOf(tm: Teammate): Promise<string | null> {
  return (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1 LIMIT 1", [tm.id])).rows[0]?.app_id ?? null;
}

// ---- /peeblo ----
export async function handleCommand(f: URLSearchParams): Promise<void> {
  const appId = f.get("api_app_id")!;
  const team = f.get("team_id")!;
  const user = f.get("user_id")!;
  const url = f.get("response_url")!;
  const [sub, ...rest] = String(f.get("text") ?? "")
    .trim()
    .split(/\s+/);
  const who = await personForSlack(team, user, { displayName: (await displayName(appId, user)) ?? undefined });
  if (!sub || sub === "crew") {
    const hidden = new Set((await pool.query("SELECT id FROM teammates WHERE hidden")).rows.map((r) => r.id));
    const crew = (await listTeammates()).filter((t) => t.slug !== "peeblo" && !hidden.has(t.id));
    const cards: any[] = [];
    for (const t of crew) {
      const app = await appOf(t);
      const a = app ? await getApp(app) : null;
      if (!a?.secrets.bot_token) continue; // only installed teammates work (and show)
      const go = (x = "") => `https://slack.com/app_redirect?app=${app}&team=${team}${x}`;
      cards.push({
        type: "card",
        block_id: `crew:${t.slug}`,
        ...(face(t.slug) ? { icon: face(t.slug) } : {}),
        title: { type: "plain_text", text: t.config.name.slice(0, 150) },
        subtitle: { type: "plain_text", text: t.config.role.slice(0, 150) },
        body: {
          type: "mrkdwn",
          text: `${await modelLabel(t.config.model.default)} · $${t.config.budget.monthly_usd}/mo · ${t.config.mode} mode`.slice(0, 200),
        },
        actions: [
          { type: "button", text: { type: "plain_text", text: "Home" }, url: go("&tab=home"), action_id: `crew_home:${t.slug}` },
          { type: "button", style: "primary", text: { type: "plain_text", text: "Message" }, url: go(), action_id: `crew_dm:${t.slug}` },
        ],
      });
    }
    await respond(url, {
      response_type: "ephemeral",
      text: `Your crew: ${cards.length} teammates`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Your crew* · ${cards.length} teammate${cards.length === 1 ? "" : "s"} in Slack` },
        },
        ...(cards.length
          ? [{ type: "carousel", elements: cards.slice(0, 10) }]
          : [{ type: "context", elements: [{ type: "mrkdwn", text: "No teammates yet. Try `/peeblo hire`." }] }]),
      ],
    });
    return;
  }
  if (sub === "budget") {
    const lines: string[] = [];
    for (const t of (await listTeammates()).filter((x) => x.slug !== "peeblo").slice(0, 15)) {
      const s = await teammateSpend(t).catch(() => null);
      if (s) lines.push(`• *${t.config.name}*: ${usd(s.spent)} of ${usd(s.cap)}`);
    }
    await respond(url, {
      response_type: "ephemeral",
      text: "Budgets",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `*This month*\n${lines.join("\n") || "No spend yet."}` } }],
    });
    return;
  }
  if (sub === "settings") {
    const name = rest.join(" ").match(/<@([A-Z0-9]+)(\|[^>]*)?>/)?.[1] ?? rest.join(" ").replace(/^@/, "");
    const tm = await teammateFor(name);
    if (!tm) return void (await respond(url, { response_type: "ephemeral", text: `Which teammate? Try \`/peeblo settings @name\`.` }));
    const refused = await mayEdit(tm, who);
    if (refused) return void (await respond(url, { response_type: "ephemeral", text: refused }));
    await slack(appId, "views.open", { trigger_id: f.get("trigger_id"), view: await settingsModal(tm) });
    return;
  }
  if (sub === "hire") {
    await slack(appId, "views.open", {
      trigger_id: f.get("trigger_id"),
      view: {
        type: "modal",
        callback_id: "hire_form",
        title: { type: "plain_text", text: "Hire a teammate" },
        submit: { type: "plain_text", text: "Ask Peeblo" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "job",
            label: { type: "plain_text", text: "What should it do, and for whom?" },
            element: {
              type: "plain_text_input",
              action_id: "v",
              multiline: true,
              placeholder: { type: "plain_text", text: "Watch our Stripe refunds and flag anything over $500 for me" },
            },
          },
          {
            type: "input",
            block_id: "budget",
            optional: true,
            label: { type: "plain_text", text: "Monthly budget (USD)" },
            element: { type: "number_input", action_id: "v", is_decimal_allowed: false, min_value: "1", max_value: "500" },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: "Peeblo drafts the teammate in your DM and shows you its ID card to approve." }],
          },
        ],
      },
    });
    return;
  }
  await respond(url, {
    response_type: "ephemeral",
    text: "Try `/peeblo crew`, `/peeblo hire`, `/peeblo budget` or `/peeblo settings @name`.",
  });
}

async function teammateFor(nameOrUser: string): Promise<Teammate | null> {
  if (/^U[A-Z0-9]+$/.test(nameOrUser)) {
    const r = (await pool.query("SELECT teammate_id FROM slack_apps WHERE bot_user_id = $1", [nameOrUser])).rows[0];
    return r ? getTeammate(r.teammate_id) : null;
  }
  const { findTeammate } = await import("../agent-tools/manager.ts");
  return findTeammate(nameOrUser);
}

async function mayEdit(tm: Teammate, who: Person): Promise<string | null> {
  const { mayManageTeammate } = await import("../rules/authority.ts");
  return mayManageTeammate(tm, who) ? null : `Only ${tm.config.name}'s owner or an admin can change its settings.`;
}

// ---- the settings modal ----
const MODES = ["ask", "auto", "trusted", "yolo"];
export async function settingsModal(tm: Teammate): Promise<any> {
  const c = tm.config;
  const { openWeightModels } = await import("../otari/catalog.ts");
  const { serverList } = await import("../connectors/mcp.ts");
  // The role's usual model first (it keeps Otari's fallback and the cheaper model near the budget), then every
  // open-weight model by its name.
  const { readableModel } = await import("./look.ts");
  const usual = c.model.default.startsWith("peeblo-") ? c.model.default : "peeblo-worker";
  const others = (await openWeightModels().catch(() => [] as any[]))
    .map((m: any) => m.id ?? m)
    .filter((m: string) => typeof m === "string" && m !== usual)
    .slice(0, 89);
  const models = [usual, ...(c.model.default !== usual && !others.includes(c.model.default) ? [c.model.default] : []), ...others].slice(
    0,
    90,
  );
  const conns = (await serverList().catch(() => [] as any[])).map((s: any) => s.name).slice(0, 90);
  const usualName = await modelLabel(usual);
  const modelText = (m: string) => (m === usual ? `Usual: ${usualName} (with fallback)` : `${readableModel(m).name} · ${m}`);
  const opt = (v: string, label = v) => ({ text: { type: "plain_text", text: label.slice(0, 75) }, value: v });
  return {
    type: "modal",
    callback_id: "teammate_settings",
    private_metadata: tm.slug,
    title: { type: "plain_text", text: `${c.name} settings`.slice(0, 24) },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "alert",
        level: "warning",
        text: {
          type: "mrkdwn",
          text: "Raising a capability (mode, budget, tools, connectors, a bigger computer) is checked against your own limits, and every change is a new version you can see in the console.",
        },
      },
      {
        type: "input",
        block_id: "instructions",
        optional: true,
        label: { type: "plain_text", text: "Standing instructions" },
        element: { type: "plain_text_input", action_id: "v", multiline: true, initial_value: c.instructions.slice(0, 3000) },
      },
      {
        type: "input",
        block_id: "model",
        label: { type: "plain_text", text: "Model" },
        element: {
          type: "static_select",
          action_id: "v",
          initial_option: opt(c.model.default, modelText(c.model.default)),
          options: models.map((m: string) => opt(m, modelText(m))),
        },
      },
      {
        type: "input",
        block_id: "budget",
        label: { type: "plain_text", text: "Monthly budget (USD)" },
        element: {
          type: "number_input",
          action_id: "v",
          is_decimal_allowed: true,
          initial_value: String(c.budget.monthly_usd),
          min_value: "0",
          max_value: "500",
        },
      },
      {
        type: "input",
        block_id: "mode",
        label: { type: "plain_text", text: "Approvals" },
        element: { type: "radio_buttons", action_id: "v", initial_option: opt(c.mode, c.mode), options: MODES.map((m) => opt(m, m)) },
      },
      {
        type: "input",
        block_id: "tools",
        optional: true,
        label: { type: "plain_text", text: "Tools" },
        element: {
          type: "multi_static_select",
          action_id: "v",
          ...(c.tools.length ? { initial_options: c.tools.map((t) => opt(t)) } : {}),
          options: ["web", "code", "computer"].map((t) => opt(t)),
        },
      },
      ...(conns.length
        ? [
            {
              type: "input",
              block_id: "connectors",
              optional: true,
              label: { type: "plain_text", text: "Connectors" },
              element: {
                type: "multi_static_select",
                action_id: "v",
                ...(c.connectors.filter((x) => conns.includes(x)).length
                  ? { initial_options: c.connectors.filter((x) => conns.includes(x)).map((x) => opt(x)) }
                  : {}),
                options: conns.map((x: string) => opt(x)),
              },
            },
          ]
        : []),
      {
        type: "input",
        block_id: "size",
        label: { type: "plain_text", text: "Computer" },
        element: {
          type: "static_select",
          action_id: "v",
          initial_option: opt(c.computer?.size ?? "small"),
          options: ["small", "large"].map((x) => opt(x)),
        },
      },
    ],
  };
}

// Saving it: the same authority rules as teammate_update, then a new version (its Slack profile follows).
async function saveSettings(team: string, user: string, slug: string, values: any): Promise<Record<string, string> | null> {
  const tm = await getTeammate(slug);
  const who = await personForSlack(team, user);
  if (!tm) return { instructions: "That teammate is gone." };
  const refused = await mayEdit(tm, who);
  if (refused) return { instructions: refused };
  const v = (b: string) => values?.[b]?.v;
  const next = {
    instructions: v("instructions")?.value ?? tm.config.instructions,
    model: v("model")?.selected_option?.value ?? tm.config.model.default,
    budget: Number(v("budget")?.value ?? tm.config.budget.monthly_usd),
    mode: v("mode")?.selected_option?.value ?? tm.config.mode,
    tools: (v("tools")?.selected_options ?? []).map((o: any) => o.value),
    connectors: v("connectors") ? (v("connectors").selected_options ?? []).map((o: any) => o.value) : tm.config.connectors,
    size: v("size")?.selected_option?.value ?? tm.config.computer?.size ?? "small",
  };
  const { configProblems } = await import("../rules/hire-rules.ts");
  const bad = await configProblems(who, {
    mode: next.mode,
    model: next.model !== tm.config.model.default ? next.model : null,
    budget_usd: next.budget !== tm.config.budget.monthly_usd ? next.budget : null,
    tools: next.tools,
    connectors: next.connectors,
  });
  if (bad)
    return {
      [/model/i.test(bad)
        ? "model"
        : /budget/i.test(bad)
          ? "budget"
          : /YOLO/i.test(bad)
            ? "mode"
            : /tool/i.test(bad)
              ? "tools"
              : "connectors"]: bad.slice(0, 150),
    };
  if (next.model !== tm.config.model.default) {
    const { changeModel } = await import("../crew/model-change.ts");
    try {
      await changeModel(tm.slug, {
        model: next.model,
        fallback: tm.config.model.fallback ?? null,
        personId: who.id,
        why: "settings modal",
      });
    } catch (e) {
      return { model: (e as Error).message.slice(0, 150) };
    }
  }
  await updateTeammate(
    tm.slug,
    {
      instructions: next.instructions,
      budget: { monthly_usd: next.budget },
      mode: next.mode,
      tools: next.tools,
      connectors: next.connectors,
      computer: { ...tm.config.computer, size: next.size },
    } as any,
    { label: `${who.display_name ?? "a person"} in Slack settings` },
    "changed in the Slack settings modal",
  );
  return null;
}

// ---- shortcuts and forms ----
// A run for a teammate, in a thread under a message (channel) or in the person's DM with it.
async function startJob(
  appId: string,
  team: string,
  user: string,
  text: string,
  where: { channel: string; ts: string; channel_type: string } | null,
): Promise<void> {
  const app = await getApp(appId);
  const tm = app?.teammate_id ? await getTeammate(app.teammate_id) : null;
  if (!tm) return;
  let place = where;
  if (place && place.channel_type !== "im") {
    const joined: any = await slack(appId, "conversations.join", { channel: place.channel }).catch(() => null);
    const info: any = joined?.ok ? joined : await slack(appId, "conversations.info", { channel: place.channel }).catch(() => null);
    if (!info?.channel?.is_member) place = null;
  }
  if (!place) {
    const dm: any = await slack(appId, "conversations.open", { users: user }).catch(() => null);
    if (!dm?.channel?.id) return;
    const top: any = await slack(appId, "chat.postMessage", {
      channel: dm.channel.id,
      text: `On it: ${text.split("\n")[0].slice(0, 200)}`,
    });
    place = { channel: dm.channel.id, ts: top.ts, channel_type: "im" };
  }
  const person = await personForSlack(team, user, { displayName: (await displayName(appId, user)) ?? undefined });
  const p = {
    app_id: appId,
    team,
    channel: place.channel,
    channel_type: place.channel_type,
    thread_ts: place.ts,
    trigger_ts: place.ts,
    user,
    direct: true,
  };
  const session = await openSession(tm.id, place.channel_type === "im" ? "dm" : "thread", `${place.channel}:${place.ts}`, { slack: p });
  const { run, created } = await submit({
    sessionId: session.id,
    personId: person.id,
    requestId: `shortcut:${appId}:${place.channel}:${place.ts}:${Date.now()}`,
    text,
    source: "slack",
  });
  if (created) await startRun(run.id);
}

export async function handleShortcut(appId: string, payload: any): Promise<void> {
  const team = payload.team?.id ?? payload.user?.team_id;
  const user = payload.user.id;
  if (payload.type === "message_action") {
    const m = payload.message ?? {};
    const quoted = `"${String(m.text ?? "").slice(0, 3000)}"${m.user ? ` (from <@${m.user}>)` : ""}`;
    const text =
      payload.callback_id === "hand_to" ? `Please take this on as a job:\n${quoted}` : `What do you make of this message?\n${quoted}`;
    await startJob(appId, team, user, text, {
      channel: payload.channel.id,
      ts: m.thread_ts ?? m.ts,
      channel_type: payload.channel?.name === "directmessage" ? "im" : "channel",
    });
    return;
  }
  if (payload.type === "shortcut" && payload.callback_id === "new_job") {
    const app = await getApp(appId);
    const tm = app?.teammate_id ? await getTeammate(app.teammate_id) : null;
    await slack(appId, "views.open", {
      trigger_id: payload.trigger_id,
      view: {
        type: "modal",
        callback_id: "new_job",
        title: { type: "plain_text", text: `New job for ${tm?.config.name ?? "teammate"}`.slice(0, 24) },
        submit: { type: "plain_text", text: "Start" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "job",
            label: { type: "plain_text", text: "What do you need?" },
            element: { type: "plain_text_input", action_id: "v", multiline: true },
          },
        ],
      },
    });
  }
}

// Form submissions: settings, a new job, a hire.
export async function handleSubmission(appId: string, payload: any): Promise<Record<string, string> | null> {
  const team = payload.team?.id ?? payload.user?.team_id;
  const user = payload.user.id;
  const values = payload.view?.state?.values ?? {};
  const cb = payload.view?.callback_id;
  if (cb === "teammate_settings") return saveSettings(team, user, String(payload.view.private_metadata), values);
  if (cb === "new_job") {
    void startJob(appId, team, user, String(values.job?.v?.value ?? ""), null);
    return null;
  }
  if (cb === "hire_form") {
    const budget = values.budget?.v?.value;
    void startJob(
      appId,
      team,
      user,
      `I'd like to hire a teammate: ${values.job?.v?.value ?? ""}${budget ? ` Budget: $${budget} a month.` : ""}`,
      null,
    );
    return null;
  }
  return null;
}
