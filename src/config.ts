import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  api_key?: string;
  api_url?: string;
}

export function configDir(): string {
  return process.env.PHRONEL_CONFIG_DIR ?? join(homedir(), ".config", "phronel");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export function readConfig(): CliConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: CliConfig): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath(), 0o600);
}

// Phronel keys are Caplia investor keys: minted at phronel.ai, same format.
export const KEY_PATTERN = /^cap_inv_(live|test)_[A-Za-z0-9]{32}$/;

export interface KeyInfo {
  env: "live" | "test";
}

export function parseKey(key: string): KeyInfo | null {
  const m = KEY_PATTERN.exec(key);
  return m ? { env: m[1] as "live" | "test" } : null;
}

export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 13)}…${key.slice(-4)}` : "(invalid)";
}

export const PROD_URL = "https://api.phronel.ai";
export const SANDBOX_URL = "https://api-sandbox.phronel.ai";
export const CONSOLE_URL = "https://phronel.ai";

export interface AuthOverrides {
  key?: string;
  apiUrl?: string;
}

/**
 * Key precedence: --key flag, PHRONEL_API_KEY, stored config.
 * URL precedence: --api-url flag, PHRONEL_API_URL, stored config, then derived
 * from the key: test keys route to the sandbox, live keys to production.
 */
export function resolveAuth(overrides: AuthOverrides): { key: string | null; baseUrl: string; keySource: string } {
  const cfg = readConfig();
  let key: string | null = null;
  let keySource = "none";
  if (overrides.key) {
    key = overrides.key;
    keySource = "flag";
  } else if (process.env.PHRONEL_API_KEY) {
    key = process.env.PHRONEL_API_KEY;
    keySource = "env";
  } else if (cfg.api_key) {
    key = cfg.api_key;
    keySource = "config";
  }
  const derived = key && parseKey(key)?.env === "test" ? SANDBOX_URL : PROD_URL;
  const baseUrl = overrides.apiUrl ?? process.env.PHRONEL_API_URL ?? cfg.api_url ?? derived;
  return { key, baseUrl: baseUrl.replace(/\/+$/, ""), keySource };
}
