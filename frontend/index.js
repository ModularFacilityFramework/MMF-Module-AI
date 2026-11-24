// Module entry point. mff-core's auto-loader (App_frontend/src/core/moduleLoader.js)
// finds this file and calls register(coreApi) once at app startup - see
// docs/MFF-Core_module-core-api.md for the full coreApi contract. This file is the ONLY place
// this module's frontend talks to core.
//
// registerDashboardTab and registerMenuPage are independent, not exclusive -
// a module may use either or both:
//   - registerDashboardTab: embeds as an extra tab inside the existing
//     Dashboard tab bar. Good for something small/contextual.
//   - registerMenuPage: gets its own standalone page, reached via a button in
//     the left-hand sidebar and its own route. Good for a module with enough
//     of its own UI to deserve a full page.
// This template registers both, pointed at the same Dashboard component
// (see frontend/components/Dashboard.js - the module's own tab bar,
// styled per docs/MFF-Core_module-ui-guide.md), so both wiring paths are exercised.
// Delete whichever this module doesn't need.
//
// `position` below is NOT part of coreApi today - registerDashboardTab only
// reads {key, label, component}, so this field is currently a no-op. It's
// left in as the shape of a pending core feature request (numeric ordering
// for the Dashboard tab bar, WordPress-style magic numbers, so a module can
// land e.g. right after the File Upload tab). Remove it if that request
// gets dropped; update the value once core actually implements and
// publishes real position numbers.
import Dashboard from './components/Dashboard';
import manifest from '../module.manifest.json';

export function register(coreApi) {
  coreApi.registerDashboardTab(manifest.id, {
    key: manifest.id,
    label: manifest.label,
    component: () => <Dashboard coreApi={coreApi} />,
    position: 11 // placeholder - see comment above; real value depends on core's published numbers
  });

  coreApi.registerMenuPage(manifest.id, {
    key: manifest.id,
    label: manifest.label,
    path: `/${manifest.id}`,
    component: () => <Dashboard coreApi={coreApi} />
  });
}
