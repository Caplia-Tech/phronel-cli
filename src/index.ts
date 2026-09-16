#!/usr/bin/env node
import { GLOBAL_FLAGS, parseFlags, strFlag, boolFlag } from "./args.js";
import { COMMANDS, type CommandDef, type Ctx } from "./commands.js";
import { CliError, EXIT_USAGE } from "./errors.js";
import { printError, wantsJson } from "./output.js";
import { VERSION } from "./version.js";

function findCommand(argv: string[]): { cmd: CommandDef; rest: string[] } | null {
  // Longest name wins: "theses create" before "theses".
  const words = argv.filter((a) => !a.startsWith("--"));
  for (let take = Math.min(3, words.length); take >= 1; take--) {
    const name = words.slice(0, take).join(" ");
    const cmd = COMMANDS.find((c) => c.name === name);
    if (cmd) {
      const rest: string[] = [];
      let matched = 0;
      for (const a of argv) {
        if (!a.startsWith("--") && matched < take) {
          matched++;
          continue;
        }
        rest.push(a);
      }
      return { cmd, rest };
    }
  }
  return null;
}

function commandHelp(cmd: CommandDef): string {
  const argStr = cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  const lines = [`Usage: phronel ${cmd.name}${argStr ? " " + argStr : ""} [flags]`, "", cmd.summary];
  if (cmd.args.length) {
    lines.push("", "Arguments:");
    for (const a of cmd.args) lines.push(`  ${a.name.padEnd(18)} ${a.desc}`);
  }
  const allFlags = [...cmd.flags, ...GLOBAL_FLAGS];
  lines.push("", "Flags:");
  for (const f of allFlags) {
    const label = f.type === "boolean" ? `--${f.name}` : `--${f.name} <value>`;
    lines.push(`  ${label.padEnd(24)} ${f.desc}`);
  }
  return lines.join("\n") + "\n";
}

function topHelp(): string {
  const lines = [
    `phronel ${VERSION} - Phronel on the command line: run a company, get the decision back`,
    "",
    "Usage: phronel <command> [arguments] [flags]",
    "",
    "Commands:",
  ];
  for (const cmd of COMMANDS) lines.push(`  ${cmd.name.padEnd(18)} ${cmd.summary}`);
  lines.push(
    "",
    "Start:",
    "  phronel login                      store your key from https://phronel.ai/app/keys",
    '  phronel run monzo.com --wait       one credit; 3 free a month',
    "  phronel run acme.io --deck deck.pdf --wait   adds CRI readiness and thesis fit",
    "",
    "Keys starting cap_inv_test_ route to the sandbox, cap_inv_live_ to production.",
    "Run `phronel <command> --help` for flags. JSON output whenever stdout is piped.",
  );
  return lines.join("\n") + "\n";
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(topHelp());
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    const flagsOnly = parseFlags(argv.filter((a) => a.startsWith("--")), GLOBAL_FLAGS);
    const err = new CliError(`Unknown command '${argv.filter((a) => !a.startsWith("--")).join(" ")}'`, {
      code: "usage",
      exitCode: EXIT_USAGE,
      fix: "Run `phronel --help` for the command list",
    });
    printError(err, wantsJson(flagsOnly.flags));
    return EXIT_USAGE;
  }
  const { cmd, rest } = found;
  let parsed;
  try {
    parsed = parseFlags(rest, [...cmd.flags, ...GLOBAL_FLAGS]);
  } catch (err) {
    if (err instanceof CliError) {
      printError(err, !process.stdout.isTTY);
      return err.exitCode;
    }
    throw err;
  }
  if (boolFlag(parsed.flags, "help")) {
    process.stdout.write(commandHelp(cmd));
    return 0;
  }
  const ctx: Ctx = {
    positionals: parsed.positionals,
    flags: parsed.flags,
    json: wantsJson(parsed.flags),
    key: strFlag(parsed.flags, "key"),
    apiUrl: strFlag(parsed.flags, "api-url"),
    command: cmd.name,
  };
  try {
    const code = await cmd.run(ctx);
    return code ?? 0;
  } catch (err) {
    if (err instanceof CliError) {
      printError(err, ctx.json);
      return err.exitCode;
    }
    const wrapped = new CliError(err instanceof Error ? err.message : String(err), { code: "internal", exitCode: 1 });
    printError(wrapped, ctx.json);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`phronel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
