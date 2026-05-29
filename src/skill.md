---
name: browser4agent
description: >-
  Access and control the user's real browser with their active session via {{BIN}}
  CLI. Use this when built-in fetch/HTTP cannot access content (login walls, SSO,
  intranet), or when you need browser-specific data (cookies, localStorage, errors,
  screenshots) or web app interactions (forms, clicks, actions).\n\n**Workflow for
  web app interactions:**\n1. Ensure target page is open (ask user, or
  chrome.tabs.create via execute_script_in_background)\n2. list_tabs → tab_id\n3.
  list_tab_tools → discover user-subscribed toolsets for that page\n4. If matching
  tool exists: execute_tab_tool (preferred)\n5. If no tool: execute_script for
  custom JS\nALWAYS check list_tab_tools first — never skip or guess tool
  names.\n\n**Reading content:** read_active_tab for current tab; list_tabs +
  read_tab for specific tabs. Open URLs first via execute_script_in_background if
  needed.\n\n**Browser automation:** execute_script_in_background runs in extension
  service worker with full chrome.* API: tabs/windows management
  (create/remove/update), notifications (chrome.notifications.create for
  long-running ops), downloads, network, permissions, etc.\n\n**Cleanup:** Close
  temporary tabs after use with chrome.tabs.remove via
  execute_script_in_background.
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

{{TOOLS}}

## Failure modes

- `failed to connect to running MCP HTTP service` — the browser extension isn't running. Ask the user to open their browser with the extension installed.
