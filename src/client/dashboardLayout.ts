import type { DashboardSpecV1, WidgetSpec } from './dashboards/types';

export const DASHBOARD_COLS = 12;
export const DASHBOARD_ROW_HEIGHT = 84;

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function defaultWidgetLayout(widget: WidgetSpec): { w: number; h: number } {
  if (widget.type === 'stat') return { w: 3, h: 1 };
  if (widget.type === 'timeseries') return { w: 6, h: 2 };
  return { w: 6, h: 2 };
}

type Rect = { x: number; y: number; w: number; h: number };

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function findFirstFit(placed: Rect[], cols: number, w: number, h: number, startY = 0): { x: number; y: number } {
  const safeW = Math.max(1, Math.min(cols, w));
  const safeH = Math.max(1, h);
  const maxY = Math.max(startY, ...placed.map((r) => r.y + r.h), 0) + 200;
  for (let y = Math.max(0, startY); y <= maxY; y += 1) {
    for (let x = 0; x <= cols - safeW; x += 1) {
      const candidate: Rect = { x, y, w: safeW, h: safeH };
      if (!placed.some((r) => rectsOverlap(r, candidate))) return { x, y };
    }
  }
  return { x: 0, y: maxY + 1 };
}

export function normalizeDashboardSpec(spec: DashboardSpecV1, cols = DASHBOARD_COLS): DashboardSpecV1 {
  const placed: Rect[] = [];
  const widgets = spec.widgets.map((widget) => {
    const defaults = defaultWidgetLayout(widget);
    const raw = widget.layout ?? ({} as any);
    const w = clampInt(raw.w, 1, cols, defaults.w);
    const h = clampInt(raw.h, 1, 50, defaults.h);

    const hasX = raw.x !== undefined && Number.isFinite(Number(raw.x));
    const hasY = raw.y !== undefined && Number.isFinite(Number(raw.y));
    const x0 = hasX ? clampInt(raw.x, 0, Math.max(0, cols - 1), 0) : 0;
    const y0 = hasY ? clampInt(raw.y, 0, 100_000, 0) : 0;
    const x = Math.min(x0, Math.max(0, cols - w));
    const y = y0;

    const candidate: Rect = { x, y, w, h };
    const needsReflow =
      !hasX ||
      !hasY ||
      candidate.x + candidate.w > cols ||
      placed.some((r) => rectsOverlap(r, candidate));

    const pos = needsReflow ? findFirstFit(placed, cols, w, h, hasY ? y : 0) : { x, y };
    const rect: Rect = { x: pos.x, y: pos.y, w, h };
    placed.push(rect);

    return { ...widget, layout: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } } as WidgetSpec;
  });

  return { ...spec, widgets };
}

export function addPlacedWidget(existing: WidgetSpec[], widget: WidgetSpec, cols = DASHBOARD_COLS): WidgetSpec {
  const base = normalizeDashboardSpec(
    { version: 1, name: '', sampleSize: 100, bucketSeconds: 60, widgets: existing },
    cols
  );
  const placed: Rect[] = base.widgets
    .map((w) => w.layout)
    .filter(Boolean)
    .map((l: any) => ({ x: l.x ?? 0, y: l.y ?? 0, w: l.w ?? 6, h: l.h ?? 2 }));

  const defaults = defaultWidgetLayout(widget);
  const w = clampInt(widget.layout?.w, 1, cols, defaults.w);
  const h = clampInt(widget.layout?.h, 1, 50, defaults.h);
  const pos = findFirstFit(placed, cols, w, h, Math.max(0, ...placed.map((r) => r.y + r.h), 0));
  return { ...widget, layout: { ...(widget.layout ?? {}), x: pos.x, y: pos.y, w, h } } as WidgetSpec;
}

