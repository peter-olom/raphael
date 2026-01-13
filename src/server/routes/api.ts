import { Router, Request, Response } from 'express';
import {
  getRecentTraces,
  getRecentWideEvents,
  getTraceById,
  getWideEventsByTraceId,
  searchTraces,
  searchWideEvents,
  getStats,
  clearAll,
} from '../db/sqlite.js';

export const apiRouter = Router();

// Get recent traces
apiRouter.get('/traces', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;
  const traces = getRecentTraces(limit, offset);
  res.json(traces);
});

// Get recent wide events
apiRouter.get('/events', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;
  const events = getRecentWideEvents(limit, offset);
  res.json(events);
});

// Get trace by ID (all spans)
apiRouter.get('/traces/:traceId', (req: Request, res: Response) => {
  const { traceId } = req.params;
  const spans = getTraceById(traceId);
  const events = getWideEventsByTraceId(traceId);
  res.json({ spans, events });
});

// Search traces
apiRouter.get('/search/traces', (req: Request, res: Response) => {
  const query = req.query.q as string || '';
  const limit = parseInt(req.query.limit as string) || 100;
  const results = searchTraces(query, limit);
  res.json(results);
});

// Search wide events
apiRouter.get('/search/events', (req: Request, res: Response) => {
  const query = req.query.q as string || '';
  const limit = parseInt(req.query.limit as string) || 100;
  const results = searchWideEvents(query, limit);
  res.json(results);
});

// Get stats
apiRouter.get('/stats', (_req: Request, res: Response) => {
  const stats = getStats();
  res.json(stats);
});

// Clear all data
apiRouter.delete('/clear', (_req: Request, res: Response) => {
  clearAll();
  res.json({ success: true });
});
