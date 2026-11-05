// Entry point: `peeblo daemon` (default).
const command = process.argv[2] ?? "daemon";
if (command === "daemon") await import("./main.ts");
else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
