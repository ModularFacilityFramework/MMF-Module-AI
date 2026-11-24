// Module entry point. mff-core's auto-loader (App_frontend/src/core/moduleLoader.js)
// finds this file and calls register(coreApi) once at app startup - see
// docs/MFF-Core_module-core-api.md for the full coreApi contract. This file is
// the ONLY place this module's frontend talks to core.
//
// One Dashboard tab ("AI") with a direct sidebar button (sidebarEntry), as
// docs/MFF-Core_module-ui-guide.md recommends. No pageKey here: who may use
// the chat is core's module access. The Setup sub-tab is the manifest page
// "setup" and is shown only to users core grants it (see Dashboard.js).
import Dashboard from './components/Dashboard';
import manifest from '../module.manifest.json';

export function register(coreApi) {
  coreApi.registerDashboardTab(manifest.id, {
    key: manifest.id,
    label: manifest.label,
    sidebarEntry: true,
    component: () => <Dashboard coreApi={coreApi} />
  });
}
