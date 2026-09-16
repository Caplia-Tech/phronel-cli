import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type FlagSpec, type FlagValues, boolFlag, intFlag, listFlag, strFlag } from "./args.js";
import { CONSOLE_URL, KEY_PATTERN, maskKey, parseKey, readConfig, resolveAuth, writeConfig } from "./config.js";
import { CliError, EXIT_API, EXIT_USAGE } from "./errors.js";
import { apiRequest, type MultipartPayload, type RequestOpts } from "./http.js";
import { note, printData } from "./output.js";
import { SKILL_MD } from "./skill.js";

export interface Ctx {
  positionals: string[];
  flags: FlagValues;
  json: boolean;
  key?: string;
  apiUrl?: string;
  command: string;
}

export interface CommandDef {
  name: string;
  summary: string;
  args: { name: string; required: boolean; desc: string }[];
  flags: FlagSpec[];
  /** Routes this command maps to (phronel-v1 or api-v1 on the same host). */
  ops: { method: string; path: string }[];
  run(ctx: Ctx): Promise<number | void>;
}

function req(ctx: Ctx, opts: Omit<RequestOpts, "key" | "apiUrl" | "tool">): Promise<any> {
  return apiRequest({ ...opts, key: ctx.key, apiUrl: ctx.apiUrl, tool: ctx.command.replace(/ /g, "-") });
}

