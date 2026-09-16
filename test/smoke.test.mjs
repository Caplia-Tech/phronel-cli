import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const TEST_KEY = "cap_inv_test_" + "a".repeat(32);
const COMPANY = "36b93e80-6aac-4a65-a308-ddcffaf6ff2f";
const RUN = "4094b86f-fa9c-464c-aab5-aae779c562c3";

function runCli(args, env = {}, input) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, PHRONEL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "phronel-test-")), ...env } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

function startMock() {
  let polls = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body: raw, contentType: req.headers["content-type"], length: req.headers["content-length"] });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_test_1" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/pricing") return send(200, { currency: "GBP", free_runs_per_month: 3, ladder: [] });
    if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
      return send(401, { error: { code: "unauthenticated", message: "Invalid or revoked API key", request_id: "req_test_1" } });
    }
    if (url.pathname === "/v1/credits") return send(200, { month: "2026-09", free_remaining: 2, paid_balance: 0 });
    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = JSON.parse(raw.toString());
      if (body.query === "broke.com") return send(402, { error: { code: "insufficient_credits", message: "No runs left", request_id: "req_test_1" } });
      return send(202, { id: RUN, status: "enrolled", status_message: "Collecting", company: { id: COMPANY, name: "Monzo" }, credit_source: "free", input: body });
    }
    if (url.pathname === `/v1/runs/${RUN}`) {
      polls++;
      return send(200, polls < 2 ? { id: RUN, status: "composing", status_message: "Composing" } : { id: RUN, status: "complete", company: { id: COMPANY, name: "Monzo" }, report: { html: "x" } });
    }
    if (url.pathname === "/v1/runs") return send(200, { runs: [{ id: RUN, status: "complete", company: { name: "Monzo" }, credit_source: "free", created_at: "2026-09-16T10:38:00Z" }] });
    if (req.method === "POST" && url.pathname === `/v1/companies/${COMPANY}/deck`) {
      return send(202, { document: { document_id: "d1", file_name: "deck.pdf", version: 1 }, scoring: "queued" });
    }
    if (req.method === "POST" && url.pathname === "/v1/theses") {
      const body = JSON.parse(raw.toString());
      return send(201, { id: "t1", name: body.name, thesis_criteria: body.criteria, scoring: { queued: 1 } });
    }
    if (url.pathname === "/v1/theses") return send(200, { theses: [{ id: "t1", name: "Seed", one_line_mandate: "m", thesis_criteria: [{ name: "Team", weight: 4 }] }] });
    send(404, { error: { code: "not_found", message: "Endpoint not found", request_id: "req_test_1" } });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, requests })));
}

test("help and version", async () => {
  const help = await runCli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /phronel run monzo.com --wait/);
  const v = await runCli(["--version"]);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test("unknown command and missing key are structured errors", async () => {
  const bad = await runCli(["frobnicate", "--json"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /"code":"usage"/);
  const noKey = await runCli(["credits", "--json"]);
  assert.equal(noKey.code, 3);
  assert.match(noKey.stderr, /unauthenticated/);
});

test("run --wait polls to completion and deck upload is exact-length multipart", async () => {
  const { server, url, requests } = await startMock();
  try {
    const deck = join(mkdtempSync(join(tmpdir(), "phronel-deck-")), "deck.pdf");
    writeFileSync(deck, "%PDF-1.4\n%fake\n");
    const r = await runCli(["run", "monzo.com", "--deck", deck, "--wait", "--json"], { PHRONEL_API_KEY: TEST_KEY, PHRONEL_API_URL: url });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "complete");
    assert.equal(out.deck.file_name, "deck.pdf");
    const upload = requests.find((q) => q.path.endsWith("/deck"));
    assert.match(upload.contentType, /^multipart\/form-data; boundary=/);
    assert.equal(Number(upload.length), upload.body.length);
    assert.match(upload.body.toString("latin1"), /filename="deck.pdf"/);
    assert.ok(requests.filter((q) => q.path === `/v1/runs/${RUN}`).length >= 2);
  } finally {
    server.close();
  }
});

test("insufficient credits exits 1 with the fix", async () => {
  const { server, url } = await startMock();
  try {
    const r = await runCli(["run", "broke.com", "--json"], { PHRONEL_API_KEY: TEST_KEY, PHRONEL_API_URL: url });
    assert.equal(r.code, 1);
    const err = JSON.parse(r.stderr);
    assert.equal(err.error.code, "insufficient_credits");
    assert.match(err.fix, /phronel.ai\/app\/billing/);
  } finally {
    server.close();
  }
});

test("theses create builds the body from flags", async () => {
  const { server, url, requests } = await startMock();
  try {
    const r = await runCli(["theses", "create", "Seed SaaS", "--mandate", "UK B2B", "--criterion", "Team:4:Domain depth", "--criterion", "Traction", "--sector", "SaaS", "--json"], { PHRONEL_API_KEY: TEST_KEY, PHRONEL_API_URL: url });
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(requests.find((q) => q.method === "POST" && q.path === "/v1/theses").body.toString());
    assert.equal(body.name, "Seed SaaS");
    assert.equal(body.one_line_mandate, "UK B2B");
    assert.deepEqual(body.criteria, [{ name: "Team", weight: 4, description: "Domain depth" }, { name: "Traction", weight: 3, description: "" }]);
    assert.deepEqual(body.target_sectors, ["SaaS"]);
    const bad = await runCli(["theses", "create", "X", "--criterion", "Team:9", "--json"], { PHRONEL_API_KEY: TEST_KEY, PHRONEL_API_URL: url });
    assert.equal(bad.code, 2);
  } finally {
    server.close();
  }
});

test("login stores the key after verifying it; pricing needs no key; tables on a tty are not required", async () => {
  const { server, url } = await startMock();
  try {
    const dir = mkdtempSync(join(tmpdir(), "phronel-cfg-"));
    const login = await runCli(["login", "--api-key", TEST_KEY, "--api-url", url, "--json"], { PHRONEL_CONFIG_DIR: dir });
    assert.equal(login.code, 0, login.stderr);
    assert.equal(JSON.parse(login.stdout).env, "test");
    const who = await runCli(["whoami", "--json"], { PHRONEL_CONFIG_DIR: dir });
    assert.equal(JSON.parse(who.stdout).key_source, "config");
    const pricing = await runCli(["pricing", "--json"], { PHRONEL_API_URL: url });
    assert.equal(JSON.parse(pricing.stdout).free_runs_per_month, 3);
    const list = await runCli(["runs", "list"], { PHRONEL_API_KEY: TEST_KEY, PHRONEL_API_URL: url });
    assert.equal(list.code, 0);
    assert.equal(JSON.parse(list.stdout).runs.length, 1);
  } finally {
    server.close();
  }
});
