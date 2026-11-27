// Chat tab: the list of chats on the left, the open chat on the right. What is
// open, searched, collapsed or half-typed is remembered per user (keys ai.chat.*).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './chat/Sidebar';
import Conversation from './chat/Conversation';
import { draftKey } from './chat/Composer';
import css from './chat/chat.module.css';
import * as S from './styles';

const POLL_READY_MS = 30000;
const POLL_NOT_READY_MS = 5000;
const UNDO_MS = 10000;

const UUID = /^[0-9a-f-]{36}$/;
const OPEN_DEFAULT = { today: true, yesterday: true, week: true, older: true, trash: false };
const validSelected = v => v === null || (typeof v === 'string' && UUID.test(v));
const validSidebar = v => Boolean(v) && typeof v.collapsed === 'boolean' && typeof v.search === 'string';
const validOpen = v => Boolean(v) && Object.keys(OPEN_DEFAULT).every(k => typeof v[k] === 'boolean');
const validIds = v => Array.isArray(v) && v.every(x => typeof x === 'string');

function StatusLine({ status }) {
  if (status && status.notice) return <div style={S.warningBanner} role="status">{status.notice}</div>;
  if (!status || status.state === 'ready') return null;
  return <div style={S.warningBanner} role="status">{status.message || 'The AI is not available right now.'}</div>;
}

