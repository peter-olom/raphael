import { useState, useEffect, useRef, useCallback } from 'react';

interface Trace {
  id: number;
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

// JSON Syntax Highlighter
function JsonView({ data, title }: { data: unknown; title: string }) {
  const [copied, setCopied] = useState(false);

  // Smart parse any JSON strings in the data
  const parsedData = smartParseJson(data);
  const jsonString = JSON.stringify(parsedData, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const highlightJson = (json: string) => {
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let color = '#a78bfa'; // purple - numbers
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            color = '#60a5fa'; // blue - keys
            match = match.replace(/"/g, '');
            match = match.replace(/:$/, '');
            return `<span style="color: ${color}">"${match}"</span>:`;
          } else {
            color = '#4ade80'; // green - strings
          }
        } else if (/true|false/.test(match)) {
          color = '#f472b6'; // pink - booleans
        } else if (/null/.test(match)) {
          color = '#888'; // gray - null
        }
        return `<span style="color: ${color}">${match}</span>`;
      }
    );
  };

  return (
    <div style={styles.jsonContainer}>
      <div style={styles.jsonHeader}>
        <span style={styles.jsonTitle}>{title}</span>
        <button style={styles.copyButton} onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <div style={styles.jsonBody}>
        <pre
          style={{
            margin: 0,
            fontFamily: 'Monaco, Consolas, monospace',
            fontSize: '12px',
            lineHeight: 1.6,
            color: '#e0e0e0',
          }}
          dangerouslySetInnerHTML={{ __html: highlightJson(jsonString) }}
        />
      </div>
    </div>
  );
}

// Detail Modal Component
function DetailModal({
  item,
  type,
  onClose,
}: {
  item: Trace | WideEvent;
  type: 'trace' | 'event';
  onClose: () => void;
}) {
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    showToast(`${label} copied!`);
  };

  const isTrace = type === 'trace';
  const trace = isTrace ? (item as Trace) : null;
  const event = !isTrace ? (item as WideEvent) : null;

  const traceId = trace?.trace_id || event?.trace_id || '-';
  const attributes = JSON.parse(item.attributes || '{}');

  return (
    <div style={styles.modal} onClick={onClose}>
      <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>
            {isTrace ? 'Trace Details' : 'Wide Event Details'}
          </span>
          <div style={styles.modalActions}>
            <button
              style={styles.copyButton}
              onClick={() => copyToClipboard(traceId, 'Trace ID')}
            >
              Copy Trace ID
            </button>
            <button
              style={styles.copyButton}
              onClick={() =>
                copyToClipboard(JSON.stringify(item, null, 2), 'Full JSON')
              }
            >
              Copy All
            </button>
            <button style={styles.button} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div style={styles.modalBody}>
          {/* Meta Information Grid */}
          <div style={styles.metaGrid}>
            <div style={styles.metaItem}>
              <div style={styles.metaLabel}>Trace ID</div>
              <div style={styles.metaValue}>{traceId}</div>
            </div>
            {isTrace && trace && (
              <>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Span ID</div>
                  <div style={styles.metaValue}>{trace.span_id}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Service</div>
                  <div style={styles.metaValue}>{trace.service_name}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Operation</div>
                  <div style={styles.metaValue}>{trace.operation_name}</div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Duration</div>
                  <div style={styles.metaValue}>
                    {formatDuration(trace.duration_ms)}
                  </div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Status</div>
                  <div style={styles.metaValue}>
                    <span
                      style={{
                        ...styles.badge,
                        ...(trace.status === 'error'
                          ? styles.badgeError
                          : styles.badgeSuccess),
                      }}
                    >
                      {trace.status}
                    </span>
                  </div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Time</div>
                  <div style={styles.metaValue}>
                    {new Date(getTraceTime(trace)).toLocaleString()}
                  </div>
                </div>
              </>
            )}
            {!isTrace && event && (
              <>
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
                        ...(event.outcome === 'error'
                          ? styles.badgeError
                          : styles.badgeSuccess),
                      }}
                    >
                      {event.outcome}
                    </span>
                  </div>
                </div>
                <div style={styles.metaItem}>
                  <div style={styles.metaLabel}>Duration</div>
                  <div style={styles.metaValue}>
                    {formatDuration(event.duration_ms)}
                  </div>
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
                  <div style={styles.metaValue}>
                    {new Date(getEventTime(event)).toLocaleString()}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Attributes JSON */}
          <JsonView data={attributes} title="Attributes" />
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
  const [selected, setSelected] = useState<{ item: Trace | WideEvent; type: 'trace' | 'event' } | null>(null);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [tracesRes, eventsRes, statsRes] = await Promise.all([
        fetch('/api/traces'),
        fetch('/api/events'),
        fetch('/api/stats'),
      ]);
      setTraces(await tracesRes.json());
      setEvents(await eventsRes.json());
      setStats(await statsRes.json());
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  }, []);

  const handleSearch = useCallback(async () => {
    if (!search.trim()) {
      fetchData();
      return;
    }
    try {
      if (tab === 'traces') {
        const res = await fetch(`/api/search/traces?q=${encodeURIComponent(search)}`);
        setTraces(await res.json());
      } else {
        const res = await fetch(`/api/search/events?q=${encodeURIComponent(search)}`);
        setEvents(await res.json());
      }
    } catch (error) {
      console.error('Search failed:', error);
    }
  }, [search, tab, fetchData]);

  const handleClear = async () => {
    if (!confirm('Clear all traces and events?')) return;
    await fetch('/api/clear', { method: 'DELETE' });
    fetchData();
  };

  useEffect(() => {
    fetchData();

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    const connect = () => {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setConnected(true);
        console.log('WebSocket connected');
      };

      ws.onclose = () => {
        setConnected(false);
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connect, 2000);
      };

      ws.onmessage = (event) => {
        if (paused) return;

        const data = JSON.parse(event.data);

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
  }, [fetchData, paused]);

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
        <div style={styles.logo}>Raphael</div>
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

        <div style={styles.content}>
          {tab === 'events' ? (
            events.length === 0 ? (
              <div style={styles.empty}>No wide events yet. They will appear here in real-time.</div>
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
                  {events.map((event) => (
                    <tr
                      key={event.id || `${event.trace_id}-${event.created_at}`}
                      style={styles.row}
                      onClick={() => setSelected({ item: event, type: 'event' })}
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
                {traces.map((trace) => (
                  <tr
                    key={trace.id || `${trace.trace_id}-${trace.span_id}`}
                    style={styles.row}
                    onClick={() => setSelected({ item: trace, type: 'trace' })}
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

      {selected && (
        <DetailModal
          item={selected.item}
          type={selected.type}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
