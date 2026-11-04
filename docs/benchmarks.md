# Page Tools vs. Generic Browsing

What an agent gets when it reads a page generically (`read_tab`, screenshots, or another browser MCP server's snapshot) versus calling a page tool from [browser4agent-toolsets](https://github.com/mantou132/browser4agent-toolsets).

Token counts use OpenAI's `o200k_base` tokenizer as a proxy; Claude's counts are typically higher, especially on code. Every number is the text the tool returns to the model, summed over all calls a task needs (including opening the tab and retried errors), and excludes tool definitions.

## Compared with Playwright MCP and Chrome DevTools MCP

Measured on 2026-11-04, Chrome 159 Canary, macOS. Median of 5 runs per task. Scripts and raw data: `browser-mcp-bench` (run `./run.sh`).

- **Playwright MCP 0.0.84**: `browser_navigate` + `browser_snapshot`.
- **Chrome DevTools MCP 1.12.0**: `list_pages` + `navigate_page` + `take_snapshot`.
- Both run headless with `--isolated`.
- **Browser4Agent** runs in the user's own signed-in browser and opens a background tab with `chrome.tabs.create({active: false})`.

"Coverage" checks text snippets from an independent source (HN Algolia API, GitHub API, raw HTML) against the output. Every row below has the same coverage across all three servers.

| Task | Playwright MCP | Chrome DevTools MCP | Browser4Agent | vs. Playwright |
| --- | ---: | ---: | ---: | ---: |
| HN thread, all ~700 comments | 389,996 | 201,548 | **83,918** (`read_tab` + `get_thread`) | −78% |
| HN front page, 30 stories | 13,638 | 10,049 | **3,424** (`list_stories`, toolset known) | −75% |
| GitHub PR, all 188 comments (timeline expanded) | 123,042 | 100,304 | **33,255** (expand script + `get_pull_request`) | −73% |
| Long blog post | 21,214 | 23,734 | **14,822** (`read_tab` + read `contentFile`; no page tool) | −30% |
| GitHub Trending | 8,550 | 8,208 | **7,576** (`read_tab`; no page tool) | −11% |

How each server reads the same page:

- **Playwright's snapshot** prints every HN comment twice: once in the table cell's accessible name and once in its child text node. That is most of the gap to DevTools.
- **The accessibility-tree snapshots and `read_tab` all lose HN's reply nesting.** HN indents replies with spacer images. Only `get_thread` returns an explicit `depth`.
- **Tool definitions loaded into every conversation**: Playwright 3,902 tokens (25 tools); DevTools 6,187 (32 tools); Browser4Agent 2,273 (12 tools) plus 574 for the server instructions.

### Long pages are saved to a file

`read_tab` and `read_active_tab` return `content` inline only up to 20,000 characters. Longer content is written under the app data directory's `pages/` folder. The result then carries `contentFile` and `contentLength` instead of `content`; pass `inline_content: true` to get it inline anyway. Files older than 24 hours are deleted on the next save, and at most 50 are kept.

This matters most on the first read of a site. The agent calls `read_tab` to discover page tools, and before this change it was also handed the whole page. On the HN thread that made discovery plus `get_thread` cost more than reading the page:

| HN thread, toolset not yet known | Tokens |
| --- | ---: |
| `read_tab` with the page inline, then `get_thread` (before) | 198,772 |
| `read_tab` returning `contentFile`, then `get_thread` (now) | 83,918 |
| `read_tab` with the page inline only (`inline_content: true`) | 116,127 |

Pages under the limit are unchanged. On the HN front page (16.5k characters), discovery plus `list_stories` still costs 11,048 tokens, more than the 7,657 of reading the page.

### Where Browser4Agent does not win

- **No page tool, no big gap.** The blog post and GitHub Trending go through `read_tab`, which is condensed HTML: 11–30% smaller than Playwright's snapshot and 8–37% smaller than DevTools'.
- **Site-wide patterns add unused tool schemas.** GitHub Tools match all of `https://github.com/*`, so a Trending read also carries ~1.7k tokens of PR, issue and commit tool schemas that do not apply. That is why Trending is 7,576 tokens here and only 5,877 before GitHub Tools existed.
- **GitHub folds long timelines** into "N hidden items / Load more…". Every server, and `get_pull_request` too, sees only the first and last ~25 comments until the page is expanded. `get_pull_request` returns that partial conversation without saying anything was omitted, and its default `limit: 100` also cuts the expanded thread short.
- **The first call on a freshly opened GitHub tab is slow.** The first call (`read_tab`, `execute_script` or `execute_tab_tool`) often hit the 30 s extension timeout before the next one succeeded. One of the 5 cold `get_pull_request` runs failed this way.
- **Timing is not comparable.** Browser4Agent reads a warm, signed-in browser; the other two start from an empty headless profile.

## Summarize a YouTube talk

Measured on 2026-10-05 in Chrome 157 through the `browser4agent` CLI. Screenshot cost is estimated at width × height / 750 tokens per image.

[[1hr Talk] Intro to Large Language Models](https://www.youtube.com/watch?v=zjkBMFhNj_g) — 60 minutes, 1,162 transcript lines.

| Approach | Tokens | Time | Transcript content |
| --- | --- | --- | --- |
| `read_tab` (whole page) | 12,937 | 36 ms | **0 of 20** sampled phrases |
| `get_transcript` | 32,126 | 1.0 s | Complete, timestamped |

The transcript is not in the page until the user opens YouTube's transcript panel, and the caption URLs now require a proof-of-origin token, so a generic read gets the title, description and recommendations — but nothing that was said.

## Summarize a Hacker News thread

[Improper redaction reveals Google Data Center water and electricity usage](https://news.ycombinator.com/item?id=49957068) — about 700 comments. Re-measured on 2026-11-04 (median of 5 runs, toolset already known).

| Approach | Tokens | Comments returned |
| --- | ---: | --- |
| `read_tab` (whole page, `inline_content: true`) | 116,127 | All, without reply nesting |
| `get_thread` (`limit: 5000`) | 82,677 | All 719, with `depth` |
| `get_thread` (default, first 200) | 24,031 | 200 |
| `get_thread` (`max_depth: 0`) | 6,344 | 44 top-level only |

For the same content, the whole thread, `get_thread` is 29% smaller than the page. The 18× gap between the page and `max_depth: 0` reflects a smaller question (top-level comments only), not a cheaper way to read everything. `get_thread` has no offset, so a thread that does not fit in one tool result cannot be paged through.

## Takeaways

- The biggest wins are pages where generic reading **cannot** reach the data: transcripts that load on demand, canvas-rendered editors like Google Docs and Sheets.
- Against other browser MCP servers, a matching page tool cuts tokens by roughly 3–5× on long pages. Without one, `read_tab` is still the smallest of the three, but only by 8–37%.
- Long pages no longer flood the context on the first read: `read_tab` hands back a file path, so discovering page tools stays cheap.
