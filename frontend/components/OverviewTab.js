// Example component - delete/replace once this module has its own real UI.
// This is now the "Overview" tab inside Dashboard.js - the module's actual
// content, as opposed to Dashboard.js itself (the tab shell) or
// PageAccessTab.js (access-control admin UI). Only ever touches core through
// the coreApi prop passed down from frontend/index.js's register() call -
// never a direct import of anything under mff-core's own src/core/ tree. See
// docs/MFF-Core_module-core-api.md for the contract.
import React, { useEffect, useState } from 'react';
import styles from '../styles/OverviewTab.module.css';

function OverviewTab({ coreApi }) {
  const { api, useAuth, useRoles } = coreApi;
  const { userData } = useAuth();
  const { canManageUsers } = useRoles(userData);
  const [things, setThings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/ai/things')
      .then(res => setThings(res.data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [api]);

  if (loading) return <div className={styles.loading}>Loading...</div>;
  if (error) return <div className={styles.error}>{error}</div>;

  return (
    <div className={styles.container}>
      <h3>AI</h3>
      {canManageUsers && <p className={styles.hint}>You have staff-level access in this module.</p>}
      {things.length === 0 ? (
        <p className={styles.empty}>No things yet.</p>
      ) : (
        <ul>
          {things.map(t => <li key={t.id}>{t.name}</li>)}
        </ul>
      )}
    </div>
  );
}

export default OverviewTab;
