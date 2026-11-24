// Setup -> Usage: how much the AI is used. Figures only: no names and no text.
// Range and sorting persist (ai.setup.usage.view).
import React, { useEffect, useState } from 'react';
import * as S from './styles';

const RANGES = [[1, 'Today and yesterday'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year']];
const COLUMNS = [
  ['day', 'Day'], ['model', 'Model'], ['answers', 'Answers'], ['people', 'People'], ['prompt_tokens', 'Tokens read'],
  ['completion_tokens', 'Tokens written'], ['avg_first_ms', 'First word after'], ['avg_ms', 'Average answer'],
  ['max_queue_ms', 'Longest wait'], ['stopped', 'Stopped'], ['errors', 'Errors']
];
const validView = v => Boolean(v) && RANGES.some(r => r[0] === v.days) && COLUMNS.some(c => c[0] === v.sort) && ['asc', 'desc'].includes(v.dir);
const int = n => Math.round(n || 0).toLocaleString();
const sec = ms => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`);
const size = b => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`);

function UsagePanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [view, setView] = usePageState('ai.setup.usage.view', { days: 7, sort: 'day', dir: 'desc' }, validView);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.get('/ai/setup/usage', { params: { days: view.days } })
      .then((r) => { if (alive) { setData(r.data); setError(''); } })
      .catch(e => alive && setError(e.response?.data?.error || 'The figures could not be loaded.'));
    return () => { alive = false; };
  }, [api, view.days]);

  const sortBy = key => setView(v => ({ ...v, sort: key, dir: v.sort === key && v.dir === 'desc' ? 'asc' : 'desc' }));
  const total = key => data.rows.reduce((n, r) => n + (r[key] || 0), 0);
  const rows = data ? [...data.rows].sort((a, b) => {
    const x = a[view.sort];
    const y = b[view.sort];
    const c = typeof x === 'string' ? x.localeCompare(String(y)) : (x || 0) - (y || 0);
    return view.dir === 'asc' ? c : -c;
  }) : [];
  const cell = (r, key) => (key.endsWith('_ms') ? sec(r[key]) : typeof r[key] === 'number' ? int(r[key]) : r[key]);

  return (
    <div>
      <select style={S.field} aria-label="Period" value={view.days} onChange={e => setView(v => ({ ...v, days: Number(e.target.value) }))}>
        {RANGES.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
      </select>
      {error && <div style={S.errorBanner}>{error}</div>}
      {!data && !error && <div style={S.loading}>Loading...</div>}
      {data && (
        <>
          <p style={S.paragraph}>
            {int(total('answers'))} answers for {int(data.people)} people, {int(total('completion_tokens'))} tokens written.
            {' '}Right now: {data.now.running} running, {data.now.waiting} waiting.
            {' '}Chats and uploads use {size(data.storage.bytes)} for {int(data.storage.people)} people
            {data.storage.checkedAt ? ` (checked ${new Date(data.storage.checkedAt).toLocaleString()})` : ' (not checked yet)'}.
          </p>
          {data.server && (
            <p style={S.paragraph}>
              Since the model started ({new Date(data.server.since).toLocaleString()}), the AI server has written {int(data.server.written)} tokens,
              of which {int(data.server.mffWritten)} through MFF chats. The difference ({int(Math.max(0, data.server.written - data.server.mffWritten))}) is
              benchmarks, other MFF installations, and people who use the server directly.
            </p>
          )}
          {rows.length ? (
            <div style={S.tableWrapper}>
              <table style={S.table}>
                <thead style={S.thead}>
                  <tr>
                    {COLUMNS.map(([key, label]) => (
                      <th key={key} style={{ ...S.th, cursor: 'pointer' }} onClick={() => sortBy(key)}>
                        {label}{view.sort === key ? (view.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={`${r.day}-${r.keyword}`}>{COLUMNS.map(([key]) => <td key={key} style={S.td}>{cell(r, key)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div style={S.empty}>Nothing in this period.</div>}
        </>
      )}
    </div>
  );
}

export default UsagePanel;
