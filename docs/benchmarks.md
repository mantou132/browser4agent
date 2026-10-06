# Page Tools vs. Generic Browsing

What an agent gets when it reads a page generically (`read_tab`, screenshots) versus calling a page tool from [browser4agent-toolsets](https://github.com/mantou132/browser4agent-toolsets).

Measured on 2026-10-05 in Chrome 157 through the `browser4agent` CLI, i.e. exactly what an agent receives. Token counts use OpenAI's `o200k_base` tokenizer as a proxy; Claude's counts differ somewhat. Screenshot cost is estimated at width × height / 750 tokens per image.

## Summarize a YouTube talk

[[1hr Talk] Intro to Large Language Models](https://www.youtube.com/watch?v=zjkBMFhNj_g) — 60 minutes, 1,162 transcript lines.

| Approach | Tokens | Time | Transcript content |
| --- | --- | --- | --- |
| `read_tab` (whole page) | 12,937 | 36 ms | **0 of 20** sampled phrases |
| `get_transcript` | 32,126 | 1.0 s | Complete, timestamped |

The transcript is not in the page until the user opens YouTube's transcript panel, and the caption URLs now require a proof-of-origin token, so a generic read gets the title, description and recommendations — but nothing that was said.

## Summarize a Hacker News thread

[Improper redaction reveals Google Data Center water and electricity usage](https://news.ycombinator.com/item?id=49957068) — 682 comments.

| Approach | Tokens | Time | Notes |
| --- | --- | --- | --- |
| `read_tab` (whole page) | 141,520 | 108 ms | 383 of 400 sampled comments present |
| Screenshots | ~115,000 | 82 × ~0.4 s | 82 viewport screenshots plus scrolling between them |
| `get_thread` (all 682) | 77,892 | 51 ms | Structured, with reply depth |
| `get_thread` (default, first 200) | 23,309 | 24 ms | |
| `get_thread` (`max_depth: 0`, 45 top-level) | 6,360 | 16 ms | |

Hacker News is already lean HTML, so a generic read works here; the gain is structure and control. The full thread costs 45% fewer tokens, and asking for top-level comments only is 22× cheaper than reading the page.

## Takeaways

- The biggest wins are pages where generic reading **cannot** reach the data: transcripts that load on demand, canvas-rendered editors like Google Docs and Sheets.
- On pages that are already readable, page tools trade raw HTML for structured, filterable results — fewer tokens and fewer round trips.
