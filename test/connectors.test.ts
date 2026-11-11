import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, githubLimit, outOfScope } from "../src/connectors/mcp.ts";
import { tool } from "./helpers.ts";

test("classify: tool names decide read, write or destructive", () => {
  assert.equal(classify(tool("linear", "list_issues"), {}), "read");
  assert.equal(classify(tool("linear", "create_issue"), {}), "write");
  assert.equal(classify(tool("linear", "delete_issue"), {}), "destructive");
  // A name that starts with a read verb is a read, whatever follows.
  assert.equal(classify(tool("github", "get_status_updates"), {}), "read");
  // Whole words only: "postgres" is not "post".
  assert.equal(classify(tool("neon", "list_postgres_roles"), {}), "read");
  assert.equal(classify(tool("x", "submit_feedback"), {}), "write");
});

test("classify: a server's hint can make a call riskier, never safer", () => {
  assert.equal(classify(tool("x", "incidents"), {}), "read");
  assert.equal(classify(tool("x", "incidents", false), {}), "write");
  assert.equal(classify(tool("x", "getIssue", false), {}), "write");
});

test("classify: dispatchers that name their kind, and read-only servers", () => {
  assert.equal(classify(tool("atlassian", "execute_read"), {}), "read");
  assert.equal(classify(tool("atlassian", "executeDestructive"), {}), "destructive");
  assert.equal(classify(tool("bridge", "delete_all", null, true), {}), "read");
});

test("classify: generic SQL runners are read by their statement", () => {
  const sql = tool("neon", "run_sql");
  assert.equal(classify(sql, { sql: "SELECT * FROM t WHERE created_at > now()" }), "read");
  assert.equal(classify(sql, { sql: "DELETE FROM t" }), "write");
  assert.equal(classify(sql, { sql: "WITH x AS (SELECT 1) UPDATE t SET a = 1" }), "write");
});

test("classify: PostHog's exec is as risky as the command it runs", () => {
  const exec = tool("posthog", "exec");
  assert.equal(classify(exec, { command: "tools" }), "read");
  assert.equal(classify(exec, { command: "call query-trends {}" }), "read");
  assert.equal(classify(exec, { command: "call query-run {}" }), "write");
  assert.equal(classify(exec, { command: 'call execute-sql {"query": "SELECT 1"}' }), "read");
  assert.equal(classify(exec, { command: 'call execute-sql {"query": "insert into x"}' }), "write");
  assert.equal(classify(exec, { command: "call create-feature-flag {}" }), "write");
});

test("outOfScope: GitHub calls must name a repo the teammate may use", () => {
  const t = tool("github", "get_file_contents");
  assert.equal(outOfScope(t, { owner: "acme", repo: "web" }, { github: ["acme/*"] }), null);
  assert.match(outOfScope(t, { owner: "other", repo: "web" }, { github: ["acme/*"] }) ?? "", /other\/web is not one of/);
  assert.equal(outOfScope(t, { owner: "other", repo: "web" }, {}), null);
});

test("githubLimit: calls stay inside the install-wide repo list", () => {
  assert.deepEqual(githubLimit(tool("github", "get_file_contents"), { owner: "Acme", repo: "Web" }, ["acme/web"]), {
    args: { owner: "Acme", repo: "Web" },
  });
  assert.deepEqual(githubLimit(tool("github", "get_me"), {}, ["acme/web"]), { args: {} });
  // A search is narrowed: its own repo/user/org qualifiers are replaced by the allowed repos.
  assert.deepEqual(
    githubLimit(tool("github", "search_issues"), { query: "bug repo:other/x is:open", owner: "o" }, ["acme/web", "acme/api"]),
    {
      args: { query: "bug is:open repo:acme/web repo:acme/api" },
    },
  );
  assert.ok("refuse" in githubLimit(tool("github", "list_repos"), {}, ["acme/web"]));
  // Other servers, or no limit set: unchanged.
  assert.deepEqual(githubLimit(tool("linear", "list_issues"), { a: 1 }, ["acme/web"]), { args: { a: 1 } });
  assert.deepEqual(githubLimit(tool("github", "list_repos"), { a: 1 }, []), { args: { a: 1 } });
});
