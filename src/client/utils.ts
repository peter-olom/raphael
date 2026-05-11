import type { Trace, WideEvent } from './types';

export function formatTime(timestamp: number | undefined | null): string {
  if (!timestamp || isNaN(timestamp)) return '-';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleTimeString();
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
}

export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error?: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export function truncate(str: string | null | undefined, len: number): string {
  if (!str) return '-';
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}

export function getTraceTime(trace: Trace): number {
  return trace.created_at || trace.start_time || Date.now();
}

export function getEventTime(event: WideEvent): number {
  return event.created_at || Date.now();
}

export function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export function toComparableString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
