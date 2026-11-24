// Setup tab (manifest page "setup"; core's page access decides who sees it).
// Sub-tabs: Model (what is loaded) and Configuration (is the module set up).
// Later steps add Benchmark, Tools, Limits and Usage. The selected sub-tab
// persists per user (ai.setup.subtab).
import React from 'react';
import ModelCard from './ModelCard';
import ConfigPanel from './ConfigPanel';
import * as S from './styles';

const SUBTABS = [
  { key: 'model', label: 'Model' },
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
      {subtab === 'config'
        ? <ConfigPanel coreApi={coreApi} initialStatus={initialStatus} />
        : <ModelCard coreApi={coreApi} />}
    </div>
  );
}

export default SetupTab;
