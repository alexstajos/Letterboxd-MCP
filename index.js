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
const DEFAULT_LIST_LIMIT = envInt(process.env.LETTERBOXD_DEFAULT_LIMIT, Infinity);
const MAX_LIST_LIMIT = envInt(process.env.LETTERBOXD_MAX_LIMIT, Infinity);
const MAX_RESPONSE_BYTES = envInt(process.env.LETTERBOXD_MAX_RESPONSE_BYTES, 0);
const MAX_PAGES = envInt(process.env.LETTERBOXD_MAX_PAGES, Infinity);
const API_KEY = process.env.MCP_API_KEY || '';

const client = new LetterboxdClient();

const server = new Server(
  {
    name: 'letterboxd-mcp-server',
    version: '3.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

function resolveLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIST_LIMIT;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return Infinity;
  return Math.floor(raw);
}

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
  const limit = resolveLimit(options.limit);
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
    if (limit !== Infinity && items.length >= limit) {
      items.splice(limit);
      break;
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const response = { items, meta: { count: items.length, pages, fetchAll: limit === Infinity } };
  if (listMeta) response.list = listMeta;
  return response;
}

function toToolResponse(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const tools = [
  {
    name: 'search',
    description: 'Search for films, lists, members, or reviews (Posters included).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['films', 'lists', 'members', 'reviews'], default: 'films' },
        limit: { type: 'integer' }
      },
      required: ['query'],
    },
  },
  {
    name: 'get_film',
    description: 'Full details of a film (Synopsis, Cast, Runtime, Rating, Poster).',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
  },
  {
    name: 'get_member_watchlist',
    description: "Member's watchlist (Private access supported, use 'me' for self).",
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'get_member_diary',
    description: "Viewing diary entries (use 'me' for self).",
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' }, limit: { type: 'integer' } },
    },
  },
  {
    name: 'get_member_pinned',
    description: "Pinned (favorite) films from a member profile (up to 4).",
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' } },
    },
  },
  {
    name: 'add_to_watched',
    description: 'Mark a film as watched.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, remove: { type: 'boolean', default: false } },
      required: ['slug'],
    },
  },
  {
    name: 'add_to_watchlist',
    description: 'Add or remove a film from watchlist.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, remove: { type: 'boolean', default: false } },
      required: ['slug'],
    },
  },
  {
    name: 'write_review',
    description: 'Log a film and write a review.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        reviewText: { type: 'string' },
        rating: { type: 'integer', description: '1-10 (half stars)' },
        containsSpoilers: { type: 'boolean', default: false }
      },
      required: ['slug', 'reviewText'],
    },
  },
  {
    name: 'toggle_like',
    description: 'Like/Unlike a film or review.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, remove: { type: 'boolean', default: false } },
      required: ['slug'],
    },
  },
  {
    name: 'get_member_lists',
    description: 'Retrieve user lists (including private ones).',
    inputSchema: {
      type: 'object',
      properties: { username: { type: 'string', default: 'me' } },
    },
  },
  {
    name: 'add_to_list',
    description: 'Add a film to a specific list.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, listSlug: { type: 'string' } },
      required: ['slug', 'listSlug'],
    },
  },
  {
    name: 'create_list',
    description: 'Create a new list (requires at least one film slug).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        isPrivate: { type: 'boolean', default: true },
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

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  // Logic simple pour le transport SSE
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Letterboxd MCP Server running on http://0.0.0.0:${PORT}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/sse`);
});