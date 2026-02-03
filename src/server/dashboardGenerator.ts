type Primitive = string | number | boolean | null;

export type FieldKind = 'string' | 'number' | 'boolean' | 'mixed' | 'object';

export type FieldProfile = {
  key: string;
  kind: FieldKind;
  count: number;
  distinct: number;
  topValues: Array<{ value: string; count: number }>;
  min?: number;
  max?: number;
  mean?: number;
  highCardinality: boolean;
};

export type EventSample = {
  id: number;
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

export type DashboardSpecV1 = {
  version: 1;
  name: string;
  sampleSize: number;
  bucketSeconds: number;
  widgets: Array<WidgetSpec>;
};

export type WidgetSpec =
  | {
      id: string;
      type: 'stat';
      title: string;
      metric: 'events' | 'errors' | 'error_rate' | 'unique_traces' | 'unique_users';
      layout?: { w: number; h: number };
    }
  | {
      id: string;
      type: 'bar';
      title: string;
      field: string;
      topN: number;
      layout?: { w: number; h: number };
    }
  | {
      id: string;
      type: 'timeseries';
      title: string;
      metric: 'events' | 'errors' | 'error_rate';
      layout?: { w: number; h: number };
    }
  | {
      id: string;
      type: 'histogram';
      title: string;
      field: string;
      bins: number;
      layout?: { w: number; h: number };
    };

function safeParseAttributes(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function kindOf(values: Array<unknown>): FieldKind {
  const kinds = new Set<FieldKind>();
  for (const v of values) {
    if (v === null) continue;
    if (typeof v === 'string') kinds.add('string');
    else if (typeof v === 'number') kinds.add('number');
    else if (typeof v === 'boolean') kinds.add('boolean');
    else if (typeof v === 'object') kinds.add('object');
    else kinds.add('mixed');
  }
  if (kinds.size === 0) return 'mixed';
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.has('object')) return 'object';
  return 'mixed';
}

export function profileWideEvents(events: EventSample[]) {
  type Entry = {
    values: Map<string, number>;
    rawValues: unknown[];
    count: number;
    numericSum: number;
    numericCount: number;
    min: number | null;
    max: number | null;
  };

  const fieldMap = new Map<string, Entry>();

  const bump = (key: string, value: unknown) => {
    let entry = fieldMap.get(key);
    if (!entry) {
      entry = {
        values: new Map<string, number>(),
        rawValues: [],
        count: 0,
        numericSum: 0,
        numericCount: 0,
        min: null,
        max: null,
      };
      fieldMap.set(key, entry);
    }

    entry.count += 1;
    entry.rawValues.push(value);

    if (!isPrimitive(value)) return;

    const str = value === null ? 'null' : String(value);
    entry.values.set(str, (entry.values.get(str) ?? 0) + 1);

    if (typeof value === 'number' && Number.isFinite(value)) {
      entry.numericSum += value;
      entry.numericCount += 1;
      entry.min = entry.min === null ? value : Math.min(entry.min, value);
      entry.max = entry.max === null ? value : Math.max(entry.max, value);
    }
  };

  for (const e of events) {
    bump('service_name', e.service_name);
    bump('outcome', e.outcome);
    if (e.operation_type) bump('operation_type', e.operation_type);
    if (e.field_name) bump('field_name', e.field_name);
    if (e.user_id) bump('user_id', e.user_id);
    if (e.duration_ms !== null && e.duration_ms !== undefined) bump('duration_ms', e.duration_ms);
    bump('error_count', e.error_count);
    bump('rpc_call_count', e.rpc_call_count);

    const attrs = safeParseAttributes(e.attributes);
    for (const [k, v] of Object.entries(attrs)) {
      if (!isPrimitive(v)) continue;
      bump(k, v);
    }
  }

  const profiles: FieldProfile[] = [];
  for (const [key, entry] of fieldMap.entries()) {
    const distinct = entry.values.size;
    const topValues = [...entry.values.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([value, count]) => ({ value, count }));

    const kind = kindOf(entry.rawValues);
    profiles.push({
      key,
      kind,
      count: entry.count,
      distinct,
      topValues,
      min: entry.min === null ? undefined : entry.min,
      max: entry.max === null ? undefined : entry.max,
      mean: entry.numericCount ? entry.numericSum / entry.numericCount : undefined,
      highCardinality: distinct > 50,
    });
  }

  profiles.sort((a, b) => {
    if (a.highCardinality !== b.highCardinality) return a.highCardinality ? 1 : -1;
    if (a.kind !== b.kind) {
      if (a.kind === 'number') return -1;
      if (b.kind === 'number') return 1;
    }
    return b.count - a.count;
  });

  return profiles;
}

function uuid(prefix = 'w') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 8)}`;
}

export function generateDashboardHeuristic(dropName: string, sampleSize: number, profiles: FieldProfile[]): DashboardSpecV1 {
  const get = (key: string) => profiles.find((p) => p.key === key);
  const service = get('service_name');
  const outcome = get('outcome');
  const opType = get('operation_type');
  const fieldName = get('field_name');
  const duration = get('duration_ms');

  const widgets: WidgetSpec[] = [
    { id: uuid('stat'), type: 'stat', title: 'Events', metric: 'events', layout: { w: 3, h: 1 } },
    { id: uuid('stat'), type: 'stat', title: 'Errors', metric: 'errors', layout: { w: 3, h: 1 } },
    { id: uuid('stat'), type: 'stat', title: 'Error rate', metric: 'error_rate', layout: { w: 3, h: 1 } },
    { id: uuid('stat'), type: 'stat', title: 'Unique users', metric: 'unique_users', layout: { w: 3, h: 1 } },
    { id: uuid('ts'), type: 'timeseries', title: 'Events over time', metric: 'events', layout: { w: 6, h: 2 } },
    { id: uuid('ts'), type: 'timeseries', title: 'Errors over time', metric: 'errors', layout: { w: 6, h: 2 } },
  ];

  if (service && !service.highCardinality) {
    widgets.push({ id: uuid('bar'), type: 'bar', title: 'Top services', field: 'service_name', topN: 8, layout: { w: 6, h: 2 } });
  }
  if (outcome && !outcome.highCardinality) {
    widgets.push({ id: uuid('bar'), type: 'bar', title: 'Outcome breakdown', field: 'outcome', topN: 8, layout: { w: 6, h: 2 } });
  }

  if (opType && fieldName) {
    widgets.push({ id: uuid('bar'), type: 'bar', title: 'Top operations', field: 'operation', topN: 10, layout: { w: 6, h: 3 } });
  } else if (fieldName && !fieldName.highCardinality) {
    widgets.push({ id: uuid('bar'), type: 'bar', title: 'Top field names', field: 'field_name', topN: 10, layout: { w: 6, h: 3 } });
  }

  if (duration && duration.kind === 'number') {
    widgets.push({ id: uuid('hist'), type: 'histogram', title: 'Duration (ms)', field: 'duration_ms', bins: 12, layout: { w: 6, h: 3 } });
  }

  // Add one extra numeric histogram if it looks useful and not too sparse
  const extraNumeric = profiles.find(
    (p) =>
      p.kind === 'number' &&
      !['duration_ms', 'rpc_call_count', 'error_count'].includes(p.key) &&
      p.count > Math.max(50, sampleSize * 0.1) &&
      p.max !== undefined &&
      p.min !== undefined &&
      p.max !== p.min
  );
  if (extraNumeric) {
    widgets.push({
      id: uuid('hist'),
      type: 'histogram',
      title: `${extraNumeric.key} (hist)`,
      field: extraNumeric.key,
      bins: 12,
      layout: { w: 6, h: 3 },
    });
  }

  return {
    version: 1,
    name: `Auto dashboard (${dropName})`,
    sampleSize,
    bucketSeconds: 60,
    widgets,
  };
}

export async function generateDashboardWithOpenRouter(params: {
  apiKey: string;
  model: string;
  dropName: string;
  sampleSize: number;
  profiles: FieldProfile[];
}) {
  const { apiKey, model, dropName, sampleSize, profiles } = params;

  const schemaHint = {
    version: 1,
    name: 'string',
    sampleSize: 'number',
    bucketSeconds: 'number',
    widgets: [
      {
        id: 'string',
        type: 'stat|bar|timeseries|histogram',
      },
    ],
  };

  const prompt = `
You are generating a dashboard spec for a local telemetry viewer.
Inputs are a per-field profile derived from the last ${sampleSize} wide events in the drop "${dropName}".

Return ONLY valid JSON matching this shape: ${JSON.stringify(schemaHint)}

Widget rules:
- Use only these widget types: stat, bar, timeseries, histogram
- bar widgets: {id,type,title,field,topN,layout{w,h}}
- timeseries: {id,type,title,metric,layout{w,h}} where metric is events|errors|error_rate
- stat: {id,type,title,metric,layout{w,h}} where metric is events|errors|error_rate|unique_traces|unique_users
- histogram: {id,type,title,field,bins,layout{w,h}}
- Prefer fields with low/moderate cardinality for bar charts; avoid high-cardinality fields unless showing unique counts.

Field profiles:
${JSON.stringify(profiles.slice(0, 80), null, 2)}
`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'Return only JSON. No markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter error (${res.status}): ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('OpenRouter returned empty content');

  try {
    return JSON.parse(content) as DashboardSpecV1;
  } catch {
    // Sometimes models wrap JSON in text; try extracting first/last braces.
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1)) as DashboardSpecV1;
    }
    throw new Error('OpenRouter returned non-JSON output');
  }
}
