// Chat tab. Step G2: shows whether the AI is usable right now and which model
// is loaded; the chat itself arrives in later steps (G4/G5).
import React, { useEffect, useState } from 'react';
import * as S from './styles';

const POLL_MS = 30000;

function StatusLine({ status }) {
  if (!status) return null;
  if (status.state === 'ready') {
    return (
      <p style={{ ...S.paragraph, fontSize: '13px' }}>
        <span style={S.chip(S.GREEN)}>AI ready</span> Model in use: <strong>{status.model ? status.model.label : status.keyword}</strong>
      </p>
    );
  }
  return <div style={S.warningBanner}>{status.message || 'The AI is not available right now.'}</div>;
}

function ChatTab({ coreApi }) {
  const { api } = coreApi;
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get('/ai/config')
      .then(res => { if (!cancelled) setConfig(res.data); })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || err.message); });

    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      api.get('/ai/status')
        .then(res => { if (!cancelled) setStatus(res.data); })
        .catch(() => { if (!cancelled) setStatus({ state: 'down', message: 'Could not reach the AI status.' }); });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [api]);

  if (error) return <div style={S.errorBanner}>Could not load the AI settings: {error}</div>;
  if (!config) return <div style={S.loading}>Loading...</div>;

  return (
    <div>
      {!config.configured && (
        <div style={S.warningBanner}>
          The AI is not set up yet. An administrator needs to finish its configuration (Setup tab).
        </div>
      )}
      {config.configured && <StatusLine status={status} />}
      <p style={S.paragraph}>
        The chat is being built. When it is ready you will be able to ask questions here and keep your
        conversations in your own server storage.
      </p>
    </div>
  );
}

export default ChatTab;
