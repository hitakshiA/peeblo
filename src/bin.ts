// Entry point: `peeblo daemon` (default), `peeblo check` (verify the setup), `peeblo image` (build the teammate VM
// images), `peeblo slack-app` (make Peeblo's own Slack app and print its install link) or `peeblo rotate-key <teammate>`
// (a new secret for a teammate's Otari key; its grants, ceiling and history stay).
const command = process.argv[2] ?? "daemon";
if (command === "daemon") await import("./main.ts");
else if (command === "check") await (await import("./check.ts")).cli();
else if (command === "image") await (await import("./environment/image.ts")).buildImage(process.argv[3]);
else if (command === "slack-app") await (await import("./crew/manager.ts")).createManagerApp();
else if (command === "rotate-key") {
  const slug = process.argv[3];
  const { getTeammate } = await import("./store/teammates.ts");
  const tm = slug ? await getTeammate(slug) : null;
  if (!tm) {
    console.error("usage: peeblo rotate-key <teammate>");
    process.exit(2);
  }
  const { rotateTeammateKey } = await import("./otari/spend.ts");
  console.log(
    (await rotateTeammateKey(tm.id))
      ? `${tm.config.name}'s Otari key has a new secret; restart core so live sessions pick it up.`
      : `${tm.config.name} has no key of its own.`,
  );
  process.exit(0);
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
