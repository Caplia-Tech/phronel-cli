import { type AuthOverrides, resolveAuth } from "./config.js";
import { CliError, EXIT_API, EXIT_AUTH, EXIT_NETWORK } from "./errors.js";
import { VERSION } from "./version.js";

const FIXES: Record<string, string> = {
  unauthenticated:
    "Run `phronel login`, or set PHRONEL_API_KEY. Mint a key at phronel.ai under API keys (sandbox keys start cap_inv_test_, production keys cap_inv_live_).",
  forbidden:
    "This key lacks the required scope or key type. Mint a key with write scope at phronel.ai under API keys.",
  rate_limited: "Wait and retry. The Retry-After response header says how long.",
  insufficient_credits: "No free runs left this month and no paid credits. Top up at https://phronel.ai/app/billing.",
  not_found: "Check the id. List commands (e.g. `phronel runs list`) show valid ids.",
  bad_request: "The request was rejected. Re-check the flags and values you passed.",
};

export interface MultipartPayload {
  body: Uint8Array;
  contentType: string;
}

export interface RequestOpts extends AuthOverrides {
  method?: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  multipart?: MultipartPayload;
  tool?: string;
  auth?: boolean;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function apiRequest(opts: RequestOpts): Promise<any> {
  const { key, baseUrl } = resolveAuth(opts);
  const method = opts.method ?? "GET";
  const needsAuth = opts.auth !== false;

  if (needsAuth && !key) {
    throw new CliError("No API key configured", {
      code: "unauthenticated",
      exitCode: EXIT_AUTH,
      fix: FIXES.unauthenticated,
    });
  }

  const url = new URL(baseUrl + opts.path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    "user-agent": `phronel-cli/${VERSION}`,
    // Ignored by the API today; lets request logs attribute CLI traffic later.
    "x-caplia-source": "cli",
  };
  if (opts.tool) headers["x-caplia-tool"] = `cli:${opts.tool}`;
  if (needsAuth && key) headers["authorization"] = `Bearer ${key}`;

  // Multipart is pre-encoded to a byte body (not FormData) so the request
  // ships with an exact Content-Length; the platform's edge gateway rejects
  // fetch's chunked-transfer FormData uploads with a 502.
  let bodyInit: BodyInit | undefined;
  if (opts.multipart) {
    headers["content-type"] = opts.multipart.contentType;
    bodyInit = opts.multipart.body as unknown as BodyInit;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }

  const timeoutMs = opts.timeoutMs ?? (opts.multipart ? 180_000 : 30_000);
  // Only idempotent reads are retried; a retried POST could double-submit.
  const maxAttempts = method === "GET" ? 3 : 1;

  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyInit,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastNetworkError = err;
      if (attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new CliError(
        timedOut ? `Request timed out after ${timeoutMs / 1000}s` : `Could not reach ${url.host}`,
        {
          code: timedOut ? "timeout" : "network",
          exitCode: EXIT_NETWORK,
          fix: `Check your connection to ${baseUrl}. Override the host with --api-url or PHRONEL_API_URL if needed.`,
        },
      );
    }

    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      await sleep(Number.isNaN(retryAfter) ? 1000 * attempt : retryAfter * 1000);
      continue;
    }

    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let parsed: any = text;
    if (contentType.includes("application/json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Fall through with the raw text.
      }
    }

    if (!res.ok) {
      const envelope = parsed && typeof parsed === "object" ? parsed.error : undefined;
      const code: string = envelope?.code ?? `http_${res.status}`;
      const message: string = envelope?.message ?? `Request failed with status ${res.status}`;
      throw new CliError(message, {
        code,
        exitCode: res.status === 401 || res.status === 403 ? EXIT_AUTH : EXIT_API,
        fix: FIXES[code],
        requestId: envelope?.request_id ?? res.headers.get("x-request-id") ?? undefined,
        status: res.status,
      });
    }
    return parsed;
  }
  // Unreachable, but satisfies the compiler.
  throw lastNetworkError;
}
