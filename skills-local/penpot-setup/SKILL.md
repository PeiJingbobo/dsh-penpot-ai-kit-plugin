---
name: penpot-setup
description: "Set up the Penpot MCP connection required by this plugin. Use whenever penpot_kit_status reports configured=false or connected=false, when the user asks to configure/connect Penpot, or after a Penpot request was refused because no MCP was available. Prints the exact config file path, a ready-to-paste JSON example, the chmod step, and how to verify the connection end to end."
version: 0.1.0
audiences: [design-system, product-designer, design-engineer]
mode-default: suggest
---

# penpot-setup — close the MCP gate

This plugin refuses all Penpot design work until a live Penpot MCP connection
is verified. This skill is the only skill available while the gate is closed.

## 1. Call `penpot_kit_status` first

Always start with the tool, never with a guess:

```json
{}
```

Read all six fields: `configured`, `connected`, `serverName`, `toolCount`,
`error`, `configPath`. Report them to the user verbatim (path included).

- `connected: true` → the gate is open. Stop this skill and load
  `penpot-router` for the actual design request.
- `configured: false` → step 2 (write the file).
- `configured: true, connected: false` → step 4 (fix the URL/server), then
  restart DSH.

## 2. Write the config file

Default path (use the `configPath` value from the tool if it differs):

```
~/.dsh/penpot-ai-kit/config.json
```

`PENPOT_AI_KIT_CONFIG` overrides the path (absolute path recommended).

Local Penpot MCP (the plugin on `4400`, MCP on `4401`):

```json
{
  "version": 1,
  "mcp": {
    "serverName": "penpot",
    "transport": "streamable-http",
    "url": "http://localhost:4401/mcp",
    "headers": {},
    "toolCallTimeoutMs": 120000
  }
}
```

Penpot SaaS:

```json
{
  "version": 1,
  "mcp": {
    "serverName": "penpot",
    "transport": "streamable-http",
    "url": "https://design.penpot.app/mcp/stream?userToken=YOUR_MCP_KEY",
    "headers": {},
    "toolCallTimeoutMs": 120000
  }
}
```

Give the user a single copy-paste block (adjust the URL):

```sh
mkdir -p ~/.dsh/penpot-ai-kit
cat > ~/.dsh/penpot-ai-kit/config.json <<'JSON'
{ ...the object above... }
JSON
chmod 600 ~/.dsh/penpot-ai-kit/config.json
```

The file contains a token for SaaS URLs: it **must** be mode 0600. Never echo
the token back into the chat.

## 3. Field reference (reject typos)

| Field | Required | Notes |
|---|---|---|
| `version` | yes | must be exactly `1` |
| `mcp.serverName` | no | `penpot` by default; `[A-Za-z0-9_-]{1,32}` |
| `mcp.transport` | yes | `streamable-http` (or `stdio` for a bridge) |
| `mcp.url` | http | e.g. `http://localhost:4401/mcp` |
| `mcp.headers` | no | object of string values |
| `mcp.toolCallTimeoutMs` | no | default `120000` |

Unknown keys are rejected on purpose (a typo must not silently fall back).
`stdio` instead requires `mcp.command` and accepts `args`, `env`, `cwd`.

## 4. Verify

1. Restart DSH so the bundle reads the config at startup.
2. Call `penpot_kit_status` again.
   - `connected: true` and `toolCount > 0` → success.
   - Still closed → read `error`: invalid URL, DNS/refused connection, 401
     (missing/expired `userToken`), or the MCP server is not running.
3. Load `penpot-router`; it runs `high_level_overview` first, then routes.
4. For a read-only smoke test, load `penpot-audit-tokens` and run an audit on
   the open file — it mutates nothing.

## 5. Rules

- Without `connected: true`, do not call `execute_code`, `export_shape`, or any
  other Penpot tool, and do not describe a design as done.
- Do not create the config in the repository; it is user state, outside the
  project.
- If the user cannot run a local MCP server, point them at the hosted endpoint
  and the `userToken` flow above.
