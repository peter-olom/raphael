import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';

interface Trace {
  id: number;
  drop_id?: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  service_name: string;
  operation_name: string;
  start_time: number;
  end_time: number | null;
  duration_ms: number | null;
  status: string;
  attributes: string;
  created_at: number;
}

interface WideEvent {
  id: number;
  drop_id?: number;
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
}

interface Stats {
  traces: number;
  wideEvents: number;
  errors: number;
}

interface Drop {
  id: number;
  name: string;
  created_at: number;
  traces_retention_ms: number | null;
  events_retention_ms: number | null;
}

type Tab = 'events' | 'traces';

const styles = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  header: {
    background: '#1a1a1a',
    padding: '16px 24px',
    borderBottom: '1px solid #333',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  logo: {
    fontSize: '24px',
    fontWeight: 700,
    color: '#fff',
  },
  stats: {
    display: 'flex',
    gap: '24px',
  },
  stat: {
    textAlign: 'center' as const,
  },
  statValue: {
    fontSize: '20px',
    fontWeight: 600,
    color: '#fff',
  },
  statLabel: {
    fontSize: '12px',
    color: '#888',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  tabs: {
    display: 'flex',
    background: '#1a1a1a',
    borderBottom: '1px solid #333',
  },
  tab: {
    padding: '12px 24px',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    color: '#888',
    fontSize: '14px',
    fontWeight: 500,
    borderBottom: '2px solid transparent',
  },
  tabActive: {
    color: '#fff',
    borderBottomColor: '#6366f1',
  },
  toolbar: {
    padding: '12px 24px',
    background: '#151515',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },
  select: {
    padding: '8px 12px',
    background: '#252525',
    border: '1px solid #333',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '14px',
    outline: 'none',
  },
  searchInput: {
    flex: 1,
    padding: '8px 12px',
    background: '#252525',
    border: '1px solid #333',
    borderRadius: '6px',
    color: '#fff',
    fontSize: '14px',
    outline: 'none',
  },
  button: {
    padding: '8px 16px',
    background: '#333',
    border: 'none',
    borderRadius: '6px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
  },
  buttonDanger: {
    background: '#7f1d1d',
  },
  liveIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    color: '#22c55e',
  },
  liveDot: {
    width: '8px',
    height: '8px',
    background: '#22c55e',
    borderRadius: '50%',
    animation: 'pulse 2s infinite',
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    borderRadius: '999px',
    border: '1px solid #333',
    background: '#111',
    fontSize: '12px',
    color: '#bbb',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    borderRadius: '999px',
    border: '1px solid #333',
    background: '#0f0f0f',
    fontSize: '12px',
    color: '#ddd',
  },
  chipButton: {
    background: 'transparent',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    padding: 0,
    fontSize: '12px',
    lineHeight: 1,
  },
  filtersPanel: {
    margin: '0 24px',
    marginTop: '12px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid #333',
    background: '#121212',
  },
  filtersGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
    gap: '12px',
  },
  filterCard: {
    border: '1px solid #2a2a2a',
    background: '#0f0f0f',
    borderRadius: '10px',
    padding: '12px',
  },
  filterCardTitle: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: '10px',
    marginBottom: '10px',
    color: '#ddd',
    fontSize: '12px',
    fontWeight: 700,
  },
  filterHint: {
    color: '#777',
    fontSize: '11px',
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  },
  filterValues: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '8px',
    alignItems: 'center',
  },
  filterInput: {
    width: '100%',
    padding: '8px 10px',
    background: '#151515',
    border: '1px solid #333',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '13px',
    outline: 'none',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: '16px 24px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
  },
  th: {
    textAlign: 'left' as const,
    padding: '12px',
    borderBottom: '1px solid #333',
    color: '#888',
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  },
  td: {
    padding: '12px',
    borderBottom: '1px solid #222',
    fontSize: '13px',
  },
  row: {
    cursor: 'pointer',
    transition: 'background 0.15s',
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 600,
  },
  badgeSuccess: {
    background: '#14532d',
    color: '#4ade80',
  },
  badgeError: {
    background: '#7f1d1d',
    color: '#fca5a5',
  },
  mono: {
    fontFamily: 'Monaco, Consolas, monospace',
    fontSize: '12px',
    color: '#a78bfa',
  },
  modal: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(0,0,0,0.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    zIndex: 1000,
  },
  modalContent: {
    background: '#1a1a1a',
    borderRadius: '12px',
    maxWidth: '1000px',
    width: '100%',
    maxHeight: '85vh',
    overflow: 'hidden',
    border: '1px solid #333',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  modalSmallContent: {
    background: '#1a1a1a',
    borderRadius: '12px',
    maxWidth: '520px',
    width: '100%',
    maxHeight: '85vh',
    overflow: 'hidden',
    border: '1px solid #333',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  modalHeader: {
    padding: '16px 24px',
    borderBottom: '1px solid #333',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexShrink: 0,
  },
  modalTitle: {
    fontSize: '18px',
    fontWeight: 600,
    color: '#fff',
  },
  modalActions: {
    display: 'flex',
    gap: '8px',
  },
  modalBody: {
    padding: '24px',
    overflow: 'auto',
    flex: 1,
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '16px',
    marginBottom: '24px',
  },
  metaItem: {
    background: '#252525',
    padding: '12px',
    borderRadius: '8px',
  },
  metaLabel: {
    fontSize: '11px',
    color: '#888',
    textTransform: 'uppercase' as const,
    marginBottom: '4px',
  },
  metaValue: {
    fontSize: '14px',
    color: '#fff',
    fontFamily: 'Monaco, Consolas, monospace',
    wordBreak: 'break-all' as const,
  },
  jsonContainer: {
    background: '#0a0a0a',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  jsonHeader: {
    padding: '12px 16px',
    background: '#151515',
    borderBottom: '1px solid #333',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jsonTitle: {
    fontSize: '12px',
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase' as const,
  },
  jsonBody: {
    padding: '16px',
    overflow: 'auto',
    maxHeight: '400px',
  },
  inspectorTabs: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  inspectorTab: {
    padding: '4px 8px',
    borderRadius: '6px',
    border: '1px solid #333',
    background: '#0f0f0f',
    color: '#bbb',
    cursor: 'pointer',
    fontSize: '11px',
  },
  inspectorTabActive: {
    borderColor: '#6366f1',
    color: '#fff',
    background: '#1b1b3a',
  },
  split: {
    display: 'flex',
    gap: '16px',
    alignItems: 'stretch',
  },
  pane: {
    flex: 1,
    minWidth: 0,
    background: '#141414',
    border: '1px solid #333',
    borderRadius: '10px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  paneHeader: {
    padding: '10px 12px',
    borderBottom: '1px solid #333',
    background: '#101010',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '10px',
  },
  paneTitle: {
    fontSize: '12px',
    fontWeight: 700,
    color: '#ddd',
    textTransform: 'uppercase' as const,
  },
  paneBody: {
    padding: '10px 12px',
    overflow: 'auto',
    flex: 1,
  },
  treeRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px',
    padding: '2px 0',
    fontFamily: 'Monaco, Consolas, monospace',
    fontSize: '12px',
    lineHeight: 1.6,
    whiteSpace: 'pre' as const,
  },
  treeToggle: {
    width: '18px',
    background: 'transparent',
    border: 'none',
    color: '#888',
    cursor: 'pointer',
    padding: 0,
    textAlign: 'center' as const,
  },
  treeKey: {
    color: '#60a5fa',
  },
  treeType: {
    color: '#888',
  },
  treeValueString: {
    color: '#4ade80',
  },
  treeValueNumber: {
    color: '#a78bfa',
  },
  treeValueBool: {
    color: '#f472b6',
  },
  treeValueNull: {
    color: '#888',
  },
  spanRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 90px 70px',
    gap: '10px',
    alignItems: 'center',
    padding: '6px 8px',
    borderRadius: '8px',
    cursor: 'pointer',
  },
  spanRowSelected: {
    background: '#1b1b3a',
    border: '1px solid #2f2f68',
  },
  spanName: {
    fontFamily: 'Monaco, Consolas, monospace',
    fontSize: '12px',
    color: '#e5e7eb',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  spanMeta: {
    fontSize: '12px',
    color: '#999',
    textAlign: 'right' as const,
  },
  barTrack: {
    height: '6px',
    background: '#0a0a0a',
    border: '1px solid #222',
    borderRadius: '999px',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    background: '#6366f1',
  },
  empty: {
    textAlign: 'center' as const,
    padding: '48px',
    color: '#666',
  },
  copyButton: {
    padding: '4px 8px',
    background: '#333',
    border: 'none',
    borderRadius: '4px',
    color: '#888',
    cursor: 'pointer',
    fontSize: '11px',
  },
  toast: {
    position: 'fixed' as const,
    bottom: '24px',
    right: '24px',
    background: '#22c55e',
    color: '#fff',
    padding: '12px 20px',
    borderRadius: '8px',
    fontSize: '14px',
    zIndex: 2000,
    animation: 'fadeIn 0.2s ease',
  },
};

function formatTime(timestamp: number | undefined | null): string {
  if (!timestamp || isNaN(timestamp)) return '-';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '-';
  return date.toLocaleTimeString();
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function truncate(str: string | null | undefined, len: number): string {
  if (!str) return '-';
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}

function getTraceTime(trace: Trace): number {
  return trace.created_at || trace.start_time || Date.now();
}

function getEventTime(event: WideEvent): number {
  return event.created_at || Date.now();
}

type FilterOp = 'in' | 'contains';
type FilterState = Record<string, { op: FilterOp; values: string[] }>;

function normalizeFilterKey(tab: Tab, key: string): string {
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

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
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

function toComparableString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function applyFilters<T extends Trace | WideEvent>(
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

type FieldStats = {
  key: string;
  count: number;
  distinct: number;
  valuesTop: Array<{ value: string; count: number }>;
  highCardinality: boolean;
};

function computeFieldStats(tab: Tab, items: Array<Trace | WideEvent>, extraKeys: string[] = []): FieldStats[] {
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

// Try to parse JSON strings recursively
function smartParseJson(data: unknown): unknown {
  if (typeof data === 'string') {
    // Try to parse if it looks like JSON
    if (
      (data.startsWith('{') && data.endsWith('}')) ||
      (data.startsWith('[') && data.endsWith(']'))
    ) {
      try {
        const parsed = JSON.parse(data);
        return smartParseJson(parsed); // Recursively parse nested JSON strings
      } catch {
        return data; // Return original string if parsing fails
      }
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(smartParseJson);
  }

  if (data !== null && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = smartParseJson(value);
    }
    return result;
  }

  return data;
}

function JsonView({ data, title }: { data: unknown; title: string }) {
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'tree' | 'raw'>('tree');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['$']));

  const parsedData = smartParseJson(data);
  const jsonString = JSON.stringify(parsedData, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const matches = (text: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return false;
    return text.toLowerCase().includes(q);
  };

  const joinPath = (parent: string, segment: string) => `${parent}/${encodeURIComponent(segment)}`;

  const togglePath = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const collapseAll = () => setExpanded(new Set(['$']));

  const expandAll = () => {
    const next = new Set<string>();
    const stack: Array<{ value: unknown; path: string }> = [{ value: parsedData, path: '$' }];
    let seen = 0;

    while (stack.length) {
      const { value, path } = stack.pop()!;
      next.add(path);
      if (seen++ > 5000) break;

      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          value.forEach((v, i) => stack.push({ value: v, path: joinPath(path, String(i)) }));
        } else {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            stack.push({ value: v, path: joinPath(path, k) });
          }
        }
      }
    }

    setExpanded(next);
  };

  const renderValue = (value: unknown) => {
    if (value === null) return <span style={styles.treeValueNull}>null</span>;
    if (typeof value === 'string') return <span style={styles.treeValueString}>"{value}"</span>;
    if (typeof value === 'number') return <span style={styles.treeValueNumber}>{value}</span>;
    if (typeof value === 'boolean') return <span style={styles.treeValueBool}>{String(value)}</span>;
    if (Array.isArray(value)) return <span style={styles.treeType}>Array({value.length})</span>;
    if (value && typeof value === 'object') return <span style={styles.treeType}>Object</span>;
    return <span style={styles.treeValueNull}>-</span>;
  };

  const renderNode = (value: unknown, path: string, depth: number, label?: string): ReactNode[] => {
    const indent = '  '.repeat(depth);
    const isExpandable = !!value && typeof value === 'object';
    const isOpen = expanded.has(path);

    const labelText = label ?? '$';
    const labelHighlight = matches(labelText) ? { background: '#2a2a00', borderRadius: '4px', padding: '0 2px' } : {};

    const rows: ReactNode[] = [];

    rows.push(
      <div key={path} style={styles.treeRow}>
        <span style={{ color: '#666' }}>{indent}</span>
        {isExpandable ? (
          <button style={styles.treeToggle} onClick={() => togglePath(path)} aria-label={isOpen ? 'Collapse' : 'Expand'}>
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span style={{ ...styles.treeToggle, cursor: 'default' }}> </span>
        )}
        <span style={{ ...styles.treeKey, ...labelHighlight }}>{labelText}</span>
        <span style={{ color: '#777' }}>:</span>
        <span style={matches(toComparableString(value)) ? { background: '#2a2a00', borderRadius: '4px', padding: '0 2px' } : {}}>
          {renderValue(value)}
        </span>
      </div>
    );

    if (!isExpandable || !isOpen) return rows;

    if (Array.isArray(value)) {
      value.forEach((child, i) => {
        rows.push(...renderNode(child, joinPath(path, String(i)), depth + 1, `[${i}]`));
      });
      return rows;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    entries.forEach(([k, v]) => {
      rows.push(...renderNode(v, joinPath(path, k), depth + 1, k));
    });
    return rows;
  };

  return (
    <div style={styles.jsonContainer}>
      <div style={styles.jsonHeader}>
        <span style={styles.jsonTitle}>{title}</span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={styles.inspectorTabs}>
            <button
              style={{ ...styles.inspectorTab, ...(mode === 'tree' ? styles.inspectorTabActive : {}) }}
              onClick={() => setMode('tree')}
            >
              Tree
            </button>
            <button
              style={{ ...styles.inspectorTab, ...(mode === 'raw' ? styles.inspectorTabActive : {}) }}
              onClick={() => setMode('raw')}
            >
              Raw
            </button>
          </div>
          {mode === 'tree' && (
            <>
              <input
                style={{ ...styles.copyButton, width: '160px', textAlign: 'left' as const, cursor: 'text' }}
                placeholder="Find…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button style={styles.copyButton} onClick={expandAll} title="Expand all">
                Expand
              </button>
              <button style={styles.copyButton} onClick={collapseAll} title="Collapse all">
                Collapse
              </button>
            </>
          )}
          <button style={styles.copyButton} onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <div style={styles.jsonBody}>
        {mode === 'raw' ? (
          <pre
            style={{
              margin: 0,
              fontFamily: 'Monaco, Consolas, monospace',
              fontSize: '12px',
              lineHeight: 1.6,
              color: '#e0e0e0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {jsonString}
          </pre>
        ) : (
          <div>{renderNode(parsedData, '$', 0)}</div>
        )}
      </div>
    </div>
  );
}

type Selected =
  | { type: 'event'; event: WideEvent }
  | { type: 'trace'; traceId: string; focusSpanId?: string };

function buildAttributePairs(attributes: Record<string, unknown>) {
  const pairs: Array<{ key: string; value: string; group: string }> = [];
  for (const [key, raw] of Object.entries(attributes)) {
    if (!isPrimitive(raw)) continue;
    const value = String(raw);
    if (!value) continue;
    const group = key.includes('.') ? key.split('.')[0] : 'attributes';
    pairs.push({ key, value, group });
  }
  return pairs.sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
}

function EventDetailModal({
  event,
  onClose,
  onOpenTrace,
}: {
  event: WideEvent;
  onClose: () => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const [showAllAttrs, setShowAllAttrs] = useState(false);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied!`);
  };

  const traceId = event.trace_id || '-';
  const attributes = safeJsonParse(event.attributes) as Record<string, unknown>;
  const pairs = buildAttributePairs(attributes);
  const shownPairs = showAllAttrs ? pairs : pairs.slice(0, 28);

  return (
    <div style={styles.modal} onClick={onClose}>
      <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>Wide Event</span>
          <div style={styles.modalActions}>
            {event.trace_id && (
              <button style={styles.copyButton} onClick={() => onOpenTrace(event.trace_id!)}>
                Open Trace
              </button>
            )}
            <button style={styles.copyButton} onClick={() => copyToClipboard(traceId, 'Trace ID')}>
              Copy Trace ID
            </button>
            <button style={styles.copyButton} onClick={() => copyToClipboard(JSON.stringify(event, null, 2), 'Full JSON')}>
              Copy All
            </button>
            <button style={styles.button} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div style={styles.modalBody}>
          <div style={styles.metaGrid}>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Trace ID</div>
              <div style={styles.metaValue}>{traceId}</div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Service</div>
              <div style={styles.metaValue}>{event.service_name}</div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Operation</div>
              <div style={styles.metaValue}>
                {event.operation_type}:{event.field_name}
              </div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Outcome</div>
              <div style={styles.metaValue}>
                <span
                  style={{
                    ...styles.badge,
                    ...(event.outcome === 'error' ? styles.badgeError : styles.badgeSuccess),
                  }}
                >
                  {event.outcome}
                </span>
              </div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Duration</div>
              <div style={styles.metaValue}>{formatDuration(event.duration_ms)}</div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>User ID</div>
              <div style={styles.metaValue}>{event.user_id || '-'}</div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>RPC Calls</div>
              <div style={styles.metaValue}>{event.rpc_call_count}</div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Errors</div>
              <div style={styles.metaValue}>{event.error_count}</div>
            </div>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Time</div>
              <div style={styles.metaValue}>{new Date(getEventTime(event)).toLocaleString()}</div>
            </div>
          </div>

          <div style={{ ...styles.pane, marginBottom: '16px' }}>
            <div style={styles.paneHeader}>
              <span style={styles.paneTitle}>Key Attributes</span>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span style={{ color: '#777', fontSize: '12px' }}>
                  {shownPairs.length}/{pairs.length}
                </span>
                {pairs.length > 28 && (
                  <button style={styles.copyButton} onClick={() => setShowAllAttrs(!showAllAttrs)}>
                    {showAllAttrs ? 'Show less' : 'Show all'}
                  </button>
                )}
              </div>
            </div>
            <div style={styles.paneBody}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {shownPairs.map(({ key, value, group }) => (
                  <div key={key} style={{ background: '#0f0f0f', border: '1px solid #2a2a2a', borderRadius: '10px', padding: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '6px' }}>
                      <span style={{ ...styles.mono, color: '#60a5fa' }}>{key}</span>
                      <span style={{ color: '#666', fontSize: '11px' }}>{group}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline' }}>
                      <span style={{ ...styles.mono, color: '#e5e7eb', wordBreak: 'break-all' as const }}>
                        {truncate(value, 160)}
                      </span>
                      <button style={styles.copyButton} onClick={() => copyToClipboard(value, key)}>
                        Copy
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <JsonView data={attributes} title="Attributes (JSON)" />
        </div>
      </div>

      {toast && <div style={styles.toast}>{toast}</div>}
    </div>
  );
}

function TraceDetailModal({
  traceId,
  dropId,
  focusSpanId,
  onClose,
}: {
  traceId: string;
  dropId: number;
  focusSpanId?: string;
  onClose: () => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spans, setSpans] = useState<Trace[]>([]);
  const [events, setEvents] = useState<WideEvent[]>([]);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(focusSpanId ?? null);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied!`);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedEventId(null);

    fetch(`/api/traces/${encodeURIComponent(traceId)}?dropId=${dropId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load trace');
        return (await res.json()) as { spans: Trace[]; events: WideEvent[] };
      })
      .then((data) => {
        if (cancelled) return;
        setSpans(data.spans ?? []);
        setEvents(data.events ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [traceId, dropId]);

  useEffect(() => {
    if (selectedSpanId) return;
    if (!spans.length) return;
    setSelectedSpanId(focusSpanId ?? spans[0].span_id);
  }, [spans, selectedSpanId, focusSpanId]);

  const spanById = new Map(spans.map((s) => [s.span_id, s]));
  const childrenByParent = new Map<string | null, Trace[]>();
  for (const s of spans) {
    const parent = s.parent_span_id ?? null;
    const arr = childrenByParent.get(parent) ?? [];
    arr.push(s);
    childrenByParent.set(parent, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
  }

  const selectedSpan = selectedSpanId ? spanById.get(selectedSpanId) : undefined;
  const selectedEvent = selectedEventId ? events.find((e) => e.id === selectedEventId) : undefined;

  const traceStart = spans.length ? Math.min(...spans.map((s) => s.start_time || Date.now())) : Date.now();
  const traceEnd = spans.length
    ? Math.max(
        ...spans.map((s) => {
          if (s.end_time) return s.end_time;
          if (s.duration_ms !== null && s.duration_ms !== undefined) return s.start_time + s.duration_ms;
          return s.start_time;
        })
      )
    : traceStart;
  const traceDuration = Math.max(1, traceEnd - traceStart);
  const errorSpans = spans.filter((s) => s.status === 'error').length;
  const services = Array.from(new Set(spans.map((s) => s.service_name).filter(Boolean))).sort();

  const renderSpanTree = (parent: string | null, depth: number): ReactNode[] => {
    const nodes = childrenByParent.get(parent) ?? [];
    const out: ReactNode[] = [];
    for (const s of nodes) {
      const start = s.start_time ?? traceStart;
      const end =
        s.end_time ?? (s.duration_ms !== null && s.duration_ms !== undefined ? start + s.duration_ms : start);
      const leftPct = ((start - traceStart) / traceDuration) * 100;
      const widthPct = (Math.max(1, end - start) / traceDuration) * 100;
      const isSelected = s.span_id === selectedSpanId;

      out.push(
        <div
          key={s.span_id}
          style={{
            ...styles.spanRow,
            ...(isSelected ? styles.spanRowSelected : {}),
            background: isSelected ? (styles.spanRowSelected as any).background : 'transparent',
          }}
          onClick={() => setSelectedSpanId(s.span_id)}
        >
          <div style={{ minWidth: 0 }}>
            <div style={styles.spanName}>
              <span style={{ color: '#666' }}>{'  '.repeat(depth)}</span>
              {s.operation_name}
            </div>
            <div style={{ marginTop: '6px' }}>
              <div style={styles.barTrack}>
                <div style={{ ...styles.barFill, width: `${widthPct}%`, marginLeft: `${leftPct}%`, background: s.status === 'error' ? '#ef4444' : '#6366f1' }} />
              </div>
            </div>
          </div>
          <div style={styles.spanMeta}>{formatDuration(s.duration_ms)}</div>
          <div style={styles.spanMeta}>
            <span
              style={{
                ...styles.badge,
                ...(s.status === 'error' ? styles.badgeError : styles.badgeSuccess),
              }}
            >
              {s.status}
            </span>
          </div>
        </div>
      );

      out.push(...renderSpanTree(s.span_id, depth + 1));
    }
    return out;
  };

  return (
    <div style={styles.modal} onClick={onClose}>
      <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>Trace</span>
          <div style={styles.modalActions}>
            <button style={styles.copyButton} onClick={() => copyToClipboard(traceId, 'Trace ID')}>
              Copy Trace ID
            </button>
            <button style={styles.button} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div style={styles.modalBody}>
          {loading ? (
            <div style={styles.empty}>Loading trace…</div>
          ) : error ? (
            <div style={styles.empty}>{error}</div>
          ) : spans.length === 0 ? (
            <div style={styles.empty}>No spans found for this trace.</div>
          ) : (
            <>
              <div style={styles.metaGrid}>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Trace ID</div>
                  <div style={styles.metaValue}>{traceId}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Spans</div>
                  <div style={styles.metaValue}>{spans.length}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Duration</div>
                  <div style={styles.metaValue}>{formatDuration(traceDuration)}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Errors</div>
                  <div style={styles.metaValue}>{errorSpans}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Services</div>
                  <div style={styles.metaValue}>{services.join(', ') || '-'}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Start</div>
                  <div style={styles.metaValue}>{new Date(traceStart).toLocaleString()}</div>
                </div>
              </div>

              <div style={styles.split}>
                <div style={{ ...styles.pane, flex: 1.2 }}>
                  <div style={styles.paneHeader}>
                    <span style={styles.paneTitle}>Span Tree</span>
                    <span style={{ color: '#777', fontSize: '12px' }}>Click a span to inspect</span>
                  </div>
                  <div style={styles.paneBody}>{renderSpanTree(null, 0)}</div>
                </div>

                <div style={{ ...styles.pane, flex: 1 }}>
                  <div style={styles.paneHeader}>
                    <span style={styles.paneTitle}>Selection</span>
                    {selectedSpan && (
                      <button style={styles.copyButton} onClick={() => copyToClipboard(selectedSpan.span_id, 'Span ID')}>
                        Copy Span ID
                      </button>
                    )}
                  </div>
                  <div style={styles.paneBody}>
                    {selectedSpan ? (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
                          <div style={styles.metaItem}>
                            <div style={styles.metaLabel}>Service</div>
                            <div style={styles.metaValue}>{selectedSpan.service_name}</div>
                          </div>
                          <div style={styles.metaItem}>
                            <div style={styles.metaLabel}>Operation</div>
                            <div style={styles.metaValue}>{selectedSpan.operation_name}</div>
                          </div>
                          <div style={styles.metaItem}>
                            <div style={styles.metaLabel}>Span ID</div>
                            <div style={styles.metaValue}>{selectedSpan.span_id}</div>
                          </div>
                          <div style={styles.metaItem}>
                            <div style={styles.metaLabel}>Parent</div>
                            <div style={styles.metaValue}>{selectedSpan.parent_span_id || '-'}</div>
                          </div>
                          <div style={styles.metaItem}>
                            <div style={styles.metaLabel}>Duration</div>
                            <div style={styles.metaValue}>{formatDuration(selectedSpan.duration_ms)}</div>
                          </div>
                          <div style={styles.metaItem}>
                            <div style={styles.metaLabel}>Status</div>
                            <div style={styles.metaValue}>{selectedSpan.status}</div>
                          </div>
                        </div>

                        <JsonView data={safeJsonParse(selectedSpan.attributes)} title="Span Attributes (JSON)" />
                      </>
                    ) : (
                      <div style={{ color: '#888' }}>Select a span to inspect.</div>
                    )}
                  </div>
                </div>
              </div>

              {events.length > 0 && (
                <div style={{ marginTop: '16px' }}>
                  <div style={{ ...styles.pane, marginBottom: '12px' }}>
                    <div style={styles.paneHeader}>
                      <span style={styles.paneTitle}>Related Wide Events</span>
                      <span style={{ color: '#777', fontSize: '12px' }}>Click an event to view JSON</span>
                    </div>
                    <div style={styles.paneBody}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Time</th>
                            <th style={styles.th}>Service</th>
                            <th style={styles.th}>Operation</th>
                            <th style={styles.th}>Outcome</th>
                            <th style={styles.th}>Duration</th>
                          </tr>
                        </thead>
                        <tbody>
                          {events.map((e) => (
                            <tr key={e.id} style={styles.row} onClick={() => setSelectedEventId(e.id)}>
                              <td style={styles.td}>{formatTime(getEventTime(e))}</td>
                              <td style={styles.td}>{e.service_name}</td>
                              <td style={styles.td}>
                                {e.operation_type}:{e.field_name}
                              </td>
                              <td style={styles.td}>
                                <span
                                  style={{
                                    ...styles.badge,
                                    ...(e.outcome === 'error' ? styles.badgeError : styles.badgeSuccess),
                                  }}
                                >
                                  {e.outcome}
                                </span>
                              </td>
                              <td style={styles.td}>{formatDuration(e.duration_ms)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {selectedEvent && (
                    <JsonView data={safeJsonParse(selectedEvent.attributes)} title="Selected Event Attributes (JSON)" />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {toast && <div style={styles.toast}>{toast}</div>}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('events');
  const [traces, setTraces] = useState<Trace[]>([]);
  const [events, setEvents] = useState<WideEvent[]>([]);
  const [stats, setStats] = useState<Stats>({ traces: 0, wideEvents: 0, errors: 0 });
  const [search, setSearch] = useState('');
  const [drops, setDrops] = useState<Drop[]>([]);
  const [dropId, setDropId] = useState<number | null>(null);
  const dropIdRef = useRef<number | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [eventFilters, setEventFilters] = useState<FilterState>({});
  const [traceFilters, setTraceFilters] = useState<FilterState>({});
  const [showNewDrop, setShowNewDrop] = useState(false);
  const [newDropName, setNewDropName] = useState('');
  const [showRetention, setShowRetention] = useState(false);
  const [retentionTracesDays, setRetentionTracesDays] = useState<string>('3');
  const [retentionEventsDays, setRetentionEventsDays] = useState<string>('7');
  const [selected, setSelected] = useState<Selected | null>(null);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchData = useCallback(async () => {
    if (dropIdRef.current === null) return;
    try {
      const [tracesRes, eventsRes, statsRes] = await Promise.all([
        fetch(`/api/traces?dropId=${dropIdRef.current}`),
        fetch(`/api/events?dropId=${dropIdRef.current}`),
        fetch(`/api/stats?dropId=${dropIdRef.current}`),
      ]);
      setTraces(await tracesRes.json());
      setEvents(await eventsRes.json());
      setStats(await statsRes.json());
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  }, []);

  const fetchDrops = useCallback(async () => {
    try {
      const res = await fetch('/api/drops');
      const json = (await res.json()) as { default_drop_id: number; drops: Drop[] };
      setDrops(json.drops);

      const stored = window.localStorage.getItem('raphael.dropId');
      const storedId = stored && /^\d+$/.test(stored) ? Number.parseInt(stored, 10) : null;
      const desired = storedId ?? json.default_drop_id;
      const exists = json.drops.some((d) => d.id === desired);
      setDropId(exists ? desired : json.default_drop_id);
    } catch (error) {
      console.error('Failed to fetch drops:', error);
      setDropId(1);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    if (!search.trim()) {
      fetchData();
      return;
    }
    try {
      if (dropIdRef.current === null) return;
      if (tab === 'traces') {
        const res = await fetch(
          `/api/search/traces?dropId=${dropIdRef.current}&q=${encodeURIComponent(search)}`
        );
        setTraces(await res.json());
      } else {
        const res = await fetch(
          `/api/search/events?dropId=${dropIdRef.current}&q=${encodeURIComponent(search)}`
        );
        setEvents(await res.json());
      }
    } catch (error) {
      console.error('Search failed:', error);
    }
  }, [search, tab, fetchData]);

  const handleClear = async () => {
    if (!confirm('Clear all traces and events?')) return;
    if (dropIdRef.current === null) return;
    await fetch(`/api/clear?dropId=${dropIdRef.current}`, { method: 'DELETE' });
    fetchData();
  };

  useEffect(() => {
    fetchDrops();
  }, [fetchDrops]);

  const subscribeWs = useCallback((id: number | null) => {
    if (id === null) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', dropId: id }));
    }
  }, []);

  useEffect(() => {
    if (dropId === null) return;
    dropIdRef.current = dropId;
    window.localStorage.setItem('raphael.dropId', String(dropId));

    const current = drops.find((d) => d.id === dropId);
    if (current) {
      setRetentionTracesDays(
        current.traces_retention_ms ? String(Math.round(current.traces_retention_ms / (24 * 60 * 60 * 1000))) : '0'
      );
      setRetentionEventsDays(
        current.events_retention_ms ? String(Math.round(current.events_retention_ms / (24 * 60 * 60 * 1000))) : '0'
      );
    }

    setSelected(null);
    fetchData();
    subscribeWs(dropId);
  }, [dropId, drops, fetchData, subscribeWs]);

  useEffect(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    const connect = () => {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setConnected(true);
        console.log('WebSocket connected');
        subscribeWs(dropIdRef.current);
      };

      ws.onclose = () => {
        setConnected(false);
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connect, 2000);
      };

      ws.onmessage = (event) => {
        if (paused) return;

        const data = JSON.parse(event.data);
        if (data?.drop_id !== undefined && dropIdRef.current !== null && data.drop_id !== dropIdRef.current) return;

        if (data.type === 'traces') {
          setTraces((prev) => {
            const newTraces = data.data.map((t: Trace) => ({
              ...t,
              created_at: t.created_at || t.start_time || Date.now(),
            }));
            return [...newTraces, ...prev].slice(0, 500);
          });
          setStats((prev) => ({ ...prev, traces: prev.traces + data.data.length }));
        } else if (data.type === 'wide_events') {
          setEvents((prev) => {
            const newEvents = data.data.map((e: WideEvent) => ({
              ...e,
              created_at: e.created_at || Date.now(),
            }));
            return [...newEvents, ...prev].slice(0, 500);
          });
          const errorCount = data.data.filter((e: WideEvent) => e.outcome === 'error').length;
          setStats((prev) => ({
            ...prev,
            wideEvents: prev.wideEvents + data.data.length,
            errors: prev.errors + errorCount,
          }));
        }
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [paused, subscribeWs]);

  const activeFilters = tab === 'events' ? eventFilters : traceFilters;
  const setActiveFilters = tab === 'events' ? setEventFilters : setTraceFilters;

  const visibleEvents = applyFilters('events', events, eventFilters, search);
  const visibleTraces = applyFilters('traces', traces, traceFilters, search);

  const statsForTab = computeFieldStats(tab, tab === 'events' ? events : traces, Object.keys(activeFilters));
  const suggestedKeys = statsForTab.slice(0, 8).map((s) => s.key);
  const filterKeys = Array.from(new Set([...suggestedKeys, ...Object.keys(activeFilters)]));
  const statsByKey = new Map(statsForTab.map((s) => [s.key, s]));

  const toggleInValue = (key: string, value: string) => {
    setActiveFilters((prev) => {
      const normalizedKey = normalizeFilterKey(tab, key);
      const current = prev[normalizedKey] ?? { op: 'in' as const, values: [] as string[] };
      const nextValues = current.values.includes(value)
        ? current.values.filter((v) => v !== value)
        : [...current.values, value];
      const next: FilterState = { ...prev, [normalizedKey]: { op: 'in', values: nextValues } };
      if (next[normalizedKey].values.length === 0) {
        delete next[normalizedKey];
      }
      return next;
    });
  };

  const addContainsToken = (key: string, token: string) => {
    const cleaned = token.trim();
    if (!cleaned) return;
    setActiveFilters((prev) => {
      const normalizedKey = normalizeFilterKey(tab, key);
      const current = prev[normalizedKey] ?? { op: 'contains' as const, values: [] as string[] };
      const values = current.values.includes(cleaned) ? current.values : [...current.values, cleaned];
      return { ...prev, [normalizedKey]: { op: 'contains', values } };
    });
  };

  const clearFilterKey = (key: string) => {
    setActiveFilters((prev) => {
      const normalizedKey = normalizeFilterKey(tab, key);
      if (!prev[normalizedKey]) return prev;
      const next: FilterState = { ...prev };
      delete next[normalizedKey];
      return next;
    });
  };

  const clearAllFilters = () => {
    if (tab === 'events') setEventFilters({});
    else setTraceFilters({});
  };

  const handleCreateDrop = async () => {
    const name = newDropName.trim();
    if (!name) return;
    try {
      const res = await fetch('/api/drops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to create drop');
      }
      const created = (await res.json()) as { id: number };
      setNewDropName('');
      setShowNewDrop(false);
      await fetchDrops();
      setDropId(created.id);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const handleSaveRetention = async () => {
    if (dropIdRef.current === null) return;
    const tracesDays = Number(retentionTracesDays);
    const eventsDays = Number(retentionEventsDays);
    if (!Number.isFinite(tracesDays) || tracesDays < 0) return alert('Trace retention must be a non-negative number');
    if (!Number.isFinite(eventsDays) || eventsDays < 0) return alert('Event retention must be a non-negative number');

    try {
      const res = await fetch(`/api/drops/${dropIdRef.current}/retention`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traces_days: tracesDays, events_days: eventsDays }),
      });
      if (!res.ok) throw new Error('Failed to save retention');
      setShowRetention(false);
      await fetchDrops();
      fetchData();
    } catch (error) {
      alert((error as Error).message);
    }
  };

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        tr:hover { background: #1a1a1a; }
        input::placeholder { color: #666; }
        button:hover { opacity: 0.9; }
      `}</style>

      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={styles.logo}>Raphael</div>
          <div style={styles.pill}>
            Drop:
            <span style={{ color: '#fff' }}>
              {drops.find((d) => d.id === dropId)?.name ?? (dropId === null ? 'loading…' : `#${dropId}`)}
            </span>
          </div>
        </div>
        <div style={styles.stats}>
          <div style={styles.stat}>
            <div style={styles.statValue}>{stats.wideEvents}</div>
            <div style={styles.statLabel}>Events</div>
          </div>
          <div style={styles.stat}>
            <div style={styles.statValue}>{stats.traces}</div>
            <div style={styles.statLabel}>Traces</div>
          </div>
          <div style={styles.stat}>
            <div style={{ ...styles.statValue, color: stats.errors > 0 ? '#ef4444' : undefined }}>
              {stats.errors}
            </div>
            <div style={styles.statLabel}>Errors</div>
          </div>
        </div>
      </header>

      <main style={styles.main}>
        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(tab === 'events' ? styles.tabActive : {}) }}
            onClick={() => setTab('events')}
          >
            Wide Events
          </button>
          <button
            style={{ ...styles.tab, ...(tab === 'traces' ? styles.tabActive : {}) }}
            onClick={() => setTab('traces')}
          >
            Traces
          </button>
        </div>

        <div style={styles.toolbar}>
          <select
            style={styles.select}
            value={dropId ?? ''}
            onChange={(e) => setDropId(Number(e.target.value))}
            disabled={drops.length === 0}
            title="Select Drop"
          >
            {drops.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button style={styles.button} onClick={() => setShowNewDrop(true)}>
            New Drop
          </button>
          <button style={styles.button} onClick={() => setShowRetention(true)} disabled={dropId === null}>
            Retention
          </button>
          <input
            type="text"
            placeholder="Search..."
            style={styles.searchInput}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button style={styles.button} onClick={handleSearch}>
            Search
          </button>
          <button style={styles.button} onClick={() => setShowFilters(!showFilters)}>
            {showFilters ? 'Hide Filters' : 'Filters'} ({Object.keys(activeFilters).length})
          </button>
          {Object.keys(activeFilters).length > 0 && (
            <button style={styles.button} onClick={clearAllFilters}>
              Clear Filters
            </button>
          )}
          {Object.entries(activeFilters).map(([key, filter]) => (
            <span key={key} style={styles.chip} title={`${key} ${filter.op} ${filter.values.join(', ')}`}>
              <span style={{ ...styles.mono, color: '#e5e7eb' }}>{key}</span>
              <span style={{ color: '#777' }}>{filter.op === 'contains' ? '∋' : '='}</span>
              <span>{truncate(filter.values.join(', '), 26)}</span>
              <button style={styles.chipButton} onClick={() => clearFilterKey(key)} aria-label={`Remove ${key} filter`}>
                ×
              </button>
            </span>
          ))}
          <button style={styles.button} onClick={() => setPaused(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button style={{ ...styles.button, ...styles.buttonDanger }} onClick={handleClear}>
            Clear
          </button>
          <div style={styles.liveIndicator}>
            {connected && !paused && <div style={styles.liveDot} />}
            {connected ? (paused ? 'Paused' : 'Live') : 'Disconnected'}
          </div>
        </div>

        {showFilters && (
          <div style={styles.filtersPanel}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', marginBottom: '12px' }}>
              <div style={{ color: '#fff', fontWeight: 700 }}>Smart Filters</div>
              <div style={{ color: '#777', fontSize: '12px' }}>
                Suggested fields update as logs stream in (high-cardinality fields use token search).
              </div>
            </div>

            <div style={styles.filtersGrid}>
              {filterKeys.map((key) => {
                const stat = statsByKey.get(key);
                const filter = activeFilters[key];
                const isHigh = stat?.highCardinality ?? true;

                return (
                  <div key={key} style={styles.filterCard}>
                    <div style={styles.filterCardTitle}>
                      <span style={{ ...styles.mono, color: '#e5e7eb' }}>{key}</span>
                      <span style={styles.filterHint}>
                        {stat
                          ? isHigh
                            ? `high-card (${stat.distinct})`
                            : `${stat.distinct} values`
                          : 'custom'}
                      </span>
                    </div>

                    {isHigh ? (
                      <>
                        <input
                          style={styles.filterInput}
                          placeholder="Add token (press Enter)…"
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            const input = e.currentTarget;
                            addContainsToken(key, input.value);
                            input.value = '';
                          }}
                        />
                        <div style={{ ...styles.filterValues, marginTop: '10px' }}>
                          {(filter?.values ?? []).map((v) => (
                            <span key={v} style={{ ...styles.chip, borderColor: '#6366f1' }}>
                              {v}
                              <button
                                style={styles.chipButton}
                                onClick={() => {
                                  setActiveFilters((prev) => {
                                    const cur = prev[key];
                                    if (!cur) return prev;
                                    const nextValues = cur.values.filter((x) => x !== v);
                                    const next: FilterState = { ...prev, [key]: { op: 'contains', values: nextValues } };
                                    if (next[key].values.length === 0) delete next[key];
                                    return next;
                                  });
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                          {stat?.valuesTop?.map(({ value }) => (
                            <button
                              key={value}
                              style={{ ...styles.chip, cursor: 'pointer', background: '#141414' }}
                              onClick={() => addContainsToken(key, value)}
                              title="Add token"
                            >
                              {value}
                            </button>
                          ))}
                          {filter?.values?.length ? (
                            <button style={styles.button} onClick={() => clearFilterKey(key)}>
                              Clear
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <div style={styles.filterValues}>
                        {(stat?.valuesTop ?? []).map(({ value, count }) => {
                          const selected = filter?.op === 'in' && filter.values.includes(value);
                          return (
                            <button
                              key={value}
                              style={{
                                ...styles.chip,
                                cursor: 'pointer',
                                borderColor: selected ? '#6366f1' : '#333',
                                background: selected ? '#1b1b3a' : '#0f0f0f',
                                color: selected ? '#fff' : '#ddd',
                              }}
                              onClick={() => toggleInValue(key, value)}
                              title={`${count} occurrences`}
                            >
                              {value}
                              <span style={{ color: selected ? '#c7d2fe' : '#777' }}>({count})</span>
                            </button>
                          );
                        })}
                        {filter?.values?.length ? (
                          <button style={styles.button} onClick={() => clearFilterKey(key)}>
                            Clear
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={styles.content}>
          {tab === 'events' ? (
            events.length === 0 ? (
              <div style={styles.empty}>No wide events yet. They will appear here in real-time.</div>
            ) : visibleEvents.length === 0 ? (
              <div style={styles.empty}>No matches. Adjust filters or search.</div>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Time</th>
                    <th style={styles.th}>Service</th>
                    <th style={styles.th}>Operation</th>
                    <th style={styles.th}>Outcome</th>
                    <th style={styles.th}>Duration</th>
                    <th style={styles.th}>User</th>
                    <th style={styles.th}>Trace ID</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEvents.map((event) => (
                    <tr
                      key={event.id || `${event.trace_id}-${event.created_at}`}
                      style={styles.row}
                      onClick={() => setSelected({ type: 'event', event })}
                    >
                      <td style={styles.td}>{formatTime(getEventTime(event))}</td>
                      <td style={styles.td}>{event.service_name}</td>
                      <td style={styles.td}>
                        {event.operation_type}:{event.field_name}
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{
                            ...styles.badge,
                            ...(event.outcome === 'error' ? styles.badgeError : styles.badgeSuccess),
                          }}
                        >
                          {event.outcome}
                        </span>
                      </td>
                      <td style={styles.td}>{formatDuration(event.duration_ms)}</td>
                      <td style={styles.td}>{event.user_id || '-'}</td>
                      <td style={{ ...styles.td, ...styles.mono }}>
                        {event.trace_id ? truncate(event.trace_id, 12) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : traces.length === 0 ? (
            <div style={styles.empty}>No traces yet. They will appear here in real-time.</div>
          ) : visibleTraces.length === 0 ? (
            <div style={styles.empty}>No matches. Adjust filters or search.</div>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Time</th>
                  <th style={styles.th}>Service</th>
                  <th style={styles.th}>Operation</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Duration</th>
                  <th style={styles.th}>Trace ID</th>
                </tr>
              </thead>
              <tbody>
                {visibleTraces.map((trace) => (
                  <tr
                    key={trace.id || `${trace.trace_id}-${trace.span_id}`}
                    style={styles.row}
                    onClick={() => setSelected({ type: 'trace', traceId: trace.trace_id, focusSpanId: trace.span_id })}
                  >
                    <td style={styles.td}>{formatTime(getTraceTime(trace))}</td>
                    <td style={styles.td}>{trace.service_name}</td>
                    <td style={styles.td}>{truncate(trace.operation_name, 50)}</td>
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.badge,
                          ...(trace.status === 'error' ? styles.badgeError : styles.badgeSuccess),
                        }}
                      >
                        {trace.status}
                      </span>
                    </td>
                    <td style={styles.td}>{formatDuration(trace.duration_ms)}</td>
                    <td style={{ ...styles.td, ...styles.mono }}>{truncate(trace.trace_id, 12)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {showNewDrop && (
        <div style={styles.modal} onClick={() => setShowNewDrop(false)}>
          <div style={styles.modalSmallContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Create Drop</span>
              <div style={styles.modalActions}>
                <button style={styles.button} onClick={() => setShowNewDrop(false)}>
                  Close
                </button>
              </div>
            </div>
            <div style={styles.modalBody}>
              <div style={{ color: '#888', fontSize: '13px', marginBottom: '10px' }}>
                Drops isolate logs from different environments (e.g., staging vs production).
              </div>
              <input
                style={styles.filterInput}
                placeholder="Drop name (e.g., production)"
                value={newDropName}
                onChange={(e) => setNewDropName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateDrop()}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '12px' }}>
                <button style={styles.button} onClick={() => setShowNewDrop(false)}>
                  Cancel
                </button>
                <button style={styles.button} onClick={handleCreateDrop} disabled={!newDropName.trim()}>
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRetention && (
        <div style={styles.modal} onClick={() => setShowRetention(false)}>
          <div style={styles.modalSmallContent} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Retention Rules</span>
              <div style={styles.modalActions}>
                <button style={styles.button} onClick={() => setShowRetention(false)}>
                  Close
                </button>
              </div>
            </div>
            <div style={styles.modalBody}>
              <div style={{ color: '#888', fontSize: '13px', marginBottom: '16px' }}>
                Auto-truncation prevents unbounded growth. Set days to keep per drop (0 disables).
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Traces (days)</div>
                  <input
                    style={styles.filterInput}
                    inputMode="numeric"
                    value={retentionTracesDays}
                    onChange={(e) => setRetentionTracesDays(e.target.value)}
                  />
                </div>
                <div>
                  <div style={{ ...styles.metaLabel, marginBottom: '6px' }}>Wide Events (days)</div>
                  <input
                    style={styles.filterInput}
                    inputMode="numeric"
                    value={retentionEventsDays}
                    onChange={(e) => setRetentionEventsDays(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <button style={styles.button} onClick={() => setShowRetention(false)}>
                  Cancel
                </button>
                <button style={styles.button} onClick={handleSaveRetention} disabled={dropId === null}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selected?.type === 'event' && (
        <EventDetailModal
          event={selected.event}
          onClose={() => setSelected(null)}
          onOpenTrace={(traceId) => setSelected({ type: 'trace', traceId })}
        />
      )}
      {selected?.type === 'trace' && (
        <TraceDetailModal
          traceId={selected.traceId}
          dropId={dropIdRef.current ?? 1}
          focusSpanId={selected.focusSpanId}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
