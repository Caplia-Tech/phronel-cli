# phronel

Phronel on the command line: run a company, get the decision back. Built for AI
agents and humans alike. Zero runtime dependencies, Node 18.17 or newer.

```bash
npx phronel login                      # key from https://phronel.ai/app/keys
npx phronel run monzo.com --wait       # P15 market waves + decision report, one credit
npx phronel run "Acme Ltd" --deck ./deck.pdf --wait   # adds CRI readiness and thesis fit
```

Three runs a month are free. Test keys (`cap_inv_test_*`) route to the sandbox,
live keys to production.

| Command | Does |
|---|---|
| `login`, `whoami` | store and verify the key |
| `run <company> [--domain d] [--ch n] [--deck f.pdf] [--deck-url u] [--webhook u] [--wait]` | start a run; `--wait` polls to complete; `--domain`/`--ch` pin the company when a name alone is ambiguous |
| `runs list`, `runs get <id> [--wait]` | runs, newest first; reading a run advances it |
| `scores <company_id>` | P15, CRI, thesis fit, jobs in flight |
| `report <company_id> [--html] [--out f] [--regenerate]` | the decision report |
| `deck add <company_id> f.pdf` or `--url u` | attach a deck, queues CRI and thesis fit |
| `theses list`, `theses create <name> --criterion "Team:4:..."`, `theses delete <id>` | theses for fit scoring |
| `credits`, `pricing` | allowance and ladder |
| `webhook-secret [--rotate]` | the secret behind `x-phronel-signature` on run webhooks |
| `skill --install` | write an agent skill file to `.claude/skills/phronel/` |

JSON on stdout whenever piped (`--json` forces it), structured errors on stderr with
a `fix` hint, exit codes 0 ok / 1 API or failed run / 2 usage / 3 auth / 4 network.

The same key also works on Caplia's wider API on the same host and on the MCP
server at `https://mcp.phronel.ai`.

## Develop

```bash
npm ci && npm test      # builds with tsc, then node --test against a mock API
```

Publishing: bump `version.ts` + `package.json`, `npm publish` (2FA), then update
the Homebrew formula in `Caplia-Tech/homebrew-tap`.
