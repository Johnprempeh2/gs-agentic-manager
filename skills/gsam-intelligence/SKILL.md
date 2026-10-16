---
name: gsam-intelligence
description: >
  Write the daily Intelligence page in GSAM: the Daily Pulse, the AI briefing
  (news and radar), the three leaderboard snapshots, and GSAM feature and skill
  recommendations. Real sources only. Use when your task is the daily
  intelligence run.
---

# GSAM Intelligence

You run the Intelligence page for this company. Every morning you research the AI industry, then write four things through the API: the Daily Pulse, the AI briefing, a snapshot of each leaderboard, and any new GSAM feature or skill recommendations. The page reads only what you write.

## Rules that never bend

- **Real sources only.** Every trend, tool, creator item, news item, radar item and opportunity carries an `https` URL you actually opened this run. The API refuses an item without one. Never invent a URL, a figure, a quote, a date or a score. If you cannot confirm a story, drop it; if it is a credible rumour, set `rumoured: true` on the news item.
- **Write for the card.** On the card: one verdict sentence (40 words at most), up to five points (25 words each, the first three show), one "Do this" line (35 words at most). Long analysis goes in `take` (400 words at most) and `lens` (160 words at most), which sit behind "Full analysis". The API counts the words and refuses overlong card text.
- **British English, no em or en dashes.** Use commas, colons, full stops or brackets; write "to" for ranges.
- **Never print or paste secrets.** No API keys or tokens in reports, comments or logs. Logos come from GSAM itself (the operator sets the Logo.dev key on the server); you only name the `domain`, never fetch or store a logo key.
- **Logos and images.** Give every trend, tool, creator, news item, radar item and board entry a `domain`: the bare brand domain whose logo should show (`anthropic.com`, `openai.com`, `cursor.com`; no `https://`, no path). For news and trends that is the publisher (`techcrunch.com`); for tools, radar items and board entries it is the maker. Leave it out only when the item's `url` is already on that domain: GSAM falls back to the URL's host. Add `imageUrl` (an `https` image you saw on the page, such as its og:image) only when the article's own preview is wrong or missing; GSAM otherwise reads the page's og:image itself.
- **Do not deploy anything.** This page replaces the old static Daily Pulse and AI hub sites; do not publish to Netlify.

## Setup

Use `$GSAM_API_URL`, `$GSAM_COMPANY_ID` and `Authorization: Bearer $GSAM_API_KEY` on every call, as in the `gsam` skill. Writes need the `intelligence:write` permission. If a write answers `403` with `Missing permission: intelligence:write`, stop: the board gets a Grant item, and you continue on the next run once it is granted. If it answers `403 not_entitled`, the Intelligence switch is off; stop and say so on your task.

`DATE` below is today's date as `YYYY-MM-DD`. Writes are upserts: a second `PUT` for the same date replaces the first, so fix mistakes by writing again.

## 1. Research (before writing anything)

1. Read yesterday's work so you do not repeat it: `GET /api/companies/$GSAM_COMPANY_ID/intelligence/reports/latest?kind=daily_pulse` and `.../reports/latest?kind=ai_briefing`, plus `GET .../intelligence/boards`.
2. Work the fixed source roster first, then range wider only if a story needs it:
   - Company newsrooms, the authority for their own launches: OpenAI, Anthropic, Google and DeepMind, Microsoft AI, Meta AI, xAI, Mistral, Alibaba Qwen, DeepSeek, Perplexity, NVIDIA, Apple.
   - Newswires and analysis: TechCrunch, The Verge, Bloomberg Tech, Reuters Tech, CNBC Tech, VentureBeat, The Information, Ars Technica, MIT Technology Review, Artificial Analysis (benchmarks), Hacker News.
   - Creators: Jack Roberts, Matt Wolfe (FutureTools), Wes Roth every day; Fireship, Ethan Mollick, The Rundown AI, Allie K. Miller weekly; look for one "new face" a week.
3. Run at least 10 searches covering the last 48 to 72 hours, and open the 3 to 5 most important sources in full.

## 2. Write the Daily Pulse

`PUT /api/companies/$GSAM_COMPANY_ID/intelligence/reports/DATE`

```json
{
  "kind": "daily_pulse",
  "status": "draft",
  "headline": "The one or two biggest stories of the day, in one line",
  "sections": {
    "quickWin": { "title": "...", "action": "...", "timeNeeded": "20 minutes", "outcome": "...", "url": "https://..." },
    "skillIdeas": [{ "name": "...", "what": "...", "whyNow": "...", "buildEstimate": "quick|medium|deep", "clientValue": "...", "sourceUrl": "https://..." }],
    "trends": [{ "headline": "...", "whyItMatters": "...", "freshness": "today|this_week|emerging", "sourceName": "TechCrunch", "url": "https://...", "domain": "techcrunch.com", "learnMore": [{ "label": "...", "url": "https://...", "tag": "Docs" }] }],
    "tools": [{ "name": "...", "url": "https://...", "domain": "cursor.com", "what": "...", "category": "automation|ai_coding|design|productivity|data|content|other", "pricing": "Freemium", "personalRating": 4, "clientRating": 3, "flaggedBy": "Matt Wolfe", "quickTake": "...", "learnMore": [] }],
    "creators": [{ "creator": "...", "platform": "YouTube", "content": "...", "why": "...", "url": "https://...", "domain": "youtube.com", "newFace": false }],
    "opportunities": [{ "title": "...", "triggeredBy": "...", "targetClients": "...", "revenuePotential": "low|medium|high", "revenueReason": "...", "nextStep": "...", "explorePrompt": "...", "sources": [{ "label": "...", "url": "https://..." }] }]
  }
}
```

