---
name: browser4agent
description: |-
  Control the user's active browser via `{{BIN}}` CLI. Use this when built-in fetch/HTTP cannot access content (login walls, SSO, intranet), or when you need browser-specific data (cookies, localStorage, errors, screenshots) or web app interactions (forms, clicks, actions).

  **Workflow:** Use whichever tool fits. If you need to run JavaScript in a page (`execute_script`), read the tab first (`read_tab` / `read_active_tab`) — if one of the page tools returned can do the job, use `execute_tab_tool` instead (use toolset_id, tool_name, and inputSchema from the read result; never guess).
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

## Available tools

Use `{{BIN}} --tool <name> --help` to view each tool's latest parameters, don't guess.

{{TOOLS}}

## Debugging with CDP (Chromium only)

The debugger tools exist only on Chromium (Chrome/Edge/Brave); never call them on Firefox.
Prefer `get_errors` and `execute_script` first — reach for CDP only when you need network
bodies/headers or lower-level visibility than page errors provide.

Order matters: `debugger_send_command` (`Network.enable`) → trigger the action → read
`debuggerEvents(tab_id)` inside `execute_script_in_background` (filter in the script, return
only what matters) → `debugger_detach`. Events are recorded only after their domain is
enabled.
If an error mentions DevTools or another debugger holding the tab, ask the user to close it;
on `No target with given id found`, get a fresh id via `list_tabs`.

## Failure modes

- `failed to connect to running MCP HTTP service` — the browser extension isn't running. Ask the user to open their browser with the extension installed.
