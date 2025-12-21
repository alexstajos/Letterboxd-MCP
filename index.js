const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const express = require('express');
const LetterboxdClient = require('./letterboxd');
require('dotenv').config();

const app = express();

// CORS Middleware to allow connections from ChatGPT and other clients
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Increase body size limit to handle large requests
app.use(express.json({ limit: '10mb' }));

const client = new LetterboxdClient();

const server = new Server(
  {
    name: 'letterboxd-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send('Letterboxd MCP Server is active. Connect via /sse endpoint.');
});

const tools = [
  {
    name: 'search',
    description: 'Global search (films, lists, members, reviews). Returns id, title, and url.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['films', 'lists', 'members', 'reviews'], default: 'films' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch',
    description: 'Fetch details of a specific item (film) by ID (slug).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item ID (film slug, e.g., "inception")' },
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
    description: 'Retrieve films from a specific list.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        listSlug: { type: 'string' },
        limit: { type: 'integer', description: 'Maximum number of films to retrieve (optional).' },
      },
      required: ['username', 'listSlug'],
    },
  },
  {
    name: 'get_review',
    description: 'Retrieve the full text of a review.',
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
    description: 'Member\'s watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', description: 'Maximum number of items to retrieve (optional).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_films',
    description: 'Films seen by a member.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', description: 'Maximum number of films to retrieve (optional).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_ratings',
    description: 'Ratings given by a member.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', description: 'Maximum number of ratings to retrieve (optional).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_reviews',
    description: 'Reviews written by a member.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', description: 'Maximum number of reviews to retrieve (optional).' },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_member_diary',
    description: 'Viewing diary.',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string' },
        limit: { type: 'integer', description: 'Maximum number of entries to retrieve (optional).' },
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search': {
        const results = await client.search(args.query, args.type);
        // Map results to fit OpenAI's expected 'id' field if needed
        const mappedResults = results.map(r => ({
          id: r.slug,
          title: r.title,
          url: r.url
        }));
        return { content: [{ type: 'text', text: JSON.stringify(mappedResults) }] };
      }
      case 'fetch': {
        // 'fetch' is essentially get_film but using 'id'
        const film = await client.getFilm(args.id);
        return { content: [{ type: 'text', text: JSON.stringify(film) }] };
      }
      case 'get_film':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getFilm(args.slug)) }] };
      case 'get_list':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getList(args.username, args.listSlug, args.limit)) }] };
      case 'get_review':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getReview(args.username, args.filmSlug)) }] };
      case 'get_member':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getMember(args.username)) }] };
      case 'get_member_watchlist':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getMemberWatchlist(args.username, args.limit)) }] };
      case 'get_member_films':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getMemberFilms(args.username, args.limit)) }] };
      case 'get_member_ratings':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getMemberRatings(args.username, args.limit)) }] };
      case 'get_member_reviews':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getMemberReviews(args.username, args.limit)) }] };
      case 'get_member_diary':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getMemberDiary(args.username, args.limit)) }] };
      case 'get_current_user':
        return { content: [{ type: 'text', text: JSON.stringify(await client.getCurrentUser()) }] };
      case 'rate_film':
        return { content: [{ type: 'text', text: JSON.stringify({ success: await client.rateFilm(args.slug, args.rating) }) }] };
      case 'add_to_watchlist':
        return { content: [{ type: 'text', text: JSON.stringify({ success: await client.addToWatchlist(args.slug) }) }] };
      case 'write_review':
        return { content: [{ type: 'text', text: JSON.stringify({ success: await client.writeReview(args.slug, args.reviewText, args.rating, args.containsSpoilers) }) }] };
      case 'add_to_list':
        return { content: [{ type: 'text', text: JSON.stringify({ success: await client.addToList(args.slug, args.listSlug) }) }] };
      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error) {
    console.error(`Error executing tool ${name}:`, error);
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

// Map to store active transports
const transports = new Map();

app.get('/sse', async (req, res) => {
  console.log(`New SSE connection initiated from ${req.ip}`);
  
  // Create transport with the endpoint where we expect messages
  const transport = new SSEServerTransport('/messages', res);
  
  try {
    // Connect the server to this transport
    await server.connect(transport);
    
    // The sessionId is usually available after connect/start
    const sessionId = transport.sessionId;
    console.log(`Transport connected. Session ID: ${sessionId}`);
    
    if (sessionId) {
        transports.set(sessionId, transport);
    }

    req.on('close', () => {
      console.log(`SSE connection closed for session: ${sessionId}`);
      if (sessionId) {
          transports.delete(sessionId);
      }
    });
  } catch (error) {
    console.error('Error connecting to transport:', error);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error during SSE handshake');
    }
  }
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`Received message for session: ${sessionId}`);
  
  if (!sessionId) {
      console.warn('Missing sessionId in query');
      res.status(400).send('Missing sessionId');
      return;
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    console.warn(`No active transport found for session: ${sessionId}`);
    res.status(404).send('Session not found');
    return;
  }
  
  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error('Error handling post message:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing message');
    }
  }
});

const PORT = process.env.PORT || 3000;

async function start() {
    console.log('Logging in to Letterboxd...');
    try {
        await client.init();
        if (process.env.LETTERBOXD_USERNAME && process.env.LETTERBOXD_PASSWORD) {
            await client.login(process.env.LETTERBOXD_USERNAME, process.env.LETTERBOXD_PASSWORD);
            console.log(`Logged in as ${process.env.LETTERBOXD_USERNAME}`);
        } else {
            console.warn('No credentials provided, some tools will be limited.');
        }
    } catch (e) {
        console.error('Failed to login:', e.message);
    }

    app.listen(PORT, () => {
        console.log(`Letterboxd MCP server running on http://localhost:${PORT}`);
        console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
        console.log(`Messages endpoint: http://localhost:${PORT}/messages`);
    });
}

start();
