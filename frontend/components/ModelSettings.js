// Setup -> Model: the instruction and the sampling values sent with every
// question, per model. Unsaved edits persist (ai.setup.modelSettings.draft).
import React, { useCallback, useEffect, useState } from 'react';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const FIELDS = [
  ['temperature', 'Creativity (temperature)', '0 = always the most likely words, 2 = very free. Empty = the model\'s own default.'],
  ['top_p', 'Word choice (top_p)', '0.01 to 1. Lower keeps to the most likely words. Empty = default.'],
  ['top_k', 'Word choice (top_k)', 'How many candidate words are considered. Empty = default.']
];
const isDraft = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function ModelSettings({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = usePageState('ai.setup.modelSettings.draft', {}, isDraft);
  const [keyword, setKeyword] = usePageState('ai.setup.modelSettings.model', '', v => typeof v === 'string');

  const load = useCallback(() => api.get('/ai/setup/model-settings').then(r => setData(r.data)).catch(e => setError(text(e))), [api]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;
  const model = data.models.find(m => m.keyword === keyword) || data.models[0];
  if (!model) return <div style={S.empty}>No models are configured.</div>;
  const kw = model.keyword;
  const stored = data.settings[kw] || {};
  const value = {
    systemPrompt: stored.systemPrompt !== undefined ? stored.systemPrompt : data.defaultSystemPrompt,
    temperature: stored.temperature ?? '', top_p: stored.top_p ?? '', top_k: stored.top_k ?? '',
    ...(draft[kw] || {})
  };
  const edited = Boolean(draft[kw]);
  const change = (next) => { setSaved(''); setDraft(d => ({ ...d, [kw]: { ...(d[kw] || {}), ...next } })); };
  const discard = () => setDraft((d) => { const n = { ...d }; delete n[kw]; return n; });

  const put = async (body) => {
    try {
      await api.put(`/ai/setup/model-settings/${kw}`, body);
      discard();
      await load();
      setError('');
      setSaved('Saved. Used from the next question on.');
    } catch (err) { setError(text(err)); }
  };
  const save = () => {
    const body = {};
    if (value.systemPrompt !== data.defaultSystemPrompt) body.systemPrompt = value.systemPrompt;
    for (const [key] of FIELDS) if (value[key] !== '') body[key] = Number(value[key]);
    put(body);
  };

  return (
    <div>
      <select style={S.field} aria-label="Model settings for" value={kw} onChange={e => setKeyword(e.target.value)}>
        {data.models.map(m => <option key={m.keyword} value={m.keyword}>{m.label}</option>)}
      </select>
      <div style={{ ...S.small, marginTop: '10px' }}>Instruction given to the model before every conversation:</div>
      <textarea
        style={{ ...S.field, width: '100%', boxSizing: 'border-box' }}
        rows={4}
        aria-label="Instruction"
        disabled={!data.canEdit}
        maxLength={8000}
        value={value.systemPrompt}
        onChange={e => change({ systemPrompt: e.target.value })}
      />
      {FIELDS.map(([key, label, help]) => (
        <div key={key} style={{ marginTop: '8px', fontSize: '13px' }}>
          <label>{label}:{' '}
            <input
              type="number"
              style={{ ...S.field, width: '90px' }}
              disabled={!data.canEdit}
              min={data.ranges[key][0]}
              max={data.ranges[key][1]}
              step={key === 'top_k' ? 1 : 0.05}
              value={value[key]}
              onChange={e => change({ [key]: e.target.value })}
            />
          </label>{' '}
          <span style={S.small}>{help}</span>
        </div>
      ))}
      {error && <div style={S.errorBanner}>{error}</div>}
      {data.canEdit && (
        <div style={{ marginTop: '10px' }}>
          <button type="button" style={S.button(S.BLUE, !edited)} disabled={!edited} onClick={save}>Save</button>
          {edited && <button type="button" style={S.button(S.GREY)} onClick={discard}>Discard changes</button>}
          <button type="button" style={S.button(S.GREY)} onClick={() => put({})}>Reset to default</button>
          {saved && <span style={S.small}>{saved}</span>}
        </div>
      )}
    </div>
  );
}

export default ModelSettings;
