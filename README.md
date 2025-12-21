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
- `LETTERBOXD_NAV_TIMEOUT_MS` (default `30000`)
- `LETTERBOXD_TOOL_TIMEOUT_MS` (default `45000`)
- `LETTERBOXD_HEADLESS` (`true`/`false`)
- `LETTERBOXD_PREWARM` (`true` to launch Puppeteer at startup)

## Usage

### Starting the server
```bash
npm start
```

### Connecting to MCP
The server uses **SSE (Server-Sent Events)** for transport.
- **SSE Endpoint**: `http://localhost:3000/sse` (alias: `/mcp`)
- **Messages Endpoint**: `http://localhost:3000/messages`

## Available Tools

### Search & Content
- `search`: Global search.
- `fetch`: Alias of `get_film` (by slug).
- `get_film`: Details of a specific film.
- `get_list`: Films in a specific list.
- `get_review`: Full text of a review.

### Member Information
- `get_member`: Profile info and stats.
- `get_member_watchlist`: Member's watchlist.
- `get_member_films`: Films seen by a member.
- `get_member_ratings`: Ratings given by a member.
- `get_member_reviews`: Reviews written by a member.
- `get_member_diary`: Viewing diary entries.
- `get_current_user`: Status of the logged-in user.

### Actions (Authenticated)
- `rate_film`: Give a star rating (1-10, where 10 = 5 stars).
- `add_to_watchlist`: Add a film to your watchlist.
- `add_to_list`: Add a film to one of your lists.
- `write_review`: Log a film and write a review.

## Technical Details

- Built with **Node.js**.
- Uses **Puppeteer** with **Stealth Plugin** for authenticated actions.
- Uses **Cheerio** for fast HTML parsing of public pages.
- Implements the **Model Context Protocol SDK**.
