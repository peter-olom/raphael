import { Router, Request, Response } from 'express';
import {
  DEFAULT_DROP_ID,
  createDrop,
  getDropById,
  getDropRetention,
  getAppSetting,
  setAppSetting,
  deleteAppSetting,
  listDashboards,
  getDashboard,
  createDashboard,
  updateDashboard,
  deleteDashboard,
  getRecentTraces,
  getRecentWideEvents,
  getTraceById,
  getWideEventsByTraceId,
  searchTraces,
  searchWideEvents,
  getStats,
  clearAll,
  listDrops,
  listUserDropPermissions,
  pruneByRetention,
  setDropRetentionMs,
  resolveDropId,
} from '../db/sqlite.js';
import { generateDashboardHeuristic, generateDashboardWithOpenRouter, profileWideEvents } from '../dashboardGenerator.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { authEnabled, noteApiKeyUsageDrop, requireAdmin, requireAuth, requireDropAccess } from '../auth.js';

export const apiRouter = Router();

function getDropId(req: Request, res: Response): number | null {
  const raw = req.query.dropId ?? req.query.drop ?? req.header('x-raphael-drop');
  const first = Array.isArray(raw) ? raw[0] : raw;
  const allowCreate = !authEnabled() || req.auth?.user?.role === 'admin';
  const dropId = resolveDropId(first?.toString() ?? '', allowCreate);
  if (dropId === null) {
    res.status(404).json({ error: 'Drop not found' });
    return null;
  }
  noteApiKeyUsageDrop(req, dropId);
  return dropId;
}

// Get recent traces
apiRouter.get('/traces', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;
  const traces = getRecentTraces(dropId, limit, offset);
  res.json(traces);
});

// Get recent wide events
apiRouter.get('/events', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const limit = parseInt(req.query.limit as string) || 100;
  const offset = parseInt(req.query.offset as string) || 0;
  const events = getRecentWideEvents(dropId, limit, offset);
  res.json(events);
});

// Get trace by ID (all spans)
apiRouter.get('/traces/:traceId', (req: Request, res: Response) => {
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

// Search traces
apiRouter.get('/search/traces', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const query = req.query.q as string || '';
  const limit = parseInt(req.query.limit as string) || 100;
  const results = searchTraces(dropId, query, limit);
  res.json(results);
});

// Search wide events
apiRouter.get('/search/events', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const query = req.query.q as string || '';
  const limit = parseInt(req.query.limit as string) || 100;
  const results = searchWideEvents(dropId, query, limit);
  res.json(results);
});

// Get stats
apiRouter.get('/stats', (_req: Request, res: Response) => {
  if (!requireAuth(_req, res)) return;
  const dropId = getDropId(_req, res);
  if (dropId === null) return;
  if (!requireDropAccess(_req, res, dropId, 'query')) return;
  const stats = getStats(dropId);
  res.json(stats);
});

// Clear all data
apiRouter.delete('/clear', (_req: Request, res: Response) => {
  if (!requireAdmin(_req, res)) return;
  const dropId = getDropId(_req, res);
  if (dropId === null) return;
  clearAll(dropId);
  res.json({ success: true });
});

// Drops
apiRouter.get('/drops', (_req: Request, res: Response) => {
  if (!requireAuth(_req, res)) return;
  if (_req.auth?.user?.role === 'admin' || !authEnabled()) {
    res.json({ default_drop_id: DEFAULT_DROP_ID, drops: listDrops() });
    return;
  }
  if (_req.auth?.user) {
    const permissions = listUserDropPermissions(_req.auth.user.id);
    const allowed = new Set(permissions.filter((p) => p.can_query).map((p) => p.drop_id));
    const drops = listDrops().filter((d) => allowed.has(d.id));
    res.json({ default_drop_id: DEFAULT_DROP_ID, drops });
    return;
  }
  res.status(403).json({ error: 'Drop access denied' });
});

apiRouter.post('/drops', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = (req.body?.name ?? '').toString();
    const drop = createDrop(name);
    res.status(201).json(drop);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to create drop' });
  }
});

apiRouter.put('/drops/:dropId/retention', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
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

// Dashboards
apiRouter.get('/dashboards', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  res.json(listDashboards(dropId));
});

