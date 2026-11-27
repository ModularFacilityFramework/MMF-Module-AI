// Setup -> Model: change the loaded model, who may do that, and what happened.
// Unsaved choices persist (ai.setup.switchTarget, ai.setup.switchers.draft).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import SortedTable from './SortedTable';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const PHASE = {
  waiting: 'Waiting for running answers to finish',
  switching: 'Loading the new model',
  checking: 'Checking that the new model answers',
  finished: 'Finished'
};
const STATUS = { done: S.GREEN, failed: S.RED, cancelled: S.GREY, interrupted: 'warning', running: 'warning' };
const validDraft = v => v === null || (Boolean(v) && Array.isArray(v.roles) && Array.isArray(v.users));
const validOpen = v => Boolean(v) && typeof v.who === 'boolean' && typeof v.log === 'boolean';

function Switchers({ coreApi }) {
  const { api, usePageState, ui } = coreApi;
  const [data, setData] = useState(null);
  const [draft, setDraft, resetDraft] = usePageState('ai.setup.switchers.draft', null, validDraft);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => api.get('/ai/setup/switchers').then(r => setData(r.data)).catch(e => setError(text(e))), [api]);
  useEffect(() => { load(); }, [load]);

  if (error && !data) return <div style={S.errorBanner}>{error}</div>;
  if (!data) return <div style={S.loading}>Loading...</div>;
  const value = draft || { roles: data.roles, users: data.users };
  const change = (next) => { setSaved(false); setDraft({ ...value, ...next }); };
  const save = async () => {
    try {
      await api.put('/ai/setup/switchers', value);
      resetDraft();
      await load();
      setError('');
      setSaved(true);
    } catch (err) { setError(text(err)); }
  };
  const Picker = ui && ui.UserPicker;

  return (
    <div>
      <p style={S.paragraph}>
        Administrators and developers can always switch the model. Add other roles or people here. They also need
        access to this Setup page (Setup → Preferences → Access).
      </p>
      <div style={{ fontSize: '13px', marginBottom: '10px' }}>
        {data.availableRoles.map(r => (
          <label key={r} style={{ marginRight: '14px', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              disabled={!data.canEdit}
              checked={value.roles.includes(r)}
              onChange={e => change({ roles: e.target.checked ? [...value.roles, r] : value.roles.filter(x => x !== r) })}
            /> {r.replace(/_/g, ' ')}
          </label>
        ))}
      </div>
      {data.canEdit && Picker
        ? <Picker mode="multi" value={value.users} onChange={ids => change({ users: ids || [] })} placeholder="Add a person" label="People" />
        : <div style={S.small}>{data.people.length ? data.people.map(p => p.label).join(', ') : 'No extra people.'}</div>}
      {error && <div style={S.errorBanner}>{error}</div>}
      {data.canEdit && (
        <div style={{ marginTop: '10px' }}>
          <button type="button" style={S.button(S.BLUE, !draft)} disabled={!draft} onClick={save}>Save</button>
          {draft && <button type="button" style={S.button(S.GREY)} onClick={() => resetDraft()}>Discard changes</button>}
          {saved && <span style={S.small}>Saved.</span>}
        </div>
      )}
    </div>
  );
}

function Log({ coreApi, version }) {
  const { api } = coreApi;
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.get('/ai/setup/switch/log').then(r => alive && setRows(r.data.log)).catch(e => alive && setError(text(e)));
    return () => { alive = false; };
  }, [api, version]);
  if (error) return <div style={S.errorBanner}>{error}</div>;
  if (!rows) return <div style={S.loading}>Loading...</div>;
  if (!rows.length) return <div style={S.empty}>No switches yet.</div>;
  return (
    <SortedTable
      coreApi={coreApi}
      rows={rows}
      rememberAs="ai.setup.switch.log"
      wrapperStyle={{ maxHeight: '300px' }}
      columns={{
        when: { value: r => r.startedAt, type: 'date' },
        from: r => r.from,
        to: r => r.to,
        by: r => (r.source === 'outside' ? 'outside MFF' : r.by),
        result: r => r.status
      }}
      head={[{ key: 'when', label: 'When' }, { key: 'from', label: 'From' }, { key: 'to', label: 'To' }, { key: 'by', label: 'By' }, { key: 'result', label: 'Result' }]}
      rowKey={r => r.id}
      renderRow={r => (
            <tr>
              <td style={S.td}>{new Date(r.startedAt).toLocaleString()}</td>
              <td style={S.td}>{r.from || '-'}</td>
              <td style={S.td}>{r.to}</td>
              <td style={S.td}>{r.source === 'outside' ? 'outside MFF' : r.by || '-'}{r.source === 'benchmark' ? ' (benchmark)' : ''}</td>
              <td style={S.td}><span style={S.chip(STATUS[r.status] || S.GREY)}>{r.status}</span> {r.message}</td>
            </tr>
      )}
    />
  );
}

