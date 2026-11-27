// Setup -> Configuration: shows whether the module's
// configuration in core's .env is complete. Values are never shown - only
// whether each MODULE_AI_* key is set - except the model list, which is
// display data. Later steps add the Model, Benchmark, Tools, Limits and
// Usage sub-tabs.
import React, { useCallback, useState } from 'react';
import SortedTable from './SortedTable';
import * as S from './styles';

const CAPABILITY_TEXT = {
  vision: 'reads images',
  thinking: 'can think before answering (can be switched off)',
  'thinking-r1': 'always thinks before answering',
  tools: 'can use tools'
};

function ConfigPanel({ coreApi, initialStatus }) {
  const { api } = coreApi;
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setError('');
    api.get('/ai/setup/status')
      .then(res => setStatus(res.data))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setRefreshing(false));
  }, [api]);

  if (!status) return <div style={S.loading}>Loading...</div>;
  const { config } = status;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
        <h3 style={{ margin: 0, fontSize: '16px', flex: 1 }}>Configuration</h3>
        <button
          style={{ padding: '5px 10px', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', backgroundColor: S.GREY }}
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? 'Checking...' : 'Check again'}
        </button>
      </div>
      {error && <div style={S.errorBanner}>{error}</div>}
      {config.missing.length > 0 ? (
        <div style={S.warningBanner}>
          Missing settings: {config.missing.join(', ')}. They go in core's <code>App_backend/.env</code>,
          followed by a restart of the MFF backend.
        </div>
      ) : (
        <p style={S.paragraph}>All required settings are present.</p>
      )}
      {config.modelErrors.length > 0 && (
        <div style={S.warningBanner}>Problems in MODULE_AI_MODELS: {config.modelErrors.join('; ')}</div>
      )}

      <SortedTable
        coreApi={coreApi}
        rows={config.keys}
        rememberAs="ai.setup.config.settings"
        columns={{
          key: k => k.key,
          needed: k => (k.required ? 'required' : 'optional'),
          state: k => (k.set ? 'set' : k.required ? 'missing' : 'not set')
        }}
        head={[{ key: 'key', label: 'Setting' }, { key: 'needed', label: 'Needed' }, { key: 'state', label: 'State' }]}
        rowKey={k => k.key}
        renderRow={k => (
              <tr>
                <td style={S.td}><code>{k.key}</code></td>
                <td style={S.td}>{k.required ? 'required' : 'optional'}</td>
                <td style={S.td}>
                  {k.set
                    ? <span style={S.chip(S.GREEN)}>set</span>
                    : <span style={k.required ? S.chip(S.RED) : S.chip('warning')}>{k.required ? 'missing' : 'not set (default used)'}</span>}
                </td>
              </tr>
        )}
      />

      <h3 style={{ fontSize: '16px', marginTop: '25px' }}>Models</h3>
      {config.models.length === 0 ? (
        <div style={S.empty}>No models configured.</div>
      ) : (
        <SortedTable
          coreApi={coreApi}
          rows={config.models}
          rememberAs="ai.setup.config.models"
          columns={{
            keyword: m => m.keyword,
            label: m => m.label,
            capabilities: m => (m.capabilities.length ? m.capabilities.map(c => CAPABILITY_TEXT[c] || c).join('; ') : 'text only')
          }}
          head={[{ key: 'keyword', label: 'Keyword' }, { key: 'label', label: 'Name' }, { key: 'capabilities', label: 'What it can do' }]}
          rowKey={m => m.keyword}
          renderRow={m => (
                <tr>
                  <td style={S.td}><code>{m.keyword}</code></td>
                  <td style={S.td}>{m.label}</td>
                  <td style={S.td}>
                    {m.capabilities.length
                      ? m.capabilities.map(c => CAPABILITY_TEXT[c] || c).join('; ')
                      : 'text only'}
                  </td>
                </tr>
          )}
        />
      )}
      <p style={{ ...S.paragraph, marginTop: '15px', fontSize: '13px' }}>
        Chats and uploads will be kept in each user's server storage, in the folder <code>{config.storageSubdir}</code>.
        {config.apiKeyInUse ? ' The AI server key is in use.' : ' The AI server has no key (as decided).'}
      </p>
    </div>
  );
}

export default ConfigPanel;
