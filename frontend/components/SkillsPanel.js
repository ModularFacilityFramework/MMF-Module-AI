// Setup -> Skills: written instructions the AI loads for particular tasks,
// built like Claude Code skills (SKILL.md + optional reference files).
// Persisted per user: filter (ai.setup.skills.filter), the open sections
// (ai.setup.skills.sections), the unsaved draft (ai.setup.skills.draft) and
// the file open in it (ai.setup.skills.editorFile).
import React, { useCallback, useEffect, useState } from 'react';
import Overview from './Overview';
import SortedTable from './SortedTable';
import * as S from './styles';

const text = err => err.response?.data?.error || 'That did not work. Try again.';
const SHOW = [['all', 'All'], ['on', 'On'], ['off', 'Off']];
const FILTER = { search: '', tag: '', show: 'all' };
const validFilter = v => Boolean(v) && typeof v.search === 'string' && typeof v.tag === 'string' && SHOW.some(s => s[0] === v.show);
const SECTIONS = { uses: false, changes: false };
const validSections = v => Boolean(v) && typeof v.uses === 'boolean' && typeof v.changes === 'boolean';
// A draft: { id (0 = new), content, tag, enabled, files: [{ name, content } | { name, from }] }.
// "from" names an unchanged file of the saved skill, so its text is not kept twice.
const validDraft = v => v === null || (Boolean(v) && Number.isInteger(v.id) && typeof v.content === 'string'
  && typeof v.tag === 'string' && typeof v.enabled === 'boolean' && Array.isArray(v.files)
  && v.files.every(f => f && typeof f.name === 'string' && (typeof f.content === 'string' || typeof f.from === 'string')));
// The two AI levels; earlier stored values are read as one of them.
const AUDIENCE = { standard: 'standard (everyone)', advanced: 'advanced (developers and administrators)' };
const levelOf = a => (['staff', 'developer', 'developer-admin', 'advanced'].includes(a) ? 'advanced' : 'standard');
const PAGE_STATE_MAX = 60000; // core keeps at most 64 KB per value
const mono = { fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: '12px' };
const when = at => new Date(at).toLocaleString();

