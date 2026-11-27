// Setup -> Safety: the guard model, the scope check and the output scan, who
// the levels, and what the checks did. Persisted per user: the
// unsaved settings (ai.setup.safety.draft), the period (ai.setup.safety.days)
// and the open sections (ai.setup.safety.sections).
import React, { useCallback, useEffect, useState } from 'react';
import SortedTable from './SortedTable';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const validDraft = v => v === null || (Boolean(v) && typeof v === 'object' && Array.isArray(v.hosts));
// Levels in older log rows (three levels until 27/11/2026) shown as the two current ones.
const levelName = l => (['staff', 'developer', 'advanced'].includes(l) ? 'Advanced' : 'Standard');
const validSections = v => Boolean(v) && typeof v.events === 'boolean' && typeof v.counts === 'boolean';
const RESULT = { blocked: S.RED, self_harm: 'warning', out_of_scope: S.GREY, error: 'warning', pass: S.GREEN };
const RESULT_TEXT = { blocked: 'blocked', self_harm: 'self-harm: help given', out_of_scope: 'out of scope', error: 'check failed', pass: 'passed' };
const STAGE_TEXT = { question: 'question (guard)', scope: 'question (scope)', answer: 'answer (guard, at the end)', answer_stream: 'answer (guard, while written)' };

function Toggle({ label, help, checked, disabled, onChange }) {
  return (
    <div style={{ marginBottom: '8px', fontSize: '13px' }}>
      <label><input type="checkbox" disabled={disabled} checked={checked} onChange={e => onChange(e.target.checked)} /> {label}</label>
      {help && <div style={{ ...S.small, marginLeft: '22px' }}>{help}</div>}
    </div>
  );
}

function SafetyPanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [draft, setDraft, resetDraft] = usePageState('ai.setup.safety.draft', null, validDraft);
  const [days, setDays] = usePageState('ai.setup.safety.days', 7, [1, 7, 30]);
  const [sections, setSections] = usePageState('ai.setup.safety.sections', { events: true, counts: false }, validSections);

  const load = useCallback(() => api.get('/ai/setup/safety', { params: { days } }).then((r) => { setData(r.data); setError(''); }).catch(e => setError(text(e))), [api, days]);
  useEffect(() => { load(); }, [load]);

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;
  const v = draft || data.settings;
  const change = (next) => { setSaved(false); setDraft({ ...v, ...next }); };
  const save = async () => {
    try {
      await api.put('/ai/setup/safety', v);
      resetDraft();
      setSaved(true);
      load();
    } catch (err) { setError(text(err)); }
  };
  const ro = !data.canEdit;
  const g = data.guard;

  return (
    <div>
      <div style={{ backgroundColor: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '4px', padding: '12px 16px', marginBottom: '15px', fontSize: '13px' }}>
        <strong>How the AI is kept safe.</strong> Every question and every answer is read by a small guard model (Qwen3Guard) on the
        AI server, which blocks requests about weapons, hacking, terrorism and the like. A question about self-harm gets a kind answer
        with where to find help, never a bare refusal. The scope check keeps the AI to MFF, the facility and its servers, structural
        biology and scientific writing. The output scan hides internal addresses, server names and paths from normal users. Each tool
        and skill has a level (Standard or Advanced), and the AI only gets what the asker's level allows. Developers and
        administrators are not slowed down: no scope check or scan for them, and the guard only if switched on below. No question or
        answer text is kept by these checks: only what was decided and how long it took.
      </div>
      <div style={g.reachable ? S.successBanner : S.warningBanner}>
        Guard model: {!g.configured && 'not set up (MODULE_AI_GUARD_URL is missing), so no question or answer is checked by it.'}
        {g.configured && g.reachable && `${g.model || 'running'}, answering.`}
        {g.configured && !g.reachable && `does not answer (${g.error}). ${v.guardDown === 'refuse' ? 'Normal users get no answers until it is back.' : 'Questions are answered without it.'}`}
      </div>
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={S.heading}>Settings</div>
      <Toggle label="Guard for the Standard level" checked={v.guardUsers} disabled={ro} onChange={x => change({ guardUsers: x })} />
      <Toggle label="Guard for the Advanced level (developers and administrators)" help="Adds the delay shown below to each answer; off by default." checked={v.guardDevelopers} disabled={ro} onChange={x => change({ guardDevelopers: x })} />
      <div style={{ marginBottom: '8px', fontSize: '13px' }}>
        When the guard does not answer:{' '}
        <select style={S.field} aria-label="When the guard does not answer" disabled={ro} value={v.guardDown} onChange={e => change({ guardDown: e.target.value })}>
          <option value="refuse">refuse to answer (safer)</option>
          <option value="answer">answer without it</option>
        </select>
      </div>
      <Toggle label="Scope check for the Standard level" help="Asks the loaded model whether a question is about MFF, the facility, its servers, structural biology or scientific writing." checked={v.scope} disabled={ro} onChange={x => change({ scope: x })} />
      <Toggle label="Output scan for the Standard level" help="Hides private IP addresses, server names and server paths in answers, thinking and tool results." checked={v.scan} disabled={ro} onChange={x => change({ scan: x })} />
      <div style={{ ...S.small, margin: '10px 0' }}>
        Levels come from core's roles: administrators and developers are at the Advanced level (every tool), everyone else at the Standard level
        (service tools only: their own, filtered data; never direct database or server access).
      </div>
      <div style={{ fontSize: '13px', margin: '10px 0 4px' }}>More server names to hide from normal users (one per line; the AI server's own names are always hidden):</div>
      <textarea
        style={{ ...S.field, width: '100%', maxWidth: '400px', boxSizing: 'border-box' }}
        rows={4}
        aria-label="Server names to hide"
        disabled={ro}
        value={v.hosts.join('\n')}
        onChange={e => change({ hosts: e.target.value.split('\n') })}
      />
      {data.canEdit && (
        <div style={{ marginTop: '8px' }}>
          <button type="button" style={S.button(S.BLUE, !draft)} disabled={!draft} onClick={save}>Save</button>
          {draft && <button type="button" style={S.button(S.GREY)} onClick={() => resetDraft()}>Discard changes</button>}
          {saved && <span style={S.small}>Saved.</span>}
        </div>
      )}

      <div style={S.heading}>
        Delay added to each answer, last{' '}
        <select style={S.field} aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value))}>
          {[1, 7, 30].map(d => <option key={d} value={d}>{d === 1 ? 'day' : `${d} days`}</option>)}
        </select>
      </div>
      {data.delay.length ? (
        <SortedTable
          coreApi={coreApi}
          rows={data.delay}
          rememberAs="ai.setup.safety.delay"
          columns={{
            level: d => levelName(d.level),
            answers: { value: d => d.answers, type: 'number' }, avg: { value: d => d.avgMs, type: 'number' }, max: { value: d => d.maxMs, type: 'number' }
          }}
          head={[{ key: 'level', label: 'Asker' }, { key: 'answers', label: 'Answers checked' }, { key: 'avg', label: 'Average added delay' }, { key: 'max', label: 'Longest' }]}
          rowKey={d => d.level}
          renderRow={d => (
                <tr>
                  <td style={S.td}>{levelName(d.level)}</td>
                  <td style={S.td}>{d.answers}</td><td style={S.td}>{(d.avgMs / 1000).toFixed(2)} s</td><td style={S.td}>{(d.maxMs / 1000).toFixed(2)} s</td>
                </tr>
          )}
        />
      ) : <div style={S.empty}>No checks in this period.</div>}

      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setSections(s => ({ ...s, counts: !s.counts }))}>{sections.counts ? '▾' : '▸'} Checks by kind</div>
      {sections.counts && (data.counts.length
        ? data.counts.map(c => <div key={`${c.stage}-${c.result}`} style={S.small}>{STAGE_TEXT[c.stage] || c.stage}: {c.n} {RESULT_TEXT[c.result] || c.result}, {c.avgMs} ms on average</div>)
        : <div style={S.empty}>None.</div>)}

      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setSections(s => ({ ...s, events: !s.events }))}>{sections.events ? '▾' : '▸'} Questions and answers stopped</div>
      {sections.events && (data.events.length ? (
        <SortedTable
          coreApi={coreApi}
          rows={data.events}
          rememberAs="ai.setup.safety.events"
          defaultSort={{ column: 'when', direction: 'desc' }}
          columns={{
            when: { value: e => e.at, type: 'date' }, by: e => e.by, stage: e => STAGE_TEXT[e.stage] || e.stage,
            result: e => RESULT_TEXT[e.result] || e.result, category: e => e.categories, answer: e => e.answer
          }}
          head={[{ key: 'when', label: 'When' }, { key: 'by', label: 'Person' }, { key: 'stage', label: 'Check' }, { key: 'result', label: 'Result' }, { key: 'category', label: 'Category' }, { key: 'answer', label: 'Answer' }]}
          rowKey={e => e.id}
          renderRow={e => (
                <tr>
                  <td style={S.td}>{new Date(e.at).toLocaleString()}</td><td style={S.td}>{e.by}</td><td style={S.td}>{STAGE_TEXT[e.stage] || e.stage}</td>
                  <td style={S.td}><span style={S.chip(RESULT[e.result] || S.GREY)}>{RESULT_TEXT[e.result] || e.result}</span></td>
                  <td style={S.td}>{e.categories || '-'}</td><td style={{ ...S.td, fontFamily: 'monospace' }}>{e.answer}</td>
                </tr>
          )}
        />
      ) : <div style={S.empty}>Nothing has been stopped.</div>)}
    </div>
  );
}

export default SafetyPanel;
