import type { DashboardSpecV1, WidgetSpec } from './types';

type WideEvent = {
  id: number;
  trace_id: string | null;
  service_name: string;
  operation_type: string | null;
  field_name: string | null;
  outcome: string;
  duration_ms: number | null;
  user_id: string | null;
  error_count: number;
  rpc_call_count: number;
  attributes: string;
  created_at: number;
};

function safeJsonParse(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getFieldValue(event: WideEvent, field: string): unknown {
  if (field === 'operation') {
    return `${event.operation_type ?? ''}:${event.field_name ?? ''}`.replace(/^:/, '').replace(/:$/, '');
  }
  const direct = (event as any)[field];
  if (direct !== undefined) return direct;
  const attrs = safeJsonParse(event.attributes);
  if (Object.prototype.hasOwnProperty.call(attrs, field)) return (attrs as any)[field];
  return undefined;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export type StatResult = { value: string; sub?: string };
export type BarResult = { labels: string[]; values: number[] };
export type SeriesPoint = { t: number; v: number };
export type SeriesResult = { points: SeriesPoint[]; unit?: string };
export type HistogramResult = { bins: Array<{ x0: number; x1: number; count: number }> };

export type WidgetResult =
  | { type: 'stat'; data: StatResult }
  | { type: 'bar'; data: BarResult }
  | { type: 'timeseries'; data: SeriesResult }
  | { type: 'histogram'; data: HistogramResult };

export function computeWidget(widget: WidgetSpec, events: WideEvent[], spec: DashboardSpecV1): WidgetResult {
  if (widget.type === 'stat') {
    const total = events.length;
    const errors = events.filter((e) => e.outcome === 'error').length;
    const uniqueTraces = new Set(events.map((e) => e.trace_id).filter(Boolean)).size;
    const uniqueUsers = new Set(events.map((e) => e.user_id).filter(Boolean)).size;

    if (widget.metric === 'events') return { type: 'stat', data: { value: String(total) } };
    if (widget.metric === 'errors') return { type: 'stat', data: { value: String(errors) } };
    if (widget.metric === 'unique_traces') return { type: 'stat', data: { value: String(uniqueTraces) } };
    if (widget.metric === 'unique_users') return { type: 'stat', data: { value: String(uniqueUsers) } };
    const rate = total ? (errors / total) * 100 : 0;
    return { type: 'stat', data: { value: `${rate.toFixed(2)}%`, sub: `${errors}/${total}` } };
  }

  if (widget.type === 'bar') {
    const counts = new Map<string, number>();
    for (const e of events) {
      const v = getFieldValue(e, widget.field);
      if (v === undefined || v === null) continue;
      const key = String(v);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, widget.topN);
    return { type: 'bar', data: { labels: sorted.map((x) => x[0]), values: sorted.map((x) => x[1]) } };
  }

  if (widget.type === 'timeseries') {
    const bucketMs = Math.max(1, (spec.bucketSeconds ?? 60) * 1000);
    const buckets = new Map<number, { total: number; errors: number }>();
    for (const e of events) {
      const t = Math.floor((e.created_at ?? 0) / bucketMs) * bucketMs;
      const cur = buckets.get(t) ?? { total: 0, errors: 0 };
      cur.total += 1;
      if (e.outcome === 'error') cur.errors += 1;
      buckets.set(t, cur);
    }
    const points = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => {
        if (widget.metric === 'errors') return { t, v: v.errors };
        if (widget.metric === 'error_rate') return { t, v: v.total ? (v.errors / v.total) * 100 : 0 };
        return { t, v: v.total };
      });
    return { type: 'timeseries', data: { points, unit: widget.metric === 'error_rate' ? '%' : undefined } };
  }

  // histogram
  const nums: number[] = [];
  for (const e of events) {
    const v = getFieldValue(e, widget.field);
    const n = toNumber(v);
    if (n === null) continue;
    nums.push(n);
  }
  if (nums.length === 0) return { type: 'histogram', data: { bins: [] } };

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  if (min === max) {
    return { type: 'histogram', data: { bins: [{ x0: min, x1: max, count: nums.length }] } };
  }

  const bins = Math.max(2, Math.min(50, widget.bins || 12));
  const width = (max - min) / bins;
  const counts = new Array(bins).fill(0) as number[];
  for (const n of nums) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((n - min) / width)));
    counts[idx] += 1;
  }
  const out = counts.map((count, i) => ({
    x0: min + i * width,
    x1: min + (i + 1) * width,
    count,
  }));
  return { type: 'histogram', data: { bins: out } };
}

export function parseDashboardSpec(specJson: string): DashboardSpecV1 | null {
  try {
    const obj = JSON.parse(specJson);
    if (!obj || obj.version !== 1 || !Array.isArray(obj.widgets)) return null;
    return obj as DashboardSpecV1;
  } catch {
    return null;
  }
}