apiRouter.get('/dashboards/:dashboardId', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const raw = (req.params as any).dashboardId as string | string[];
  const dashboardId = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(dashboardId)) return res.status(400).json({ error: 'Invalid dashboard id' });
  const row = getDashboard(dropId, dashboardId);
  if (!row) return res.status(404).json({ error: 'Dashboard not found' });
  res.json(row);
});

apiRouter.post('/dashboards', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  try {
    const name = (req.body?.name ?? '').toString();
    const specJson = JSON.stringify(req.body?.spec ?? {});
    const row = createDashboard(dropId, name, specJson);
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to create dashboard' });
  }
});

apiRouter.put('/dashboards/:dashboardId', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const raw = (req.params as any).dashboardId as string | string[];
  const dashboardId = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(dashboardId)) return res.status(400).json({ error: 'Invalid dashboard id' });

  try {
    const name = req.body?.name === undefined ? undefined : (req.body?.name ?? '').toString();
    const specJson = req.body?.spec === undefined ? undefined : JSON.stringify(req.body?.spec ?? {});
    const row = updateDashboard(dropId, dashboardId, name, specJson);
    if (!row) return res.status(404).json({ error: 'Dashboard not found' });
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to update dashboard' });
  }
});

apiRouter.delete('/dashboards/:dashboardId', (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const raw = (req.params as any).dashboardId as string | string[];
  const dashboardId = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(dashboardId)) return res.status(400).json({ error: 'Invalid dashboard id' });
  const ok = deleteDashboard(dropId, dashboardId);
  if (!ok) return res.status(404).json({ error: 'Dashboard not found' });
  res.json({ success: true });
});

apiRouter.post('/dashboards/generate', async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const dropId = getDropId(req, res);
  if (dropId === null) return;
  if (!requireDropAccess(req, res, dropId, 'query')) return;
  const drop = getDropById(dropId) as any;
  const dropName = drop?.name ?? `#${dropId}`;

  const limit = Math.max(100, Math.min(20_000, Number(req.body?.limit ?? 2000)));
  const useAi = Boolean(req.body?.use_ai ?? false);

  // Sample: last N events (by created_at)
  const sample = getRecentWideEvents(dropId, limit, 0) as any[];
  const profiles = profileWideEvents(sample);

  try {
    if (useAi) {
      const storedKey = getAppSetting('openrouter_api_key');
      const apiKey = storedKey ? decryptSecret(storedKey) : process.env.OPENROUTER_API_KEY;
      if (!apiKey) return res.status(400).json({ error: 'OPENROUTER_API_KEY is not set' });
      const storedModel = getAppSetting('openrouter_model');
      const model = storedModel || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
      const spec = await generateDashboardWithOpenRouter({ apiKey, model, dropName, sampleSize: sample.length, profiles });
      return res.json({ spec, profiles });
    }

    const spec = generateDashboardHeuristic(dropName, sample.length, profiles);
    return res.json({ spec, profiles });
  } catch (error) {
    return res.status(500).json({ error: (error as Error).message || 'Failed to generate dashboard' });
  }
});

// Settings: OpenRouter (global)
apiRouter.get('/settings/openrouter', (_req: Request, res: Response) => {
  if (!requireAdmin(_req, res)) return;
  const model = getAppSetting('openrouter_model') || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const storedKey = getAppSetting('openrouter_api_key');
  res.json({ model, api_key_set: Boolean(storedKey || process.env.OPENROUTER_API_KEY) });
});

apiRouter.put('/settings/openrouter', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const apiKeyRaw = req.body?.api_key;
  const modelRaw = req.body?.model;

  if (apiKeyRaw !== undefined) {
    const apiKey = (apiKeyRaw ?? '').toString().trim();
    if (!apiKey) {
      deleteAppSetting('openrouter_api_key');
    } else {
      setAppSetting('openrouter_api_key', encryptSecret(apiKey));
    }
  }

  if (modelRaw !== undefined) {
    const model = (modelRaw ?? '').toString().trim();
    if (!model) {
      deleteAppSetting('openrouter_model');
    } else {
      setAppSetting('openrouter_model', model);
    }
  }

  const model = getAppSetting('openrouter_model') || process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  const storedKey = getAppSetting('openrouter_api_key');
  res.json({ success: true, model, api_key_set: Boolean(storedKey || process.env.OPENROUTER_API_KEY) });
});
