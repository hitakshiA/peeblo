// Entry point: `peeblo daemon` (default) or `peeblo image` (build the teammate VM image).
const command = process.argv[2] ?? "daemon";
if (command === "daemon") await import("./main.ts");
else if (command === "image") await (await import("./environment/image.ts")).buildImage();
else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
