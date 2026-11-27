// The box where a question is written. Its draft (text and uploaded files) is
// remembered per chat, so leaving the page or reloading loses nothing.
import React, { useEffect, useRef, useState } from 'react';
import { fileSize } from './Message';
import css from './chat.module.css';

export const draftKey = chatId => `ai.chat.draft:${chatId || 'new'}`;
const EMPTY = { text: '', files: [] };
const validDraft = d => Boolean(d) && typeof d.text === 'string' && Array.isArray(d.files)
  && d.files.every(f => f && typeof f.id === 'string' && typeof f.name === 'string');
// Page state holds at most 64 KB per key: a longer draft stays in this tab only.
const DRAFT_MAX = 50000;

// The microphone (speech to text): records in the browser, the text comes back
// from Whisper on the AI server and is added to the question to check and send.
const MAX_RECORDING_S = 300;

function Microphone({ api, disabled, onText, onError }) {
  const [state, setState] = useState('idle'); // idle | recording | working
  const [seconds, setSeconds] = useState(0);
  const rec = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => { clearInterval(timer.current); if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); }, []);
  const start = async () => {
    if (!navigator.mediaDevices || !window.MediaRecorder) { onError('This browser cannot record sound here (it needs a secure https page).'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (err) { onError('The microphone could not be used (no permission, or no microphone).'); return; }
    const chunks = [];
    const r = new MediaRecorder(stream);
    rec.current = r;
    r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    r.onstop = async () => {
      clearInterval(timer.current);
      stream.getTracks().forEach(t => t.stop());
      setState('working');
      try {
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        const res = await api.post('/ai/transcribe', blob, { headers: { 'Content-Type': 'application/octet-stream' }, timeout: 0 });
        if (res.data.text) onText(res.data.text); else onError('Nothing was understood in the recording.');
      } catch (err) {
        onError(err.response?.data?.error || 'The recording could not be turned into text.');
      }
      setState('idle');
    };
    r.start();
    setSeconds(0);
    setState('recording');
    timer.current = setInterval(() => setSeconds((s) => { if (s + 1 >= MAX_RECORDING_S && r.state === 'recording') r.stop(); return s + 1; }), 1000);
  };
  const stop = () => { if (rec.current && rec.current.state === 'recording') rec.current.stop(); };
  if (state === 'recording') return <button type="button" className={css.stop} data-testid="mic" aria-label="Stop recording" onClick={stop}>■ Stop ({seconds} s)</button>;
  return (
    <button type="button" className={css.secondary} data-testid="mic" aria-label="Speak your question" title="Speak your question: the text is written into the box for you to check" disabled={disabled || state === 'working'} onClick={start}>
      {state === 'working' ? 'Writing…' : '🎤 Speak'}
    </button>
  );
}

function Composer({ coreApi, chatId, limits, speech, model, think, setThink, answering, ready, onSend, onStop, ensureChat, handOver, takeHandOver, onError }) {
  const { api } = coreApi;
  const [saved, setSaved, resetSaved] = coreApi.usePageState(draftKey(chatId), EMPTY, validDraft);
  const [draft, setDraftState] = useState(saved);
  const [uploads, setUploads] = useState([]); // names being uploaded
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  const textArea = useRef(null);
  const latest = useRef(draft);
  const mounted = useRef(true);

  const setDraft = (change) => {
    const next = { ...latest.current, ...change };
    latest.current = next;
    setDraftState(next);
    if (!next.text && !next.files.length) resetSaved();
    else if (next.text.length <= DRAFT_MAX) setSaved(next);
  };

  useEffect(() => {
    mounted.current = true;
    // A draft carried over from "new chat" when the first upload created the chat.
    const carried = takeHandOver(chatId);
    if (carried) setDraft(carried);
    // Forget draft files that no longer exist.
    const ids = latest.current.files.map(f => f.id);
    if (chatId && ids.length) {
      api.get(`/ai/chats/${chatId}/files`, { params: { ids: ids.join(',') } }).then((res) => {
        const have = new Set(res.data.files.map(f => f.id));
        const kept = latest.current.files.filter(f => have.has(f.id) || !ids.includes(f.id));
        if (mounted.current && kept.length !== latest.current.files.length) setDraft({ files: kept });
      }).catch(() => {});
    } else if (!chatId && ids.length) {
      setDraft({ files: [] });
    }
    if (textArea.current) textArea.current.focus({ preventScroll: true });
    return () => { mounted.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grow with the text. Measured again when the box changes width (first
  // layout, window resize, the list being hidden).
  useEffect(() => {
    const el = textArea.current;
    if (!el) return undefined;
    const fit = () => {
      el.style.height = 'auto';
      if (el.value) el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    let width = 0;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [draft.text]);

  const upload = async (list) => {
    const picked = [...list];
    if (!picked.length) return;
    if (latest.current.files.length + uploads.length + picked.length > limits.maxFilesPerMessage) {
      onError(`Attach at most ${limits.maxFilesPerMessage} files to one question.`);
      return;
    }
    const tooBig = picked.find(f => f.size > limits.maxFileMB * 1048576);
    if (tooBig) {
      onError(`${tooBig.name}: files can be at most ${limits.maxFileMB} MB.`);
      return;
    }
    onError('');
    setUploads(u => [...u, ...picked.map(f => f.name)]);
    let id = chatId;
    const done = [];
    for (const f of picked) {
      try {
        if (!id) id = await ensureChat();
        const form = new FormData();
        form.append('file', f, f.name || 'pasted-image.png');
        const res = await api.post(`/ai/chats/${id}/files`, form, { timeout: 0, headers: { 'Content-Type': 'multipart/form-data' } });
        done.push(res.data.file);
        if (chatId && mounted.current) setDraft({ files: [...latest.current.files, res.data.file] });
        if (res.data.file.truncated) onError(`${f.name} is very long: only its beginning can be read.`);
      } catch (err) {
        onError(`${f.name || 'File'}: ${err.response?.data?.error || 'the upload failed.'}`);
      }
      if (mounted.current) setUploads(u => { const i = u.indexOf(f.name); return i < 0 ? u : [...u.slice(0, i), ...u.slice(i + 1)]; });
    }
    if (!chatId && id) {
      const carried = { text: latest.current.text, files: [...latest.current.files, ...done] };
      resetSaved();
      handOver(id, carried);
    }
  };

  const removeFile = (f) => {
    setDraft({ files: latest.current.files.filter(x => x.id !== f.id) });
    if (chatId) api.delete(`/ai/chats/${chatId}/files/${f.id}`).catch(() => {});
  };

  const canSend = ready && !answering && !sending && !uploads.length && (draft.text.trim() || draft.files.length);
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const sent = latest.current;
    const ok = await onSend(sent.text, sent.files.map(f => f.id));
    if (ok) {
      latest.current = EMPTY;
      resetSaved();
    }
    if (mounted.current) {
      if (ok) setDraftState(EMPTY);
      setSending(false);
    }
  };

  const caps = model ? model.capabilities : [];
  const hasImage = draft.files.some(f => f.kind === 'image');

  return (
    <div
      className={`${css.composer} ${dragging ? css.dragging : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}
    >
      {(draft.files.length > 0 || uploads.length > 0) && (
        <div className={css.chips}>
          {draft.files.map(f => (
            <span key={f.id} className={css.chip}>
              {f.kind === 'image' ? '🖼️' : '📄'} {f.name} <span className={css.muted}>{fileSize(f.bytes || 0)}</span>
              <button type="button" className={css.chipRemove} aria-label={`Remove ${f.name}`} onClick={() => removeFile(f)}>×</button>
            </span>
          ))}
          {uploads.map((n, i) => <span key={`${n}-${i}`} className={css.chip}>Reading {n}…</span>)}
        </div>
      )}
      {hasImage && model && !caps.includes('vision') && (
        <div className={css.notice}>{model.label} cannot see images. It will only be told that an image was attached.</div>
      )}
      <textarea
        ref={textArea}
        className={css.input}
        rows={1}
        value={draft.text}
        placeholder="Ask the AI…"
        aria-label="Your question"
        onChange={e => setDraft({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const pasted = [...(e.clipboardData?.files || [])];
          if (pasted.length) {
            e.preventDefault();
            upload(pasted);
          }
        }}
      />
      <div className={css.composerBar}>
        <input ref={fileInput} type="file" multiple hidden data-testid="file-input" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        <button type="button" className={css.secondary} disabled={answering} onClick={() => fileInput.current.click()}>Attach files</button>
        {speech && (
          <Microphone
            api={api}
            disabled={answering}
            onError={onError}
            onText={(t) => { const cur = latest.current.text; setDraft({ text: cur ? `${cur.replace(/\s+$/, '')} ${t}` : t }); if (textArea.current) textArea.current.focus(); }}
          />
        )}
        {caps.includes('thinking') && (
          <label className={css.thinkToggle} title="Slower, better for hard questions. The thinking is shown separately from the answer.">
            <input type="checkbox" checked={think} onChange={e => setThink(e.target.checked)} /> Think first
          </label>
        )}
        {caps.includes('thinking-r1') && <span className={css.muted}>This model always thinks first</span>}
        <span className={css.spacer} />
        <span className={css.muted}>{model ? model.label : ''}</span>
        {answering
          ? <button type="button" className={css.stop} onClick={onStop}>Stop</button>
          : <button type="button" className={css.primary} disabled={!canSend} onClick={send}>{sending ? 'Sending…' : 'Send'}</button>}
      </div>
    </div>
  );
}

export default Composer;