function requireArg(ctx: Ctx, index: number, name: string): string {
  const v = ctx.positionals[index];
  if (!v) {
    throw new CliError(`Missing required argument <${name}>`, {
      code: "usage",
      exitCode: EXIT_USAGE,
      fix: `Run \`phronel ${ctx.command} --help\``,
    });
  }
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(ctx: Ctx, index: number, name: string): string {
  const v = requireArg(ctx, index, name);
  if (!UUID.test(v)) {
    throw new CliError(`<${name}> must be a UUID, got '${v}'`, { code: "usage", exitCode: EXIT_USAGE, fix: "Copy the id from `phronel runs list`" });
  }
  return v.toLowerCase();
}

/** Hand-encoded multipart with an exact Content-Length (the platform gateway 502s chunked uploads). */
function fileForm(filePath: string): MultipartPayload {
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    throw new CliError(`Cannot read file '${filePath}'`, { code: "usage", exitCode: EXIT_USAGE, fix: "Check the path. The deck must be a PDF." });
  }
  const boundary = "----phronel" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const enc = new TextEncoder();
  const filename = basename(filePath).replace(/"/g, "'");
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + buf.length + tail.length);
  body.set(head, 0);
  body.set(new Uint8Array(buf), head.length);
  body.set(tail, head.length + buf.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function hiddenPrompt(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(promptText);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "") process.exit(130);
        if (ch === "" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const TERMINAL = new Set(["complete", "failed"]);

async function waitForRun(ctx: Ctx, id: string, timeoutSeconds: number): Promise<any> {
  const started = Date.now();
  let delay = 10_000;
  for (;;) {
    const run = await req(ctx, { path: `/v1/runs/${id}` });
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() - started > timeoutSeconds * 1000) {
      throw new CliError(`Run ${id} is still ${run.status} after ${timeoutSeconds}s`, {
        code: "timeout",
        exitCode: EXIT_API,
        fix: `Poll later with \`phronel runs get ${id}\`; the run keeps going.`,
      });
    }
    note(`${run.status}: ${run.status_message ?? ""}`);
    await sleep(delay);
    delay = Math.min(delay + 5_000, 30_000);
  }
}

/** "Name:weight:description" or "Name:weight" or "Name". */
export function parseCriterion(raw: string): { name: string; weight: number; description: string } {
  const [name, weightRaw, ...rest] = raw.split(":");
  const weight = weightRaw === undefined || weightRaw.trim() === "" ? 3 : Number.parseInt(weightRaw, 10);
  if (!name?.trim()) throw new CliError(`--criterion needs a name, got '${raw}'`, { code: "usage", exitCode: EXIT_USAGE });
  if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
    throw new CliError(`--criterion weight must be 1 to 5, got '${weightRaw}'`, { code: "usage", exitCode: EXIT_USAGE, fix: 'Use "Name:weight:description", e.g. "Team:4:Founders with domain depth"' });
  }
  return { name: name.trim(), weight, description: rest.join(":").trim() };
}

const WAIT_FLAGS: FlagSpec[] = [
  { name: "wait", type: "boolean", desc: "Poll until the run completes or fails (usually 5 to 10 minutes)" },
  { name: "timeout", type: "string", desc: "Seconds to wait with --wait (default 1200)" },
];

export const COMMANDS: CommandDef[] = [
  {
    name: "login",
    summary: "Store your Phronel API key (from phronel.ai, API keys)",
    args: [],
    flags: [{ name: "api-key", type: "string", desc: "Key to store; omitted = prompted (or read from stdin when piped)" }],
    ops: [{ method: "GET", path: "/v1/credits" }],
    async run(ctx) {
      let key = strFlag(ctx.flags, "api-key");
      if (!key) key = process.stdin.isTTY ? await hiddenPrompt("Phronel API key: ") : await readStdin();
      key = key.trim();
      if (!KEY_PATTERN.test(key)) {
        throw new CliError("That is not a Phronel key", { code: "usage", exitCode: EXIT_USAGE, fix: `Mint one at ${CONSOLE_URL}/app/keys; it starts cap_inv_live_ or cap_inv_test_` });
      }
      const credits = await apiRequest({ path: "/v1/credits", key, apiUrl: ctx.apiUrl });
      writeConfig({ ...readConfig(), api_key: key, ...(ctx.apiUrl ? { api_url: ctx.apiUrl } : {}) });
      printData({ ok: true, key: maskKey(key), env: parseKey(key)?.env, ...credits }, ctx.json);
    },
  },
  {
    name: "whoami",
    summary: "Show which key and host are in use, and the credit balance",
    args: [],
    flags: [],
    ops: [{ method: "GET", path: "/v1/credits" }],
    async run(ctx) {
      const { key, baseUrl, keySource } = resolveAuth({ key: ctx.key, apiUrl: ctx.apiUrl });
      if (!key) {
        printData({ authenticated: false, api_url: baseUrl, fix: "Run `phronel login` or set PHRONEL_API_KEY" }, ctx.json);
        return 3;
      }
      const credits = await req(ctx, { path: "/v1/credits" });
      printData({ authenticated: true, key: maskKey(key), key_source: keySource, env: parseKey(key)?.env, api_url: baseUrl, ...credits }, ctx.json);
    },
  },
  {
    name: "run",
    summary: "Run a company: enrol, collect P15 market waves, compose the decision report (one credit)",
    args: [{ name: "company", required: true, desc: "Name, website/domain, or Companies House number" }],
    flags: [
      { name: "description", type: "string", desc: "What the company does (helps entity matching)" },
      { name: "domain", type: "string", desc: "The company's website, when the name alone is ambiguous (e.g. monzo.com)" },
      { name: "ch", type: "string", desc: "Companies House number (8 digits or 2 letters + 6 digits)" },
      { name: "deck", type: "string", desc: "Path to the pitch deck PDF; uploaded after the run starts (unlocks CRI and thesis fit)" },
      { name: "deck-url", type: "string", desc: "Public https URL of the pitch deck PDF" },
      { name: "webhook", type: "string", desc: "https URL to POST the run to when it completes" },
      { name: "no-email", type: "boolean", desc: "Do not email the workspace owner when the run completes" },
      ...WAIT_FLAGS,
    ],
    ops: [{ method: "POST", path: "/v1/runs" }, { method: "GET", path: "/v1/runs/{id}" }, { method: "POST", path: "/v1/companies/{id}/deck" }],
    async run(ctx) {
      const query = requireArg(ctx, 0, "company");
      const body: Record<string, unknown> = { query };
      const description = strFlag(ctx.flags, "description");
      if (description) body.description = description;
      const domain = strFlag(ctx.flags, "domain");
      if (domain) body.domain = domain;
      const ch = strFlag(ctx.flags, "ch");
      if (ch) body.companies_house_number = ch;
      const deckUrl = strFlag(ctx.flags, "deck-url");
      if (deckUrl) body.deck_url = deckUrl;
      const webhook = strFlag(ctx.flags, "webhook");
      if (webhook) body.webhook_url = webhook;
      if (boolFlag(ctx.flags, "no-email")) body.notify_email = false;
      let run = await req(ctx, { method: "POST", path: "/v1/runs", body });
      note(`run ${run.id} started for ${run.company?.name ?? query} (${run.credit_source} credit)`);
      const deck = strFlag(ctx.flags, "deck");
      if (deck) {
        const up = await req(ctx, { method: "POST", path: `/v1/companies/${run.company.id}/deck`, multipart: fileForm(deck) });
        run.deck = up.document;
        note(`deck ${up.document?.file_name} uploaded; CRI and thesis fit queued`);
      }
      if (boolFlag(ctx.flags, "wait")) {
        run = { ...(await waitForRun(ctx, run.id, intFlag(ctx.flags, "timeout") ?? 1200)), deck: run.deck };
      }
      printData(run, ctx.json);
      return run.status === "failed" ? 1 : 0;
    },
  },
  {
    name: "runs list",
    summary: "List the workspace's runs, newest first",
    args: [],
    flags: [],
    ops: [{ method: "GET", path: "/v1/runs" }],
    async run(ctx) {
      const data = await req(ctx, { path: "/v1/runs" });
      const rows = (data.runs ?? []).map((r: any) => ({ id: r.id, company: r.company?.name, status: r.status, credit: r.credit_source, created_at: r.created_at }));
      printData(ctx.json ? data : rows, ctx.json);
    },
  },
  {
    name: "runs get",
    summary: "Get a run (reading it also advances it); --wait polls to a terminal state",
    args: [{ name: "id", required: true, desc: "Run id" }],
    flags: WAIT_FLAGS,
    ops: [{ method: "GET", path: "/v1/runs/{id}" }],
    async run(ctx) {
      const id = requireUuid(ctx, 0, "id");
      const run = boolFlag(ctx.flags, "wait") ? await waitForRun(ctx, id, intFlag(ctx.flags, "timeout") ?? 1200) : await req(ctx, { path: `/v1/runs/${id}` });
      printData(run, ctx.json);
      return run.status === "failed" ? 1 : 0;
    },
  },
  {
    name: "scores",
    summary: "Scores for a company: P15, CRI (needs a deck), thesis fit (needs a deck and a thesis)",
    args: [{ name: "company_id", required: true, desc: "Company id (from the run)" }],
    flags: [],
    ops: [{ method: "GET", path: "/v1/companies/{id}/scores" }],
    async run(ctx) {
      printData(await req(ctx, { path: `/v1/companies/${requireUuid(ctx, 0, "company_id")}/scores` }), ctx.json);
    },
  },
  {
    name: "report",
    summary: "Fetch the decision report (JSON by default, --html for the page)",
    args: [{ name: "company_id", required: true, desc: "Company id (from the run)" }],
    flags: [
      { name: "html", type: "boolean", desc: "Return the HTML page instead of the JSON document" },
      { name: "out", type: "string", desc: "Write the report to this file instead of stdout" },
      { name: "regenerate", type: "boolean", desc: "Ask for a fresh report first (after adding a deck or thesis)" },
    ],
    ops: [{ method: "GET", path: "/v1/companies/{id}/report" }, { method: "POST", path: "/v1/companies/{id}/report" }],
    async run(ctx) {
      const id = requireUuid(ctx, 0, "company_id");
      if (boolFlag(ctx.flags, "regenerate")) {
        await req(ctx, { method: "POST", path: `/v1/companies/${id}/report`, query: { force: "true" } });
        note("report regenerating; fetching in 90s");
        await sleep(90_000);
      }
      const html = boolFlag(ctx.flags, "html");
      const data = await req(ctx, { path: `/v1/companies/${id}/report`, query: html ? { format: "html" } : undefined, timeoutMs: 60_000 });
      const out = strFlag(ctx.flags, "out");
      if (out) {
        mkdirSync(join(out, ".."), { recursive: true });
        writeFileSync(out, typeof data === "string" ? data : JSON.stringify(data, null, 2));
        printData({ written: out, bytes: typeof data === "string" ? data.length : JSON.stringify(data).length }, ctx.json);
        return;
      }
      if (typeof data === "string") process.stdout.write(data + (data.endsWith("\n") ? "" : "\n"));
      else printData(data, ctx.json);
    },
  },
  {
    name: "deck add",
    summary: "Attach a pitch deck PDF to a company (queues CRI and thesis fit)",
    args: [
      { name: "company_id", required: true, desc: "Company id (from the run)" },
      { name: "file", required: false, desc: "Path to the PDF (or pass --url)" },
    ],
    flags: [{ name: "url", type: "string", desc: "Public https URL of the PDF instead of a local file" }],
    ops: [{ method: "POST", path: "/v1/companies/{id}/deck" }],
    async run(ctx) {
      const id = requireUuid(ctx, 0, "company_id");
      const url = strFlag(ctx.flags, "url");
      const file = ctx.positionals[1];
      if (!url && !file) throw new CliError("Give a PDF path or --url", { code: "usage", exitCode: EXIT_USAGE, fix: "`phronel deck add <company_id> deck.pdf` or `--url https://...`" });
      const data = url
        ? await req(ctx, { method: "POST", path: `/v1/companies/${id}/deck`, body: { deck_url: url } })
        : await req(ctx, { method: "POST", path: `/v1/companies/${id}/deck`, multipart: fileForm(file!) });
      printData(data, ctx.json);
    },
  },
  {
    name: "theses list",
    summary: "List active theses with their criteria",
    args: [],
    flags: [],
    ops: [{ method: "GET", path: "/v1/theses" }],
    async run(ctx) {
      const data = await req(ctx, { path: "/v1/theses" });
      const rows = (data.theses ?? []).map((t: any) => ({ id: t.id, name: t.name, mandate: t.one_line_mandate, criteria: (t.thesis_criteria ?? []).map((c: any) => `${c.name}:${c.weight}`).join(", ") }));
      printData(ctx.json ? data : rows, ctx.json);
    },
  },
  {
    name: "theses create",
    summary: "Create a thesis and score every company with a deck against it",
    args: [{ name: "name", required: true, desc: "Thesis name" }],
    flags: [
      { name: "mandate", type: "string", desc: "One-line mandate" },
      { name: "description", type: "string", desc: "Longer description" },
      { name: "criterion", type: "list", desc: 'Repeatable: "Name:weight:description" (weight 1 to 5)' },
      { name: "sector", type: "list", desc: "Repeatable target sector" },
      { name: "stage", type: "list", desc: "Repeatable target stage" },
      { name: "geography", type: "list", desc: "Repeatable target geography" },
      { name: "must-have", type: "list", desc: "Repeatable must-have signal" },
      { name: "deal-breaker", type: "list", desc: "Repeatable deal-breaker" },
      { name: "from-json", type: "string", desc: "Path to a JSON body (same shape as POST /v1/theses); flags override" },
    ],
    ops: [{ method: "POST", path: "/v1/theses" }],
    async run(ctx) {
      const name = requireArg(ctx, 0, "name");
      let body: Record<string, unknown> = {};
      const fromJson = strFlag(ctx.flags, "from-json");
      if (fromJson) {
        try {
          body = JSON.parse(readFileSync(fromJson, "utf8"));
        } catch {
          throw new CliError(`Cannot read JSON from '${fromJson}'`, { code: "usage", exitCode: EXIT_USAGE });
        }
      }
      body.name = name;
      const mandate = strFlag(ctx.flags, "mandate");
      if (mandate) body.one_line_mandate = mandate;
      const description = strFlag(ctx.flags, "description");
      if (description) body.description = description;
      const criteria = listFlag(ctx.flags, "criterion").map(parseCriterion);
      if (criteria.length) body.criteria = criteria;
      for (const [flag, field] of [["sector", "target_sectors"], ["stage", "target_stages"], ["geography", "target_geographies"], ["must-have", "must_have_signals"], ["deal-breaker", "auto_pass_rules"]] as const) {
        const v = listFlag(ctx.flags, flag);
        if (v.length) body[field] = v;
      }
      if (!Array.isArray(body.criteria) || body.criteria.length === 0) {
        throw new CliError("A thesis needs at least one --criterion", { code: "usage", exitCode: EXIT_USAGE, fix: '--criterion "Team:4:Founders with domain depth" --criterion "Traction:4:Paying customers"' });
      }
      printData(await req(ctx, { method: "POST", path: "/v1/theses", body }), ctx.json);
    },
  },
  {
    name: "theses delete",
    summary: "Deactivate a thesis (existing fit scores stay)",
    args: [{ name: "id", required: true, desc: "Thesis id" }],
    flags: [],
    ops: [{ method: "DELETE", path: "/v1/theses/{id}" }],
    async run(ctx) {
      printData(await req(ctx, { method: "DELETE", path: `/v1/theses/${requireUuid(ctx, 0, "id")}` }), ctx.json);
    },
  },
  {
    name: "webhook-secret",
    summary: "The secret that signs run webhooks (x-phronel-signature); --rotate replaces it",
    args: [],
    flags: [{ name: "rotate", type: "boolean", desc: "Replace the secret; update your receiver straight after" }],
    ops: [{ method: "GET", path: "/v1/webhook-secret" }, { method: "POST", path: "/v1/webhook-secret/rotate" }],
    async run(ctx) {
      const rotate = boolFlag(ctx.flags, "rotate");
      printData(await req(ctx, rotate ? { method: "POST", path: "/v1/webhook-secret/rotate" } : { path: "/v1/webhook-secret" }), ctx.json);
      if (rotate) note("secret rotated; deliveries from now on are signed with it");
    },
  },
  {
    name: "credits",
    summary: "Free runs left this month and paid credit balance",
    args: [],
    flags: [],
    ops: [{ method: "GET", path: "/v1/credits" }],
    async run(ctx) {
      printData(await req(ctx, { path: "/v1/credits" }), ctx.json);
    },
  },
  {
    name: "pricing",
    summary: "Free allowance and the per-run price ladder (no key needed)",
    args: [],
    flags: [],
    ops: [{ method: "GET", path: "/v1/pricing" }],
    async run(ctx) {
      printData(await req(ctx, { path: "/v1/pricing", auth: false }), ctx.json);
    },
  },
  {
    name: "skill",
    summary: "Print (or --install) the agent skill file that teaches an AI assistant this CLI",
    args: [],
    flags: [
      { name: "install", type: "boolean", desc: "Write to .claude/skills/phronel/SKILL.md in the current directory" },
      { name: "dir", type: "string", desc: "Directory to install into (default .claude/skills/phronel)" },
    ],
    ops: [],
    async run(ctx) {
      if (!boolFlag(ctx.flags, "install")) {
        process.stdout.write(SKILL_MD);
        return;
      }
      const dir = strFlag(ctx.flags, "dir") ?? join(".claude", "skills", "phronel");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "SKILL.md");
      writeFileSync(path, SKILL_MD);
      printData({ installed: path }, ctx.json);
    },
  },
];
