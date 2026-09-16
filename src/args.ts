import { CliError, EXIT_USAGE } from "./errors.js";

export interface FlagSpec {
  name: string;
  type: "string" | "boolean" | "list";
  desc: string;
}

export type FlagValues = Record<string, string | boolean | string[]>;

export interface ParsedArgs {
  positionals: string[];
  flags: FlagValues;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: "json", type: "boolean", desc: "Force JSON output (the default when stdout is not a terminal)" },
  { name: "key", type: "string", desc: "API key to use for this invocation (overrides PHRONEL_API_KEY and stored config)" },
  { name: "api-url", type: "string", desc: "API base URL override (defaults to sandbox for test keys, production for live keys)" },
  { name: "help", type: "boolean", desc: "Show help for this command" },
];

export function parseFlags(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s]));
  const flags: FlagValues = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const spec = byName.get(name);
    if (!spec) {
      throw new CliError(`Unknown flag --${name}`, {
        code: "usage",
        exitCode: EXIT_USAGE,
        fix: "Run the command with --help to see its flags",
      });
    }
    if (spec.type === "boolean") {
      flags[name] = inline === undefined ? true : inline !== "false";
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) {
        throw new CliError(`Flag --${name} requires a value`, {
          code: "usage",
          exitCode: EXIT_USAGE,
          fix: `Pass --${name} <value>`,
        });
      }
    }
    if (spec.type === "list") {
      const existing = flags[name];
      if (Array.isArray(existing)) existing.push(value);
      else flags[name] = [value];
    } else {
      flags[name] = value;
    }
  }
  return { positionals, flags };
}

export function strFlag(flags: FlagValues, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function boolFlag(flags: FlagValues, name: string): boolean {
  return flags[name] === true;
}

export function listFlag(flags: FlagValues, name: string): string[] {
  const v = flags[name];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

export function intFlag(flags: FlagValues, name: string): number | undefined {
  const v = strFlag(flags, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new CliError(`Flag --${name} must be a non-negative integer, got '${v}'`, {
      code: "usage",
      exitCode: EXIT_USAGE,
    });
  }
  return n;
}
