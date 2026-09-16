import type { FlagValues } from "./args.js";
import { boolFlag } from "./args.js";
import type { CliError } from "./errors.js";

/** JSON is the default whenever stdout is not a terminal; --json forces it. */
export function wantsJson(flags: FlagValues): boolean {
  return boolFlag(flags, "json") || !process.stdout.isTTY;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const s = JSON.stringify(value);
    return s.length > 40 ? s.slice(0, 37) + "…" : s;
  }
  const s = String(value);
  return s.length > 48 ? s.slice(0, 45) + "…" : s;
}

function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no results)";
  const columns: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!columns.includes(k)) columns.push(k);
      if (columns.length >= 8) break;
    }
  }
  const shown = columns.slice(0, 8);
  const widths = shown.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join("  ");
  const out = [line(shown), line(widths.map((w) => "-".repeat(w)))];
  for (const row of rows) out.push(line(shown.map((c) => cell(row[c]))));
  return out.join("\n");
}

export function printData(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  if (Array.isArray(data) && data.every((r) => r && typeof r === "object")) {
    process.stdout.write(renderTable(data as Record<string, unknown>[]) + "\n");
    return;
  }
  if (data && typeof data === "object" && Array.isArray((data as any).data)) {
    const { data: rows, next_cursor } = data as { data: Record<string, unknown>[]; next_cursor?: string | null };
    process.stdout.write(renderTable(rows) + "\n");
    if (next_cursor) {
      process.stdout.write(`\nmore results: pass --cursor ${next_cursor}\n`);
    }
    return;
  }
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function printError(err: CliError, json: boolean): void {
  if (json) {
    const envelope: Record<string, unknown> = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.requestId ? { request_id: err.requestId } : {}),
        ...(err.status ? { status: err.status } : {}),
      },
    };
    if (err.fix) envelope.fix = err.fix;
    process.stderr.write(JSON.stringify(envelope) + "\n");
    return;
  }
  process.stderr.write(`phronel: ${err.code}: ${err.message}\n`);
  if (err.requestId) process.stderr.write(`  request_id: ${err.requestId}\n`);
  if (err.fix) process.stderr.write(`  fix: ${err.fix}\n`);
}

/** Progress note for humans; silent when stderr is piped so agents see clean streams. */
export function note(message: string): void {
  if (process.stderr.isTTY) process.stderr.write(message + "\n");
}
