// Getting a new connector without leaving Slack: find it in Otari's MCP catalog, ask an admin for it (a person),
// add it and sign it in with OAuth (an admin, after a yes). Otari holds the account and renews its token.
import {
  addServer,
  catalogEntry,
  findServer,
  finishSignIn,
  healthLine,
  parseCallback,
  requestServer,
  searchCatalog,
  startSignIn,
} from "../otari/connectors.ts";
import { session } from "../otari/admin.ts";
import { tellAdmins } from "../otari/connector-watch.ts";
import { links } from "../otari/links.ts";
import { isOtariAdmin } from "../rules/authority.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const noSession = async () =>
  (await session())
    ? null
    : "Peeblo isn't signed in to Otari as an admin right now, so it can't reach the MCP catalog; an admin signs it in from the console.";
const adminOnly = async (ctx: ToolContext) =>
  (await noSession()) ??
  (isOtariAdmin(ctx.person) ? null : "Only an Otari admin can add or sign in a connector. Use connector_request to ask one.");

const signInSteps = (link: string, title: string) =>
  `Sign-in link for ${title} (works once, for 30 minutes): ${link}\n` +
  `Hand it to the admin as is. They open it in a browser signed in to otari.ai as the Otari admin Peeblo uses, and approve with the account the whole team should act as (a service account is best). ` +
  `If the browser then shows Otari's Overview page instead of the MCP servers page, the sign-in isn't finished: they paste that page's full address here and you finish it with otari_finish_connector_sign_in.`;

export const connectorTools: AgentTool[] = [
  {
    name: "connector_find",
    description:
      'Search Otari\'s catalog of MCP servers (tens of thousands, vendors\' own first) for a tool the work needs that no connector covers yet, e.g. "figma", "granola", "asana". Says which are already connected and how they\'re doing. Use it before telling someone a tool isn\'t available.',
    input_schema: object({ query: { type: "string" } }),
    kind: "read",
    authorize: () => noSession(),
    async run(_ctx, a) {
      const found = await searchCatalog(String(a.query));
      if (!found.length) return { text: `Nothing in Otari's MCP catalog matches "${a.query}".` };
      const lines = await Promise.all(
        found.map(async (x) => {
          const have = x.added_as ? await findServer(x.added_as) : null;
          return `- ${x.title} (catalog name ${x.name}, ${x.publisher_kind}): ${(x.description ?? "").slice(0, 140)}${have ? `\n  already connected as ${healthLine(have)}` : ""}`;
        }),
      );
      return { text: lines.join("\n"), data: found };
    },
  },
  {
    name: "connector_request",
    description:
      "Ask the team's Otari admins to add a catalog MCP server (from connector_find) that someone's work needs. Files the request in Otari, where the admins see it, and tells them in Slack. For a person who isn't an admin; an admin adds it with otari_add_connector instead.",
    input_schema: object({
      catalog_name: { type: "string", description: "The exact catalog name from connector_find." },
      why: { type: "string", description: "One line: what the person wants to do with it." },
    }),
    kind: "read",
    authorize: () => noSession(),
    async run(ctx, a) {
      if (isOtariAdmin(ctx.person))
        return {
          text: "The person asking is an Otari admin, so add it for them with otari_add_connector (it asks them to approve first).",
        };
      const who = ctx.person?.display_name ?? "Someone";
      const r = await requestServer(String(a.catalog_name), `${who}, through ${ctx.teammate.config.name} in Slack: ${a.why}`);
      const told = await tellAdmins(
        `${who} asked ${ctx.teammate.config.name} for *${r.title}* (${r.url}): ${a.why}\nTell me "add ${r.title}" to connect it; Otari closes the request when it's added.`,
      );
      return {
        text: `Asked for ${r.title}. Otari keeps the request until an admin adds it${told ? `, and ${told} admin${told === 1 ? " was" : "s were"} told in Slack` : ""}.`,
      };
    },
  },
  {
    name: "otari_add_connector",
    description:
      "Add a catalog MCP server (from connector_find) to the team's Otari workspace as a shared connector: reads open to every teammate, everything to Peeblo. Approves any pending request for it. If it needs an account, the result has an OAuth sign-in link for the admin, so nobody pastes a token. Then give it to a teammate with teammate_update (connectors). Admins only; a person approves first.",
    input_schema: object({
      catalog_name: { type: "string", description: "The exact catalog name from connector_find." },
      name: { type: ["string", "null"], description: "A short connector name, e.g. figma; null to derive one." },
      reason: { type: "string" },
    }),
    kind: "write",
    authorize: (ctx) => adminOnly(ctx),
    describe: async (_ctx, a) => ({
      summary: `Add ${(await catalogEntry(String(a.catalog_name)).catch(() => null))?.title ?? a.catalog_name} to Otari as a connector for the team`,
      setting: "mcp_server",
      to: a.catalog_name,
      reason: a.reason,
    }),
    async run(_ctx, a) {
      const { server, signIn } = await addServer(String(a.catalog_name), a.name);
      if (signIn && "link" in signIn)
        return {
          text: `Added ${server.name}; it needs an account before anyone can use it.\n${signInSteps(signIn.link, server.name)}`,
          data: { server: server.name },
        };
      if (signIn)
        return {
          text: `Added ${server.name}, but it can't be signed in from here: ${signIn.refused} Until an admin does that on Otari's MCP servers page (${links.mcpServers()}), nobody can use it.`,
          data: { server: server.name },
        };
      return { text: `Added ${healthLine(server)}. Give it to a teammate with teammate_update.`, data: { server: server.name } };
    },
  },
  {
    name: "otari_connector_sign_in",
    description:
      'A sign-in link for a connector that needs an account, or whose token stopped working ("needs an admin to sign in", 401, unauthorized): the admin signs in once with OAuth and Otari renews the token from then on. Replaces a pasted token if it had one. Admins only; a person approves first.',
    input_schema: object({ connector: { type: "string" }, reason: { type: "string" } }),
    kind: "write",
    authorize: (ctx) => adminOnly(ctx),
    async describe(_ctx, a) {
      const s = await findServer(String(a.connector));
      return {
        summary: `Sign ${a.connector} in to Otari with OAuth${s?.has_token ? " (replaces its pasted token)" : ""}`,
        setting: "mcp_server",
        from: s ? healthLine(s) : "not found",
        reason: a.reason,
      };
    },
    async run(_ctx, a) {
      const s = await findServer(String(a.connector));
      if (!s) return { text: `No connector called ${a.connector} in Otari.`, isError: true };
      if (s.credential_mode !== "shared")
        return { text: `${s.name} signs in each person separately, not with one shared account.`, isError: true };
      return { text: signInSteps(await startSignIn(s.id), s.name) };
    },
  },
  {
    name: "otari_finish_connector_sign_in",
    description:
      "Finish a connector sign-in from the otari.ai address an admin's browser ended on after approving (it contains mcp-connections/callback, a code and a state). Use it when an admin pastes such an address. Admins only.",
    input_schema: object({ address: { type: "string" } }),
    kind: "read",
    authorize: (ctx, a) =>
      (isOtariAdmin(ctx.person) ? null : "Only the admin who signed in can finish it.") ??
      (parseCallback(String(a.address))
        ? null
        : "That address has no sign-in code in it; ask the admin for the full address from their browser."),
    async run(_ctx, a) {
      const s = await finishSignIn(String(a.address));
      return { text: `Signed in. ${healthLine(s)}. Give it to a teammate with teammate_update if it needs it.` };
    },
  },
];
