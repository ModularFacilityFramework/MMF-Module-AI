// Setup -> Model: what is loaded on the AI server right now, then switching
// and the per-model settings. Refreshes every 10 s while visible.
// Open/closed sections persist per user (ai.setup.modelCard.open).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import SwitchPanel from './SwitchPanel';
import ModelSettings from './ModelSettings';
import SortedTable from './SortedTable';
import * as S from './styles';

const REFRESH_MS = 10000;

const STATE_CHIP = {
  ready: { color: S.GREEN, text: 'Ready' },
  switching: { color: 'warning', text: 'Switching' },
  starting: { color: 'warning', text: 'Starting' },
  down: { color: S.RED, text: 'Down' },
  unconfigured: { color: S.GREY, text: 'Not set up' }
};

const CAPABILITY_TEXT = {
  vision: 'reads images',
  thinking: 'can think before answering (can be switched off)',
  'thinking-r1': 'always thinks before answering',
  tools: 'can use tools'
};

const fmtInt = n => (n === null || n === undefined ? '-' : Math.round(n).toLocaleString());
const gib = mib => (mib === null || mib === undefined ? '-' : (mib / 1024).toFixed(1));

function Row({ label, children }) {
  return (
    <tr>
      <td style={{ ...S.td, width: '35%', color: '#666' }}>{label}</td>
      <td style={S.td}>{children}</td>
    </tr>
  );
}

function Section({ title, open, onToggle, children }) {
  return (
    <div style={{ marginTop: '20px' }}>
      <div style={{ cursor: 'pointer', fontSize: '14px', fontWeight: 600, marginBottom: '8px' }} onClick={onToggle}>
        {open ? '▾' : '▸'} {title}
      </div>
      {open && children}
    </div>
  );
}

const isOpenState = v => v && typeof v === 'object' && !Array.isArray(v);

