const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const express = require('express');
const LetterboxdClient = require('./letterboxd');
require('dotenv').config();

const app = express();

function envInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PORT = envInt(process.env.PORT, 3000);
const TOOL_TIMEOUT_MS = envInt(process.env.LETTERBOXD_TOOL_TIMEOUT_MS, 45000);
const DEFAULT_LIST_LIMIT = envInt(process.env.LETTERBOXD_DEFAULT_LIMIT, 5000);
const MAX_LIST_LIMIT = envInt(process.env.LETTERBOXD_MAX_LIMIT, 50000);
const MAX_RESPONSE_BYTES = envInt(process.env.LETTERBOXD_MAX_RESPONSE_BYTES, 0);
const MAX_PAGES = envInt(process.env.LETTERBOXD_MAX_PAGES, 1000);
const FETCH_ALL_DEFAULT = process.env.LETTERBOXD_FETCH_ALL !== 'false';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);
const API_KEY = process.env.MCP_API_KEY || '';

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (!CORS_ORIGIN.length) {
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }

  const origin = req.headers.origin;
  if (origin && (CORS_ORIGIN.includes('*') || CORS_ORIGIN.includes(origin))) {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN.includes('*') ? '*' : origin);
    if (!CORS_ORIGIN.includes('*')) {
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-Key');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  if (!API_KEY) return next();
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const apiKeyHeader = req.headers['x-api-key'];
  const apiKeyQuery = typeof req.query.api_key === 'string' ? req.query.api_key : '';
  const provided = bearer || apiKeyHeader || apiKeyQuery || '';

  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

const client = new LetterboxdClient();

const server = new Server(
  {
    name: 'letterboxd-mcp-server',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

function resolveLimit(value) {
  if (value === undefined || value === null || value === '') {
    return FETCH_ALL_DEFAULT ? Infinity : DEFAULT_LIST_LIMIT;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const max = Number.isFinite(MAX_LIST_LIMIT) && MAX_LIST_LIMIT > 0 ? MAX_LIST_LIMIT : raw;
  return Math.min(Math.floor(raw), max);
}

function resolveMaxPages(value) {
  if (value === undefined || value === null || value === '') {
    return MAX_PAGES;
  }
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function normalizeUsername(value) {
  if (value === undefined || value === null) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  try {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const parts = new URL(raw).pathname.split('/').filter(Boolean);
      if (!parts.length) return '';
      const listIndex = parts.indexOf('list');
      if (listIndex > 0) return parts[listIndex - 1];
      return parts[0];
    }
  } catch {}

  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return '';
  const listIndex = parts.indexOf('list');
  if (listIndex > 0) return parts[listIndex - 1];
  return parts[0];
}

function parseListUrl(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  try {
    const url = raw.startsWith('http://') || raw.startsWith('https://') ? new URL(raw) : null;
    if (url) {
      const parts = url.pathname.split('/').filter(Boolean);
      const listIndex = parts.indexOf('list');
      if (listIndex > 0 && parts[listIndex + 1]) {
        return { username: parts[listIndex - 1], listSlug: parts[listIndex + 1] };
      }
    }
  } catch {}

  const parts = raw.split('/').filter(Boolean);
  const listIndex = parts.indexOf('list');
  if (listIndex > 0 && parts[listIndex + 1]) {
    return { username: parts[listIndex - 1], listSlug: parts[listIndex + 1] };
  }
  return null;
}

function parseListReference(usernameInput, listSlugInput) {
  const fromSlug = parseListUrl(listSlugInput);
  if (fromSlug) return fromSlug;

  const fromUsername = listSlugInput ? null : parseListUrl(usernameInput);
  if (fromUsername) return fromUsername;

  const username = normalizeUsername(usernameInput);
  const listSlug =
    typeof listSlugInput === 'string' ? listSlugInput.trim() : listSlugInput;
  return { username, listSlug: listSlug || '' };
}

async function collectPaged(fetchPage, options) {
  const limit = resolveLimit(options.limit);
  const maxPages = resolveMaxPages(options.maxPages);
  const items = [];
  let cursor = options.cursor || null;
  let nextCursor = cursor;
  let pages = 0;
  const visited = new Set();
  let listMeta = null;

  while (pages < maxPages) {
    const cursorKey = cursor || 'start';
    if (visited.has(cursorKey)) break;
    visited.add(cursorKey);

    const page = await fetchPage({ cursor });
    if (page && page.list && !listMeta) {
      listMeta = page.list;
    }
    const pageItems = Array.isArray(page.items) ? page.items : [];
    items.push(...pageItems);
    pages += 1;
    nextCursor = page.nextCursor || null;

    if (limit !== Infinity && items.length >= limit) {
      items.splice(limit);
      break;
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  const response = {
    items,
    meta: {
      count: items.length,
      limit: limit === Infinity ? null : limit,
      cursor: options.cursor || null,
      nextCursor: pages < maxPages ? nextCursor : null,
      pages,
      maxPages,
      fetchAll: limit === Infinity,
    },
  };

  if (listMeta) {
    response.list = listMeta;
  }

  return response;
}

function fitPayload(payload) {
  const maxBytes = MAX_RESPONSE_BYTES;
  const initialJson = JSON.stringify(payload);
  if (!maxBytes || maxBytes <= 0) {
    return { json: initialJson, payload };
  }
  if (Buffer.byteLength(initialJson, 'utf8') <= maxBytes) {
    return { json: initialJson, payload };
  }

  if (payload && Array.isArray(payload.items)) {
    const baseMeta = payload.meta ? { ...payload.meta, truncated: true } : { truncated: true };
    let low = 0;
    let high = payload.items.length;
    let best = null;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = {
        ...payload,
        items: payload.items.slice(0, mid),
        meta: baseMeta,
      };
      const json = JSON.stringify(candidate);
      if (Buffer.byteLength(json, 'utf8') <= maxBytes) {
        best = { json, payload: candidate };
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (best) return best;
  }

  return {
    error: `Response too large. Reduce limit or increase LETTERBOXD_MAX_RESPONSE_BYTES.`,
  };
}

function toToolResponse(payload) {
  const fitted = fitPayload(payload);
  if (fitted.error) {
    return { content: [{ type: 'text', text: `Error: ${fitted.error}` }], isError: true };
  }
  return { content: [{ type: 'text', text: fitted.json }] };
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

const tools = [
  {
    name: 'search',
    description: 'Search for films, lists, members, or reviews (paged, fetches all pages by default).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['films', 'lists', 'members', 'reviews'], default: 'films' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
        maxPages: { type: 'integer', default: MAX_PAGES, minimum: 1 },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description: 'Fetch details of a specific film by slug (alias of get_film).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The film slug (e.g., "inception")' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_film',
    description: 'Full details of a film (synopsis, director, ratings).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The film slug (e.g., "inception")' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_list',
    description: 'Retrieve all lists for a user or the films in a specific list (paged, fetches all pages by default).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        listSlug: { type: 'string', description: 'Optional list slug or full list URL.' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
        maxPages: { type: 'integer', default: MAX_PAGES, minimum: 1 },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_review',
    description: 'Retrieve the full text of a review (truncated).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        filmSlug: { type: 'string' },
      },
      required: ['username', 'filmSlug'],
    },
  },
  {
    name: 'get_member',
    description: 'Profile of a member (bio, stats).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_pinned',
    description: 'Pinned (favorite) films from a member profile (up to 4).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_watchlist',
    description: "Member's watchlist (paged, fetches all pages by default).",
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
        maxPages: { type: 'integer', default: MAX_PAGES, minimum: 1 },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_films',
    description: 'Films seen by a member (paged, fetches all pages by default).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
        maxPages: { type: 'integer', default: MAX_PAGES, minimum: 1 },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_ratings',
    description: 'Ratings given by a member (paged, fetches all pages by default).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
        maxPages: { type: 'integer', default: MAX_PAGES, minimum: 1 },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_reviews',
    description: 'Reviews written by a member (paged, fetches all pages by default).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
        maxPages: { type: 'integer', default: MAX_PAGES, minimum: 1 },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_diary',
    description: 'Viewing diary entries (paged, fetches all pages by default).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
        maxPages: { type: 'integer', default: MAX_PAGES, minimum: 1 },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_current_user',
    description: 'Connection status of the configured user.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rate_film',
    description: 'Rate a film.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        rating: { type: 'integer', minimum: 1, maximum: 10, description: 'Rating from 1 to 10 (half stars)' },
      },
      required: ['slug', 'rating'],
    },
  },
  {
    name: 'add_to_watchlist',
    description: 'Add a film to the watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'write_review',
    description: 'Write a review for a film.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        reviewText: { type: 'string' },
        rating: { type: 'integer', minimum: 1, maximum: 10 },
        containsSpoilers: { type: 'boolean', default: false },
      },
      required: ['slug', 'reviewText'],
    },
  },
  {
    name: 'add_to_list',
    description: 'Add a film to a list.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        listSlug: { type: 'string', description: 'The slug of the list to add the film to.' },
      },
      required: ['slug', 'listSlug'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

const toolHandlers = {
  search: async (args) =>
    collectPaged(
      ({ cursor }) => client.search(args.query, args.type, { cursor }),
      { limit: args.limit, cursor: args.cursor, maxPages: args.maxPages }
    ),
  fetch: async (args) => client.getFilm(args.id),
  get_film: async (args) => client.getFilm(args.slug),
  get_list: async (args) => {
    const parsed = parseListReference(args.username, args.listSlug);
    if (!parsed.username) {
      throw new Error('Missing username for get_list.');
    }
    const fetcher = parsed.listSlug
      ? ({ cursor }) => client.getList(parsed.username, parsed.listSlug, { cursor })
      : ({ cursor }) => client.getLists(parsed.username, { cursor });
    return collectPaged(fetcher, { limit: args.limit, cursor: args.cursor, maxPages: args.maxPages });
  },
  get_review: async (args) => client.getReview(args.username, args.filmSlug),
  get_member: async (args) => client.getMember(args.username),
  get_member_pinned: async (args) => client.getMemberPinned(args.username),
  get_member_watchlist: async (args) =>
    collectPaged(
      ({ cursor }) => client.getMemberWatchlist(args.username, { cursor }),
      { limit: args.limit, cursor: args.cursor, maxPages: args.maxPages }
    ),
  get_member_films: async (args) =>
    collectPaged(
      ({ cursor }) => client.getMemberFilms(args.username, { cursor }),
      { limit: args.limit, cursor: args.cursor, maxPages: args.maxPages }
    ),
  get_member_ratings: async (args) =>
    collectPaged(
      ({ cursor }) => client.getMemberRatings(args.username, { cursor }),
      { limit: args.limit, cursor: args.cursor, maxPages: args.maxPages }
    ),
  get_member_reviews: async (args) =>
    collectPaged(
      ({ cursor }) => client.getMemberReviews(args.username, { cursor }),
      { limit: args.limit, cursor: args.cursor, maxPages: args.maxPages }
    ),
  get_member_diary: async (args) =>
    collectPaged(
      ({ cursor }) => client.getMemberDiary(args.username, { cursor }),
      { limit: args.limit, cursor: args.cursor, maxPages: args.maxPages }
    ),
  get_current_user: async () => client.getCurrentUser(),
  rate_film: async (args) => ({ success: await client.rateFilm(args.slug, args.rating) }),
  add_to_watchlist: async (args) => ({ success: await client.addToWatchlist(args.slug) }),
  write_review: async (args) => ({
    success: await client.writeReview(args.slug, args.reviewText, args.rating, args.containsSpoilers),
  }),
  add_to_list: async (args) => ({ success: await client.addToList(args.slug, args.listSlug) }),
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Error: Tool not found: ${name}` }], isError: true };
  }

  try {
    const result = await withTimeout(handler(args || {}), TOOL_TIMEOUT_MS, `Tool ${name}`);
    return toToolResponse(result);
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

const sessions = new Map();

async function handleSseConnection(req, res) {
  req.socket.setTimeout(0);
  const transport = new SSEServerTransport('/messages', res);
  const keepAliveInterval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepAliveInterval);
      return;
    }
    res.write(': keepalive\n\n');
  }, 15000);

  try {
    await server.connect(transport);
    const sessionId = transport.sessionId;
    if (sessionId) sessions.set(sessionId, transport);

    req.on('close', () => {
      clearInterval(keepAliveInterval);
      if (sessionId) sessions.delete(sessionId);
    });
  } catch {
    clearInterval(keepAliveInterval);
    if (!res.headersSent) res.status(500).send('Internal Server Error');
  }
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Letterboxd MCP Server',
    sse_endpoints: ['/sse', '/mcp'],
    messages_endpoint: '/messages',
  });
});

app.get('/mcp', handleSseConnection);
app.get('/sse', handleSseConnection);

app.post('/messages', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (!sessionId) {
    return res.status(400).send('Missing sessionId parameter');
  }

  const transport = sessions.get(sessionId);
  if (!transport) {
    return res.status(404).send('Session not found');
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).send('Internal Server Error');
  }
});

const httpServer = app.listen(PORT, () => {
  console.log('\n--- Letterboxd MCP Server ---');
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`SSE URLs: http://localhost:${PORT}/sse , http://localhost:${PORT}/mcp`);
  console.log(`Messages URL: http://localhost:${PORT}/messages`);
  console.log('-----------------------------\n');
});

httpServer.keepAliveTimeout = 120000;
httpServer.headersTimeout = 125000;
httpServer.requestTimeout = 0;

async function shutdown() {
  await client.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
