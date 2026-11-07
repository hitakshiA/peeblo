// Entry point: `peeblo daemon` (default) `peeblo check` (verify the setup) or `peeblo image` (build the teammate VM image).
const command = process.argv[2] ?? "daemon";
if (command === "daemon") await import("./main.ts");
else if (command === "check") await import("./check.ts");
else if (command === "image") await (await import("./environment/image.ts")).buildImage(process.argv[3]);
else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
