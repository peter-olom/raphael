export interface Trace {
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

export interface WideEvent {
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

export interface Stats {
  traces: number;
  wideEvents: number;
  errors: number;
}

export interface Drop {
  id: number;
  name: string;
  label: string | null;
  created_at: number;
  traces_retention_ms: number | null;
  events_retention_ms: number | null;
}

export type Tab = 'events' | 'traces' | 'dashboards' | 'settings';

