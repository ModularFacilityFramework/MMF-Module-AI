// One question or one answer.
import React, { Suspense, useEffect, useState } from 'react';
import copyText from './copyText';
import css from './chat.module.css';

// The Markdown renderer is large: load it only when an answer is shown.
const Markdown = React.lazy(() => import('./Markdown'));

const seconds = ms => (ms < 1000 ? 'less than a second' : `${Math.round(ms / 1000)} s`);

// "10:32" today, else "26 Nov 2026, 10:32" (the viewer's own clock).
function when(at) {
  const d = new Date(at);
  if (!at || Number.isNaN(d.getTime())) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fileSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return <button type="button" className={css.linkButton} onClick={onClick}>{copied ? 'Copied' : 'Copy'}</button>;
}

// An image the AI made (a chart): shown in the answer, loaded with the
// person's own login like a download.
function AnswerImage({ file, loadImage }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    loadImage(file).then(u => alive && setSrc(u)).catch(() => {});
    return () => { alive = false; };
  }, [file, loadImage]);
  return src ? <img src={src} alt={file.name} data-testid="answer-image" style={{ maxWidth: '100%', maxHeight: '480px', display: 'block', margin: '8px 0', border: '1px solid #eee' }} /> : null;
}

function FileChip({ file, title, onDownload }) {
  return (
    <button type="button" className={css.chip} title={title} onClick={() => onDownload(file)}>
      {file.kind === 'image' ? '🖼️' : '📄'} {file.name} <span className={css.muted}>{fileSize(file.bytes)}</span>
    </button>
  );
}

export function Question({ message, canEdit, onEdit, onDownload }) {
  const [draft, setDraft] = useState(null);
  return (
    <div className={css.question} data-testid="question">
      {draft === null ? (
        <>
          {message.text && <div className={css.questionText}>{message.text}</div>}
          {message.files && message.files.length > 0 && (
            <div className={css.chips}>
              {message.files.map(f => <FileChip key={f.id} file={f} title="Download the original file" onDownload={onDownload} />)}
            </div>
          )}
          <div className={css.messageTools}>
            {message.at && <span className={css.muted} title={new Date(message.at).toLocaleString()} data-testid="message-time">{when(message.at)}</span>}
            <CopyButton text={message.text} />
            {canEdit && <button type="button" className={css.linkButton} onClick={() => setDraft(message.text)}>Edit</button>}
          </div>
        </>
      ) : (
        <div>
          <textarea className={css.editArea} value={draft} autoFocus rows={Math.min(10, draft.split('\n').length + 1)} onChange={e => setDraft(e.target.value)} />
          <div className={css.messageTools}>
            <button type="button" className={css.primary} onClick={async () => { if (await onEdit(message, draft)) setDraft(null); }}>Ask again</button>
            <button type="button" className={css.secondary} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// "12 s", counting: shows that a long wait is still going on.
function Elapsed({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span>{Math.max(0, Math.round((now - since) / 1000))} s</span>;
}

function Thinking({ message, live, open, onToggle }) {
  if (!message.reasoning) return null;
  const stillThinking = live && !message.content;
  const label = stillThinking ? 'Thinking…' : message.reasoningMs ? `Thought for ${seconds(message.reasoningMs)}` : 'Thinking';
  return (
    <div className={css.thinking}>
      <button type="button" className={css.thinkingToggle} aria-expanded={open} onClick={onToggle}>
        {open ? '▾' : '▸'} {label} {stillThinking && <Elapsed since={message.since} />}
      </button>
      {open && <div className={css.thinkingText}>{message.reasoning}</div>}
    </div>
  );
}

function ToolUse({ tools, open, onToggle }) {
  if (!tools || !tools.length) return null;
  const names = [...new Set(tools.map(t => t.name))].join(', ');
  const failed = tools.filter(t => !t.ok).length;
  return (
    <div className={css.thinking}>
      <button type="button" className={css.thinkingToggle} aria-expanded={open} onClick={onToggle}>
        {open ? '▾' : '▸'} Used {tools.length === 1 ? 'a tool' : `${tools.length} tools`}: {names}
        {failed > 0 && <span className={css.toolFailed}> {failed === tools.length ? 'did not work' : `${failed} did not work`}</span>}
      </button>
      {open && tools.map((t, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className={css.thinkingText}>{t.name} {t.args !== '{}' && t.args}{'\n'}{t.ok ? '→ ' : '✗ '}{t.result}</div>
      ))}
    </div>
  );
}

const ENDINGS = {
  stopped: 'Stopped.',
  length: 'The answer reached the length limit and was cut off. Ask "continue" for more.'
};

export function Answer({ message, live, thinkingOpen, onToggleThinking, toolsOpen, onToggleTools, onDownload, loadImage, canRegenerate, onRegenerate }) {
  const ending = message.error || ENDINGS[message.status];
  return (
    <div className={css.answer} data-testid="answer">
      <Thinking message={message} live={live} open={thinkingOpen} onToggle={onToggleThinking} />
      <ToolUse tools={message.tools} open={toolsOpen} onToggle={onToggleTools} />
      {message.content && (
        <Suspense fallback={<div className={css.questionText}>{message.content}</div>}>
          <Markdown text={message.content} />
        </Suspense>
      )}
      {live && !message.content && !message.reasoning && <div className={css.muted}>{message.waiting || 'Reading your question…'} <Elapsed since={message.since} /></div>}
      {live && message.content && <span className={css.cursor} />}
      {loadImage && (message.files || []).filter(f => f.kind === 'image').map(f => <AnswerImage key={`img-${f.id}`} file={f} loadImage={loadImage} />)}
      {message.files && message.files.length > 0 && (
        <div className={css.chips}>
          {message.files.map(f => <FileChip key={f.id} file={f} title="Download this file" onDownload={onDownload} />)}
        </div>
      )}
      {(message.notices || []).map(n => <div key={n} className={css.notice}>{n}</div>)}
      {!live && ending && <div className={message.status === 'error' ? css.errorNote : css.notice}>{ending}</div>}
      {message.unsaved && <div className={css.errorNote}>This answer is not saved. Copy it if you need it.</div>}
      {!live && (
        <div className={css.messageTools}>
          {message.content && <CopyButton text={message.content} />}
          {canRegenerate && <button type="button" className={css.linkButton} onClick={onRegenerate}>Answer again</button>}
          <span className={css.muted}>
            {[when(message.at), message.model, message.usage && `${message.usage.completion} tokens`, message.ms > 0 && seconds(message.ms)].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
    </div>
  );
}
