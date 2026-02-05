import { Router, Request, Response } from 'express';
import {
  getTraceById,
  getWideEventsByTraceId,
  queryTraces,
  queryWideEvents,
  resolveDropId,
} from '../db/sqlite.js';
import { authEnabled, noteApiKeyUsageDrop, requireAuth, requireDropAccess } from '../auth.js';

export const queryRouter = Router();

function getDropId(req: Request, res: Response): number | null {
  const raw = req.body?.drop ?? req.body?.dropId ?? req.query.drop ?? req.query.dropId ?? req.header('x-raphael-drop');
  const first = Array.isArray(raw) ? raw[0] : raw;
  const allowCreate = !authEnabled() || req.auth?.user?.role === 'admin';
  const dropId = resolveDropId(first?.toString?.() ?? '', allowCreate);
  if (dropId === null) {
    res.status(404).json({ error: 'Drop not found' });
    return null;
  }
  noteApiKeyUsageDrop(req, dropId);
  return dropId;
}

queryRouter.post('/v1/query/traces', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const results = queryTraces(dropId, req.body ?? {});
  res.json(results);
});

queryRouter.post('/v1/query/events', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const results = queryWideEvents(dropId, req.body ?? {});
  res.json(results);
});

queryRouter.get('/v1/query/traces/:traceId', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const raw = (req.params as any).traceId as string | string[];
  const traceId = Array.isArray(raw) ? raw[0] : raw;
  const spans = getTraceById(dropId, traceId);
  const events = getWideEventsByTraceId(dropId, traceId);
  res.json({ spans, events });
});
