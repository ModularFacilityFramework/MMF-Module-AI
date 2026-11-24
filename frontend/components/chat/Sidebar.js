// The list of the user's chats: new, search, rename, delete, restore.
import React, { useState } from 'react';
import css from './chat.module.css';

const GROUPS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'older', label: 'Older' }
];

function groupOf(iso) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = (midnight.getTime() - new Date(iso).getTime()) / 86400000;
  if (days <= 0) return 'today';
  if (days <= 1) return 'yesterday';
  if (days <= 7) return 'week';
  return 'older';
}

function Row({ chat, selected, onSelect, onRename, onDelete }) {
  const [name, setName] = useState(null);
  const [menu, setMenu] = useState(false);
  const finish = () => {
    const next = name.trim();
    setName(null);
    if (next && next !== chat.title) onRename(chat, next);
  };
  if (name !== null) {
    return (
      <input
        className={css.renameInput}
        value={name}
        autoFocus
        maxLength={120}
        aria-label="Chat name"
        onChange={e => setName(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setName(null);
        }}
      />
    );
  }
  return (
    <div className={`${css.row} ${selected ? css.rowSelected : ''}`} onMouseLeave={() => setMenu(false)}>
      <button type="button" className={css.rowTitle} title={chat.title} onClick={() => onSelect(chat.id)}>
        {chat.title}{chat.answering && <span className={css.muted}> · answering</span>}
        {chat.snippet && <span className={css.snippet}>{chat.snippet}</span>}
      </button>
      <button type="button" className={css.rowMenuButton} aria-label={`Options for ${chat.title}`} onClick={() => setMenu(m => !m)}>…</button>
      {menu && (
        <div className={css.rowMenu}>
          <button type="button" onClick={() => { setMenu(false); setName(chat.title); }}>Rename</button>
          <button type="button" className={css.danger} onClick={() => { setMenu(false); onDelete(chat); }}>Delete</button>
        </div>
      )}
    </div>
  );
}

function Sidebar({ chats, trash, trashDays, selected, search, setSearch, open, setOpen, onNew, onSelect, onRename, onDelete, onRestore, onCollapse }) {
  const toggle = key => setOpen(o => ({ ...o, [key]: !o[key] }));
  const rows = list => list.map(c => (
    <Row key={c.id} chat={c} selected={c.id === selected} onSelect={onSelect} onRename={onRename} onDelete={onDelete} />
  ));
  return (
    <div className={css.sidebar}>
      <div className={css.sidebarTop}>
        <button type="button" className={css.primary} onClick={onNew}>New chat</button>
        <button type="button" className={css.secondary} title="Hide the list" aria-label="Hide the list of chats" onClick={onCollapse}>‹</button>
      </div>
      <input className={css.search} type="search" placeholder="Search chats" aria-label="Search chats" value={search} onChange={e => setSearch(e.target.value)} />
      <div className={css.list}>
        {chats === null && <div className={css.centre}>Loading...</div>}
        {chats && search.trim() && (chats.length ? rows(chats) : <div className={css.muted}>Nothing found.</div>)}
        {chats && !search.trim() && !chats.length && <div className={css.muted}>No chats yet.</div>}
        {chats && !search.trim() && GROUPS.map((g) => {
          const list = chats.filter(c => groupOf(c.updatedAt) === g.key);
          if (!list.length) return null;
          return (
            <div key={g.key}>
              <button type="button" className={css.groupTitle} aria-expanded={open[g.key]} onClick={() => toggle(g.key)}>
                {open[g.key] ? '▾' : '▸'} {g.label} ({list.length})
              </button>
              {open[g.key] && rows(list)}
            </div>
          );
        })}
        {trash.length > 0 && !search.trim() && (
          <div className={css.trash}>
            <button type="button" className={css.groupTitle} aria-expanded={open.trash} onClick={() => toggle('trash')}>
              {open.trash ? '▾' : '▸'} Deleted ({trash.length})
            </button>
            {open.trash && <div className={css.muted}>Removed for good {trashDays} days after deletion.</div>}
            {open.trash && trash.map(c => (
              <div key={c.id} className={css.row}>
                <span className={css.rowTitle} title={c.title}>{c.title}</span>
                <button type="button" className={css.linkButton} onClick={() => onRestore(c)}>Restore</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Sidebar;