// The skill name and description, read from the frontmatter as the server does.
function frontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
  const get = k => (m && (new RegExp(`^${k}:\\s*(.*)$`, 'mi').exec(m[1]) || [])[1]) || '';
  return { name: get('name').trim().replace(/^["']|["']$/g, ''), description: get('description').trim() };
}

function Editor({ api, data, draft, setDraft, resetDraft, tooBig, readOnly, reload, usePageState }) {
  const [openFile, setOpenFile] = usePageState('ai.setup.skills.editorFile', 'SKILL.md', v => typeof v === 'string');
  const [saved, setSaved] = useState(null); // the saved skill, for unchanged file texts
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!draft.id) { setSaved(null); return undefined; }
    api.get(`/ai/setup/skills/${draft.id}`).then((r) => { if (alive) setSaved(r.data.skill); }).catch((err) => {
      if (!alive) return;
      if (err.response?.status === 404) {
        // Deleted meanwhile: keep what was typed, as a new skill.
        setDraft(d => (d ? { ...d, id: 0, files: d.files.filter(f => typeof f.content === 'string') } : d));
        setError('This skill was deleted meanwhile. Saving creates it again.');
      } else setError(text(err));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, draft.id]);

  const fileText = f => (typeof f.content === 'string' ? f.content : ((saved && saved.files.find(x => x.name === f.from)) || {}).content);
  const current = openFile === 'SKILL.md' ? null : draft.files.find(f => f.name === openFile);
  const shown = current || openFile === 'SKILL.md' ? openFile : 'SKILL.md';
  const value = shown === 'SKILL.md' ? draft.content : fileText(current);
  const loading = shown !== 'SKILL.md' && value === undefined;
  const front = frontmatter(draft.content);

  const change = (v) => {
    if (shown === 'SKILL.md') setDraft(d => ({ ...d, content: v }));
    else setDraft(d => ({ ...d, files: d.files.map(f => (f.name === shown ? { name: f.name, content: v } : f)) }));
  };
  const rename = (name) => {
    if (draft.files.some(f => f.name === name)) return;
    setDraft(d => ({ ...d, files: d.files.map(f => (f.name === shown ? { ...f, name } : f)) }));
    setOpenFile(name);
  };
  const addFile = () => {
    const taken = new Set(draft.files.map(f => f.name));
    let n = 1;
    while (taken.has(`reference-${n}.md`)) n += 1;
    setDraft(d => ({ ...d, files: [...d.files, { name: `reference-${n}.md`, content: '' }] }));
    setOpenFile(`reference-${n}.md`);
  };
  const removeFile = () => {
    setDraft(d => ({ ...d, files: d.files.filter(f => f.name !== shown) }));
    setOpenFile('SKILL.md');
  };

  const save = async () => {
    const files = draft.files.map(f => ({ name: f.name, content: fileText(f) }));
    if (files.some(f => f.content === undefined)) { setError('The saved files are still loading. Try again in a moment.'); return; }
    setBusy(true);
    try {
      const body = { content: draft.content, tag: draft.tag, audience: levelOf(draft.audience), enabled: draft.enabled, files };
      if (draft.id) await api.put(`/ai/setup/skills/${draft.id}`, body);
      else await api.post('/ai/setup/skills', body);
      setError('');
      resetDraft();
      setOpenFile('SKILL.md');
      reload();
    } catch (err) {
      setError(text(err));
    } finally {
      setBusy(false);
    }
  };

  const tags = [...new Set(data.skills.map(s => s.tag).filter(Boolean))].sort();
  const limit = shown === 'SKILL.md' ? data.max.skillChars : data.max.fileChars;
  return (
    <div style={{ border: '1px solid #dee2e6', borderRadius: '4px', padding: '14px', marginBottom: '15px' }} data-testid="skill-editor">
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
        {readOnly ? 'Skill' : draft.id ? 'Edit skill' : 'New skill'}: {front.name || '(no name yet)'}
      </div>
      <div style={{ marginBottom: '8px', fontSize: '13px' }}>
        <label>
          Module tag{' '}
          <input style={{ ...S.field, width: '140px' }} list="ai-skill-tags" aria-label="Module tag" placeholder="for example slurm" maxLength={32} disabled={readOnly} value={draft.tag} onChange={e => setDraft(d => ({ ...d, tag: e.target.value }))} />
        </label>
        <datalist id="ai-skill-tags">{tags.map(t => <option key={t} value={t} />)}</datalist>
        <label style={{ marginLeft: '14px' }}>
          Level{' '}
          <select style={S.field} aria-label="Audience" disabled={readOnly} value={levelOf(draft.audience)} onChange={e => setDraft(d => ({ ...d, audience: e.target.value }))}>
            {Object.entries(AUDIENCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label style={{ marginLeft: '14px' }}>
          <input type="checkbox" disabled={readOnly} checked={draft.enabled} onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))} /> On (the AI may use it)
        </label>
      </div>
      <div style={{ ...S.subTabBar, marginBottom: '0' }}>
        {['SKILL.md', ...draft.files.map(f => f.name)].map(n => (
          <div key={n} style={{ ...S.subTab(n === shown), padding: '6px 12px', ...mono }} onClick={() => setOpenFile(n)}>{n}</div>
        ))}
        {!readOnly && draft.files.length < data.max.files && (
          <div style={{ ...S.subTab(false), padding: '6px 12px' }} onClick={addFile}>+ Reference file</div>
        )}
      </div>
      {shown !== 'SKILL.md' && !readOnly && (
        <div style={{ margin: '8px 0', fontSize: '13px' }}>
          File name <input style={{ ...S.field, ...mono, width: '220px' }} aria-label="File name" maxLength={100} value={shown} onChange={e => rename(e.target.value)} />{' '}
          <button type="button" style={S.button(S.RED)} onClick={removeFile}>Remove this file</button>
        </div>
      )}
      <textarea
        style={{ ...S.field, ...mono, width: '100%', boxSizing: 'border-box', marginTop: '8px' }}
        rows={18}
        aria-label={shown}
        readOnly={readOnly || loading}
        value={loading ? 'Loading...' : value || ''}
        onChange={e => change(e.target.value)}
      />
      <div style={S.small}>
        {(value || '').length} of at most {limit} characters.
        {shown === 'SKILL.md' && ' Start with the frontmatter (name: lowercase-with-hyphens, description: what it does and exactly when to use it), then short numbered steps. Put long tables or details in reference files and say in the steps when to read them.'}
      </div>
      {tooBig && <div style={{ ...S.warningBanner, marginTop: '8px' }}>This draft is too large to be kept if you leave the page: save it first.</div>}
      {error && <div style={S.errorBanner}>{error}</div>}
      <div style={{ marginTop: '10px' }}>
        {!readOnly && <button type="button" style={S.button(S.BLUE, busy)} disabled={busy} onClick={save}>Save</button>}
        <button type="button" style={S.button(S.GREY)} onClick={() => { resetDraft(); setOpenFile('SKILL.md'); }}>{readOnly ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  );
}

function SkillsPanel({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = usePageState('ai.setup.skills.filter', FILTER, validFilter);
  const [sections, setSections] = usePageState('ai.setup.skills.sections', SECTIONS, validSections);
  const [savedDraft, setSavedDraft, resetSavedDraft] = usePageState('ai.setup.skills.draft', null, validDraft);
  const [bigDraft, setBigDraft] = useState(null); // too large for page state: kept here only
  const [deleting, setDeleting] = useState(null);

  const draft = bigDraft || savedDraft;
  const setDraft = (next) => {
    const v = typeof next === 'function' ? next(draft) : next;
    if (v && JSON.stringify(v).length > PAGE_STATE_MAX) setBigDraft(v);
    else { setBigDraft(null); setSavedDraft(v); }
  };
  const resetDraft = () => { setBigDraft(null); resetSavedDraft(); };

  const load = useCallback(() => api.get('/ai/setup/skills').then((r) => { setData(r.data); setError(''); }).catch(e => setError(text(e))), [api]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn) => {
    try { await fn(); setError(''); } catch (err) { setError(text(err)); }
    load();
  };

  if (!data) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;
  const tags = [...new Set(data.skills.map(s => s.tag).filter(Boolean))].sort();
  const tag = tags.includes(filter.tag) ? filter.tag : ''; // a tag nobody uses any more: show all
  const q = filter.search.trim().toLowerCase();
  const shown = data.skills.filter(s => (!q || `${s.name} ${s.description}`.toLowerCase().includes(q))
    && (!tag || s.tag === tag) && (filter.show === 'all' || (filter.show === 'on') === s.enabled));
  const onCount = data.skills.filter(s => s.enabled).length;
  const open = s => setDraft({ id: s.id, content: '', tag: '', enabled: s.enabled, files: [], loading: true });

  return (
    <div>
      <div style={{ backgroundColor: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: '4px', padding: '12px 16px', marginBottom: '15px', fontSize: '13px' }}>
        <strong>What is a skill?</strong> A skill is a short set of written instructions for one kind of task, for example how this
        facility wants a buffer recipe or a booking request written. The AI always sees the name and description of every skill
        that is on. When a question matches a description, the AI loads that skill's steps (and, if the steps say so, its reference
        files) and follows them. The chat shows when a skill is loaded. Skills are written like Claude Code skills: a SKILL.md with a
        frontmatter, then the steps.
      </div>
      <Overview title="Skills" items={data.overview} coreApi={coreApi} stateKey="ai.setup.skills.overviewOpen" />
      {!data.loadedCanUse && (
        <div style={S.warningBanner}>
          {data.loadedModel ? `The loaded model (${data.loadedModel}) cannot use skills: it answers without them.` : 'No model is loaded.'} Skills work with: {data.capableModels.join(', ') || 'none'}.
        </div>
      )}
      {onCount > data.max.listed && (
        <div style={S.warningBanner}>{onCount} skills are on; the AI is shown only the first {data.max.listed} (by name).</div>
      )}
      {error && <div style={S.errorBanner}>{error}</div>}
      {draft && <EditorLoader api={api} data={data} draft={draft} setDraft={setDraft} resetDraft={resetDraft} tooBig={Boolean(bigDraft)} readOnly={!data.canEdit} reload={load} usePageState={usePageState} />}
      <div style={{ marginBottom: '12px' }}>
        <input type="search" style={S.field} placeholder="Search skills" aria-label="Search skills" value={filter.search} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))} />{' '}
        <select style={S.field} aria-label="Module tag filter" value={tag} onChange={e => setFilter(f => ({ ...f, tag: e.target.value }))}>
          <option value="">All tags</option>
          {tags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>{' '}
        <select style={S.field} aria-label="Show" value={filter.show} onChange={e => setFilter(f => ({ ...f, show: e.target.value }))}>
          {SHOW.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>{' '}
        {data.canEdit && !draft && (
          <button type="button" style={S.button(S.GREEN)} onClick={() => setDraft({ id: 0, content: data.template, tag: '', enabled: true, files: [] })}>New skill</button>
        )}
      </div>
      {shown.length ? (
        <SortedTable
          coreApi={coreApi}
          rows={shown}
          rememberAs="ai.setup.skills.list"
          columns={{
            name: s => s.name, description: s => s.description, tag: s => s.tag, audience: s => levelOf(s.audience),
            files: { value: s => s.files.length, type: 'number' }, state: s => (s.enabled ? 'on' : 'off')
          }}
          head={[
            { key: 'name', label: 'Skill' }, { key: 'description', label: 'When the AI uses it' }, { key: 'tag', label: 'Tag' }, { key: 'audience', label: 'Level' },
            { key: 'files', label: 'Files' }, { key: 'state', label: 'State' }, { key: 'actions', label: '' }
          ]}
          rowKey={s => s.id}
          renderRow={s => (
                <tr data-testid={`skill-${s.name}`}>
                  <td style={{ ...S.td, ...mono }}>{s.name}</td>
                  <td style={S.td}>{s.description}</td>
                  <td style={S.td}>{s.tag || '-'}</td>
                  <td style={S.td}>{AUDIENCE[levelOf(s.audience)]}</td>
                  <td style={S.td}>{s.files.length || '-'}</td>
                  <td style={S.td}><span style={S.chip(s.enabled ? S.GREEN : S.GREY)}>{s.enabled ? 'on' : 'off'}</span></td>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    {!draft && <button type="button" style={S.button(S.GREY)} onClick={() => open(s)}>{data.canEdit ? 'Edit' : 'View'}</button>}
                    {data.canEdit && (
                      <button type="button" style={S.button(s.enabled ? S.GREY : S.BLUE)} onClick={() => act(() => api.post(`/ai/setup/skills/${s.id}/enabled`, { enabled: !s.enabled }))}>
                        {s.enabled ? 'Switch off' : 'Switch on'}
                      </button>
                    )}
                    {data.canEdit && deleting !== s.id && <button type="button" style={S.button(S.RED)} onClick={() => setDeleting(s.id)}>Delete…</button>}
                    {data.canEdit && deleting === s.id && (
                      <>
                        <span style={S.small}>Delete {s.name} and its files? </span>
                        <button type="button" style={S.button(S.RED)} onClick={() => { setDeleting(null); act(() => api.delete(`/ai/setup/skills/${s.id}`)); }}>Delete</button>
                        <button type="button" style={S.button(S.GREY)} onClick={() => setDeleting(null)}>Keep</button>
                      </>
                    )}
                  </td>
                </tr>
          )}
        />
      ) : <div style={S.empty}>{data.skills.length ? 'No skill matches.' : 'No skills yet.'}</div>}

      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setSections(s => ({ ...s, uses: !s.uses }))}>{sections.uses ? '▾' : '▸'} Skills loaded in answers</div>
      {sections.uses && (data.uses.length ? (
        <SortedTable
          coreApi={coreApi}
          rows={data.uses}
          rememberAs="ai.setup.skills.uses"
          defaultSort={{ column: 'when', direction: 'desc' }}
          columns={{ when: { value: u => u.at, type: 'date' }, by: u => u.by, skill: u => u.skill, file: u => u.file || 'SKILL.md', model: u => u.model, answer: u => u.answer }}
          head={[{ key: 'when', label: 'When' }, { key: 'by', label: 'Person' }, { key: 'skill', label: 'Skill' }, { key: 'file', label: 'File' }, { key: 'model', label: 'Model' }, { key: 'answer', label: 'Answer' }]}
          rowKey={u => u.id}
          renderRow={u => (
                <tr>
                  <td style={S.td}>{when(u.at)}</td><td style={S.td}>{u.by}</td><td style={{ ...S.td, ...mono }}>{u.skill}</td>
                  <td style={{ ...S.td, ...mono }}>{u.file || 'SKILL.md'}</td><td style={S.td}>{u.model}</td><td style={{ ...S.td, ...mono }}>{u.answer}</td>
                </tr>
          )}
        />
      ) : <div style={S.empty}>No skill has been loaded yet.</div>)}
      <div style={{ ...S.heading, cursor: 'pointer' }} onClick={() => setSections(s => ({ ...s, changes: !s.changes }))}>{sections.changes ? '▾' : '▸'} History of changes</div>
      {sections.changes && (data.changes.length
        ? data.changes.map(c => <div key={c.id} style={S.small}>{when(c.at)}: {c.by}, {c.action}, {c.skill}</div>)
        : <div style={S.empty}>No changes yet.</div>)}
    </div>
  );
}

// Opening a saved skill: fetch it, then fill the draft from it.
function EditorLoader(props) {
  const { api, draft, setDraft, resetDraft } = props;
  const [error, setError] = useState('');
  useEffect(() => {
    if (!draft.loading) return undefined;
    let alive = true;
    api.get(`/ai/setup/skills/${draft.id}`).then((r) => {
      const s = r.data.skill;
      if (alive) setDraft({ id: s.id, content: s.content, tag: s.tag || '', audience: levelOf(s.audience), enabled: s.enabled, files: s.files.map(f => ({ name: f.name, from: f.name })) });
    }).catch((err) => {
      if (!alive) return;
      if (err.response?.status === 404) resetDraft(); // deleted meanwhile: nothing to show
      else setError(text(err));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.loading, draft.id]);
  if (draft.loading) return error ? <div style={S.errorBanner}>{error}</div> : <div style={S.loading}>Loading...</div>;
  return <Editor {...props} />;
}

export default SkillsPanel;
