// Setup -> Tool servers: the separate programs (MCP servers) that give the AI
// more tools, for example PDBe or BioMCP. Add one, switch it on or off, remove
// it, and tick which of its tools the AI may use. Persisted per user: the
// unsaved "add a server" form (ai.setup.toolServers.draft), which servers show
// their tools (ai.setup.toolServers.open) and the sort of each table.
import React, { useCallback, useEffect, useState } from 'react';
import SortedTable from './SortedTable';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const validDraft = v => v === null || (Boolean(v) && typeof v.name === 'string' && typeof v.url === 'string');
const validOpen = v => Array.isArray(v) && v.every(x => typeof x === 'string');
// "PDBe API" -> "pdbe_api": the short name the module uses inside
const keyOf = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's$1').slice(0, 20);
const LIGHT = {
  ok: { color: S.GREEN, text: 'answering' },
  error: { color: S.RED, text: 'not answering' },
  off: { color: S.GREY, text: 'switched off' }
};

function Light({ state }) {
  const l = LIGHT[state] || LIGHT.off;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span aria-hidden="true" style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', backgroundColor: l.color, marginRight: '6px' }} />
      {l.text}
    </span>
  );
}

function ServerTools({ coreApi, server, canEdit, onChange }) {
  return (
    <div style={{ margin: '10px 0 18px' }} data-testid={`tools-of-${server.key}`}>
      <div style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 6px' }}>
        Tools of {server.name}: {server.inUse} of {server.toolCount} in use
      </div>
      {server.tools.length ? (
        <SortedTable
          coreApi={coreApi}
          rows={server.tools}
          rememberAs={`ai.setup.toolServers.tools.${server.key}`}
          wrapperStyle={{ maxHeight: '380px' }}
          columns={{ inUse: { value: t => (t.inUse ? 1 : 0), type: 'number' }, name: t => t.name, about: t => t.about }}
          head={[{ key: 'inUse', label: 'In use', style: { width: '80px' } }, { key: 'name', label: 'Tool' }, { key: 'about', label: 'What it does' }]}
          rowKey={t => t.key}
          renderRow={t => (
            <tr>
              <td style={S.td}>
                <input
                  type="checkbox"
                  aria-label={`Use ${t.name}`}
                  data-testid={`use-${t.key}`}
                  disabled={!canEdit}
                  checked={t.inUse}
                  onChange={e => onChange(t, e.target.checked)}
                />
              </td>
              <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '12px' }}>{t.name}</td>
              <td style={{ ...S.td, color: '#666' }}>{t.about || '-'}</td>
            </tr>
          )}
        />
      ) : <div style={S.empty}>{server.state === 'ok' ? 'This server offers no tools.' : 'Its tools are shown when the server answers.'}</div>}
    </div>
  );
}

function ToolServersPanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [draft, setDraft, resetDraft] = usePageState('ai.setup.toolServers.draft', null, validDraft);
  const [open, setOpen] = usePageState('ai.setup.toolServers.open', [], validOpen);

  const load = useCallback((fresh) => api.get('/ai/setup/tool-servers', { params: fresh ? { fresh: 1 } : {} })
    .then((r) => { setData(r.data); setError(''); })
    .catch(e => setError(text(e))), [api]);
  useEffect(() => { load(false); }, [load]);

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); setError(''); return true; } catch (err) { setError(text(err)); return false; } finally { setBusy(false); load(false); }
  };

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;
  const canEdit = data.canEdit;
  const form = draft || { name: '', url: '' };
  const add = async () => {
    const ok = await act(() => api.post('/ai/setup/mcp-servers', { key: keyOf(form.name), name: form.name.trim(), url: form.url.trim() }));
    if (ok) resetDraft();
  };
  const toggleOpen = key => setOpen(o => (o.includes(key) ? o.filter(k => k !== key) : [...o, key]));
  const shown = data.servers.filter(s => open.includes(s.key)); // a removed server's open state is simply ignored

  return (
    <div>
      <div style={{ backgroundColor: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '4px', padding: '12px 16px', marginBottom: '15px', fontSize: '13px' }}>
        <strong>What is a tool server?</strong> A separate program that gives the AI more tools, for example to look up protein
        structures (PDBe) or scientific articles and genes (BioMCP). Add a server here, then tick the tools the AI may use: only ticked
        tools are offered to it. Who may use each tool (Standard or Advanced level) is set on the Tools tab.
      </div>
      {error && <div style={S.errorBanner}>{error}</div>}

      {canEdit && (
        <div style={{ border: '1px solid #dee2e6', borderRadius: '4px', padding: '12px', marginBottom: '15px', fontSize: '13px' }} data-testid="add-server">
          <div style={{ fontWeight: 600, marginBottom: '6px' }}>Add a server</div>
          <input style={{ ...S.field, width: '200px' }} aria-label="Server name" placeholder="Name, for example PDBe API" value={form.name} onChange={e => setDraft({ ...form, name: e.target.value })} />{' '}
          <input style={{ ...S.field, width: '300px' }} aria-label="Server address" placeholder="Address, for example http://127.0.0.1:8901/api/" value={form.url} onChange={e => setDraft({ ...form, url: e.target.value })} />{' '}
          <button type="button" style={S.button(S.GREEN, busy || !form.name.trim() || !form.url.trim())} disabled={busy || !form.name.trim() || !form.url.trim()} onClick={add}>Add server</button>
          {draft && <button type="button" style={S.button(S.GREY)} onClick={() => resetDraft()}>Clear</button>}
          {form.name.trim() && <div style={{ ...S.small, marginTop: '4px' }}>Short name used inside the module: {keyOf(form.name) || '(type a name with letters)'}</div>}
        </div>
      )}

      <div style={{ ...S.heading, marginTop: 0 }}>
        Servers{' '}
        <button type="button" style={S.button(S.GREY, busy)} disabled={busy} onClick={() => load(true)}>Check again</button>
      </div>
      {data.servers.length ? (
        <SortedTable
          coreApi={coreApi}
          rows={data.servers}
          rememberAs="ai.setup.toolServers.servers"
          testId="tool-servers"
          columns={{
            state: s => LIGHT[s.state].text, name: s => s.name, url: s => s.url,
            tools: { value: s => s.toolCount, type: 'number' }, inUse: { value: s => s.inUse, type: 'number' }
          }}
          head={[
            { key: 'state', label: 'Status' }, { key: 'name', label: 'Name' }, { key: 'url', label: 'Address' },
            { key: 'tools', label: 'Tools' }, { key: 'inUse', label: 'In use' }, { key: 'actions', label: '' }
          ]}
          rowKey={s => s.key}
          renderRow={s => (
            <tr data-testid={`server-${s.key}`}>
              <td style={S.td}><Light state={s.state} />{s.error && <div style={S.small}>{s.error}</div>}</td>
              <td style={S.td}>{s.name}</td>
              <td style={{ ...S.td, fontFamily: 'monospace', fontSize: '12px' }}>{s.url}</td>
              <td style={S.td}>{s.enabled ? s.toolCount : '-'}</td>
              <td style={S.td}>{s.enabled ? s.inUse : '-'}</td>
              <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                <button type="button" style={S.button(S.BLUE)} onClick={() => toggleOpen(s.key)}>{open.includes(s.key) ? 'Hide tools' : 'Show tools'}</button>
                {canEdit && (s.enabled
                  ? <button type="button" style={S.button(S.GREY, busy)} disabled={busy} onClick={() => act(() => api.post(`/ai/setup/mcp-servers/${s.key}/enabled`, { enabled: false }))}>Disable</button>
                  : <button type="button" style={S.button(S.GREEN, busy)} disabled={busy} onClick={() => act(() => api.post(`/ai/setup/mcp-servers/${s.key}/enabled`, { enabled: true }))}>Enable</button>)}
                {canEdit && removing !== s.key && <button type="button" style={S.button(S.RED)} onClick={() => setRemoving(s.key)}>Remove…</button>}
                {canEdit && removing === s.key && (
                  <>
                    <span style={S.small}>Remove {s.name}? </span>
                    <button type="button" style={S.button(S.RED, busy)} disabled={busy} onClick={() => { setRemoving(null); act(() => api.delete(`/ai/setup/mcp-servers/${s.key}`)); }}>Remove</button>
                    <button type="button" style={S.button(S.GREY)} onClick={() => setRemoving(null)}>Keep</button>
                  </>
                )}
              </td>
            </tr>
          )}
        />
      ) : <div style={S.empty}>No tool servers yet.</div>}

      {shown.map(s => (
        <ServerTools
          key={s.key}
          coreApi={coreApi}
          server={s}
          canEdit={canEdit}
          onChange={(t, use) => act(() => api.post(`/ai/setup/tool-servers/${s.key}/tools/${t.key}`, { use }))}
        />
      ))}
    </div>
  );
}

export default ToolServersPanel;
