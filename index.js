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
const DEFAULT_LIST_LIMIT = envInt(process.env.LETTERBOXD_DEFAULT_LIMIT, 25);
const MAX_LIST_LIMIT = envInt(process.env.LETTERBOXD_MAX_LIMIT, 100);
const MAX_RESPONSE_BYTES = envInt(process.env.LETTERBOXD_MAX_RESPONSE_BYTES, 200000);
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

function clampLimit(value, fallback) {
  const fallbackValue = Number.isFinite(fallback) ? fallback : DEFAULT_LIST_LIMIT;
  const raw = value === undefined || value === null || value === '' ? fallbackValue : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const max = Number.isFinite(MAX_LIST_LIMIT) && MAX_LIST_LIMIT > 0 ? MAX_LIST_LIMIT : raw;
  return Math.min(Math.floor(raw), max);
}

function listResponse(items, meta) {
  return {
    items,
    meta: {
      count: items.length,
      ...meta,
    },
  };
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
    description: 'Search for films, lists, members, or reviews (paged).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['films', 'lists', 'members', 'reviews'], default: 'films' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
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
    description: 'Retrieve films from a specific list (paged).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        listSlug: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
      },
      required: ['username', 'listSlug'],
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
    name: 'get_member_watchlist',
    description: "Member's watchlist (paged).",
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_films',
    description: 'Films seen by a member (paged).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_ratings',
    description: 'Ratings given by a member (paged).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_reviews',
    description: 'Reviews written by a member (paged).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_diary',
    description: 'Viewing diary entries (paged).',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', default: DEFAULT_LIST_LIMIT, minimum: 1, maximum: MAX_LIST_LIMIT },
        cursor: { type: 'string', description: 'Cursor for next page (from meta.nextCursor).' },
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
  search: async (args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
    const result = await client.search(args.query, args.type, { limit, cursor: args.cursor });
    return listResponse(result.items, {
      limit,
      cursor: args.cursor || null,
      nextCursor: result.nextCursor,
    });
  },
  fetch: async (args) => client.getFilm(args.id),
  get_film: async (args) => client.getFilm(args.slug),
  get_list: async (args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
    const result = await client.getList(args.username, args.listSlug, { limit, cursor: args.cursor });
    return listResponse(result.items, {
      limit,
      cursor: args.cursor || null,
      nextCursor: result.nextCursor,
    });
  },
  get_review: async (args) => client.getReview(args.username, args.filmSlug),
  get_member: async (args) => client.getMember(args.username),
  get_member_watchlist: async (args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
    const result = await client.getMemberWatchlist(args.username, { limit, cursor: args.cursor });
    return listResponse(result.items, {
      limit,
      cursor: args.cursor || null,
      nextCursor: result.nextCursor,
    });
  },
  get_member_films: async (args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
    const result = await client.getMemberFilms(args.username, { limit, cursor: args.cursor });
    return listResponse(result.items, {
      limit,
      cursor: args.cursor || null,
      nextCursor: result.nextCursor,
    });
  },
  get_member_ratings: async (args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
    const result = await client.getMemberRatings(args.username, { limit, cursor: args.cursor });
    return listResponse(result.items, {
      limit,
      cursor: args.cursor || null,
      nextCursor: result.nextCursor,
    });
  },
  get_member_reviews: async (args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
    const result = await client.getMemberReviews(args.username, { limit, cursor: args.cursor });
    return listResponse(result.items, {
      limit,
      cursor: args.cursor || null,
      nextCursor: result.nextCursor,
    });
  },
  get_member_diary: async (args) => {
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT);
    const result = await client.getMemberDiary(args.username, { limit, cursor: args.cursor });
    return listResponse(result.items, {
      limit,
      cursor: args.cursor || null,
      nextCursor: result.nextCursor,
    });
  },
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
