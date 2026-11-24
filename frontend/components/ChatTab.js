// Chat tab. Step G1 only shows whether the module is configured and which
// models it knows; the chat itself arrives in later steps (G4/G5).
import React, { useEffect, useState } from 'react';
import * as S from './styles';

function ChatTab({ coreApi }) {
  const { api } = coreApi;
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get('/ai/config')
      .then(res => { if (!cancelled) setConfig(res.data); })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || err.message); });
    return () => { cancelled = true; };
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
      <p style={S.paragraph}>
        The chat is being built. When it is ready you will be able to ask questions here and keep your
        conversations in your own server storage.
      </p>
      {config.models.length > 0 && (
        <p style={S.paragraph}>
          Models on this server: {config.models.map(m => m.label).join(', ')}.
        </p>
      )}
    </div>
  );
}

export default ChatTab;
