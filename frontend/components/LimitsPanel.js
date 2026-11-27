// Setup -> Limits: every quota and limit, with its default. Unsaved edits
// persist (ai.setup.limits.draft).
import React, { useCallback, useEffect, useState } from 'react';
import SortedTable from './SortedTable';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const isDraft = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function LimitsPanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [draft, setDraft, resetDraft] = usePageState('ai.setup.limits.draft', {}, isDraft); // key -> text, or null = default
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => api.get('/ai/setup/limits').then(r => setData(r.data)).catch(e => setError(text(e))), [api]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;

  const shown = key => (key in draft ? (draft[key] === null ? data.defaults[key] : draft[key]) : data.values[key]);
  const invalid = (s) => {
    const v = Number(shown(s.key));
    return !Number.isInteger(v) || v < s.min || v > s.max || shown(s.key) === '';
  };
  const bad = data.specs.filter(invalid);
  const edited = data.specs.some(s => s.key in draft);
  const set = (key, value) => { setSaved(false); setDraft(d => ({ ...d, [key]: value })); };

  const save = async () => {
    const body = {};
    for (const s of data.specs) if (s.key in draft) body[s.key] = draft[s.key] === null ? null : Number(draft[s.key]);
    try {
      await api.put('/ai/setup/limits', body);
      resetDraft();
      await load();
      setError('');
      setSaved(true);
    } catch (err) { setError(text(err)); }
  };

  return (
    <div>
      <p style={S.paragraph}>
        Changes apply within a few seconds, without a restart. Answers already running keep the limits they started with.
        {!data.canEdit && ' Only administrators and developers can change them.'}
      </p>
      <SortedTable
        coreApi={coreApi}
        rows={data.specs}
        rememberAs="ai.setup.limits.table"
        columns={{
          label: s => s.label,
          value: { value: s => data.values[s.key], type: 'number' }, // the saved value: rows do not move while typing
          allowed: { value: s => s.min, type: 'number' },
          default: { value: s => data.defaults[s.key], type: 'number' }
        }}
        head={[{ key: 'label', label: 'Limit' }, { key: 'value', label: 'Value' }, { key: 'allowed', label: 'Allowed' }, { key: 'default', label: 'Default' }, { key: 'actions', label: '' }]}
        rowKey={s => s.key}
        renderRow={s => (
              <tr>
                <td style={S.td}>{s.label}{s.help && <div style={S.small}>{s.help}</div>}</td>
                <td style={S.td}>
                  <input
                    type="number"
                    aria-label={s.label}
                    style={{ ...S.field, width: '100px', borderColor: invalid(s) ? S.RED : '#ccc', backgroundColor: s.key in draft ? '#fff3cd' : 'white' }}
                    disabled={!data.canEdit}
                    min={s.min}
                    max={s.max}
                    value={shown(s.key)}
                    onChange={e => set(s.key, e.target.value)}
                  /> {s.unit}
                </td>
                <td style={{ ...S.td, color: '#666' }}>{s.min.toLocaleString()} to {s.max.toLocaleString()}</td>
                <td style={{ ...S.td, color: '#666' }}>{data.defaults[s.key].toLocaleString()}</td>
                <td style={S.td}>
                  {data.canEdit && Number(shown(s.key)) !== data.defaults[s.key] && (
                    <button type="button" style={S.button(S.GREY)} onClick={() => set(s.key, null)}>Reset to default</button>
                  )}
                </td>
              </tr>
        )}
      />
      {error && <div style={S.errorBanner}>{error}</div>}
      {data.canEdit && (
        <div style={{ marginTop: '12px' }}>
          <button type="button" style={S.button(S.BLUE, !edited || bad.length > 0)} disabled={!edited || bad.length > 0} onClick={save}>Save</button>
          {edited && <button type="button" style={S.button(S.GREY)} onClick={() => resetDraft()}>Discard changes</button>}
          {bad.length > 0 && <span style={{ ...S.small, color: S.RED }}>Check: {bad.map(s => s.label).join(', ')}</span>}
          {saved && <span style={S.small}>Saved.</span>}
        </div>
      )}
    </div>
  );
}

export default LimitsPanel;
