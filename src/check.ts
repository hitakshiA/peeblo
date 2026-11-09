// `peeblo check`: verifies a setup end to end and says exactly what to fix. Exit code 1 if anything fails.
import { access, constants, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, pool } from "./db.ts";
import { imagePath } from "./environment/controller.ts";
import { containerRuntime, currentBuild, distroOf } from "./environment/image.ts";

type Result = { name: string; ok: boolean; detail: string };

// The checks, for the CLI and the console's Setup screen.
export async function runChecks(): Promise<Result[]> {
  const results: Result[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, detail: (e as Error).message }); }
  };

  await check("database", async () => {
    const { rows } = await pool.query<{ server_version: string }>("SHOW server_version");
    const applied = await migrate();
    return `Postgres ${rows[0].server_version}; migrations ${applied.length ? `applied now: ${applied.join(", ")}` : "up to date"}`;
  });
  await check("durable execution", async () => {
    const { rows } = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'dbos'");
    return rows.length ? "DBOS schema present" : "DBOS schema not created yet (it appears on the first daemon start)";
  });
  await check("data directory", async () => {
    const probe = join(config.dataDir, ".write-test");
    await writeFile(probe, "ok");
    await unlink(probe);
    return config.dataDir;
  });
  await check("teammate computer image", async () => {
    const p = imagePath();
    await access(join(p, "manifest.json"), constants.R_OK).catch(() => { throw new Error(`no VM image at ${p}; run: ./peeblo image`); });
    return `${config.vmArch} image at ${p}`;
  });
  await check("Slack app configuration token", async () => {
    // Peeblo makes each teammate's app with this token, and rotates it every 12 hours.
    const { configToken } = await import("./slack/admin.ts");
    await configToken();
    return "valid (Peeblo rotates it before it expires)";
  });
  await check("Peeblo's Slack app", async () => {
    const { rows } = await pool.query("SELECT a.app_id, a.team_id, a.bot_user_id FROM slack_apps a JOIN teammates t ON t.id = a.teammate_id WHERE t.slug = 'peeblo' AND a.bot_user_id IS NOT NULL LIMIT 1");
    if (!rows[0]) throw new Error("not installed: run ./peeblo slack-app, open the link it prints and click Allow");
    return "installed in your workspace";
  });
  await check("teammates waiting for install", async () => {
    // A teammate works only through its own Slack app; these won't run until someone clicks "Add to Slack".
    const { waitingTeammates } = await import("./slack/install.ts");
    const w = await waitingTeammates();
    if (!w.length) return "none; every hired teammate is installed";
    const list = (xs: typeof w) => xs.map((t) => `${t.name} (${t.slug})`).join(", ");
    const ready = w.filter((t) => t.hasApp), noApp = w.filter((t) => !t.hasApp);
    return `${w.length} not installed, so they don't work.${ready.length ? ` Install button in Peeblo's App Home: ${list(ready)}.` : ""}${noApp.length ? ` No Slack app (never made, or removed from Slack; rehire or remove): ${list(noApp)}.` : ""}`;
  });
  await check("large computer image", async () => {
    const id = currentBuild("large");
    if (!id) throw new Error("the large computer image isn't built yet; run: ./peeblo image large");
    const d = distroOf("large", id);
    const rt = containerRuntime();
    const note = d === "debian" ? "Debian 13 (built with " + (rt ?? "a container runtime, not found now") + ")"
      : rt && process.env.PEEBLO_LARGE_DISTRO !== "alpine" ? "Alpine; Docker/Podman is here now, so ./peeblo image large would build Debian"
      : "Alpine (no Docker or Podman, so the Debian image can't be built here)";
    return `${note}, build ${id}`;
  });
  await check("hypervisor", async () => {
    if (process.platform === "linux") {
      await access("/dev/kvm", constants.R_OK | constants.W_OK).catch(() => { throw new Error("/dev/kvm is missing or not writable; teammate computers need KVM (bare metal or nested virtualization)"); });
      return "KVM available";
    }
    if (process.platform === "darwin") return "macOS Hypervisor.framework (Gondolin runs natively)";
    throw new Error(`unsupported platform ${process.platform}`);
  });
  await check("Otari", async () => {
    const { keyBudget } = await import("./otari/client.ts");
    const { models, openWeightModels } = await import("./otari/catalog.ts");
    const b = await keyBudget();
    const m = await models();
    const cap = b.limits?.[0];
    return `${config.otariKeyKind} key ok; ${m.size} models (${(await openWeightModels()).length} open-weight); ${cap ? `$${cap.used_usd} of $${cap.limit_usd} used this period` : "no key cap"}`;
  });
  await check("Otari service key (bills each person)", async () => {
    if (config.otariKeyKind !== "service") throw new Error("OTARI_API_KEY is a plain key; set OTARI_SERVICE_KEY so each person is an Otari end user with a budget");
    const { tiers } = await import("./otari/people.ts");
    const t = await tiers();
    const d = t.find((x) => x.is_default);
    if (!d) throw new Error("the service key has no default end-user budget; give it one in the dashboard (Keys)");
    return `${t.length} budget tiers; new people get ${d.name} ($${d.max_budget})`;
  });
  await check("Otari dashboard session (admin work)", async () => {
    const { session } = await import("./otari/admin.ts");
    const { links } = await import("./otari/links.ts");
    const s = await session();
    if (!s) throw new Error(`not connected: open the console (http://127.0.0.1:${config.apiPort}/console/) → Setup → Connect Otari, and sign in once with your Otari dashboard login. Until then teammates share one key with no per-teammate spend ceiling, and the role routing policies aren\'t made (calls use each role\'s default model).`);
    return `signed in as ${s.signedInAs} until ${s.expiresAt.toISOString().slice(0, 10)}`;
  });
  await check("Otari web search and code execution", async () => {
    const { otari } = await import("./otari/client.ts");
    const { links } = await import("./otari/links.ts");
    const { data } = await otari<{ data: { id: string; available: boolean; reason: string | null }[] }>("GET", "/tools");
    const state = (id: string) => data.data.find((t) => t.id === id);
    const off = ["otari_web_search", "otari_web_fetch", "otari_code_execution"].filter((id) => !state(id)?.available);
    if (off.length) throw new Error(`${off.join(", ")} off for this workspace (${off.map((id) => state(id)?.reason ?? "unknown").join("; ")}); turn on at ${links.webSearch()} / ${links.codeExecution()}`);
    return "web search, web fetch and code execution available";
  });
  await check("Otari routing policies", async () => {
    const { session } = await import("./otari/admin.ts");
    const { ROLES, rolePoliciesInOtari } = await import("./otari/routing.ts");
    if (!(await session())) return "not checked without a dashboard session";
    const have = await rolePoliciesInOtari();
    const missing = Object.keys(ROLES).filter((n) => !have.includes(n));
    if (missing.length) throw new Error(`missing ${missing.join(", ")}; Peeblo creates them when an admin signs in`);
    return `${have.length} role policies (${have.join(", ")})`;
  });
  await check("Otari guardrail", async () => {
    const { guardMode, lakeraMandate } = await import("./guard.ts");
    const { session } = await import("./otari/admin.ts");
    const mode = guardMode();
    if (mode === "off") return "off (PEEBLO_GUARD=off): messages are not screened";
    if (mode === "open") return `open guard model ${config.guardModel} through Otari chat`;
    if (!(await session())) return "Lakera org guardrail (state not readable without a dashboard session)";
    const m = await lakeraMandate();
    if (!m) throw new Error(`no org guardrail with profile ${config.guardProfile}`);
    return m.enabled ? "Lakera through Otari, on every call (org guardrail on)" : "Lakera through Otari, on text from outside the company (org-wide mandate off)";
  });
  await check("Otari MCP connectors", async () => {
    const { session } = await import("./otari/admin.ts");
    const { otari } = await import("./otari/client.ts");
    const { data } = await otari<{ servers: { name: string }[] }>("GET", "/mcp/servers");
    if (!(await session())) return `${data.servers.length} servers listed for this key (health needs a dashboard session)`;
    const { mcpServers } = await import("./otari/admin.ts");
    const all = ((await mcpServers()).data ?? []) as { name: string; health?: { status?: string } }[];
    const bad = all.filter((s) => s.health?.status && s.health.status !== "healthy");
    if (bad.length) throw new Error(`unhealthy: ${bad.map((s) => `${s.name} (${s.health?.status})`).join(", ")}`);
    return `${all.length} servers, all healthy`;
  });
  await check("Otari rule engine", async () => {
    const { checkAction } = await import("./otari/rules.ts");
    const d = await checkAction({ commands: ["git push --force origin main"] });
    if (d.decision !== "deny") throw new Error(`the teammate policy did not refuse a force push (${d.decision})`);
    return "teammate policy loaded; force push refused";
  });
  await check("public URL", async () => {
    if (!config.publicUrl) throw new Error("PEEBLO_PUBLIC_URL is not set; Slack needs a public HTTPS URL (a domain, or a tunnel on a Mac)");
    if (!config.publicUrl.startsWith("https://")) throw new Error("PEEBLO_PUBLIC_URL must be https://");
    const r = await fetch(`${config.publicUrl}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "peeblo-check" }, body: JSON.stringify({ type: "url_verification", challenge: "peeblo-check" }), signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    if (text !== "peeblo-check") throw new Error(`${config.publicUrl} answered ${r.status} but not as this Peeblo's ingress (is the daemon running and the tunnel pointed at port ${config.ingressPort}?)`);
    return `${config.publicUrl} reaches this ingress`;
  });
  await check("console stays private", async () => {
    if (!config.publicUrl) return "no public URL set";
    const r = await fetch(`${config.publicUrl}/v1/teammates`, { headers: { "user-agent": "peeblo-check" }, signal: AbortSignal.timeout(10_000) });
    if (r.status !== 404) throw new Error(`${config.publicUrl}/v1/teammates answered ${r.status}; the core API must not be public`);
    return "core API is not reachable from the public URL";
  });


  return results;
}

// `peeblo check`.
export async function cli(): Promise<void> {
  const results = await runChecks();
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
  await pool.end();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

