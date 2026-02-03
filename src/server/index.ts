import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { otlpRouter } from './routes/otlp.js';
import { eventsRouter } from './routes/events.js';
import { apiRouter } from './routes/api.js';
import { setupWebSocket } from './websocket.js';
import { pruneByRetention } from './db/sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// OTLP receivers (traces and logs)
app.use('/', otlpRouter);
app.use('/', eventsRouter);

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
