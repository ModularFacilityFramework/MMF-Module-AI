// Setup -> Tools: what the AI can use besides writing text. Written for people
// who have never used AI tools. Search and filter persist (ai.setup.tools.filter).
import React, { useCallback, useEffect, useState } from 'react';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const SHOW = [['all', 'All'], ['installed', 'Installed'], ['catalogue', 'Not installed']];
const validFilter = v => Boolean(v) && typeof v.search === 'string' && SHOW.some(s => s[0] === v.show);
const RISK = { 'reads only': S.GREEN, 'reads your MFF data': 'warning', 'reaches the internet': S.RED };

function ToolCard({ tool, data, act }) {
  return (
    <div style={{ border: '1px solid #dee2e6', borderRadius: '4px', padding: '14px', marginBottom: '10px' }} data-testid={`tool-${tool.key}`}>
      <div style={{ fontSize: '14px', fontWeight: 600 }}>
        {tool.name}{' '}
        <span style={S.chip(RISK[tool.risk] || S.GREY)}>{tool.risk}</span>
        {tool.installed && <span style={S.chip(tool.enabled ? S.GREEN : S.GREY)}>{tool.enabled ? 'on' : 'off'}</span>}
      </div>
      <p style={{ ...S.paragraph, margin: '6px 0' }}>{tool.what}</p>
      <div style={S.small}>Example: "{tool.example}"</div>
      <div style={S.small}>What it can see: {tool.sees}</div>
      {tool.needs && <div style={S.small}>What it needs: {tool.needs}</div>}
      {tool.installed && (
        <div style={{ ...S.small, marginTop: '6px' }}>
          Who may use it: {tool.roles.length ? '' : 'everyone with access to the chat. '}
          {data.roles.map(r => (
            <label key={r} style={{ marginRight: '10px', whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                disabled={!data.canEdit}
                checked={tool.roles.includes(r)}
                onChange={e => act(tool, { action: 'roles', roles: e.target.checked ? [...tool.roles, r] : tool.roles.filter(x => x !== r) })}
              /> {r.replace(/_/g, ' ')}
            </label>
          ))}
          {!tool.roles.length && '(tick roles to restrict it)'}
        </div>
      )}
      {data.canEdit && tool.available && (
        <div style={{ marginTop: '8px' }}>
          {!tool.installed && <button type="button" style={S.button(S.GREEN)} onClick={() => act(tool, { action: 'install' })}>Install</button>}
          {tool.installed && (
            <button type="button" style={S.button(tool.enabled ? S.GREY : S.BLUE)} onClick={() => act(tool, { action: tool.enabled ? 'disable' : 'enable' })}>
              {tool.enabled ? 'Switch off' : 'Switch on'}
            </button>
          )}
          {tool.installed && <button type="button" style={S.button(S.RED)} onClick={() => act(tool, { action: 'remove' })}>Remove</button>}
        </div>
      )}
      {!tool.available && <div style={{ ...S.small, marginTop: '8px' }}>Not available yet.</div>}
    </div>
  );
}

function ToolsPanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = usePageState('ai.setup.tools.filter', { search: '', show: 'all' }, validFilter);
  const [logOpen, setLogOpen] = usePageState('ai.setup.tools.logOpen', false, [true, false]);

  const load = useCallback(() => api.get('/ai/setup/tools').then(r => setData(r.data)).catch(e => setError(text(e))), [api]);
  useEffect(() => { load(); }, [load]);

  const act = async (tool, body) => {
    try {
      await api.post(`/ai/setup/tools/${tool.key}`, body);
      setError('');
    } catch (err) { setError(text(err)); }
    load();
  };

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;
  const q = filter.search.trim().toLowerCase();
  const match = t => (!q || `${t.name} ${t.what} ${t.example}`.toLowerCase().includes(q))
    && (filter.show === 'all' || (filter.show === 'installed') === t.installed);
  const installed = data.tools.filter(t => t.installed && match(t));
  const catalogue = data.tools.filter(t => !t.installed && match(t));
  const nameOf = key => (data.tools.find(t => t.key === key) || { name: key }).name;

  return (
    <div>
      <div style={{ backgroundColor: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '4px', padding: '12px 16px', marginBottom: '15px', fontSize: '13px' }}>
        <strong>What is a tool?</strong> A tool lets the AI do something it cannot do by just writing text: look up today's date,
        read the rest of a long file, work out a sum exactly. The AI asks to use the tool, MFF runs it, and the result goes back to
        the AI. Tools run only inside MFF, as the person asking, with that person's permissions. The chat shows every time a tool is used.
        "Install" only switches on something that is already part of this module: nothing is downloaded.
      </div>
      {!data.loadedCanUse && (
        <div style={S.warningBanner}>
          {data.loadedModel ? `The loaded model (${data.loadedModel}) cannot use tools.` : 'No model is loaded.'} Tools work with: {data.capableModels.join(', ') || 'none'}.
        </div>
      )}
      {error && <div style={S.errorBanner}>{error}</div>}
      <div style={{ marginBottom: '12px' }}>
        <input type="search" style={S.field} placeholder="Search tools" aria-label="Search tools" value={filter.search} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))} />{' '}
        <select style={S.field} aria-label="Show" value={filter.show} onChange={e => setFilter(f => ({ ...f, show: e.target.value }))}>
          {SHOW.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {filter.show !== 'catalogue' && (
        <>
          <div style={S.heading}>Installed</div>
          {installed.length ? installed.map(t => <ToolCard key={t.key} tool={t} data={data} act={act} />) : <div style={S.empty}>No tools installed{q ? ' that match' : ''}.</div>}
        </>
      )}
      {filter.show !== 'installed' && (
        <>
          <div style={S.heading}>Could be installed</div>
          {catalogue.length ? catalogue.map(t => <ToolCard key={t.key} tool={t} data={data} act={act} />) : <div style={S.empty}>Nothing else{q ? ' that matches' : ''}.</div>}
        </>
      )}
      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setLogOpen(o => !o)}>{logOpen ? '▾' : '▸'} History</div>
      {logOpen && (data.log.length
        ? data.log.map(l => <div key={l.id} style={S.small}>{new Date(l.at).toLocaleString()}: {l.by}, {l.action}, {nameOf(l.tool)}</div>)
        : <div style={S.empty}>No changes yet.</div>)}
    </div>
  );
}

export default ToolsPanel;
