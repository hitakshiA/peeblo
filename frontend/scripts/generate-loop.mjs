import fs from "node:fs";
const [action, name] = process.argv.slice(2);
if (!["orbit", "evidence"].includes(name))
  throw new Error("Choose orbit or evidence");
const record = `output/video/${name}.json`;
const apiKey = process.env.TOGETHER_API_KEY;
if (!apiKey)
  throw new Error(
    "Set TOGETHER_API_KEY in your shell; never use a VITE_ variable for this credential",
  );
const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};
const prompts = {
  orbit:
    "A seamless five-second cinemagraph loop of the exact sculptural ivory ledger-paper ribbon and forest-green stone pedestal in the supplied photograph. Locked tripod camera, unchanged framing, unchanged object geometry and paper folds. The only motion is a soft studio reflection slowly travelling over the green glass tabs and along the ivory paper edge, breathing brighter in the middle, then returning exactly to the initial illumination. A minute natural paper-edge flex of less than one millimeter returns to rest. Quiet premium financial editorial still life. Preserve all materials, the deep warm charcoal background, negative space, and grounded shadows. Single continuous shot. First and last frames must match the supplied identical image with zero visible jump and zero motion at the join. No camera movement, no rotation, no zoom, no cuts, no new objects, no morphing, no text, no logos, no particles, no neon, no flicker. Deliberately restrained movement; the object stays still.",
  evidence:
    "A seamless five-second cinemagraph loop of the exact ivory ledger-paper stack and interlocking forest-green glass paperweight in the supplied photograph. Locked tripod camera, preserve the exact composition and shape of every object. A broad soft reflection slowly passes across the green glass arches and fades back to the original studio illumination. One lifted paper corner gently breathes upward by one millimeter and settles exactly back to its starting position. Calm tangible premium editorial product photography. Maintain deep warm charcoal background, ivory paper grain, brushed metal tabs, stable shadows. A single continuous shot with no edits. Identical supplied start and end images define the loop; match both precisely with no jump, movement zero at the join. No camera movement, no zoom, no rotation, no shape changes, no new objects, no text or logos, no particles, no flickering. Motion should be barely perceptible and luxurious.",
};
if (action === "create") {
  if (fs.existsSync(record))
    throw new Error(
      "Job already recorded; use status to avoid duplicate charges",
    );
  const asset =
    name === "orbit" ? "peeblo-ledger-orbit.png" : "peeblo-evidence.png";
  const data =
    "data:image/png;base64," +
    fs.readFileSync(`public/images/${asset}`).toString("base64");
  const body = {
    model: "ByteDance/Seedance-2.0",
    prompt: prompts[name],
    resolution: "720p",
    ratio: "16:9",
    seconds: "5",
    settings: { audio: false },
    media: {
      frame_images: [
        { input_image: data, frame: "first" },
        { input_image: data, frame: "last" },
      ],
    },
  };
  fs.writeFileSync(`output/video/${name}-prompt.txt`, prompts[name]);
  const r = await fetch("https://api.together.xyz/v2/videos", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    console.log(r.status, text.slice(0, 1500));
    process.exit(1);
  }
  fs.writeFileSync(record, text);
  const job = JSON.parse(text);
  console.log(
    JSON.stringify({ id: job.id, status: job.status, model: job.model }),
  );
} else if (action === "status") {
  const previous = JSON.parse(fs.readFileSync(record, "utf8"));
  const r = await fetch(`https://api.together.xyz/v2/videos/${previous.id}`, {
    headers,
  });
  const job = await r.json();
  if (!r.ok) {
    console.log(r.status, JSON.stringify(job));
    process.exit(1);
  }
  fs.writeFileSync(record, JSON.stringify(job, null, 2));
  console.log(
    JSON.stringify({
      id: job.id,
      status: job.status,
      cost: job.outputs?.cost,
      error: job.error,
    }),
  );
  if (
    job.status === "completed" &&
    job.outputs?.video_url &&
    !fs.existsSync(`output/video/peeblo-${name}-raw.mp4`)
  ) {
    const v = await fetch(job.outputs.video_url);
    if (!v.ok) throw new Error("Download failed");
    fs.writeFileSync(
      `output/video/peeblo-${name}-raw.mp4`,
      Buffer.from(await v.arrayBuffer()),
    );
    console.log("Saved video");
  }
} else throw new Error("Use create or status");
