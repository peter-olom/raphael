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
import { startRetentionScheduler } from './retention.js';
import {
  authEnabled,
  authMiddleware,
  ensureAdminSeed,
  getAuthConfigSummary,
  getAuthNodeHandler,
  validateAuthBootstrapConfig,
} from './auth.js';
import { toNodeHandler } from 'better-auth/node';
import { adminRouter } from './routes/admin.js';
import { accountRouter } from './routes/account.js';
import { configureTrustProxy } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
configureTrustProxy(app);

function originFromUrl(raw: string | undefined) {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function configuredCorsOrigins() {
  const raw = [
    process.env.RAPHAEL_CORS_ORIGINS,
    process.env.RAPHAEL_AUTH_TRUSTED_ORIGINS,
    process.env.BETTER_AUTH_BASE_URL,
    process.env.BETTER_AUTH_URL,
  ]
    .filter(Boolean)
    .join(',');

  const origins = new Set(
    raw
      .split(',')
      .map((value) => originFromUrl(value.trim()))
      .filter((value): value is string => Boolean(value))
  );

  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    origins.add('http://localhost:5173');
    origins.add('http://127.0.0.1:5173');
    origins.add(`http://localhost:${process.env.PORT || 6274}`);
    origins.add(`http://127.0.0.1:${process.env.PORT || 6274}`);
  }

  return origins;
}

const allowedCorsOrigins = configuredCorsOrigins();

// Middleware
app.use(
  cors({
    credentials: authEnabled(),
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedCorsOrigins.has(origin)) return callback(null, true);
      return callback(null, false);
    },
  })
);

// Auth config (non-BetterAuth endpoint)
app.get('/api/auth/config', (_req, res) => {
  res.json(getAuthConfigSummary());
});

validateAuthBootstrapConfig();

// BetterAuth handler (must come before express.json)
if (authEnabled()) {
  app.all('/api/auth/*', toNodeHandler(getAuthNodeHandler()));
}

app.use(express.json({ limit: '10mb' }));
app.use(authMiddleware);

await ensureAdminSeed();

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

app.use(['/api', '/v1'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

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

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  const status = (error as any)?.status || (error as any)?.statusCode || 500;
  const isBodyParserError = status === 400 && (error as any)?.type === 'entity.parse.failed';
  if (isBodyParserError) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }
  console.error('Unhandled request error:', error);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: 'Internal server error' });
});

// Setup WebSocket
setupWebSocket(server);

// Auto-truncation (retention rules per Drop). Runs only in the background
// scheduler so request handlers never perform retention cleanup inline.
startRetentionScheduler();

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
