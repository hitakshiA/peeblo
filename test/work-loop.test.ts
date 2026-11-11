import { test } from "node:test";
import assert from "node:assert/strict";
import { countRepeat, isLoop } from "../src/proxy/loops.ts";
import { modelsForPi } from "../src/proxy/relay.ts";
import { bm25Index } from "../src/pi/peeblo-tools.ts";
import { DEFAULT_HOSTS, egressRefusal } from "../src/environment/controller.ts";

test("countRepeat: quick repeats are a loop, spaced ones are polling", () => {
  let r = countRepeat(undefined, 0);
  for (let i = 1; i < 6; i++) r = countRepeat(r, i * 1_000);
  assert.equal(r.rapid, 6);
  assert.equal(isLoop(r), true);

  // Checking CI once a minute for an hour is not a loop.
  let p = countRepeat(undefined, 0);
  for (let i = 1; i <= 60; i++) p = countRepeat(p, i * 60_000);
  assert.equal(p.rapid, 1);
  assert.equal(p.total, 61);
  assert.equal(isLoop(p), false);
});

test("countRepeat: polling still has a ceiling", () => {
  let p = countRepeat(undefined, 0);
  for (let i = 1; i < 120; i++) p = countRepeat(p, i * 60_000);
  assert.equal(isLoop(p), true);
});

test("modelsForPi: real windows and reasoning, roles take their default model's facts", () => {
  const list = [
    {
      id: "deepseek/x",
      context_window: 1_048_576,
      max_output_tokens: 384_000,
      supported_parameters: ["tools", "reasoning"],
      architecture: { input_modalities: ["text", "image"] },
    },
    { id: "plain/y", context_window: 32_000, max_output_tokens: 8_000, supported_parameters: ["tools"] },
    { id: "peeblo-heavy", context_window: null, max_output_tokens: null },
  ];
  const out = modelsForPi(list, { "peeblo-heavy": { default: "deepseek/x" } }, { context: 262_144, output: 32_768 });
  assert.deepEqual(out[0].input_modalities, ["text", "image"]);
  assert.equal(out[0].reasoning, true);
  assert.equal(out[0].context_window, 262_144);
  assert.equal(out[0].max_output_tokens, 32_768);
  assert.equal(out[1].reasoning, false);
  assert.equal(out[1].context_window, 32_000);
  assert.equal(out[2].id, "peeblo-heavy");
  assert.equal(out[2].context_window, 262_144);
  assert.equal(out[2].reasoning, true);
});

test("bm25Index: plain words find the right connector tool", () => {
  const docs = [
    "linear create issue linear create issue Create a new issue in a Linear team",
    "linear list issues linear list issues List issues with filters",
    "github create pull request github create pull request Open a pull request",
    "stripe create refund stripe create refund Refund a charge",
  ];
  const ix = bm25Index(docs);
  assert.equal(ix.search("create a linear issue", 1)[0], 0);
  assert.equal(ix.search("refund the customer", 1)[0], 3);
  assert.equal(ix.search("open a PR on github", 1)[0], 2);
  assert.deepEqual(ix.search("zzz", 3), []);
});

test("egressRefusal: large computers read anywhere but write only to allowed hosts", () => {
  assert.equal(egressRefusal("large", "GET", "example.com", DEFAULT_HOSTS), null);
  assert.equal(egressRefusal("large", "HEAD", "evil.example", DEFAULT_HOSTS), null);
  assert.match(
    egressRefusal("large", "POST", "evil.example", DEFAULT_HOSTS) ?? "",
    /sends data \(POST\) only to its allowed hosts; evil\.example/,
  );
  assert.equal(egressRefusal("large", "POST", "registry.npmjs.org", DEFAULT_HOSTS), null);
  assert.equal(egressRefusal("large", "PUT", "api.github.com", DEFAULT_HOSTS), null);
  // Small computers are limited by the allowlist itself.
  assert.equal(egressRefusal("small", "POST", "evil.example", DEFAULT_HOSTS), null);
});

test("DEFAULT_HOSTS covers the common package registries with their subdomains", () => {
  for (const h of [
    "crates.io",
    "*.crates.io",
    "*.golang.org",
    "rubygems.org",
    "*.maven.org",
    "nodejs.org",
    "*.docker.io",
    "pypi.org",
    "*.pythonhosted.org",
  ])
    assert.ok(DEFAULT_HOSTS.includes(h), h);
});
