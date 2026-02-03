import { Router, Request, Response } from 'express';
import {
  DEFAULT_DROP_ID,
  createDrop,
  getDropById,
  getDropRetention,
  getRecentTraces,
  getRecentWideEvents,
  getTraceById,
  getWideEventsByTraceId,
  searchTraces,
  searchWideEvents,
  getStats,
  clearAll,
  ensureDrop,
  listDrops,
  pruneByRetention,
  setDropRetentionMs,
} from '../db/sqlite.js';

export const apiRouter = Router();

function getDropId(req: Request): number {
  const raw = req.query.dropId ?? req.query.drop ?? req.header('x-raphael-drop');
  const first = Array.isArray(raw) ? raw[0] : raw;
  return ensureDrop(first?.toString());
}

// Get recent traces
apiRouter.get('/traces', (req: Request, res: Response) => {
  const dropId = getDropId(req);
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;
  const traces = getRecentTraces(dropId, limit, offset);
  res.json(traces);
});

// Get recent wide events
apiRouter.get('/events', (req: Request, res: Response) => {
  const dropId = getDropId(req);
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;
  const events = getRecentWideEvents(dropId, limit, offset);
  res.json(events);
});

// Get trace by ID (all spans)
apiRouter.get('/traces/:traceId', (req: Request, res: Response) => {
  const dropId = getDropId(req);
  const raw = (req.params as any).traceId as string | string[];
  const traceId = Array.isArray(raw) ? raw[0] : raw;
  const spans = getTraceById(dropId, traceId);
  const events = getWideEventsByTraceId(dropId, traceId);
  res.json({ spans, events });
});

// Search traces
apiRouter.get('/search/traces', (req: Request, res: Response) => {
  const dropId = getDropId(req);
  const query = req.query.q as string || '';
  const limit = parseInt(req.query.limit as string) || 100;
  const results = searchTraces(dropId, query, limit);
  res.json(results);
});

// Search wide events
apiRouter.get('/search/events', (req: Request, res: Response) => {
  const dropId = getDropId(req);
  const query = req.query.q as string || '';
  const limit = parseInt(req.query.limit as string) || 100;
  const results = searchWideEvents(dropId, query, limit);
  res.json(results);
});

// Get stats
apiRouter.get('/stats', (_req: Request, res: Response) => {
  const dropId = getDropId(_req);
  const stats = getStats(dropId);
  res.json(stats);
});

// Clear all data
apiRouter.delete('/clear', (_req: Request, res: Response) => {
  const dropId = getDropId(_req);
  clearAll(dropId);
  res.json({ success: true });
});

// Drops
apiRouter.get('/drops', (_req: Request, res: Response) => {
  res.json({ default_drop_id: DEFAULT_DROP_ID, drops: listDrops() });
});

apiRouter.post('/drops', (req: Request, res: Response) => {
  try {
    const name = (req.body?.name ?? '').toString();
    const drop = createDrop(name);
    res.status(201).json(drop);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to create drop' });
  }
});

apiRouter.put('/drops/:dropId/retention', (req: Request, res: Response) => {
  const raw = (req.params as any).dropId as string | string[];
  const dropId = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(dropId)) {
    res.status(400).json({ error: 'Invalid drop id' });
    return;
  }
  if (!getDropById(dropId)) {
    res.status(404).json({ error: 'Drop not found' });
    return;
  }

  const tracesDaysRaw = req.body?.traces_days;
  const eventsDaysRaw = req.body?.events_days;

  const tracesDays = tracesDaysRaw === undefined ? undefined : Number(tracesDaysRaw);
  const eventsDays = eventsDaysRaw === undefined ? undefined : Number(eventsDaysRaw);

  if (tracesDays !== undefined && (!Number.isFinite(tracesDays) || tracesDays < 0)) {
    res.status(400).json({ error: 'traces_days must be a non-negative number' });
    return;
  }
  if (eventsDays !== undefined && (!Number.isFinite(eventsDays) || eventsDays < 0)) {
    res.status(400).json({ error: 'events_days must be a non-negative number' });
    return;
  }

  const current = getDropRetention(dropId);
  const tracesRetentionMs =
    tracesDays === undefined
      ? current?.traces_retention_ms ?? null
      : tracesDays === 0
        ? null
        : Math.round(tracesDays * 24 * 60 * 60 * 1000);
  const eventsRetentionMs =
    eventsDays === undefined
      ? current?.events_retention_ms ?? null
      : eventsDays === 0
        ? null
        : Math.round(eventsDays * 24 * 60 * 60 * 1000);

  setDropRetentionMs(dropId, tracesRetentionMs, eventsRetentionMs);
  pruneByRetention(dropId);
  res.json({ success: true });
});
