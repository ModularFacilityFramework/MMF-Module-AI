// Setup -> Benchmark: the same questions asked to several models, with speed,
// automatic checks and 1-5 scores. View and unsaved edits persist
// (ai.setup.benchmark.view, ai.setup.benchmark.draft).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const STATUS = { done: S.GREEN, failed: S.RED, cancelled: S.GREY, interrupted: 'warning', running: 'warning' };
const KIND = { text: 'Text', image: 'With the test image (models that see images only)', long: 'After a long list (tests long input)' };
const VIEW = { runId: null, models: null, think: false, showAnswers: false, blind: true, promptsOpen: false };
const validView = v => Boolean(v) && (v.runId === null || Number.isInteger(v.runId)) && (v.models === null || Array.isArray(v.models))
  && ['think', 'showAnswers', 'blind', 'promptsOpen'].every(k => typeof v[k] === 'boolean');
const validDraft = v => v === null || (Boolean(v) && typeof v.title === 'string' && typeof v.prompt === 'string');
const sec = ms => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(2)} s`);
const avg = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

// The order of the models is mixed differently per question, but always the
// same for one question, so a blind score stays where it was.
const mix = (list, seed) => [...list].sort((a, b) => ((a.id * 7919 + seed * 104729) % 1009) - ((b.id * 7919 + seed * 104729) % 1009));

function Bars({ rows, unit }) {
  const max = Math.max(...rows.map(r => r.value || 0), 1);
  return rows.map(r => (
    <div key={r.label} style={{ display: 'flex', alignItems: 'center', fontSize: '12px', marginBottom: '4px' }}>
      <span style={{ width: '200px' }}>{r.label}</span>
      <span style={{ flex: 1, backgroundColor: '#f8f9fa' }}>
        <span style={{ display: 'block', height: '14px', width: `${(100 * (r.value || 0)) / max}%`, backgroundColor: S.BLUE, borderRadius: '2px' }} />
      </span>
      <span style={{ width: '110px', textAlign: 'right' }}>{r.value === null ? '-' : `${r.value.toFixed(1)} ${unit}`}</span>
    </div>
  ));
}

function csvOf(run) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = /^[=+\-@\t]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s; // no formulas when opened in Excel
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ['model', 'question', 'status', 'correct', 'score', 'first_word_ms', 'total_ms', 'tokens_read', 'tokens_written', 'tokens_per_second', 'answer'];
  const label = kw => (run.models.find(m => m.keyword === kw) || { label: kw }).label;
  return [head, ...run.results.map(r => [label(r.keyword), r.title, r.status, r.pass === null ? '' : r.pass, r.score, r.firstMs, r.totalMs, r.promptTokens, r.tokens, r.perSecond === null ? '' : r.perSecond.toFixed(1), r.answer])]
    .map(row => row.map(cell).join(',')).join('\r\n');
}

function Results({ api, run, runId, view, set, canScore, reload }) {
  const [error, setError] = useState('');
  const perModel = run.models.map((m) => {
    const rs = run.results.filter(r => r.keyword === m.keyword);
    const checked = rs.filter(r => r.pass !== null);
    return {
      ...m, answered: rs.filter(r => ['done', 'length'].includes(r.status)).length,
      passed: checked.filter(r => r.pass).length, checked: checked.length,
      score: avg(rs.filter(r => r.score).map(r => r.score)),
      speed: avg(rs.filter(r => r.perSecond !== null).map(r => r.perSecond)),
      first: avg(rs.filter(r => r.firstMs !== null && r.kind !== 'long').map(r => r.firstMs))
    };
  });
  const questions = [...new Map(run.results.map(r => [r.promptId, r])).values()];
  const label = kw => (run.models.find(m => m.keyword === kw) || { label: kw }).label;
  const unscored = run.results.some(r => r.status !== 'skipped' && r.pass === null && !r.score && r.answer);
  const hide = view.blind && unscored && canScore;

  const score = async (r, value) => {
    try { await api.put(`/ai/setup/benchmark/results/${r.id}/score`, { score: r.score === value ? null : value }); setError(''); } catch (err) { setError(text(err)); }
    reload();
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob(['﻿', csvOf(run)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-benchmark-${runId}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <div data-testid="results">
      <div style={S.tableWrapper}>
        <table style={S.table}>
          <thead style={S.thead}>
            <tr>{['Model', 'Correct', 'Average score', 'Speed', 'First word after', 'Loading time', 'GPU memory', 'Long chats at once'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {perModel.map(m => (
              <tr key={m.keyword}>
                <td style={S.td}>{m.label}</td>
                <td style={S.td}>{m.passed} of {m.checked}</td>
                <td style={S.td}>{hide ? 'hidden until scored' : m.score === null ? '-' : m.score.toFixed(1)}</td>
                <td style={S.td}>{m.speed === null ? '-' : `${m.speed.toFixed(1)} tokens/s`}</td>
                <td style={S.td}>{sec(m.first)}</td>
                <td style={S.td}>{m.loadSeconds === null ? 'was loaded' : `${m.loadSeconds} s`}</td>
                <td style={S.td}>{m.gpuMemoryMiB ? `${(m.gpuMemoryMiB / 1024).toFixed(1)} GiB` : '-'}</td>
                <td style={S.td}>{m.maxConcurrency ? m.maxConcurrency.toFixed(1) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={S.heading}>Speed (higher is better)</div>
      <Bars rows={perModel.map(m => ({ label: m.label, value: m.speed }))} unit="tokens/s" />
      <div style={{ margin: '12px 0', fontSize: '13px' }}>
        <label style={{ marginRight: '16px' }}><input type="checkbox" checked={view.showAnswers} onChange={e => set({ showAnswers: e.target.checked })} /> Show the answers</label>
        {canScore && <label style={{ marginRight: '16px' }}><input type="checkbox" checked={view.blind} onChange={e => set({ blind: e.target.checked })} /> Hide model names until all answers are scored</label>}
        <button type="button" style={S.button('#17a2b8')} onClick={download}>Download CSV</button>
      </div>
      {error && <div style={S.errorBanner}>{error}</div>}
      {view.showAnswers && questions.map(q => (
        <div key={q.promptId} style={{ border: '1px solid #dee2e6', borderRadius: '4px', padding: '12px', marginBottom: '10px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px' }}>{q.title}</div>
          <div style={{ ...S.small, whiteSpace: 'pre-wrap', maxHeight: '90px', overflow: 'auto' }}>{q.prompt}</div>
          {mix(run.results.filter(r => r.promptId === q.promptId), q.promptId).map((r, i) => {
            const masked = hide && r.pass === null;
            return (
              <div key={r.id} style={{ borderTop: '1px solid #eee', marginTop: '8px', paddingTop: '8px' }}>
                <div style={{ fontSize: '12px' }}>
                  <strong>{masked ? `Answer ${'ABCDEFGH'[i]}` : label(r.keyword)}</strong>{' '}
                  {r.pass !== null && <span style={S.chip(r.pass ? S.GREEN : S.RED)}>{r.pass ? 'correct' : 'wrong'}</span>}
                  {r.status !== 'done' && <span style={S.chip('warning')}>{r.status === 'length' ? 'cut off' : r.status}</span>}
                  {!masked && r.totalMs !== null && <span style={S.small}> {sec(r.totalMs)}, {r.tokens} tokens</span>}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: '13px', maxHeight: '240px', overflow: 'auto', margin: '4px 0' }}>{r.answer || '(no answer)'}</div>
                {canScore && r.pass === null && r.answer && (
                  <div style={S.small}>
                    Score:{' '}
                    {[1, 2, 3, 4, 5].map(n => (
                      <button key={n} type="button" aria-label={`Score ${n}`} style={S.button(r.score === n ? S.BLUE : '#adb5bd')} onClick={() => score(r, n)}>{n}</button>
                    ))}
                    1 = poor, 5 = excellent
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Prompts({ api, data, reload, usePageState }) {
  const [draft, setDraft, resetDraft] = usePageState('ai.setup.benchmark.draft', null, validDraft);
  const [error, setError] = useState('');
  const act = async (fn) => {
    try { await fn(); setError(''); return true; } catch (err) { setError(text(err)); return false; } finally { reload(); }
  };
  const save = async () => {
    const ok = await act(() => (draft.id ? api.put(`/ai/setup/benchmark/prompts/${draft.id}`, draft) : api.post('/ai/setup/benchmark/prompts', draft)));
    if (ok) resetDraft();
  };
  return (
    <div>
      {data.prompts.map(p => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'center', fontSize: '13px', borderBottom: '1px solid #eee', padding: '6px 0' }}>
          <input type="checkbox" aria-label={`Use ${p.title}`} disabled={!data.canEdit} checked={p.enabled} onChange={e => act(() => api.put(`/ai/setup/benchmark/prompts/${p.id}`, { ...p, enabled: e.target.checked }))} />
          <span style={{ flex: 1, margin: '0 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><strong>{p.title}</strong> <span style={S.small}>{p.prompt}</span></span>
          <span style={{ ...S.small, marginRight: '8px' }}>{p.check ? 'checked automatically' : 'scored by hand'}</span>
          {data.canEdit && <button type="button" style={S.button(S.GREY)} onClick={() => setDraft({ ...p, check: p.check || '' })}>Edit</button>}
          {data.canEdit && <button type="button" style={S.button(S.RED)} onClick={() => act(() => api.delete(`/ai/setup/benchmark/prompts/${p.id}`))}>Remove</button>}
        </div>
      ))}
      {data.canEdit && !draft && (
        <button type="button" style={{ ...S.button(S.GREEN), marginTop: '10px' }} onClick={() => setDraft({ title: '', kind: 'text', prompt: '', check: '', enabled: true })}>Add a question</button>
      )}
      {error && <div style={S.errorBanner}>{error}</div>}
      {data.canEdit && draft && (
        <div style={{ border: '1px solid #dee2e6', borderRadius: '4px', padding: '12px', marginTop: '10px' }}>
          <input style={{ ...S.field, width: '260px' }} placeholder="Title" aria-label="Title" maxLength={100} value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />{' '}
          <select style={S.field} aria-label="Kind" value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}>
            {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <textarea style={{ ...S.field, width: '100%', boxSizing: 'border-box', marginTop: '8px' }} rows={4} placeholder="Question" aria-label="Question" maxLength={20000} value={draft.prompt} onChange={e => setDraft(d => ({ ...d, prompt: e.target.value }))} />
          <input style={{ ...S.field, width: '100%', boxSizing: 'border-box', marginTop: '8px' }} placeholder="Expected answer (a text or pattern that must occur; empty = scored by hand)" aria-label="Expected answer" maxLength={500} value={draft.check} onChange={e => setDraft(d => ({ ...d, check: e.target.value }))} />
          <div style={{ marginTop: '8px' }}>
            <button type="button" style={S.button(S.BLUE)} onClick={save}>Save</button>
            <button type="button" style={S.button(S.GREY)} onClick={() => resetDraft()}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function BenchmarkPanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [view, setView] = usePageState('ai.setup.benchmark.view', VIEW, validView);
  const [data, setData] = useState(null);
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const set = change => setView(v => ({ ...v, ...change }));

  const load = useCallback(() => api.get('/ai/setup/benchmark').then((r) => { setData(r.data); return r.data; }).catch(e => setError(text(e))), [api]);
  const active = data && data.active;
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, active ? 3000 : 20000);
    return () => clearInterval(timer);
  }, [load, Boolean(active)]); // eslint-disable-line react-hooks/exhaustive-deps

  // A remembered run that no longer exists falls back to the newest.
  const runId = useMemo(() => {
    if (!data || !data.runs.length) return null;
    return data.runs.some(r => r.id === view.runId) ? view.runId : data.runs[0].id;
  }, [data, view.runId]);
  const doneCount = active ? active.done : -1;
  const loadRun = useCallback(() => {
    if (!runId) return;
    api.get(`/ai/setup/benchmark/runs/${runId}`).then(r => setRun({ id: runId, ...r.data })).catch(() => setRun({ id: runId, empty: true }));
  }, [api, runId]);
  useEffect(() => { loadRun(); }, [loadRun, doneCount]);

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;
  const chosen = (view.models || data.models.map(m => m.keyword)).filter(k => data.models.some(m => m.keyword === k));
  const busy = data.load.mffRunning + data.load.mffWaiting > 0 || data.load.vllmTotal > 0;
  const info = data.runs.find(r => r.id === runId);

  const start = async (mode) => {
    try {
      const r = await api.post('/ai/setup/benchmark/start', { models: chosen, think: view.think, mode });
      setError('');
      setConfirm(false);
      set({ runId: r.data.runId });
    } catch (err) { setError(text(err)); }
    load();
  };

  return (
    <div>
      <p style={S.paragraph}>
        Asks every model the same questions and compares speed and answers. The models are loaded one after the other, and the model
        that is loaded now is loaded again at the end. Chat questions wait until it has finished.
      </p>
      {error && <div style={S.errorBanner}>{error}</div>}
      {active ? (
        <div style={S.warningBanner}>
          <strong>Benchmark running:</strong> {active.cancelled ? 'cancelling. ' : ''}{active.step} ({active.done} of {active.total} answers){' '}
          {data.canRun && !active.cancelled && <button type="button" style={S.button(S.GREY)} onClick={() => api.post('/ai/setup/benchmark/cancel').catch(e => setError(text(e))).then(load)}>Cancel</button>}
        </div>
      ) : data.canRun && (
        <div style={{ marginBottom: '15px', fontSize: '13px' }}>
          {data.models.map(m => (
            <label key={m.keyword} style={{ marginRight: '14px' }}>
              <input type="checkbox" checked={chosen.includes(m.keyword)} onChange={e => set({ models: e.target.checked ? [...chosen, m.keyword] : chosen.filter(k => k !== m.keyword) })} /> {m.label}
            </label>
          ))}
          <label style={{ marginRight: '14px' }}><input type="checkbox" checked={view.think} onChange={e => set({ think: e.target.checked })} /> Let models think first where it can be switched (slower)</label>
          {!confirm && <button type="button" style={S.button(S.BLUE, !chosen.length)} disabled={!chosen.length} onClick={() => setConfirm(true)}>Run…</button>}
          {confirm && (
            <div style={{ ...S.warningBanner, marginTop: '10px' }}>
              <p style={{ marginTop: 0 }}>The chat stops answering for everyone until the benchmark has finished: several minutes. {busy ? 'The AI is being used right now.' : 'Nobody is using the AI right now.'}</p>
              <button type="button" style={S.button(S.BLUE)} onClick={() => start('wait')}>{busy ? 'Wait for running answers, then start' : 'Start now'}</button>
              {busy && <button type="button" style={S.button(S.RED)} onClick={() => start('stop')}>Stop them and start now</button>}
              <button type="button" style={S.button(S.GREY)} onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {data.runs.length > 0 && (
        <>
          <div style={S.heading}>Results</div>
          <select style={{ ...S.field, marginBottom: '10px' }} aria-label="Benchmark run" value={runId || ''} onChange={e => set({ runId: Number(e.target.value) })}>
            {data.runs.map(r => <option key={r.id} value={r.id}>{new Date(r.startedAt).toLocaleString()}: {r.models.join(', ')}{r.think ? ' (thinking)' : ''}</option>)}
          </select>
          {info && <div style={{ marginBottom: '10px' }}><span style={S.chip(STATUS[info.status] || S.GREY)}>{info.status}</span> <span style={S.small}>{info.message} {info.by && `Started by ${info.by}.`}</span></div>}
          {run && run.id === runId && !run.empty && <Results api={api} run={run} runId={runId} view={view} set={set} canScore={data.canRun} reload={loadRun} />}
          {run && run.id === runId && run.empty && <div style={S.empty}>No results in this run.</div>}
        </>
      )}

      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => set({ promptsOpen: !view.promptsOpen })}>{view.promptsOpen ? '▾' : '▸'} Questions ({data.prompts.filter(p => p.enabled).length} in use)</div>
      {view.promptsOpen && <Prompts api={api} data={data} reload={load} usePageState={usePageState} />}
    </div>
  );
}

export default BenchmarkPanel;
