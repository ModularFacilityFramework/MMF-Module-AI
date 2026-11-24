import React, { useEffect, useMemo, useState } from 'react';
import manifest from '../../module.manifest.json';

// Key shape: <moduleId>.<page>.<what>. Holds this tab's unsaved edits (the
// "draft") per user, so leaving the tab or reloading doesn't lose them.
const DRAFT_KEY = `${manifest.id}.page-access.draft`;

// A saved draft is accepted only if it is a plain { pageKey: [role, ...] }
// object; anything else silently falls back to "no draft".
function isValidDraft(value) {
  return value === null || (
    typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every(roles => Array.isArray(roles) && roles.every(r => typeof r === 'string'))
  );
}

// Drops pages and roles from a saved draft that no longer exist, so a stale
// draft can never send a deleted role back to the server on Save.
function sanitizeDraft(draft, pages, roles) {
  const out = {};
  pages.forEach(page => {
    out[page.key] = (draft[page.key] || []).filter(role => roles.includes(role));
  });
  return out;
}

const wrapperStyle = { border: '1px solid #ddd', borderRadius: '4px', overflow: 'auto' };
const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const theadStyle = { backgroundColor: '#f8f9fa' };
const thStyle = { padding: '12px', textAlign: 'left', borderBottom: '1px solid #ddd', fontSize: '13px' };
const tdStyle = { padding: '12px', textAlign: 'left', borderBottom: '1px solid #eee', fontSize: '13px' };
const loadingStyle = { textAlign: 'center', padding: '20px' };
const errorStyle = { textAlign: 'center', padding: '20px', color: 'red', backgroundColor: '#ffeeee', borderRadius: '4px', margin: '10px 0' };
const hintStyle = { fontSize: '12px', color: '#856404', backgroundColor: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px', padding: '8px 12px', display: 'inline-block', marginBottom: '12px' };
const saveButtonStyle = { padding: '5px 10px', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', backgroundColor: '#007bff', marginTop: '12px' };
const savedChipStyle = { display: 'inline-block', padding: '2px 6px', margin: '0 0 0 10px', borderRadius: '3px', fontSize: '11px', color: 'white', backgroundColor: '#28a745' };

function PageAccessTab({ coreApi }) {
  const { api, useAuth, useRoles, usePageState } = coreApi;
  const { userData } = useAuth();
  const { canManageUsers } = useRoles(userData);
  const [pages, setPages] = useState([]);
  const [roles, setRoles] = useState([]);
  const [savedAccess, setSavedAccess] = useState({});
  // The unsaved draft lives in page state (per user, survives leaving the tab,
  // a reload and a logout); null means "no draft, show what the server has".
  // Call resetDraft() once the draft is saved, so it isn't restored again.
  const [draft, setDraft, resetDraft] = usePageState(DRAFT_KEY, null, isValidDraft);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/example/page-access')
      .then(res => { setPages(res.data.pages); setRoles(res.data.roles); setSavedAccess(res.data.access); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [api]);

  // What the grid shows and what Save sends: the draft when there is one
  // (cleaned of pages/roles that no longer exist), else the saved config.
  const access = useMemo(
    () => (draft ? sanitizeDraft(draft, pages, roles) : savedAccess),
    [draft, pages, roles, savedAccess]
  );

  function toggleRole(pageKey, role) {
    if (!canManageUsers) return;
    setSaved(false);
    const current = access[pageKey] || [];
    const next = current.includes(role) ? current.filter(r => r !== role) : [...current, role];
    setDraft({ ...access, [pageKey]: next });
  }

  function handleSave() {
    setSaving(true);
    setError('');
    api.put('/example/page-access', { access })
      .then(() => { setSavedAccess(access); resetDraft(); setSaved(true); })
      .catch(err => setError(err.message))
      .finally(() => setSaving(false));
  }

  if (loading) return <div style={loadingStyle}>Loading...</div>;
  if (error) return <div style={errorStyle}>{error}</div>;

  return (
    <div>
      {!canManageUsers && <p style={hintStyle}>Read-only - only staff-level users in this module can change page access.</p>}
      <div style={wrapperStyle}>
        <table style={tableStyle}>
          <thead style={theadStyle}><tr><th style={thStyle}>Page</th>{roles.map(role => <th key={role} style={thStyle}>{role}</th>)}</tr></thead>
          <tbody>
            {pages.map(page => (
              <tr key={page.key}>
                <td style={tdStyle}>{page.label}</td>
                {roles.map(role => (
                  <td key={role} style={tdStyle}>
                    <input type="checkbox" checked={(access[page.key] || []).includes(role)} disabled={!canManageUsers} onChange={() => toggleRole(page.key, role)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManageUsers && (
        <div>
          <button style={saveButtonStyle} onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          {saved && <span style={savedChipStyle}>Saved</span>}
        </div>
      )}
    </div>
  );
}
export default PageAccessTab;
