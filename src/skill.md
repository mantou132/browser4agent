---
name: browser4agent
description: |-
  Control the user's active browser via `{{BIN}}` CLI. Use this when built-in fetch/HTTP cannot access content (login walls, SSO, intranet), or when you need browser-specific data (cookies, localStorage, errors, screenshots) or web app interactions (forms, clicks, actions).
  Follow the routing workflow below: prefer dedicated tools, then discovered page tools, and use scripts or CDP only at their stated capability boundary.
---

## Calling a tool

```bash
# Inline JSON
{{BIN}} --tool <name> --input '<json-object>'

# Complex/multiline JSON via heredoc (no escaping needed)
cat <<'EOF' | {{BIN}} --tool <name> --stdin
<json-object>
EOF
```

Use `--stdin` with heredoc when the JSON contains nested quotes, multiline strings, or embedded code that would be difficult to escape inline (use corresponding methods in different operating environments).

## Tool routing

{{WORKFLOW}}

## Available tools

Each tool below includes a compact top-level input signature. Use `{{BIN}} --tool <name> --help`
only when a nested value's shape is unclear or you need the complete latest schema; don't guess.

{{TOOLS}}

## Debugging with CDP (Chromium only)

The debugger tools exist only on Chromium (Chrome/Edge/Brave); never call them on Firefox.
Prefer dedicated tools and page/background scripts first. Reach for CDP only when they cannot
provide network bodies/headers or other required protocol-level visibility.

For event-driven domains, order matters:

1. Call `debugger_send_command` to enable the domain, such as `Network.enable`.
2. Read `debuggerEvents(tab_id).cursor` inside `execute_script_in_background` and save it as the
   baseline.
3. Trigger the action.
4. Read `debuggerEvents(tab_id)` again; filter inside the background script to events whose `seq`
   is at least the baseline and return only the relevant methods/request IDs.
5. Before detaching, run any required follow-up CDP commands. For a response body, wait for the
   matching request to finish, then call `Network.getResponseBody` with its `requestId`.
6. Call `debugger_detach` when all follow-up commands are complete.

Events are recorded only after their domain is enabled. The baseline prevents buffered events
from an earlier action or attachment from being mistaken for new ones.
If an error mentions DevTools or another debugger holding the tab, ask the user to close it;
on `No target with given id found`, get a fresh id via `list_tabs`.

## Failure modes

- `failed to connect to running MCP HTTP service` — the browser extension isn't running. Ask the user to open their browser with the extension installed.
