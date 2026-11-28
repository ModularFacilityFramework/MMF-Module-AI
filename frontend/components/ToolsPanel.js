// Setup -> Tools: what the AI can use besides writing text. Written for people
// who have never used AI tools. Search and filter persist (ai.setup.tools.filter).
import React, { useCallback, useEffect, useState } from 'react';
import Overview from './Overview';
import SortedTable from './SortedTable';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const SHOW = [['all', 'All'], ['installed', 'Installed'], ['catalogue', 'Not installed']];
const validFilter = v => Boolean(v) && typeof v.search === 'string' && SHOW.some(s => s[0] === v.show) && (v.source === undefined || typeof v.source === 'string');
// The two AI levels (core's roles decide): earlier stored values are read as one of them.
const LEVELS = [['standard', 'Standard: everyone'], ['advanced', 'Advanced: developers and administrators']];
const levelOf = a => (['staff', 'developer', 'developer-admin', 'advanced'].includes(a) ? 'advanced' : 'standard');
const RISK = { 'reads only': S.GREEN, 'makes new files': S.BLUE, 'reads your MFF data': 'warning', 'reaches the internet': S.RED };

function ToolCard({ tool, data, act }) {
  return (
    <div style={{ border: '1px solid #dee2e6', borderRadius: '4px', padding: '14px', marginBottom: '10px' }} data-testid={`tool-${tool.key}`}>
      <div style={{ fontSize: '14px', fontWeight: 600 }}>
        {tool.name}{' '}
        {tool.mcp && <span style={S.chip('#17a2b8')} title={`MCP server ${tool.mcp.serverName}, tool ${tool.mcp.tool}`}>MCP</span>}
        <span style={S.chip(RISK[tool.risk] || S.GREY)}>{tool.risk}</span>
        {tool.installed && <span style={S.chip(tool.enabled ? S.GREEN : S.GREY)}>{tool.enabled ? 'on' : 'off'}</span>}
      </div>
      <p style={{ ...S.paragraph, margin: '6px 0' }}>{tool.what}</p>
      <div style={S.small}>Example: "{tool.example}"</div>
      <div style={S.small}>What it can see: {tool.sees}</div>
      {tool.needs && <div style={S.small}>What it needs: {tool.needs}</div>}
      <div style={{ ...S.small, marginTop: '6px' }} data-testid={`kind-${tool.key}`}>
        {tool.kind === 'direct'
          ? <><span style={S.chip(S.RED)}>Direct</span> direct access to a database or server: advanced level only, always.</>
          : <><span style={S.chip(S.GREEN)}>Service</span> {tool.forModel ? 'gives the AI only the asker\'s own, filtered data or public data.' : 'a feature of the chat, not given to the AI.'}</>}
      </div>
      {tool.installed && (
        <div style={{ ...S.small, marginTop: '6px' }}>
          Level:{' '}
          <select style={S.field} aria-label={`Level of ${tool.name}`} disabled={!data.canEdit || tool.kind === 'direct'} value={tool.kind === 'direct' ? 'advanced' : levelOf(tool.audience)} onChange={e => act(tool, { action: 'audience', audience: e.target.value })}>
            {LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      )}
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
      {!tool.available && <div style={{ ...S.small, marginTop: '8px' }}>Planned: not built yet.</div>}
    </div>
  );
}

function ToolsPanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = usePageState('ai.setup.tools.filter', { search: '', show: 'all', source: 'all' }, validFilter);
  const [logOpen, setLogOpen] = usePageState('ai.setup.tools.logOpen', false, [true, false]);
  const [open, setOpen] = usePageState('ai.setup.tools.sections', { docs: false, uses: false }, v => Boolean(v) && typeof v.docs === 'boolean' && typeof v.uses === 'boolean');

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
  const servers = data.mcpServers || [];
  // a source that no longer exists falls back to all
  const source = filter.source && (filter.source === 'builtin' || servers.some(sv => sv.key === filter.source)) ? filter.source : 'all';
  const match = t => (!q || `${t.name} ${t.what} ${t.example}`.toLowerCase().includes(q))
    && (filter.show === 'all' || (filter.show === 'installed') === t.installed)
    && (source === 'all' || (source === 'builtin' ? !t.mcp : t.mcp && t.mcp.server === source));

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
      <Overview title="What the AI can do" items={data.overview} coreApi={coreApi} stateKey="ai.setup.tools.overviewOpen" />
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
        </select>{' '}
        <select style={S.field} aria-label="Source" value={source} onChange={e => setFilter(f => ({ ...f, source: e.target.value }))}>
          <option value="all">All sources</option>
          <option value="builtin">Built into this module</option>
          {servers.map(sv => <option key={sv.key} value={sv.key}>MCP: {sv.name}</option>)}
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
          <div style={S.heading}>Could be installed, and planned</div>
          {catalogue.length ? catalogue.map(t => <ToolCard key={t.key} tool={t} data={data} act={act} />) : <div style={S.empty}>Nothing else{q ? ' that matches' : ''}.</div>}
        </>
      )}
      <div style={{ ...S.small, margin: '14px 0' }}>
        Tool servers (PDBe, BioMCP, ...) are added, switched on or off, and their tools ticked on the <strong>Tool servers</strong> tab.
        Their tools also appear above, to set who may use them.
      </div>
      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setOpen(o => ({ ...o, docs: !o.docs }))}>
        {open.docs ? '▾' : '▸'} MFF docs the AI can read{data.docs ? ` (${data.docs.length}, from ${data.docsSource === 'core' ? 'core' : 'MODULE_AI_DOCS_DIR'})` : ': not available here'}
      </div>
      {!data.docs && data.tools.some(t => ['docs_index', 'search_docs', 'read_doc'].includes(t.key) && t.installed) && (
        <div style={S.warningBanner}>
          The MFF docs are not available on this server, so the AI cannot look anything up in them and says so when asked.
          They come from an MFF-docs checkout beside the core checkout (coreApi.docs), or from MODULE_AI_DOCS_DIR.
        </div>
      )}
      {open.docs && (!data.docs ? <div style={S.empty}>The MFF docs are not available on this server: core has no docs (no MFF-docs checkout beside it) and MODULE_AI_DOCS_DIR is not set.</div> : (
        <SortedTable
          coreApi={coreApi}
          rows={data.docs}
          rememberAs="ai.setup.tools.docs"
          wrapperStyle={{ maxHeight: '320px' }}
          columns={{ name: d => d.name, area: d => d.area, audience: d => levelOf(d.audience), summary: d => d.summary }}
          head={[{ key: 'name', label: 'Doc' }, { key: 'area', label: 'Area' }, { key: 'audience', label: 'Level' }, { key: 'summary', label: 'What it covers' }]}
          rowKey={d => d.name}
          renderRow={d => (
                <tr>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '12px' }}>{d.name}</td><td style={S.td}>{d.area}</td>
                  <td style={S.td}>{levelOf(d.audience) === 'advanced' ? 'advanced' : 'standard (everyone)'}{!d.indexed && <div style={S.small}>not in INDEX.json: default</div>}</td><td style={{ ...S.td, color: '#666' }}>{d.summary}</td>
                </tr>
          )}
        />
      ))}
      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setOpen(o => ({ ...o, uses: !o.uses }))}>{open.uses ? '▾' : '▸'} Tools used in answers</div>
      {open.uses && (data.uses.length ? (
        <SortedTable
          coreApi={coreApi}
          rows={data.uses}
          rememberAs="ai.setup.tools.uses"
          wrapperStyle={{ maxHeight: '320px' }}
          defaultSort={{ column: 'when', direction: 'desc' }}
          columns={{ when: { value: u => u.at, type: 'date' }, by: u => u.by, tool: u => nameOf(u.tool), target: u => u.target, result: u => (u.ok ? 'worked' : 'failed'), answer: u => u.answer }}
          head={[{ key: 'when', label: 'When' }, { key: 'by', label: 'Person' }, { key: 'tool', label: 'Tool' }, { key: 'target', label: 'On' }, { key: 'result', label: 'Result' }, { key: 'answer', label: 'Answer' }]}
          rowKey={u => u.id}
          renderRow={u => (
                <tr>
                  <td style={S.td}>{new Date(u.at).toLocaleString()}</td><td style={S.td}>{u.by}</td><td style={S.td}>{nameOf(u.tool)}</td>
                  <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '12px' }}>{u.target || '-'}</td>
                  <td style={S.td}><span style={S.chip(u.ok ? S.GREEN : S.RED)}>{u.ok ? 'worked' : 'failed'}</span></td>
                  <td style={{ ...S.td, fontFamily: 'monospace' }}>{u.answer}</td>
                </tr>
          )}
        />
      ) : <div style={S.empty}>No tool has been used yet.</div>)}
      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setLogOpen(o => !o)}>{logOpen ? '▾' : '▸'} History of changes</div>
      {logOpen && (data.log.length
        ? data.log.map(l => <div key={l.id} style={S.small}>{new Date(l.at).toLocaleString()}: {l.by}, {l.action}, {nameOf(l.tool)}</div>)
        : <div style={S.empty}>No changes yet.</div>)}
    </div>
  );
}

export default ToolsPanel;
