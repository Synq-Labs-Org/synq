# Revalidation: Kimi web tools API (2026-10-10)
Read-only documentation check for the Kimi research adapter. No API key was available, so nothing was called live.

## Sources
- https://platform.kimi.ai/docs/guide/use-web-search.md: the built-in `$web_search` tool retires on 2026-10-20. The replacements are standalone REST endpoints.
- https://platform.kimi.ai/docs/api/tools-search.md
- https://platform.kimi.ai/docs/api/tools-fetch.md
- https://platform.kimi.ai/docs/guide/best-practices-for-web-search.md

## `POST https://api.moonshot.ai/v1/tools/search` (Web Search Basic)
- **Auth:** `Authorization: Bearer <key>`, `Content-Type: application/json`.
- **Request:**
  - `text_query` (string, required, non-empty)
  - `timeout_seconds` (integer 1–60, optional)
  - `limit` (integer 1–20, default 5)
  - `include_content` (boolean, default false)
- **Response 200:** `search_results[]`. Every item has these string fields, which are empty when unknown: `authority`, `date`, `icon`, `mime`, `site_name`, `snippet`, `text`, `title`, `url`.
- **Errors:** `{error:{message,type?,code?}}`. 401 and 403 return no body. Other statuses: 400 `invalid_request`, 429 `rate_limited`, 502 `upstream_failed`, 504 `timeout`.
- **Price:** $0.002 per call, charged only for a 200 with non-empty results.

## `POST https://api.moonshot.ai/v1/tools/fetch` (URL Fetch)
- **Request:** `url` (http or https URI with a host, required).
- **Response 200:** `url`, `title`, `markdown`.
- **Errors:** 400 `invalid_url`, 403 `security_risk`, 404 `markdown_not_found`, 429, 502, 504.
- **Price:** $0.002 per call, charged only for non-blank markdown.

## Consequences for Synq
- The Kimi adapter uses these endpoints, not `$web_search`.
- Search and fetch results are wrapped as `UntrustedEvidence` (`untrusted=true`).
- Paid-tool spend is accounted at $0.002 per charged call against the subagent's `max_paid_api_budget_usd`.
