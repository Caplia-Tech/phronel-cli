export const SKILL_MD = `---
name: phronel
description: Use the Phronel CLI to run a company through Phronel (P15 market waves, CRI readiness from a pitch deck, thesis fit) and read the decision report. Trigger whenever the task is to assess, screen or research a startup or company, or mentions Phronel, Caplia scores, CRI, P15 or thesis fit.
---

# Phronel CLI

\`phronel\` is a thin client over the Phronel API (https://api.phronel.ai). Built for
agents: JSON on stdout whenever piped, structured errors on stderr, stable exit codes,
and \`--wait\` for the long operations.

## Auth

- Set \`PHRONEL_API_KEY\`, or run \`phronel login\` once (stores the key in
  ~/.config/phronel/config.json, mode 600). \`phronel whoami\` verifies it and shows credits.
- Keys are minted at https://phronel.ai under API keys. Test keys (\`cap_inv_test_*\`)
  route to the sandbox automatically, live keys (\`cap_inv_live_*\`) to production.

## The one-call flow

\`\`\`bash
phronel run monzo.com --wait                       # 202, then polls to complete (5 to 10 min)
phronel run "Acme Ltd" --deck ./deck.pdf --wait    # also uploads the deck: CRI + thesis fit
phronel runs get <run_id>                          # status, report URLs when complete
phronel scores <company_id>                        # P15, CRI, thesis fit, jobs in flight
phronel report <company_id>                        # decision report JSON (--html for the page)
\`\`\`

A run costs one credit; three a month are free (\`phronel credits\`, \`phronel pricing\`).
Without a deck the report carries P15 only; say so rather than inventing a CRI number.

## Theses

\`\`\`bash
phronel theses create "Seed B2B SaaS" --mandate "Pre-seed to seed UK B2B software" \\
  --criterion "Team:4:Founders with domain depth" --criterion "Traction:4:Paying customers" \\
  --sector SaaS --stage Seed
phronel theses list
phronel report <company_id> --regenerate           # after adding a deck or a thesis
\`\`\`

## Output and errors

- Stdout carries data only; \`--json\` forces JSON on a terminal.
- Errors are JSON on stderr: \`{"error":{"code","message","request_id"},"fix":"..."}\`.
  Act on \`fix\` before retrying. \`insufficient_credits\` means the workspace must top up.
- Exit codes: 0 ok, 1 API error or failed run, 2 usage, 3 auth, 4 network/timeout.

## Everything else on the same key

The same key works on Caplia's wider API (companies, documents, usage) at the same
host, and on the MCP server at https://mcp.phronel.ai for MCP-capable clients.
`;