function ModelCard({ coreApi }) {
  const { api, usePageState } = coreApi;
  const [open, setOpen] = usePageState('ai.setup.modelCard.open', { details: true, catalogue: true, flags: false }, isOpenState);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback((fresh) => {
    setBusy(true);
    return api.get('/ai/setup/model', { params: fresh ? { fresh: 1 } : {} })
      .then(res => { setData(res.data); setError(''); })
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setBusy(false));
  }, [api]);

  useEffect(() => {
    load(false);
    timer.current = setInterval(() => {
      if (document.visibilityState === 'visible') load(false);
    }, REFRESH_MS);
    return () => clearInterval(timer.current);
  }, [load]);

  const toggle = key => setOpen(prev => ({ ...(isOpenState(prev) ? prev : {}), [key]: !(prev && prev[key]) }));

  if (!data && error) return <div style={S.errorBanner}>{error}</div>;
  if (!data) return <div style={S.loading}>Loading...</div>;

  const chip = STATE_CHIP[data.state] || { color: S.GREY, text: data.state };
  const m = data.vllm && data.vllm.metrics;
  const loaded = data.catalogue.find(c => c.keyword === data.keyword);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
        <div style={{ flex: 1, fontSize: '15px' }}>
          <span style={S.chip(chip.color)}>{chip.text}</span>{' '}
          <strong>{data.model ? data.model.label : (data.keyword || 'No model')}</strong>
          {data.variantLabel && <span> · {data.variantLabel}</span>}
          {data.keyword && <span style={{ color: '#999', fontSize: '12px' }}> ({data.controllerKeyword || data.keyword})</span>}
        </div>
        <span style={{ color: '#999', fontSize: '11px', marginRight: '8px' }}>
          checked {new Date(data.checkedAt).toLocaleTimeString()}
        </span>
        <button
          style={{ padding: '5px 10px', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', backgroundColor: S.GREY }}
          onClick={() => load(true)}
          disabled={busy}
        >
          {busy ? 'Checking...' : 'Refresh'}
        </button>
      </div>
      {data.message && <div style={S.warningBanner}>{data.message}</div>}
      {data.changedOutside && (
        <div style={S.warningBanner}>The model was changed outside MFF (directly on the AI server, or by a restart).</div>
      )}
      {error && <div style={S.errorBanner}>Last refresh failed: {error}</div>}
      {data.controllerError && <div style={S.warningBanner}>The model switcher on the AI server could not be reached: {data.controllerError}</div>}
      {data.vllm && !data.vllm.reachable && <div style={S.warningBanner}>The AI server does not answer: {data.vllm.error}</div>}

      <SwitchPanel coreApi={coreApi} loaded={data.controllerKeyword || data.keyword} onFinished={() => load(true)} />

      <Section title="Loaded model" open={open.details} onToggle={() => toggle('details')}>
        <div style={S.tableWrapper}>
          <table style={S.table}>
            <tbody>
              <Row label="What it can do">
                {data.model && data.model.capabilities.length
                  ? data.model.capabilities.map(c => CAPABILITY_TEXT[c] || c).join('; ')
                  : 'text only'}
              </Row>
              <Row label="Precision">{data.precision ? `${data.precision.weights} weights, ${data.precision.kv} KV cache` : '-'}</Row>
              <Row label="Longest conversation it accepts">{fmtInt(data.vllm && data.vllm.maxModelLen)} tokens (about {fmtInt(data.vllm && data.vllm.maxModelLen ? data.vllm.maxModelLen * 0.75 : null)} words)</Row>
              <Row label="Model design">{loaded && loaded.details ? `${loaded.details.architecture}, ${loaded.details.layers} layers, ${loaded.details.dtype}${loaded.details.quantized ? ', compressed' : ', not compressed'}` : '-'}</Row>
              <Row label="Size of its files">{loaded && loaded.details ? `${loaded.details.weightsGB} GB` : '-'}</Row>
              <Row label="GPU memory in use">{data.gpu ? `${gib(data.gpu.memoryUsedMiB)} of ${gib(data.gpu.memoryTotalMiB)} GiB (GPU ${data.gpu.index}, ${data.gpu.name})` : '-'}</Row>
              <Row label="GPU busy / temperature / power">{data.gpu ? `${data.gpu.utilizationPct}% / ${data.gpu.temperatureC} °C / ${Math.round(data.gpu.powerW)} W` : '-'}</Row>
              <Row label="Answers being written now">{m ? `${fmtInt(m.running)} running, ${fmtInt(m.waiting)} waiting` : '-'}</Row>
              <Row label="Room for simultaneous long conversations">{m && m.maxConcurrency ? `about ${m.maxConcurrency.toFixed(1)} at full length (${fmtInt(m.kvCacheTokens)} tokens of working memory, ${Math.round((m.kvCacheUsage || 0) * 100)}% used)` : '-'}</Row>
              <Row label="Tokens handled since the model started">{m ? `${fmtInt(m.promptTokensTotal)} read, ${fmtInt(m.generationTokensTotal)} written` : '-'}</Row>
              <Row label="Server software">{data.vllm && data.vllm.version ? `vLLM ${data.vllm.version}` : '-'}</Row>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Models available on the server" open={open.catalogue} onToggle={() => toggle('catalogue')}>
        <SortedTable
          coreApi={coreApi}
          rows={data.catalogue}
          rememberAs="ai.setup.model.catalogue"
          columns={{
            model: c => c.label,
            can: c => (c.capabilities.length ? c.capabilities.map(x => CAPABILITY_TEXT[x] || x).join('; ') : 'text only'),
            trained: { value: c => (c.details ? c.details.nativeContext : null), type: 'number' },
            files: { value: c => (c.details ? c.details.weightsGB : null), type: 'number' },
            state: c => [c.keyword === data.keyword ? 'loaded' : '', c.knownToController ? '' : 'unknown to the server'].filter(Boolean).join(', ')
          }}
          head={[
            { key: 'model', label: 'Model' }, { key: 'can', label: 'What it can do' }, { key: 'trained', label: 'Longest input it was trained for' },
            { key: 'files', label: 'Files' }, { key: 'state', label: 'State' }
          ]}
          rowKey={c => c.keyword}
          renderRow={c => (
                <tr>
                  <td style={S.td}>{c.label} <span style={{ color: '#999' }}>({c.keyword})</span></td>
                  <td style={S.td}>{c.capabilities.length ? c.capabilities.map(x => CAPABILITY_TEXT[x] || x).join('; ') : 'text only'}</td>
                  <td style={S.td}>{c.details ? `${fmtInt(c.details.nativeContext)} tokens` : '-'}</td>
                  <td style={S.td}>{c.details ? `${c.details.weightsGB} GB` : '-'}</td>
                  <td style={S.td}>
                    {c.keyword === data.keyword ? <span style={S.chip(S.GREEN)}>loaded</span> : null}
                    {!c.knownToController && <span style={S.chip(S.RED)}>unknown to the server</span>}
                    {c.variants && c.variants.length > 0 && (
                      <div style={S.small}>
                        Precisions: {c.variants.map(v => `${v.label}${v.context ? ` (${fmtInt(v.context)} tokens)` : ''}`).join('; ')}
                      </div>
                    )}
                  </td>
                </tr>
          )}
        />
        {data.extraOnController.length > 0 && (
          <p style={{ ...S.paragraph, fontSize: '13px' }}>
            The server also knows: {data.extraOnController.join(', ')} (not listed in MODULE_AI_MODELS, so not offered here).
          </p>
        )}
        <p style={{ ...S.paragraph, fontSize: '13px' }}>
          Only one model can be loaded at a time. The loaded model accepts conversations of up to{' '}
          {fmtInt(data.vllm && data.vllm.maxModelLen)} tokens. Qwen can also be loaded with FP8 numbers (smaller, so longer
          conversations fit); the choice is made when switching.
        </p>
      </Section>

      <Section title="How each model answers" open={Boolean(open.settings)} onToggle={() => toggle('settings')}>
        <ModelSettings coreApi={coreApi} />
      </Section>

      <Section title="Technical: how the model was started" open={open.flags} onToggle={() => toggle('flags')}>
        {data.serveArgs
          ? <pre style={{ background: '#f8f9fa', border: '1px solid #eee', borderRadius: '4px', padding: '10px', fontSize: '12px', whiteSpace: 'pre-wrap' }}>vllm serve {data.serveArgs.join(' ')}</pre>
          : <div style={S.empty}>Not available.</div>}
      </Section>
    </div>
  );
}

export default ModelCard;
