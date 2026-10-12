import { useState } from 'react';
import { normalizeFilterKey, type FilterSetter, type FilterState } from './filters';
import type { Tab } from './types';
import { styles } from './styles';

export function FilterBar({ tab, filters, setFilters, fields }: { tab: Tab; filters: FilterState; setFilters: FilterSetter; fields: string[] }) {
  const [field, setField] = useState('service_name');
  const [op, setOp] = useState<'in' | 'contains'>('in');
  const [value, setValue] = useState('');
  return <form style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }} onSubmit={event => {
    event.preventDefault();
    if (!field.trim() || !value.trim()) return;
    const key = normalizeFilterKey(tab, field.trim());
    setFilters(previous => {
      const existing = previous[key];
      return { ...previous, [key]: { op, values: [...new Set([...(existing?.op === op ? existing.values : []), value.trim()])] } };
    });
    setValue('');
  }}>
    <label>Field<input aria-label="Filter field" list="filter-fields" style={{ ...styles.filterInput, display: 'block', marginTop: 6 }} value={field} onChange={e => setField(e.target.value)} required pattern="[a-zA-Z0-9_.-]{1,120}" /></label>
    <datalist id="filter-fields">{fields.map(key => <option key={key} value={key} />)}</datalist>
    <label>Match<select aria-label="Filter match" style={{ ...styles.select, display: 'block', marginTop: 6 }} value={op} onChange={e => setOp(e.target.value as 'in' | 'contains')}><option value="in">is exactly</option><option value="contains">contains</option></select></label>
    <label>Value<input aria-label="Filter value" style={{ ...styles.filterInput, display: 'block', marginTop: 6 }} value={value} onChange={e => setValue(e.target.value)} required maxLength={500} /></label>
    <button style={styles.button} type="submit">Add filter</button>
    {Object.keys(filters).length > 0 && <button style={styles.button} type="button" onClick={() => setFilters({})}>Reset filters</button>}
  </form>;
}
