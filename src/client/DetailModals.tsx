import { useEffect, useState, type ReactNode } from 'react';
import type { Trace, WideEvent } from './types';
import { styles } from './styles';
import { JsonView } from './JsonView';
import { fetchJson, formatDuration, formatTime, getEventTime, safeJsonParse, isPrimitive, truncate } from './utils';

export type Selected =
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

export function EventDetailModal({
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

export function TraceDetailModal({
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

    fetchJson<{ spans: Trace[]; events: WideEvent[] }>(`/api/traces/${encodeURIComponent(traceId)}?dropId=${dropId}`)
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

