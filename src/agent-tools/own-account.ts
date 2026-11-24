// A person connects their own Otari account (Otari's app sign-in), so their requests are paid from it instead of
// the team's budget. Only ever about the person asking: nobody connects, reads or disconnects someone else's.
import { clientId, disconnect, ownAccount, startConnect } from "../otari/own-account.ts";
import { dmFromPeeblo } from "../otari/connector-watch.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const ownAccountTools: AgentTool[] = [
  {
    name: "own_otari_account",
    description:
      "The asking person's own Otari account (otari.ai). connect: sends them, privately, a sign-in link; they approve on otari.ai (choosing a spending limit and expiry there) and from then on their requests to the crew are paid from their own Otari account and held to its limits, not the team's budget. status: whether it's connected and working. disconnect: revokes it, and their requests go back to the team's budget. Use it when someone wants to use their own Otari credits or account, has used up their allowance and wants to keep going, or asks how they're paying. Never post the sign-in link yourself.",
    input_schema: object({ action: { type: "string", enum: ["connect", "status", "disconnect"] } }),
    kind: "read",
    authorize: (ctx) => (ctx.person ? null : "Only a person in Slack can connect their own Otari account."),
    async run(ctx, a) {
      const person = ctx.person!;
      const have = await ownAccount(person.id);
      if (a.action === "status") {
        if (!have) return { text: "Not connected: their requests are paid from the team's budget." };
        if (have.broken)
          return {
            text: `Connected on ${have.connectedAt.slice(0, 10)}, but Otari stopped accepting the key (${have.broken}), so their requests are on the team's budget again. Offer to connect again.`,
          };
        return {
          text: `Connected since ${have.connectedAt.slice(0, 10)} (key ending ${have.hint}): their requests are paid from their own Otari account.${have.manageUrl ? ` They see and revoke the key at ${have.manageUrl}.` : ""}`,
        };
      }
      if (a.action === "disconnect") {
        if (!have) return { text: "Nothing to disconnect: they weren't using their own Otari account." };
        await disconnect(person.id);
        return { text: "Disconnected: the key is revoked in Otari, and their requests are paid from the team's budget again." };
      }
      if (have && !have.broken)
        return { text: `Already connected (key ending ${have.hint}). To use another account, disconnect first, then connect again.` };
      if (!clientId())
        return {
          text: "Peeblo has no public web address set up, so Otari can't send anyone back after signing in. An admin sets PEEBLO_PUBLIC_URL.",
          isError: true,
        };
      const link = await startConnect(person.id, { limitUsd: 5, expiration: "30-days" });
      const sent = await dmFromPeeblo(
        person.id,
        `Here's your link to connect your own Otari account (it works once, for 15 minutes): ${link}\nSign in on otari.ai and approve. Otari suggests a $5 limit and a 30-day expiry for the key; change either there. You'll get a message here once it's connected.`,
      ).catch(() => false);
      if (!sent)
        return {
          text: "Couldn't send them the link privately (Peeblo's own Slack app can't reach them), so it wasn't sent.",
          isError: true,
        };
      return { text: "Sent them a private sign-in link from Peeblo (a DM). Tell them to open it there; it works once, for 15 minutes." };
    },
  },
];
