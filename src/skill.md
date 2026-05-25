---
name: browser4agent
description: Drive the user's running browser from the command line via the `browser4agent` CLI — read web page content, manage browser tabs and windows, intercept network requests, and run custom scripts either inside a tab or in the extension background.
---

# browser4agent

This skill exposes the user's running browser through the local `browser4agent` CLI. Two main use cases:

- **Read web page content** — especially pages that need the user's browser session (local services, intranet, login-required), since the browser carries the cookies and access. Works whether the page is already open or not; if it isn't, open it first via `execute_script_in_background` (`chrome.tabs.create`) then read it.
- **Drive the browser itself** — list/create/close tabs and windows, intercept network requests, run arbitrary JS inside a specific tab, or run scripts in the extension background to manage browser-wide state. Some `chrome.*` APIs require optional permissions (e.g. `history`, `bookmarks`, `downloads`, `notifications`); call `chrome.permissions.request({ permissions: ['<name>'] })` inside `execute_script_in_background` to obtain them at runtime before use.

If a tool listed below matches the user's intent, prefer it over scraping or guessing.

## Calling a tool

```bash
# Inline JSON
{{BIN}} --tool <name> --input '<json-object>'

# Complex/multiline JSON via heredoc (no escaping needed)
cat <<'EOF' | {{BIN}} --tool <name> --stdin
<json-object>
EOF
```

Use `--stdin` with heredoc when the JSON contains nested quotes, multiline strings, or embedded code that would be difficult to escape inline.

## Typical flow

1. If you need a `tab_id`, run `{{BIN}} --tool list_tabs` (or `--tool read_active_tab` when the user means "the current page").
2. Before writing custom JS for a tab, call `list_tab_tools` first — pages can register purpose-built tools (e.g. `send_email` on Gmail). If a match exists, prefer `execute_tab_tool` over `execute_script`.
3. Call the target tool with `--tool` + `--input`.

## Available tools

{{TOOLS}}

## Failure modes

- `failed to connect to running MCP HTTP service` — the browser extension isn't running. Ask the user to open their browser with the extension installed.
