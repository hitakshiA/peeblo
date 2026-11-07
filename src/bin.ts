// Entry point: `peeblo daemon` (default), `peeblo check` (verify the setup), `peeblo image` (build the teammate VM
// images) or `peeblo slack-app` (make Peeblo's own Slack app and print its install link).
const command = process.argv[2] ?? "daemon";
if (command === "daemon") await import("./main.ts");
else if (command === "check") await (await import("./check.ts")).cli();
else if (command === "image") await (await import("./environment/image.ts")).buildImage(process.argv[3]);
else if (command === "slack-app") await (await import("./manager.ts")).createManagerApp();
else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
