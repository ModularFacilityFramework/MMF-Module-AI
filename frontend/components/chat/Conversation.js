// One open chat: its messages, the answer being written, and the composer.
// Mounted once per chat (key = chat id).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Composer from './Composer';
import { Answer, Question } from './Message';
import follow from './stream';
import css from './chat.module.css';

const errorText = err => err.response?.data?.error || 'The AI module could not be reached. Try again.';
const PAINT_MS = 80; // repaint a streaming answer at most this often

function Conversation({ coreApi, chatId, limits, status, think, setThink, reasoningOpen, setReasoningOpen, onMissing, onChanged, onCreated, handOver, takeHandOver }) {
  const { api } = coreApi;
  const [messages, setMessages] = useState(chatId ? null : []);
  const [live, setLive] = useState(null); // the answer being written
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const following = useRef(null);
  const alive = useRef(true);
  const scroller = useRef(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    const res = await api.get(`/ai/chats/${chatId}`);
    return res.data;
  }, [api, chatId]);

  const track = useCallback((generation) => {
    if (following.current) following.current.abort();
    const abort = new AbortController();
    following.current = abort;
    const g = { ...generation, since: Date.now() - (generation.elapsedMs || 0) };
    let timer = null;
    const paint = () => {
      timer = null;
      if (!abort.signal.aborted) setLive({ ...g });
    };
    const onEvent = (e) => {
      if (abort.signal.aborted) return;
      if (e.type === 'snapshot') Object.assign(g, e.generation);
      else if (e.type === 'content' || e.type === 'reasoning') g[e.type] += e.text;
      else if (e.type === 'set' && (e.kind === 'content' || e.kind === 'reasoning')) g[e.kind] = e.text;
      else if (e.type === 'notice') g.notices = [...g.notices, e.text];
      else if (e.type === 'tool') g.tools = [...(g.tools || []), e.entry];
      else if (e.type === 'queued') g.position = e.position;
      else if (e.type === 'start') { g.state = 'running'; g.position = 0; }
      else if (e.type === 'done') { g.state = 'finished'; g.result = e.result; }
      if (!timer) timer = setTimeout(paint, PAINT_MS);
    };
    setLive({ ...g });
    follow(api, generation.id, onEvent, abort.signal).catch(() => {}).then(async () => {
      if (abort.signal.aborted) return;
      clearTimeout(timer);
      if (g.result && g.result.message) {
        setMessages(list => [...list.filter(m => m.id !== g.result.message.id), g.result.message]);
        setLive(null);
      } else {
        // Finished while we were not listening: the chat itself has the answer.
        try {
          const data = await load();
          if (abort.signal.aborted) return;
          setMessages(data.messages);
          if (data.generation && data.generation.id !== generation.id) { track(data.generation); return; }
        } catch (err) { setError(errorText(err)); }
        setLive(null);
      }
      onChanged();
    });
  }, [api, load, onChanged]);

  useEffect(() => {
    alive.current = true;
    if (chatId) {
      load().then((data) => {
        if (!alive.current) return;
        setMessages(data.messages);
        if (data.generation) track(data.generation);
      }).catch((err) => {
        if (!alive.current) return;
        if (err.response?.status === 404) onMissing(chatId);
        else { setMessages([]); setError(errorText(err)); }
      });
    }
    return () => {
      alive.current = false;
      if (following.current) following.current.abort(); // only stops listening; the answer goes on
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  // Runs a request that starts an answer. Resolves to true when it started.
  const ask = async (request, apply) => {
    setError('');
    setBusy(true);
    try {
      const res = await request();
      stick.current = true;
      if (alive.current) {
        setMessages(list => apply(list || [], res.data.question));
        track(res.data.generation);
      }
      onChanged();
      return true;
    } catch (err) {
      if (alive.current) setError(errorText(err));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const send = async (text, fileIds) => {
    if (!chatId) {
      // First question: create the chat, ask, then open it.
      setError('');
      setBusy(true);
      let id = null;
      try {
        id = (await api.post('/ai/chats', {})).data.chat.id;
        await api.post(`/ai/chats/${id}/messages`, { text, fileIds, think });
        onCreated(id);
        return true;
      } catch (err) {
        if (id) api.delete(`/ai/chats/${id}`).catch(() => {});
        if (alive.current) setError(errorText(err));
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    }
    return ask(() => api.post(`/ai/chats/${chatId}/messages`, { text, fileIds, think }), (list, q) => [...list, q]);
  };

  const lastQuestion = [...(messages || [])].reverse().find(m => m.role === 'user');
  const upToLast = list => list.slice(0, list.findIndex(m => m.id === lastQuestion.id));

  const regenerate = () => ask(() => api.post(`/ai/chats/${chatId}/regenerate`, { think }), (list, q) => [...upToLast(list), q]);
  const edit = (m, text) => ask(
    () => api.post(`/ai/chats/${chatId}/edit`, { messageId: m.id, text, think }),
    (list, q) => [...upToLast(list), q]
  );
  const stop = () => {
    if (live) api.post(`/ai/generations/${live.id}/stop`).catch(() => {});
  };
  const ensureChat = async () => (await api.post('/ai/chats', {})).data.chat.id;

  const download = async (f) => {
    try {
      const res = await api.get(`/ai/chats/${chatId}/files/${f.id}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { setError('The file could not be downloaded.'); }
  };

  // Images the AI made, shown in its answers; loaded once per file.
  const images = useRef(new Map());
  const loadImage = useCallback(async (f) => {
    if (!images.current.has(f.id)) {
      images.current.set(f.id, api.get(`/ai/chats/${chatId}/files/${f.id}`, { responseType: 'blob' }).then(r => URL.createObjectURL(r.data)));
    }
    return images.current.get(f.id);
  }, [api, chatId]);
  useEffect(() => () => { images.current.forEach(p => p.then(u => URL.revokeObjectURL(u)).catch(() => {})); }, []);

  const toggleThinking = id => setReasoningOpen(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id].slice(-50)));

  const answering = Boolean(live);
  const ready = status && status.state === 'ready';
  const liveMessage = live && {
    id: live.assistantId, content: live.content, reasoning: live.reasoning, notices: live.notices, tools: live.tools, since: live.since,
    waiting: live.position > 0 ? `Waiting for other answers to finish (position ${live.position})…` : null
  };
  const last = messages && messages[messages.length - 1];

  return (
    <div className={css.conversation}>
      <div
        className={css.messages}
        ref={scroller}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}
      >
        {messages === null && !error && <div className={css.centre}>Loading...</div>}
        {messages && !messages.length && !live && (
          <div className={css.centre}>
            <p>Ask a question, or attach files and ask about them.</p>
            <p className={css.muted}>
              The AI runs on the facility's own computers: nothing is sent outside. Conversations are kept in your own
              server storage until you delete them. The AI can make mistakes, so check important answers.
            </p>
          </div>
        )}
        {(messages || []).map(m => (m.role === 'user' ? (
          <Question key={m.id} message={m} onDownload={download} onEdit={edit} canEdit={!answering && !busy && ready && m === lastQuestion} />
        ) : (
          <Answer
            key={m.id}
            message={m}
            thinkingOpen={reasoningOpen.includes(m.id)}
            onDownload={download}
            loadImage={loadImage}
            toolsOpen={reasoningOpen.includes(`tools:${m.id}`)}
            onToggleTools={() => toggleThinking(`tools:${m.id}`)}
            onToggleThinking={() => toggleThinking(m.id)}
            canRegenerate={!answering && !busy && ready && m === last}
            onRegenerate={regenerate}
          />
        )))}
        {liveMessage && (
          <Answer
            key={liveMessage.id}
            live
            message={liveMessage}
            thinkingOpen={reasoningOpen.includes(liveMessage.id)}
            toolsOpen={reasoningOpen.includes(`tools:${liveMessage.id}`)}
            onToggleTools={() => toggleThinking(`tools:${liveMessage.id}`)}
            onToggleThinking={() => toggleThinking(liveMessage.id)}
          />
        )}
        {!answering && !busy && last && last.role === 'user' && (
          <div className={css.notice}>
            This question has no answer (the server may have restarted).{' '}
            <button type="button" className={css.linkButton} disabled={!ready} onClick={regenerate}>Answer it now</button>
          </div>
        )}
      </div>
      {error && (
        <div className={css.errorNote} role="alert">
          {error} <button type="button" className={css.linkButton} onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      <Composer
        coreApi={coreApi}
        chatId={chatId}
        limits={limits}
        model={status ? status.model : null}
        think={think}
        setThink={setThink}
        answering={answering}
        ready={Boolean(ready) && messages !== null}
        onSend={send}
        onStop={stop}
        ensureChat={ensureChat}
        handOver={handOver}
        takeHandOver={takeHandOver}
        onError={setError}
      />
    </div>
  );
}

export default Conversation;
