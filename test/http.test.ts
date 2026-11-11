import { test } from "node:test";
import assert from "node:assert/strict";
import { bad, httpError, notFound, Router } from "../src/api/http.ts";

test("Router matches method and path, and decodes params", async () => {
  const r = new Router().add("GET", "/teammates/:id", async (req) => req.params.id).add("POST", "/teammates", async () => "made");
  const m = r.match("GET", "/teammates/a%20b");
  assert.deepEqual(m?.params, { id: "a b" });
  assert.equal(await m?.handler({ method: "GET", path: "/teammates/a%20b", params: m.params, query: new URLSearchParams(), body: {}, headers: {} }), "a b");
  assert.equal(r.match("DELETE", "/teammates/x"), null);
  assert.equal(r.match("GET", "/teammates/x/extra"), null);
});

test("client errors carry their status", () => {
  assert.equal(httpError(409, "taken").status, 409);
  assert.deepEqual([bad("no").status, bad("no").message], [400, "no"]);
  assert.deepEqual([notFound("teammate").status, notFound("teammate").message], [404, "no teammate"]);
});
