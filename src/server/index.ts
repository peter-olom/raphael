import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { otlpRouter } from './routes/otlp.js';
import { eventsRouter } from './routes/events.js';
import { apiRouter } from './routes/api.js';
import { queryRouter } from './routes/query.js';
import { setupWebSocket } from './websocket.js';
import { pruneByRetention } from './db/sqlite.js';
import { authEnabled, authMiddleware, ensureAdminSeed, getAuthConfigSummary, getAuthNodeHandler } from './auth.js';
import { toNodeHandler } from 'better-auth/node';
import { adminRouter } from './routes/admin.js';
import { accountRouter } from './routes/account.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// Middleware
app.use(cors({ origin: true, credentials: true }));

// Auth config (non-BetterAuth endpoint)
app.get('/api/auth/config', (_req, res) => {
  res.json(getAuthConfigSummary());
});

// BetterAuth handler (must come before express.json)
if (authEnabled()) {
  app.all('/api/auth/*', toNodeHandler(getAuthNodeHandler()));
}

app.use(express.json({ limit: '10mb' }));
app.use(authMiddleware);

void ensureAdminSeed();

// OTLP receivers (traces and logs)
app.use('/', otlpRouter);
app.use('/', eventsRouter);
app.use('/', queryRouter);

// Admin routes
app.use('/api/admin', adminRouter);

// Account routes (session-only, mine-only)
app.use('/api/account', accountRouter);

// API routes
app.use('/api', apiRouter);

// Serve static files in production
const publicPath = path.join(__dirname, '../../dist/client');
app.use(express.static(publicPath));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/v1')) {
    return next();
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Setup WebSocket
setupWebSocket(server);

// Auto-truncation (retention rules per Drop)
try {
  pruneByRetention();
  setInterval(() => {
    try {
      pruneByRetention();
    } catch (error) {
      console.error('Retention pruning failed:', error);
    }
  }, 60_000);
} catch (error) {
  console.error('Initial retention pruning failed:', error);
}

const PORT = process.env.PORT || 6274;

server.listen(PORT, () => {
  console.log(`
  ╭─────────────────────────────────────────╮
  │                                         │
  │   🎨 Raphael - Trace & Event Viewer     │
  │                                         │
  │   UI:     http://localhost:${PORT}         │
  │   OTLP:   http://localhost:${PORT}/v1/traces│
  │   Events: http://localhost:${PORT}/v1/events│
  │                                         │
  ╰─────────────────────────────────────────╯
  `);
});
