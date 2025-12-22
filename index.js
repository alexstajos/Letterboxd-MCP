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
const TOOL_TIMEOUT_MS = envInt(process.env.LETTERBOXD_TOOL_TIMEOUT_MS, 300000);
const MAX_RESPONSE_BYTES = envInt(process.env.LETTERBOXD_MAX_RESPONSE_BYTES, 0);
const MAX_PAGES = envInt(process.env.LETTERBOXD_MAX_PAGES, Infinity);
const API_KEY = process.env.MCP_API_KEY || '';

const client = new LetterboxdClient();

const server = new Server(
  {
    name: 'letterboxd',
    version: '3.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

function resolveMaxPages(value) {
  if (value === undefined || value === null || value === '') return MAX_PAGES;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return Infinity;
  return Math.floor(raw);
}

function normalizeUsername(value) {
  if (value === undefined || value === null) return '';
  let raw = String(value).trim();
  if (!raw) return '';
  if (raw.toLowerCase() === 'me' || raw.toLowerCase() === 'self') return client.username || raw;
  try {
    if (raw.startsWith('http')) {
      const parts = new URL(raw).pathname.split('/').filter(Boolean);
      return parts[0];
    }
  } catch {}
  return raw.split('/').filter(Boolean)[0];
}

async function collectPaged(fetchPage, options) {
  const maxPages = resolveMaxPages(options.maxPages);
  const items = [];
  let cursor = options.cursor || null;
  let pages = 0;
  const visited = new Set();
  let listMeta = null;

  while (pages < maxPages) {
    const cursorKey = cursor || 'start';
    if (visited.has(cursorKey)) break;
    visited.add(cursorKey);

    const page = await fetchPage({ cursor });
    if (page && page.list && !listMeta) listMeta = page.list;
    const pageItems = Array.isArray(page.items) ? page.items : [];
    items.push(...pageItems);
    pages += 1;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const response = { items, meta: { count: items.length, pages, fetchAll: true } };
  if (listMeta) response.list = listMeta;
  return response;
}

function toToolResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const tools = [
  {
    name: 'search',
    description: 'Search films/members/lists.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['films', 'lists', 'members', 'reviews'], default: 'films' },
        maxPages: { type: 'integer', minimum: 1 }
      },
      required: ['query'],
    },
  },
  {
    name: 'get_film',
    description: 'Get film details.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'get_member_watchlist',
    description: 'Get user watchlist.',
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' }, maxPages: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'get_member_diary',
    description: 'Get user diary.',
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' }, maxPages: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'get_member_films',
    description: 'Get all films watched by a user.',
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' }, maxPages: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'get_member_pinned',
    description: 'Get user favorites.',
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' } },
    },
  },
  {
    name: 'add_to_watched',
    description: 'Mark film as watched.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, remove: { type: 'boolean', default: false } },
      required: ['slug'],
    },
  },
  {
    name: 'add_to_watchlist',
    description: 'Add/remove from watchlist.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, remove: { type: 'boolean', default: false } },
      required: ['slug'],
    },
  },
  {
    name: 'write_review',
    description: 'Post a review.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        reviewText: { type: 'string' },
        rating: { type: 'integer' }
      },
      required: ['slug', 'reviewText'],
    },
  },
  {
    name: 'toggle_like',
    description: 'Like/Unlike a film.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, remove: { type: 'boolean', default: false } },
      required: ['slug'],
    },
  },
  {
    name: 'get_member_lists',
    description: 'Get user lists.',
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' }, maxPages: { type: 'integer', minimum: 1 } },
    },
  },
  {
    name: 'add_to_list',
    description: 'Add film to list.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, listSlug: { type: 'string' } },
      required: ['slug', 'listSlug'],
    },
  },
  {
    name: 'create_list',
    description: 'Create list (1 film min).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        filmSlugs: { type: 'array', items: { type: 'string' } }
      },
      required: ['title', 'filmSlugs'],
    },
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const toolHandlers = {
  search: async (args) => collectPaged(({ cursor }) => client.search(args.query, args.type, { cursor }), args),
  get_film: async (args) => client.getFilm(args.slug),
  get_member_watchlist: async (args) => collectPaged(({ cursor }) => client.getMemberWatchlist(normalizeUsername(args.username), { cursor }), args),
  get_member_diary: async (args) => collectPaged(({ cursor }) => client.getMemberDiary(normalizeUsername(args.username), { cursor }), args),
  get_member_films: async (args) => collectPaged(({ cursor }) => client.getMemberFilms(normalizeUsername(args.username), { cursor }), args),
  get_member_pinned: async (args) => client.getMemberPinned(normalizeUsername(args.username)),
  add_to_watched: async (args) => ({ success: await client.addToWatched(args.slug, args.remove) }),
  add_to_watchlist: async (args) => ({ success: await client.addToWatchlist(args.slug, args.remove) }),
  write_review: async (args) => ({ success: await client.writeReview(args.slug, args) }),
  toggle_like: async (args) => ({ success: await client.toggleLike(args.slug, null, args.remove) }),
  get_member_lists: async (args) => collectPaged(({ cursor }) => client.getLists(normalizeUsername(args.username), { cursor }), args),
  add_to_list: async (args) => ({ success: await client.addToList(args.slug, args.listSlug) }),
  create_list: async (args) => ({ success: await client.createList(args.title, args.description, args.isPrivate, args.filmSlugs) })
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = toolHandlers[request.params.name];
  if (!handler) throw new Error('Tool not found');
  const result = await handler(request.params.arguments || {});
  return toToolResponse(result);
});

const sessions = new Map();

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
  const sessionId = transport.sessionId;
  if (sessionId) {
    sessions.set(sessionId, transport);
    req.on('close', () => sessions.delete(sessionId));
  }
});

app.post('/messages', express.json(), async (req, res) => {
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
});
