import { useState, type ReactNode } from 'react';
import { styles } from './styles';
import { toComparableString } from './utils';

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

export function JsonView({ data, title }: { data: unknown; title: string }) {
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

