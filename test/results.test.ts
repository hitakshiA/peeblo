import { test } from "node:test";
import assert from "node:assert/strict";
import { salvageList, summarize, urlsIn } from "../src/proxy/tools.ts";

test("summarize: a list is counted, a record is named, text gives its first line", () => {
  assert.equal(summarize('[{"a":1},{"a":2}]'), "2 results");
  assert.equal(summarize('{"results":[1]}'), "1 result");
  assert.equal(summarize('{"identifier":"GRO-331","title":"Pricing page footer"}'), "GRO-331 · Pricing page footer");
  assert.equal(summarize("\n\n  first line\nsecond"), "first line");
  assert.equal(summarize("x".repeat(100)), `${"x".repeat(79)}…`);
});

test("urlsIn: distinct addresses, trailing punctuation dropped", () => {
  assert.deepEqual(urlsIn('see https://a.com/x, and "https://b.com/y". https://a.com/x'), ["https://a.com/x", "https://b.com/y"]);
  const many = Array.from({ length: 8 }, (_, i) => `https://s${i}.com`).join(" ");
  assert.equal(urlsIn(many).length, 5);
});

test("salvageList: keeps the whole records before a cut", () => {
  assert.deepEqual(salvageList('{"data":[{"id":1},{"id":2,"s":"}"},{"id":3,"t'), { data: [{ id: 1 }, { id: 2, s: "}" }], has_more: true });
  assert.equal(salvageList("not json"), null);
  assert.equal(salvageList('[{"id":1'), null);
});
