import type { Trace, WideEvent, Tab } from './types';
import { safeJsonParse, isPrimitive, toComparableString } from './utils';

export type FilterOp = 'in' | 'contains';
export type FilterState = Record<string, { op: FilterOp; values: string[] }>;
export type SetStateAction<T> = T | ((prev: T) => T);
export type FilterSetter = (action: SetStateAction<FilterState>) => void;

export function normalizeFilterKey(tab: Tab, key: string): string {
  if (tab === 'events') {
    switch (key) {
      case 'service.name':
        return 'service_name';
      case 'graphql.operation_type':
        return 'operation_type';
      case 'graphql.field_name':
        return 'field_name';
      case 'duration.total_ms':
        return 'duration_ms';
      case 'user.id':
        return 'user_id';
      case 'count.rpc_calls':
        return 'rpc_call_count';
      default:
        return key;
    }
  }
  return key;
}

function getFieldValue(tab: Tab, item: Trace | WideEvent, key: string, parsedAttributes?: Record<string, unknown>): unknown {
  const normalized = normalizeFilterKey(tab, key);
  const direct = (item as any)[normalized];
  if (direct !== undefined && direct !== null) return direct;

  const attrs = parsedAttributes ?? (safeJsonParse((item as any).attributes) as Record<string, unknown>);
  if (attrs && typeof attrs === 'object') {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) return (attrs as any)[key];
    if (Object.prototype.hasOwnProperty.call(attrs, normalized)) return (attrs as any)[normalized];
    if (normalized.includes('.')) {
      const parts = normalized.split('.');
      let cur: any = attrs;
      for (const part of parts) {
        if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) {
          cur = cur[part];
        } else {
          cur = undefined;
          break;
        }
      }
      return cur;
    }
  }

  return undefined;
}

export function applyFilters<T extends Trace | WideEvent>(
  tab: Tab,
  items: T[],
  filters: FilterState,
  searchText: string
): T[] {
  const search = searchText.trim().toLowerCase();

  const activeFilters = Object.entries(filters).filter(([, f]) => f.values.length > 0);
  if (!search && activeFilters.length === 0) return items;

  return items.filter((item) => {
    const attrs = safeJsonParse(item.attributes) as Record<string, unknown>;

    if (search) {
      const haystack = [
        (item as any).trace_id,
        (item as any).service_name,
        (item as any).operation_name,
        (item as any).operation_type,
        (item as any).field_name,
        (item as any).user_id,
        item.attributes,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    for (const [key, filter] of activeFilters) {
      const value = getFieldValue(tab, item, key, attrs);
      const str = toComparableString(value);
      if (!str) return false;

      if (filter.op === 'in') {
        if (!filter.values.includes(str)) return false;
      } else if (filter.op === 'contains') {
        const lower = str.toLowerCase();
        const ok = filter.values.some((needle) => lower.includes(needle.toLowerCase()));
        if (!ok) return false;
      }
    }

    return true;
  });
}

export type FieldStats = {
  key: string;
  count: number;
  distinct: number;
  valuesTop: Array<{ value: string; count: number }>;
  highCardinality: boolean;
};

export function computeFieldStats(tab: Tab, items: Array<Trace | WideEvent>, extraKeys: string[] = []): FieldStats[] {
  const stats = new Map<string, { count: number; values: Map<string, number> }>();
  const forcedKeys = new Set(extraKeys.map((k) => normalizeFilterKey(tab, k)));

  const bump = (key: string, rawValue: unknown) => {
    if (!isPrimitive(rawValue)) return;
    const value = toComparableString(rawValue);
    if (!value) return;
    const normalizedKey = normalizeFilterKey(tab, key);
    const entry = stats.get(normalizedKey) ?? { count: 0, values: new Map<string, number>() };
    entry.count += 1;
    entry.values.set(value, (entry.values.get(value) ?? 0) + 1);
    stats.set(normalizedKey, entry);
  };

  const knownKeys =
    tab === 'events'
      ? ['service_name', 'outcome', 'operation_type', 'field_name', 'user_id']
      : ['service_name', 'status', 'operation_name'];

  for (const key of [...knownKeys, ...extraKeys]) {
    stats.set(key, { count: 0, values: new Map<string, number>() });
  }

  for (const item of items) {
    const attrs = safeJsonParse(item.attributes) as Record<string, unknown>;

    for (const key of knownKeys) {
      bump(key, (item as any)[key]);
    }

    if (attrs && typeof attrs === 'object') {
      for (const [k, v] of Object.entries(attrs)) {
        bump(k, v);
      }
    }
  }

  const result: FieldStats[] = [];
  for (const [key, entry] of stats.entries()) {
    const distinct = entry.values.size;
    if (distinct < 2 && !forcedKeys.has(key)) continue;

    const valuesTop = [...entry.values.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([value, count]) => ({ value, count }));

    result.push({
      key,
      count: entry.count,
      distinct,
      valuesTop,
      highCardinality: distinct > 50,
    });
  }

  // Prefer keys seen often, with manageable cardinality first
  return result.sort((a, b) => {
    if (a.highCardinality !== b.highCardinality) return a.highCardinality ? 1 : -1;
    if (a.distinct !== b.distinct) return a.distinct - b.distinct;
    return b.count - a.count;
  });
}

