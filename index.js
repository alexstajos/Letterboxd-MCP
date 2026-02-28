const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const express = require('express');
const LetterboxdClient = require('./letterboxd');
require('dotenv').config({ quiet: true });

function envInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PORT = envInt(process.env.PORT, 3000);
const TOOL_TIMEOUT_MS = envInt(process.env.LETTERBOXD_TOOL_TIMEOUT_MS, 300000);
const MAX_RESPONSE_BYTES = envInt(process.env.LETTERBOXD_MAX_RESPONSE_BYTES, 0);
const API_KEY = process.env.MCP_API_KEY || '';
const MODE =
  (process.argv.find((arg) => arg.startsWith('--mode=')) || '').split('=')[1] || 'sse';

const client = new LetterboxdClient();

const server = new Server(
  {
    name: 'letterboxd',
    version: '3.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

function normalizeUsername(value) {
  if (value === undefined || value === null) return '';
  const rawInput = String(value).trim();
  if (!rawInput) return '';

  const lower = rawInput.toLowerCase();
  if (lower === 'me' || lower === 'self') return 'me';

  try {
    if (rawInput.startsWith('http://') || rawInput.startsWith('https://')) {
      const parts = new URL(rawInput).pathname.split('/').filter(Boolean);
      return parts[0] || '';
    }
  } catch {
    // Ignore malformed URLs and continue with fallback parsing.
  }

  return rawInput.split('/').filter(Boolean)[0] || '';
}

async function resolveMemberUsername(value) {
  const normalized = normalizeUsername(value || 'me');
  if (normalized && normalized !== 'me') return normalized;

  if (client.username) return client.username;

  try {
    await client.ensureLoggedIn();
    if (client.username) return client.username;
  } catch {
    // Fall through to explicit guidance below.
  }

  throw new Error(
    'Unable to resolve username "me". Provide a username explicitly, or set LETTERBOXD_USERNAME and LETTERBOXD_PASSWORD.'
  );
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutHandle));
}

function maybeTrimPayload(payload) {
  if (!MAX_RESPONSE_BYTES || MAX_RESPONSE_BYTES <= 0) return payload;

  const raw = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(raw, 'utf8');

  if (byteLength <= MAX_RESPONSE_BYTES) return payload;

  const truncatedText = raw.slice(0, Math.max(0, MAX_RESPONSE_BYTES - 3)) + '...';
  return {
    truncated: true,
    message: 'Response exceeded LETTERBOXD_MAX_RESPONSE_BYTES and was truncated.',
    maxResponseBytes: MAX_RESPONSE_BYTES,
    originalBytes: byteLength,
    preview: truncatedText,
  };
}

function toToolResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(maybeTrimPayload(payload)) }] };
}

async function collectPaged(fetchPage, options = {}) {
  const fetchAll = options.fetchAll !== false;
  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : null;
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0 ? options.maxItems : null;

  const items = [];
  let cursor = options.cursor || null;
  let pages = 0;
  const visited = new Set();
  let listMeta = null;
  let nextCursor = null;

  while (true) {
    const cursorKey = cursor || 'start';
    if (visited.has(cursorKey)) break;
    visited.add(cursorKey);

    const remaining = maxItems ? Math.max(maxItems - items.length, 0) : null;
    if (remaining === 0) break;

    const page = await fetchPage({
      cursor,
      limit: remaining && remaining > 0 ? remaining : options.limit,
    });

    if (page && page.list && !listMeta) listMeta = page.list;

    const pageItems = Array.isArray(page?.items) ? page.items : [];
    items.push(...pageItems);

    pages += 1;
    nextCursor = page?.nextCursor || null;

    if (!fetchAll) break;
    if (!nextCursor) break;
    if (maxPages && pages >= maxPages) break;
    if (maxItems && items.length >= maxItems) break;

    cursor = nextCursor;
  }

  const trimmed = maxItems ? items.slice(0, maxItems) : items;
  const response = {
    items: trimmed,
    meta: {
      count: trimmed.length,
      pages,
      fetchAll,
      ...(nextCursor ? { nextCursor } : {}),
    },
  };

  if (listMeta) response.list = listMeta;
  return response;
}

const paginationSchemaProps = {
  username: {
    type: 'string',
    description: 'Letterboxd username, profile URL, or "me".',
    default: 'me',
  },
  fetchAll: {
    type: 'boolean',
    description: 'If true (default), follows pagination automatically.',
    default: true,
  },
  maxPages: {
    type: 'integer',
    minimum: 1,
    description: 'Maximum number of pages to fetch when fetchAll is true.',
  },
  maxItems: {
    type: 'integer',
    minimum: 1,
    description: 'Maximum total items to return across pages.',
  },
  cursor: {
    type: 'string',
    description: 'Pagination cursor/URL for continuing from a previous response.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    description: 'Per-page extraction cap used by underlying scraper.',
  },
};