function ChatTab({ coreApi }) {
  const { api, usePageState, clearPageState } = coreApi;
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [noStorage, setNoStorage] = useState('');
  const [chats, setChats] = useState(null);
  const [trash, setTrash] = useState({ chats: [], days: 0 });
  const [undo, setUndo] = useState(null);

  const [selected, setSelected] = usePageState('ai.chat.selected', null, validSelected);
  const [sidebar, setSidebar] = usePageState('ai.chat.sidebar', { collapsed: false, search: '' }, validSidebar);
  const [open, setOpen] = usePageState('ai.chat.groupsOpen', OPEN_DEFAULT, validOpen);
  const [reasoningOpen, setReasoningOpen] = usePageState('ai.chat.reasoningOpen', [], validIds);
  const [think, setThink] = usePageState('ai.chat.think', true, [true, false]);

  const handed = useRef({}); // drafts carried from "new chat" to the chat just created
  const alive = useRef(true);
  const searchRef = useRef(sidebar.search);
  const requestNo = useRef(0);

  const refresh = useCallback(async () => {
    const no = ++requestNo.current;
    try {
      const q = searchRef.current.trim();
      const [list, bin] = await Promise.all([api.get('/ai/chats', { params: q ? { search: q } : {} }), api.get('/ai/trash')]);
      if (!alive.current || no !== requestNo.current) return;
      setChats(list.data.chats);
      setTrash(bin.data);
      setNoStorage('');
    } catch (err) {
      if (!alive.current || no !== requestNo.current) return;
      if (err.response?.data?.code === 'no_storage') setNoStorage(err.response.data.error);
      else setError(err.response?.data?.error || 'The list of chats could not be loaded.');
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    api.get('/ai/config')
      .then(res => { if (alive.current) setConfig(res.data); })
      .catch((err) => { if (alive.current) setError(err.response?.data?.error || 'The AI settings could not be loaded.'); });
    refresh();
    return () => { alive.current = false; };
  }, [api, refresh]);

  // Is the AI usable? Asked more often while it is not.
  const readyRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let first = true;
    const poll = async () => {
      if (first || document.visibilityState === 'visible') {
        first = false;
        try {
          const res = await api.get('/ai/status');
          if (cancelled) return;
          setStatus(res.data);
          readyRef.current = res.data.state === 'ready' && !res.data.notice;
        } catch (err) {
          if (cancelled) return;
          setStatus({ state: 'down', message: 'The AI module cannot be reached right now.' });
          readyRef.current = false;
        }
      }
      clearTimeout(timer);
      timer = setTimeout(poll, readyRef.current ? POLL_READY_MS : POLL_NOT_READY_MS);
    };
    const onShow = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onShow);
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [api]);

  const setSearch = (search) => {
    searchRef.current = search;
    setSidebar(s => ({ ...s, search }));
  };
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) { firstSearch.current = false; return undefined; }
    const timer = setTimeout(refresh, 300);
    return () => clearTimeout(timer);
  }, [sidebar.search, refresh]);

  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

  const guard = async (fn) => {
    try { await fn(); setError(''); } catch (err) { setError(err.response?.data?.error || 'That did not work. Try again.'); }
    refresh();
  };

  // The open chat no longer exists (deleted elsewhere): open the newest one.
  const onMissing = useCallback((id) => {
    clearPageState(draftKey(id));
    setSelected(null);
    refresh();
  }, [clearPageState, setSelected, refresh]);

  const rename = (chat, title) => guard(() => api.patch(`/ai/chats/${chat.id}`, { title }));
  const remove = chat => guard(async () => {
    await api.delete(`/ai/chats/${chat.id}`);
    clearPageState(draftKey(chat.id));
    if (chat.id === selected) setSelected(null);
    setUndo(chat);
  });
  const restore = chat => guard(async () => {
    await api.post(`/ai/trash/${chat.id}/restore`);
    setUndo(null);
    setSelected(chat.id);
  });

  const onCreated = useCallback((id) => { setSelected(id); refresh(); }, [setSelected, refresh]);
  const handOver = useCallback((id, draft) => {
    handed.current[id] = draft;
    setSelected(id);
    refresh();
  }, [setSelected, refresh]);
  const takeHandOver = useCallback((id) => {
    const d = handed.current[id];
    delete handed.current[id];
    return d || null;
  }, []);

  if (error && !config) return <div style={S.errorBanner}>{error}</div>;
  if (!config) return <div style={S.loading}>Loading...</div>;
  if (!config.configured) {
    return <div style={S.warningBanner}>The AI is not set up yet. An administrator needs to finish its configuration (Setup tab).</div>;
  }
  if (noStorage) return <div style={S.warningBanner}>{noStorage}</div>;

  return (
    <div>
      <StatusLine status={status} />
      {error && (
        <div className={css.errorNote} role="alert">
          {error} <button type="button" className={css.linkButton} onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      <div className={css.page}>
        {sidebar.collapsed ? (
          <div className={css.sidebarClosed}>
            <button type="button" className={css.secondary} title="Show the list" aria-label="Show the list of chats" onClick={() => setSidebar(s => ({ ...s, collapsed: false }))}>›</button>
            <button type="button" className={css.primary} title="New chat" aria-label="New chat" onClick={() => setSelected(null)}>+</button>
          </div>
        ) : (
          <Sidebar
            chats={chats}
            trash={trash.chats}
            trashDays={trash.days}
            selected={selected}
            search={sidebar.search}
            setSearch={setSearch}
            open={open}
            setOpen={setOpen}
            onNew={() => setSelected(null)}
            onSelect={setSelected}
            onRename={rename}
            onDelete={remove}
            onRestore={restore}
            onCollapse={() => setSidebar(s => ({ ...s, collapsed: true }))}
          />
        )}
        <Conversation
          key={selected || 'new'}
          coreApi={coreApi}
          chatId={selected}
          limits={config.limits}
          speech={Boolean(config.speech)}
          level={config.level}
          status={status}
          think={think}
          setThink={setThink}
          reasoningOpen={reasoningOpen}
          setReasoningOpen={setReasoningOpen}
          onMissing={onMissing}
          onChanged={refresh}
          onCreated={onCreated}
          handOver={handOver}
          takeHandOver={takeHandOver}
        />
      </div>
      {undo && (
        <div className={css.toast} role="status">
          "{undo.title}" was deleted. <button type="button" className={css.linkButton} onClick={() => restore(undo)}>Undo</button>
        </div>
      )}
    </div>
  );
}

export default ChatTab;
