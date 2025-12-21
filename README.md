# Letterboxd MCP Server

This is a Model Context Protocol (MCP) server that provides a comprehensive interface for Letterboxd through scraping. It lets LLMs (ChatGPT, Claude, Mistral) read Letterboxd data and perform user actions.

## Features

- **Search**: Global search for films, lists, members, and reviews.
- **Content**: Detailed film info, list contents, and full review texts.
- **Member Data**: Profiles, watchlists, films seen, ratings, reviews, and diaries.
- **User Actions**: Rate films, add to watchlist, add to lists, and write reviews (requires login).

## Installation

1. Clone or download this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file based on `.env.example`.

## Configuration

Required for authenticated actions:
- `LETTERBOXD_USERNAME`
- `LETTERBOXD_PASSWORD`

Optional:
- `PORT` (default `3000`)
- `CORS_ORIGIN` (comma-separated list, or `*`)
- `MCP_API_KEY` (requires `Authorization: Bearer <key>`, `X-API-Key`, or `?api_key=`)
- `LETTERBOXD_HTTP_TIMEOUT_MS` (default `20000`)
- `LETTERBOXD_TOOL_TIMEOUT_MS` (default `45000`)
- `LETTERBOXD_FETCH_ALL` (default `true`)
- `LETTERBOXD_DEFAULT_LIMIT` (default `1000`)
- `LETTERBOXD_MAX_LIMIT` (default `10000`)
- `LETTERBOXD_MAX_PAGES` (default `200`)
- `LETTERBOXD_MAX_RESPONSE_BYTES` (default `1900000`)
- `LETTERBOXD_MAX_TEXT_LENGTH` (default `0`, no truncation)
- `LETTERBOXD_MAX_REDIRECTS` (default `5`)
- `LETTERBOXD_LOGIN_FOR_READS` (default `false`)

List-style tools are paged. By default the server follows all pages (up to `LETTERBOXD_MAX_PAGES`); use `limit` or `maxPages` to cap. Use `cursor` to continue (`meta.nextCursor`) if pagination stops early.

If you need to read private data (e.g., your diary), set `LETTERBOXD_LOGIN_FOR_READS=true` and provide credentials.

## Usage

### Starting the server
```bash
npm start
```

### Connecting to MCP
The server uses **SSE (Server-Sent Events)** for transport.
- **SSE Endpoint**: `http://localhost:3000/sse` (alias: `/mcp`)
- **Messages Endpoint**: `http://localhost:3000/messages`

### Pagination Response
Paged tools return:
```json
{
  "items": [],
  "meta": {
    "count": 0,
    "limit": null,
    "cursor": null,
    "nextCursor": null,
    "pages": 0,
    "maxPages": 200,
    "fetchAll": true
  }
}
```

## Available Tools

### Search & Content
- `search`: Global search (paged).
- `fetch`: Alias of `get_film` (by slug).
- `get_film`: Details of a specific film.
- `get_list`: Films in a specific list (paged).
- `get_review`: Full text of a review (truncated).

### Member Information
- `get_member`: Profile info and stats.
- `get_member_watchlist`: Member's watchlist (paged).
- `get_member_films`: Films seen by a member (paged).
- `get_member_ratings`: Ratings given by a member (paged).
- `get_member_reviews`: Reviews written by a member (paged).
- `get_member_diary`: Viewing diary entries (paged).
- `get_current_user`: Status of the logged-in user.

### Actions (Authenticated)
- `rate_film`: Give a star rating (1-10, where 10 = 5 stars).
- `add_to_watchlist`: Add a film to your watchlist.
- `add_to_list`: Add a film to one of your lists.
- `write_review`: Log a film and write a review.

Write actions are disabled in HTTP-only mode. This build avoids browser automation to run on locked-down hosts.

## Technical Details

- Built with **Node.js**.
- Uses **Axios** + **Cheerio** for HTTP scraping.
- Implements the **Model Context Protocol SDK**.