const tools = [
  {
    name: 'search',
    description: 'Search Letterboxd by query. Supports films, lists, members, and reviews.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search query text.' },
        type: {
          type: 'string',
          enum: ['films', 'lists', 'members', 'reviews'],
          default: 'films',
          description: 'Search category.',
        },
        fetchAll: paginationSchemaProps.fetchAll,
        maxPages: paginationSchemaProps.maxPages,
        maxItems: paginationSchemaProps.maxItems,
        cursor: paginationSchemaProps.cursor,
        limit: paginationSchemaProps.limit,
      },
      required: ['query'],
    },
  },
  {
    name: 'get_film',
    description: 'Get detailed film metadata by film slug.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Film slug (for /film/{slug}/).' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_member',
    description: 'Get a member profile summary and profile stats.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        username: paginationSchemaProps.username,
      },
    },
  },
  {
    name: 'get_member_watchlist',
    description: 'Get a member watchlist (supports automatic pagination).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...paginationSchemaProps,
      },
    },
  },
  {
    name: 'get_member_diary',
    description: 'Get diary entries for a member (supports automatic pagination).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...paginationSchemaProps,
      },
    },
  },
  {
    name: 'get_member_films',
    description: 'Get films watched by a member (supports automatic pagination).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...paginationSchemaProps,
      },
    },
  },
  {
    name: 'get_member_ratings',
    description: 'Get films rated by a member (supports automatic pagination).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...paginationSchemaProps,
      },
    },
  },
  {
    name: 'get_member_reviews',
    description: 'Get review summaries for a member (supports automatic pagination).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...paginationSchemaProps,
      },
    },
  },
  {
    name: 'get_member_pinned',
    description: 'Get favorite/pinned films shown on a member profile.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        username: paginationSchemaProps.username,
      },
    },
  },
  {
    name: 'get_member_lists',
    description: 'Get a member list directory (supports automatic pagination).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...paginationSchemaProps,
      },
    },
  },
  {
    name: 'get_list',
    description: 'Get list metadata and entries by owner username and list slug.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        username: paginationSchemaProps.username,
        listSlug: {
          type: 'string',
          description: 'List slug from /{username}/list/{listSlug}/. If omitted, behaves like get_member_lists.',
        },
        fetchAll: paginationSchemaProps.fetchAll,
        maxPages: paginationSchemaProps.maxPages,
        maxItems: paginationSchemaProps.maxItems,
        cursor: paginationSchemaProps.cursor,
        limit: paginationSchemaProps.limit,
      },
    },
  },
  {
    name: 'get_review',
    description: 'Get full review details by username + film slug (+ optional review id).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        username: paginationSchemaProps.username,
        filmSlug: { type: 'string', description: 'Film slug used in review URL.' },
        reviewId: {
          type: 'string',
          description: 'Optional review id segment for permalink URLs.',
        },
      },
      required: ['filmSlug'],
    },
  },
  {
    name: 'get_current_user',
    description: 'Return currently authenticated Letterboxd username and login state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'rate_film',
    description: 'Set your rating for a film (requires authenticated account).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Film slug.' },
        rating: { type: 'number', minimum: 0.5, maximum: 10 },
      },
      required: ['slug', 'rating'],
    },
  },
  {
    name: 'add_to_watched',
    description: 'Mark a film as watched or remove watched state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Film slug.' },
        remove: { type: 'boolean', default: false, description: 'If true, unmark watched.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'add_to_watchlist',
    description: 'Add a film to watchlist or remove it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Film slug.' },
        remove: { type: 'boolean', default: false, description: 'If true, remove from watchlist.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'toggle_like',
    description: 'Like or unlike a film page (current implementation targets film-level like control).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Film slug.' },
        remove: { type: 'boolean', default: false, description: 'If true, remove like.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'write_review',
    description: 'Write or update a diary/review entry by film slug.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Film slug.' },
        reviewText: { type: 'string', description: 'Review body text.' },
        rating: { type: 'number', minimum: 0, maximum: 5, description: 'Star rating. Half-stars supported.' },
        like: { type: 'boolean', description: 'Mark review as liked.' },
        containsSpoilers: { type: 'boolean', description: 'Flag as spoiler review.' },
        seenBefore: { type: 'boolean', description: 'Mark as rewatch.' },
      },
      required: ['slug', 'reviewText'],
    },
  },
  {
    name: 'write_review_by_title',
    description: 'Search a film by title (optionally year), then write a review entry.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Film title query.' },
        year: { type: 'integer', minimum: 1800, maximum: 2100 },
        reviewText: { type: 'string' },
        rating: { type: 'number', minimum: 0, maximum: 5 },
        like: { type: 'boolean' },
        containsSpoilers: { type: 'boolean' },
        seenBefore: { type: 'boolean' },
      },
      required: ['title', 'reviewText'],
    },
  },
  {
    name: 'add_to_list',
    description: 'Add a film to an existing list by list title.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'Film slug.' },
        listTitle: { type: 'string', description: 'Exact visible list title in your account.' },
      },
      required: ['slug', 'listTitle'],
    },
  },
  {
    name: 'create_list',
    description: 'Create a new list. Optionally add one initial film slug at creation time.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        description: { type: 'string', default: '' },
        visibility: {
          type: 'string',
          enum: ['Public', 'Anyone', 'Friends', 'You'],
          default: 'Public',
        },
        ranked: { type: 'boolean', default: false },
        filmSlug: { type: 'string', description: 'Optional single film slug to add while creating.' },
      },
      required: ['title'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const toolHandlers = {
  search: async (args) =>
    collectPaged(
      ({ cursor, limit }) => client.search(args.query, args.type || 'films', { cursor, limit }),
      args
    ),

  get_film: async (args) => client.getFilm(args.slug),

  get_member: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return client.getMember(username);
  },

  get_member_watchlist: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return collectPaged(({ cursor, limit }) => client.getMemberWatchlist(username, { cursor, limit }), args);
  },

  get_member_diary: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return collectPaged(({ cursor, limit }) => client.getMemberDiary(username, { cursor, limit }), args);
  },

  get_member_films: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return collectPaged(({ cursor, limit }) => client.getMemberFilms(username, { cursor, limit }), args);
  },

  get_member_ratings: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return collectPaged(({ cursor, limit }) => client.getMemberRatings(username, { cursor, limit }), args);
  },

  get_member_reviews: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return collectPaged(({ cursor, limit }) => client.getMemberReviews(username, { cursor, limit }), args);
  },

  get_member_pinned: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return client.getMemberPinned(username);
  },

  get_member_lists: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return collectPaged(({ cursor, limit }) => client.getLists(username, { cursor, limit }), args);
  },

  get_list: async (args) => {
    const username = await resolveMemberUsername(args.username);

    if (!args.listSlug) {
      return collectPaged(({ cursor, limit }) => client.getLists(username, { cursor, limit }), args);
    }

    return collectPaged(
      ({ cursor }) => client.getList(username, args.listSlug, { cursor }),
      args
    );
  },

  get_review: async (args) => {
    const username = await resolveMemberUsername(args.username);
    return client.getReview(username, args.filmSlug, args.reviewId);
  },

  get_current_user: async () => client.getCurrentUser(),

  rate_film: async (args) => ({ success: await client.rateFilm(args.slug, args.rating) }),

  add_to_watched: async (args) => ({ success: await client.addToWatched(args.slug, args.remove) }),

  add_to_watchlist: async (args) => ({ success: await client.addToWatchlist(args.slug, args.remove) }),

  toggle_like: async (args) => ({ success: await client.toggleLike(args.slug, null, args.remove) }),

  write_review: async (args) => ({ success: await client.writeReview(args.slug, args) }),

  write_review_by_title: async (args) => ({ success: await client.writeReviewByTitle(args.title, args) }),

  add_to_list: async (args) => ({ success: await client.addToList(args.slug, args.listTitle || args.listSlug) }),

  create_list: async (args) =>
    ({
      success: await client.createList(args.title, args.description || '', {
        visibility: args.visibility,
        ranked: args.ranked,
        filmSlug: args.filmSlug || null,
      }),
    }),
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const handler = toolHandlers[toolName];
  if (!handler) {
    throw new Error(`Tool not found: ${toolName}`);
  }

  const args = request.params.arguments || {};
  const result = await withTimeout(handler(args), TOOL_TIMEOUT_MS, `Tool ${toolName}`);
  return toToolResponse(result);
});

