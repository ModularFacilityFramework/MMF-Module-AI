// The module's top-level content (passed to registerDashboardTab in
// frontend/index.js). Core's Dashboard wrapper already applies the page
// padding, so this starts directly with the module's own sub-tab bar
// (docs/MFF-Core_module-ui-guide.md, "Sub-tab bar").
//
// Tabs: Chat (everyone with module access) and Setup (the manifest page
// "setup"; shown only when the backend's requirePage('setup') lets this user
// through). The selected tab is remembered per user with usePageState.
import React, { useEffect, useState } from 'react';
import ChatTab from './ChatTab';
import SetupTab from './SetupTab';
import * as S from './styles';

const TAB_KEYS = ['chat', 'setup'];

function Dashboard({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [activeTab, setActiveTab] = usePageState('ai.main.tab', 'chat', TAB_KEYS);
  // null = still checking, true/false = may this user open Setup?
  const [canSetup, setCanSetup] = useState(null);
  const [setupStatus, setSetupStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/ai/setup/status')
      .then(res => {
        if (cancelled) return;
        setSetupStatus(res.data);
        setCanSetup(true);
      })
      .catch(() => { if (!cancelled) setCanSetup(false); });
    return () => { cancelled = true; };
  }, [api]);

  const tabs = [{ key: 'chat', label: 'Chat' }];
  if (canSetup) tabs.push({ key: 'setup', label: 'Setup' });

  // A saved tab this user can no longer see (Setup access removed) falls back
  // to Chat for display, without overwriting the saved choice.
  const shown = tabs.some(t => t.key === activeTab) ? activeTab : 'chat';
  if (canSetup === null && activeTab === 'setup') return <div style={S.loading}>Loading...</div>;

  return (
    <div>
      <div style={S.subTabBar}>
        {tabs.map(tab => (
          <div key={tab.key} style={S.subTab(tab.key === shown)} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </div>
        ))}
      </div>
      <div style={S.contentPanel}>
        {shown === 'setup'
          ? <SetupTab coreApi={coreApi} initialStatus={setupStatus} />
          : <ChatTab coreApi={coreApi} />}
      </div>
    </div>
  );
}

export default Dashboard;