function SwitchPanel({ coreApi, loaded, onFinished }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [saved, setTarget] = usePageState('ai.setup.switchTarget', '', v => typeof v === 'string');
  const [open, setOpen] = usePageState('ai.setup.switch.open', { who: false, log: false }, validOpen);
  const wasActive = useRef(false);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    let alive = true;
    let timer = null;
    const poll = async () => {
      let active = false;
      try {
        const r = await api.get('/ai/setup/switch');
        if (!alive) return;
        setData(r.data);
        active = Boolean(r.data.active);
        if (wasActive.current && !active) {
          setVersion(v => v + 1);
          finishedRef.current();
        }
        wasActive.current = active;
      } catch (err) {
        if (!alive) return;
        setError(text(err));
      }
      timer = setTimeout(poll, active ? 1500 : 10000);
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, version, busy]);

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : null;
  // One choice per model, or per precision of a model that has several.
  const tokens = n => `up to ${Math.round(n).toLocaleString()} tokens`;
  const choices = data.models.flatMap(m => (m.variants && m.variants.length
    ? m.variants.map(v => ({ value: v.key, keyword: m.keyword, variant: v.key, label: `${m.label}: ${v.label}${v.context ? `, ${tokens(v.context)}` : ''}` }))
    : [{ value: m.keyword, keyword: m.keyword, variant: null, label: m.label }]));
  const current = data.loaded || loaded;
  const others = choices.filter(c => c.value !== current);
  const chosen = others.find(c => c.value === saved) || others[0] || null;
  const target = chosen ? chosen.value : '';
  const targetLabel = chosen ? chosen.label : '';
  const { active, last, load } = data;
  const outside = load.vllmTotal === null ? 0 : Math.max(0, load.vllmTotal - load.mffRunning);
  const running = load.mffRunning + load.mffWaiting;

  const act = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); setConfirm(false); } catch (err) { setError(text(err)); }
    setBusy(false);
  };
  const start = mode => act(() => api.post('/ai/setup/switch', { keyword: chosen.keyword, variant: chosen.variant, mode }));

  return (
    <div style={{ border: '1px solid #dee2e6', borderRadius: '4px', padding: '14px', marginTop: '10px' }}>
      <div style={{ ...S.heading, marginTop: 0 }}>Switch the model</div>
      {error && <div style={S.errorBanner}>{error}</div>}
      {active ? (
        <div>
          <div style={S.warningBanner}>
            <strong>{PHASE[active.phase]}</strong> ({active.toLabel}, {active.seconds} s)
            {active.phase === 'waiting' && `: ${load.mffRunning} answers in MFF, ${outside} from outside MFF.`}
          </div>
          {active.lines.length > 0 && <pre style={{ background: '#f8f9fa', border: '1px solid #eee', borderRadius: '4px', padding: '10px', fontSize: '12px', maxHeight: '180px', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{active.lines.join('\n')}</pre>}
          {active.phase === 'waiting' && data.canSwitch && (
            <button type="button" style={S.button(S.GREY, busy)} disabled={busy} onClick={() => act(() => api.post('/ai/setup/switch/cancel'))}>Cancel the switch</button>
          )}
        </div>
      ) : (
        <div>
          {last && last.status && (
            <div style={last.status === 'done' ? S.successBanner : S.warningBanner}>Last switch, to {last.toLabel}: {last.message}</div>
          )}
          {!data.canSwitch && <div style={S.small}>You can see this page but not switch the model.</div>}
          {data.canSwitch && !confirm && (
            <div>
              <select style={{ ...S.field, marginRight: '8px' }} aria-label="Model to load" value={target} onChange={e => setTarget(e.target.value)}>
                {others.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
              <button type="button" style={S.button(S.BLUE, !target)} disabled={!target} onClick={() => setConfirm(true)}>Switch…</button>
              <span style={S.small}>The AI is unavailable for everyone for about 2 to 3 minutes (about 10 minutes the first time a model starts at a new length).</span>
            </div>
          )}
          {data.canSwitch && confirm && (
            <div style={S.warningBanner}>
              <p style={{ marginTop: 0 }}>
                <strong>Load {targetLabel}?</strong> The AI stops answering for everyone for about 2 to 3 minutes (about 10 minutes the first time a model starts at a new length).
                {' '}Right now: {running === 0 && outside === 0 ? 'nobody is using it.' : `${load.mffRunning} answers running and ${load.mffWaiting} waiting in MFF, ${outside} from outside MFF.`}
              </p>
              <button type="button" style={S.button(S.BLUE, busy)} disabled={busy} onClick={() => start('wait')}>
                {running || outside ? 'Wait for them, then switch' : 'Switch now'}
              </button>
              {(running > 0 || outside > 0) && (
                <button type="button" style={S.button(S.RED, busy)} disabled={busy} onClick={() => start('stop')}>Stop them and switch now</button>
              )}
              <button type="button" style={S.button(S.GREY, busy)} disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
      {[['who', 'Who may switch the model'], ['log', 'History of switches']].map(([key, title]) => (
        <div key={key} style={{ marginTop: '12px' }}>
          <div style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 600 }} onClick={() => setOpen(o => ({ ...o, [key]: !o[key] }))}>
            {open[key] ? '▾' : '▸'} {title}
          </div>
          {open[key] && (key === 'who' ? <Switchers coreApi={coreApi} /> : <Log coreApi={coreApi} version={version} />)}
        </div>
      ))}
    </div>
  );
}

export default SwitchPanel;
