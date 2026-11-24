// Setup tab (manifest page "setup"; core's page access decides who sees it).
// The selected sub-tab persists per user (ai.setup.subtab).
import React from 'react';
import ModelCard from './ModelCard';
import ConfigPanel from './ConfigPanel';
import LimitsPanel from './LimitsPanel';
import UsagePanel from './UsagePanel';
import * as S from './styles';

const SUBTABS = [
  { key: 'model', label: 'Model' },
  { key: 'limits', label: 'Limits' },
  { key: 'usage', label: 'Usage' },
  { key: 'config', label: 'Configuration' }
];

function SetupTab({ coreApi, initialStatus }) {
  const [subtab, setSubtab] = coreApi.usePageState('ai.setup.subtab', 'model', SUBTABS.map(t => t.key));

  return (
    <div>
      <div style={{ ...S.subTabBar, marginBottom: '15px' }}>
        {SUBTABS.map(t => (
          <div key={t.key} style={S.subTab(t.key === subtab)} onClick={() => setSubtab(t.key)}>{t.label}</div>
        ))}
      </div>
      {subtab === 'model' && <ModelCard coreApi={coreApi} />}
      {subtab === 'limits' && <LimitsPanel coreApi={coreApi} />}
      {subtab === 'usage' && <UsagePanel coreApi={coreApi} />}
      {subtab === 'config' && <ConfigPanel coreApi={coreApi} initialStatus={initialStatus} />}
    </div>
  );
}

export default SetupTab;
