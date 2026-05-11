import type { Trace, WideEvent } from './types';
import { styles } from './styles';
import { formatDuration, formatTime, getEventTime, getTraceTime, truncate } from './utils';

export function EventsTable({
  allEvents,
  visibleEvents,
  onSelect,
}: {
  allEvents: WideEvent[];
  visibleEvents: WideEvent[];
  onSelect: (event: WideEvent) => void;
}) {
  if (allEvents.length === 0) {
    return <div style={styles.empty}>No wide events yet. They will appear here in real-time.</div>;
  }
  if (visibleEvents.length === 0) {
    return <div style={styles.empty}>No matches. Adjust filters or search.</div>;
  }

  return (
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
            onClick={() => onSelect(event)}
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
            <td style={{ ...styles.td, ...styles.mono }}>{event.trace_id ? truncate(event.trace_id, 12) : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TracesTable({
  allTraces,
  visibleTraces,
  onSelect,
}: {
  allTraces: Trace[];
  visibleTraces: Trace[];
  onSelect: (trace: Trace) => void;
}) {
  if (allTraces.length === 0) {
    return <div style={styles.empty}>No traces yet. They will appear here in real-time.</div>;
  }
  if (visibleTraces.length === 0) {
    return <div style={styles.empty}>No matches. Adjust filters or search.</div>;
  }

  return (
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
            onClick={() => onSelect(trace)}
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
  );
}
