# vin-recall-mcp

[![PR checks](https://github.com/pratikmehkarkar/vin-recall-mcp/actions/workflows/pr-checks.yml/badge.svg)](https://github.com/pratikmehkarkar/vin-recall-mcp/actions/workflows/pr-checks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

▶️ [Watch a 2-minute demo](https://www.loom.com/share/3d9b33266e1740008129534103e0f68d)

A remote [MCP](https://modelcontextprotocol.io) server that gives any MCP client (Claude, or any other MCP-compatible agent) two tools for free U.S. government vehicle data: **decode a VIN** and **check open safety recalls**, both backed by NHTSA's public APIs.

## What it does

`vin-recall-mcp` exposes two tools over a single Streamable HTTP endpoint: `decode_vin`, which turns a 17-character VIN into make, model, year, body class, engine, fuel type, and assembly plant using NHTSA's vPIC database; and `check_recalls`, which decodes that same VIN internally and returns every open safety recall campaign NHTSA has on file for that vehicle configuration. Point an MCP client at the URL below and ask it a plain-English question — no API key, no signup, no auth.

## Why it exists

NHTSA's vPIC and Recalls APIs are free and genuinely useful, but they're not built for a conversation. `decodevin` alone returns 100+ key/value pairs per VIN, most of them empty or the literal string `"Not Applicable"`. The recalls endpoint returns `HTTP 400` for a *legitimate* zero-results case, the exact same status it uses for a bad request. Response times swing from a quarter-second to several seconds on the same VIN. None of that is something you want an agent — or a human — parsing raw. This server does the flattening, validation, timeout handling, and error translation once, so an MCP client can just ask "what's this VIN, and does it have any open recalls?" and get a clean answer back.

## Architecture

```
MCP client (Claude, mcp-remote, MCP Inspector, ...)
        │  Streamable HTTP, JSON-RPC
        ▼
Node/Express server  ──▶  NHTSA vPIC API        (decode_vin)
(this repo, self-hosted   NHTSA Recalls API     (check_recalls)
 on Ubuntu behind Caddy)
        │
        ▼
Cleaned, structured response
(flattened fields, human summary, error/caveat notes)
```

The server is a stateless Node/Express process using `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport` — a fresh `McpServer` per request, no sessions, no database, no auth layer. It's self-hosted on-prem (Ubuntu Server, "Zenith") behind a Caddy reverse proxy for HTTPS termination, rather than a serverless platform, so the tools run under a real long-lived process with straightforward logs and no cold starts. Tool logic (`src/tools.ts`) is fully decoupled from the transport (`src/server.ts`), so it can be — and is — imported and tested directly by the eval suite without a running server.

## Tools

### `decode_vin`

Decode a 17-character US VIN into vehicle attributes.

| | |
|---|---|
| **Input** | `vin` *(string, required)* — 17 characters, letters and digits, excluding `I`, `O`, `Q` |
| **Output** | `make`, `model`, `year`, `bodyClass`, `engineCylinders`, `fuelType`, `driveType`, `plantCountry` (each omitted if NHTSA has no meaningful value), a one-line `summary`, and a `found` flag |
| **Coverage** | US-market vehicles from the 1981 17-character VIN standard onward |

### `check_recalls`

List open NHTSA safety recall campaigns for a vehicle, by VIN.

| | |
|---|---|
| **Input** | `vin` *(string, required)* — same 17-character format; decoded internally to get make/model/year, so there's no separate make/model/year input path |
| **Output** | `checked` flag, `make`/`model`/`year`, `recallCount`, and a `recalls` array — each with `campaignNumber`, `summary`, `consequence`, `remedy`, `reportDate`, and the `parkIt`/`parkOutside` safety flags where NHTSA provides them |
| **Zero recalls** | Returns an explicit "No open recall campaigns found for this vehicle," never a silent empty array |

## Install

**Live endpoint:** `https://vin-recall-mcp.zenithserver.duckdns.org/mcp`

**Claude.ai / Claude web:** Settings → Connectors → Add custom connector → paste the URL above.

**Claude Desktop** (or any client that needs a local proxy) — add to your MCP config, using [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "vin-recall": {
      "command": "npx",
      "args": ["mcp-remote", "https://vin-recall-mcp.zenithserver.duckdns.org/mcp"]
    }
  }
}
```

Once connected, just ask naturally: *"Can you decode VIN JM3KFBCM1R0123456 and tell me if it has any open recalls?"*

## Caveats

These aren't polish — they're correctness constraints this server is built around:

- **A recall campaign is not proof of a repair.** `check_recalls` returns campaigns issued for a make/model/year *configuration*. It never confirms whether the specific VIN's vehicle was actually fixed at a dealer — that record isn't public. Every non-empty result carries this disclaimer.
- **Coverage gap by design, not by bug.** vPIC reliably decodes US-market vehicles from the 1981 17-character VIN standard onward. Pre-1981 VINs are shorter by definition and are rejected by input validation before any network call; some foreign-market vehicles may also return partial or no data. Either way you get a clean "not found" message, never a crash.
- **NHTSA is slow, and inconsistently so.** Real-world response times for the same VIN have ranged from ~0.3s to 3s+ in testing. Every outbound request carries a 9-second timeout; a timeout returns a plain "NHTSA is slow or unavailable, try again," never a hang or a stack trace.
- **Decoded fields are manufacturer-submitted.** NHTSA doesn't guarantee every field is populated even for a VIN that decodes successfully. Missing fields are silently dropped rather than shown as empty, and a note is attached whenever NHTSA's own error code flags the decode as non-clean.

## Evals

`evals/` contains 9 cases exercising both tools against the *real* NHTSA APIs (deliberately not mocked — the point is proving the tool logic survives NHTSA's actual response shapes, not a fake of them): a known-good modern VIN, a Tesla, a truck, a motorcycle, a malformed VIN, a pre-1981-length VIN, a well-formed-but-undecodable VIN, a VIN with known open recalls, and a VIN with none. Each case asserts on error/success state, required substrings, structured-content fields, and — for successful results — that the output actually satisfies the tool's declared Zod `outputSchema`.

```bash
cd vin-recall-mcp
npm install
npm run eval
```

This also runs automatically on every pull request against `main` (see `.github/workflows/pr-checks.yml`), alongside a type-check.

## License

[MIT](LICENSE)