Aim for 2 to 3 skill ideas, 3 to 5 trends, 3 to 5 tools, 2 to 3 creator items, 2 to 3 opportunities and exactly one quick win (under 30 minutes, concrete). Rate tools honestly: not everything gets five stars. On Fridays add `"weekInReview"` (150 words at most).

## 3. Write the AI briefing (News and Radar)

`PUT /api/companies/$GSAM_COMPANY_ID/intelligence/reports/DATE`

```json
{
  "kind": "ai_briefing",
  "status": "draft",
  "headline": "The lead story in one line",
  "sections": {
    "news": [{ "headline": "...", "tag": "Meta · Models", "date": "YYYY-MM-DD", "sourceName": "TechCrunch", "url": "https://...", "domain": "techcrunch.com", "imageUrl": "https://... (optional)", "verdict": "...", "points": ["...", "...", "..."], "action": "...", "take": "...", "lens": "...", "lead": true, "rumoured": false }],
    "radar": {
      "emerging": [{ "name": "...", "by": "...", "what": "...", "why": "...", "status": "Launched 8 Oct 2026", "url": "https://...", "domain": "maker.com" }],
      "movers": [{ "name": "...", "direction": "up|down", "note": "...", "tag": "OpenAI", "url": "https://...", "domain": "openai.com" }],
      "watchlist": [{ "name": "...", "note": "...", "tag": "Anthropic", "url": "https://...", "domain": "anthropic.com" }]
    }
  }
}
```

About 12 news items, lead first (`lead: true` on one). `action` is the Greatstone "Do this": imperative, concrete, for Greatstone or a client. 4 to 7 movers, 5 or 6 watchlist items, 4 to 6 emerging tools, each verified.

## 4. Write the leaderboard snapshots

One call per board: `ai_systems`, `frontier_models`, `tools_agents`.

`PUT /api/companies/$GSAM_COMPANY_ID/intelligence/boards/{board}/snapshots/DATE`

```json
{ "entries": [{ "name": "Claude", "rank": 1, "score": 97.3, "maker": "Anthropic", "domain": "anthropic.com", "flagship": "Claude Opus 5.5", "verdict": "...", "url": "https://...", "specs": { "priceIn": 5, "priceOut": 25, "context": "1M", "speed": 80, "gpqa": 88, "swe": 79, "hle": null } }] }
```

- `score` is the board score for AI Systems and Tools and Agents, and the Artificial Analysis Intelligence Index for Frontier Models (read each lab's current flagship page at max effort; `null` if unpublished).
- Change a score only with dated, sourced evidence from today's sweep (a launch, a major feature, a pricing move, an outage). Keep the same names day to day so movement lines up; a renamed entry shows as new.
- `domain` is the maker's domain and drives the podium and table logos; set it on every entry, even when `url` points elsewhere (a docs page, a leaderboard).
- `specs` feeds the Compare tab; write it for Frontier Models. Use `null` for figures that are not published.
- Movement is computed by GSAM against the snapshot about a week earlier. Do not write deltas yourself.
- On Mondays, re-score every board from fresh research instead of carrying scores forward.

## 5. Publish

Re-read both reports with `GET .../reports/DATE?kind=daily_pulse` and `?kind=ai_briefing`, check every link opens and nothing is fabricated, then `PUT` each again with `"status": "published"`. The page shows the newest published report first.

## 6. Recommend GSAM features and skills

Propose at most three a day, only when today's research gives a real reason (a new tool, a pattern in how this company works, a gap you hit yourself).

1. Check for duplicates first: `GET /api/companies/$GSAM_COMPANY_ID/intelligence/recommendations`, and search existing tasks with `GET /api/companies/$GSAM_COMPANY_ID/issues?q=<key words>` (GRE tasks included). If either already covers it, skip it.
2. For skills, also check the company skill library (`GET /api/companies/$GSAM_COMPANY_ID/skills`) so you do not propose one that exists.
3. Create it:

`POST /api/companies/$GSAM_COMPANY_ID/intelligence/recommendations`

```json
{ "kind": "gsam_feature|skill", "title": "Short imperative title", "why": "80 words at most: the problem, the evidence, the payoff", "effort": "quick|medium|deep", "sourceUrl": "https://...", "reportDate": "DATE" }
```

A `409` means the same title exists: skip it. The board accepts, dismisses or turns it into a task; you never do.

## 7. Report on your task

Comment on your task with: the lead story, counts written (trends, tools, news, entries per board), recommendations created, and anything you dropped as unconfirmable.