function getApiKeyFromRequest(req) {
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();

  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const bearer = auth.match(/^Bearer\s+(.+)$/i);
    if (bearer && bearer[1]) return bearer[1].trim();
  }

  if (typeof req.query.key === 'string' && req.query.key.trim()) return req.query.key.trim();
  return '';
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();

  const provided = getApiKeyFromRequest(req);
  if (provided === API_KEY) return next();

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Missing or invalid MCP API key. Provide x-api-key header, Authorization: Bearer <key>, or ?key=... query param.',
  });
}

async function startSSE() {
  const app = express();
  const sessions = new Map();

  app.get('/sse', requireApiKey, async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    await server.connect(transport);
    const sessionId = transport.sessionId;

    if (sessionId) {
      sessions.set(sessionId, transport);
      req.on('close', () => sessions.delete(sessionId));
    }
  });

  app.post('/messages', requireApiKey, express.json(), async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = sessions.get(sessionId);
    if (!transport) {
      return res.status(404).send('Session not found');
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Letterboxd MCP Server running on http://0.0.0.0:${PORT}`);
    console.log(`MCP endpoint: http://0.0.0.0:${PORT}/sse`);
    if (API_KEY) {
      console.log('MCP API key auth enabled.');
    }
  });
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // IMPORTANT: Do not write to stdout in stdio mode, it breaks MCP framing/handshake.
  console.error('Letterboxd MCP Server running in stdio mode (MCP).');
}

async function shutdown() {
  try {
    await client.close();
  } catch (error) {
    console.error('Error while closing Letterboxd client:', error);
  }
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

if (MODE === 'stdio') {
  startStdio().catch((err) => {
    console.error('Failed to start stdio mode:', err);
    process.exit(1);
  });
} else {
  startSSE().catch((err) => {
    console.error('Failed to start SSE mode:', err);
    process.exit(1);
  });
}
