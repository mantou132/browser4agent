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

## Failure modes

- `failed to connect to running MCP HTTP service` — the browser extension isn't running. Ask the user to open their browser with the extension installed.
