# Letterboxd MCP Server

> **Origin Note:** This project was originally based on [Racimy/Letterboxd-MCP](https://github.com/Racimy/Letterboxd-MCP). It has since been extensively rewritten and expanded (V3+) to include comprehensive Playwright actions, multi-mode transport (Stdio/SSE), and expanded toolsets.

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for [Letterboxd](https://letterboxd.com/). It enables AI models to interact with Letterboxd data and perform account actions like rating films, writing reviews, and managing watchlists.

This server uses [Playwright](https://playwright.dev/) for authenticated account actions and fast HTML scraping for read endpoints.

## Features

- **Rich Film Metadata**: Fetch posters, cast, runtime, genres, and synopses.
- **Search**: Comprehensive search for films, members, lists, and reviews.
- **Member Insights**: Get profile summaries, stats, watchlists, diary entries, and ratings.
- **Account Management**:
  - Rate films (0.5 to 5 stars).
  - Toggle "Watched", "Watchlist", and "Like" status.
  - Write and update reviews (supports ratings, spoilers, and rewatch flags).
  - Create and manage lists.
- **`me` Shortcut**: Use "me" as a username to target your authenticated account.
- **Automatic Pagination**: Fetches all pages by default or supports manual cursor-based navigation.

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/)

### Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/Letterboxd-MCP.git
   cd Letterboxd-MCP
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
   *Note: This will also download Chromium for Playwright.*

3. Create a `.env` file (see [Configuration](#configuration)):
   ```bash
   cp .env.example .env
   ```

## Configuration

The server is configured via environment variables. Create a `.env` file in the root directory:

```env
# Required for account actions & private data
LETTERBOXD_USERNAME=your_username
LETTERBOXD_PASSWORD=your_password

# Optional
PORT=3000
MCP_API_KEY=your_optional_secret_key
LETTERBOXD_LOGIN_FOR_READS=true # Set to false to avoid logging in for public data
```

## Usage

### Stdio Mode (Recommended for local MCP clients)
To run the server in Stdio mode for local clients like Claude Desktop:
```bash
node index.js --mode=stdio
```

### SSE Mode (For remote integrations)
To run the server in SSE (Server-Sent Events) mode:
```bash
npm start
```

### Integration with AI Agents
For detailed instructions on how to configure an AI agent (like Claude or Gemini) to use this server effectively, including specialized workflows like natural language review posting, see the **[Agent Instructions & Example Guide](./AGENT_GUIDE.md)**.

### Integration with Claude Desktop
Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "letterboxd": {
      "command": "node",
      "args": ["/absolute/path/to/Letterboxd-MCP/index.js", "--mode=stdio"],
      "env": {
        "LETTERBOXD_USERNAME": "your_username",
        "LETTERBOXD_PASSWORD": "your_password"
      }
    }
  }
}
```

## Available Tools

### Read Tools
- `search`: Search Letterboxd (films, lists, members, reviews).
- `get_film`: Get detailed metadata for a film.
- `get_member`: Get profile and stats for a member.
- `get_member_watchlist`: List films in a member's watchlist.
- `get_member_diary`: List a member's diary entries.
- `get_member_films`: List films a member has watched.
- `get_member_ratings`: List films rated by a member.
- `get_member_reviews`: List reviews written by a member.
- `get_member_pinned`: Get a member's favorite/pinned films.
- `get_member_lists`: List lists created by a member.
- `get_list`: Get entries and metadata for a specific list.
- `get_review`: Get full review details.
- `get_current_user`: Check authentication status.

### Write Tools (Requires Authentication)
- `rate_film`: Set a star rating.
- `add_to_watched`: Mark a film as watched/unwatched.
- `add_to_watchlist`: Add/remove a film from your watchlist.
- `toggle_like`: Like/unlike a film.
- `write_review`: Write or update a review.
- `write_review_by_title`: Search by title and write a review.
- `add_to_list`: Add a film to an existing list.
- `create_list`: Create a new list.

## Development & Testing

### Running Tests
- **Read-only tests**: `npm run test:read`
- **Mutating tests** (Requires live credentials): `RUN_MUTATING_TESTS=true npm run test:mutating`
- **All tests**: `npm run test:all`

## Credits

This project was originally based on [Racimy/Letterboxd-MCP](https://github.com/Racimy/Letterboxd-MCP). It has since been extensively rewritten and expanded (V3+) to include comprehensive Playwright actions, multi-mode transport (Stdio/SSE), and expanded toolsets.

## Security Warning
This server uses Playwright to automate your Letterboxd account. **Never** share your `.env` file or commit it to version control. Always use a strong `MCP_API_KEY` if running in SSE mode over the internet.

## License
[ISC](LICENSE)
