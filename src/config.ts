// Reads settings from the environment once at startup.
// Secrets are removed from process.env right away, so child processes never inherit them.

import { totalmem } from "node:os";
import { loadSettingsIntoEnv } from "./settings.ts";
// What the console's setup saved (settings.json in the data directory) fills in what the environment leaves empty.
loadSettingsIntoEnv();

const SECRET_VARS = ["DATABASE_URL", "POSTGRES_PASSWORD", "PEEBLO_ADMIN_TOKEN", "PEEBLO_SECRET_KEY", "OTARI_API_KEY", "OTARI_SERVICE_KEY", "PEEBLO_CONSOLE_PASSWORD"];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  dataDir: process.env.PEEBLO_DATA_DIR?.trim() || "/data",
  // Fixed per installation so a restarted core recovers its own in-flight runs.
  executorId: process.env.PEEBLO_EXECUTOR_ID?.trim() || "core-1",
  // The core API never faces the internet: loopback by default (compose sets the internal address).
  apiHost: process.env.PEEBLO_API_HOST?.trim() || "127.0.0.1",
  apiPort: Number(process.env.PEEBLO_API_PORT ?? 7340),
  adminToken: required("PEEBLO_ADMIN_TOKEN"),
  secretKey: required("PEEBLO_SECRET_KEY"),
  // The public ingress (Slack events, interactions, OAuth callback). A tunnel or reverse proxy points at it.
  ingressHost: process.env.PEEBLO_INGRESS_HOST?.trim() || "127.0.0.1",
  ingressPort: Number(process.env.PEEBLO_INGRESS_PORT ?? 8787),
  // Teammate computers (Gondolin). The image is built once with `peeblo image`.
  vmArch: (process.env.PEEBLO_VM_ARCH?.trim() || (process.arch === "arm64" ? "aarch64" : "x86_64")) as "aarch64" | "x86_64",
  vmImage: process.env.PEEBLO_VM_IMAGE?.trim() || "",
  vmIdleMs: Number(process.env.PEEBLO_VM_IDLE_MS ?? 5 * 60_000),
  // Hosted Otari. Peeblo uses an org service key (it can name end users); a plain key also works without per-person billing.
  otariBaseUrl: (process.env.OTARI_BASE_URL?.trim() || (process.env.OTARI_REGION === "eu" ? "https://eu.api.otari.ai/api/v1" : "https://api.otari.ai/api/v1")).replace(/\/+$/, ""),
  // Empty until it's given (in the console's setup, or .env): core then runs only the console, in setup mode.
  otariKey: process.env.OTARI_SERVICE_KEY?.trim() || process.env.OTARI_API_KEY?.trim() || "",
  otariKeyKind: (process.env.OTARI_SERVICE_KEY?.trim() ? "service" : "plain") as "service" | "plain",
  // The default budget for a new end user, from the service key's end_user_budget_ids (optional).
  otariEndUserBudget: process.env.OTARI_END_USER_BUDGET_ID?.trim() || "",
  proxyPort: Number(process.env.PEEBLO_PROXY_PORT ?? 7341),
  piIdleMs: Number(process.env.PEEBLO_PI_IDLE_MS ?? 10 * 60_000),
  // Otari's server-side tools and vision, each switchable (on by default). The agent chooses them; nothing
  // attaches them to every call.
  otariCode: (process.env.PEEBLO_OTARI_CODE ?? "on") !== "off",
  // Otari keeps each call's prompt and answer on its trace only when asked (Otari-Trace-Content: keep). Off by default.
  traceContent: (process.env.PEEBLO_TRACE_CONTENT ?? "off").trim() === "keep",
  webFetch: (process.env.PEEBLO_WEB_FETCH ?? "on") !== "off",
  vision: (process.env.PEEBLO_VISION ?? "on") !== "off",
  guard: process.env.PEEBLO_GUARD ?? "lakera",                       // lakera | open | off (see src/guard.ts)
  decisionModel: process.env.PEEBLO_DECISION_MODEL ?? "typesafe:jev-latest",   // used when Otari has a decision provider
  judgeModel: process.env.PEEBLO_JUDGE_MODEL ?? "peeblo-judge",                 // the judge-role routing policy
  guardProfile: process.env.PEEBLO_GUARD_PROFILE ?? "peeblo-lakera",  // the org guardrail's profile in Otari
  guardProbeModel: process.env.PEEBLO_GUARD_PROBE_MODEL?.trim() || "", // one-token screening calls; empty: the worker role's cheapest model
  lakeraProject: process.env.PEEBLO_LAKERA_PROJECT ?? "",              // Lakera project whose policy the org guardrail uses
  guardModel: process.env.PEEBLO_GUARD_MODEL ?? "alibaba/qwen3guard-gen-8b",
  managerAppId: process.env.PEEBLO_SLACK_APP_ID?.trim() || "",   // Peeblo's own Slack app
  consolePassword: process.env.PEEBLO_CONSOLE_PASSWORD ?? "",   // the console's one password
  admins: (process.env.PEEBLO_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),   // Slack user ids of Otari admins
  priceCardUsd: Number(process.env.PEEBLO_PRICE_CARD_USD ?? 0.5),                           // above this a run needs a price card
  teammateSpend: process.env.PEEBLO_TEAMMATE_SPEND ?? "auto",       // auto | key | tag (see src/otari/spend.ts)
  approvalTtlSeconds: Number(process.env.PEEBLO_APPROVAL_TTL_S ?? 1800),
  turnTimeoutMs: Number(process.env.PEEBLO_TURN_TIMEOUT_MS ?? 10 * 60_000),
  publicUrl: (process.env.PEEBLO_PUBLIC_URL?.trim() || "").replace(/\/+$/, ""),
  // The most jobs working at once on this machine; the rest wait in line, in order. A job waiting on a person's card
  // doesn't count. Default: one per GB of memory above 2 GB, at least 2.
  maxRunning: Number(process.env.PEEBLO_MAX_RUNNING || Math.max(2, Math.floor((totalmem() / 2 ** 30) - 2))),
  // A workspace anyone can join: off means people who aren't admins read connected tools but never change them.
  memberWrites: (process.env.PEEBLO_MEMBER_WRITES ?? "on").trim() !== "off",
  // The most teammates one person who isn't an admin may have hired and kept (0: no limit).
  memberHires: Number(process.env.PEEBLO_MEMBER_HIRES || 0),
  // The only GitHub repos (owner/repo, comma-separated) any teammate may touch, whatever the GitHub token can
  // reach. Empty: no limit beyond each teammate's own repos.
  githubRepos: (process.env.PEEBLO_GITHUB_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
};

for (const name of SECRET_VARS) delete process.env[name];
