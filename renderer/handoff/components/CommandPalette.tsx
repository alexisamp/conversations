// CommandPalette.tsx — ⌘K palette. Minimalist, single column. NOTHING shows until
// the user types; on each keystroke it returns suggestions (people / companies / files)
// grouped, and ↵ pulls the selected result into the active chat.
//
// Styling: classes ".pal-overlay", ".pal", ".pal-*", ".pal-res" in styles/styles.css.
//
// INTEGRATION: replace `search()` with your real cross-source search (WhatsApp +
// LinkedIn + reThink). The component is otherwise self-contained.

import React, { useEffect, useRef, useState } from 'react';

const Icon = ({ name }: { name: string }) => <i className={`ph ph-${name}`} aria-hidden />;

export type PalResultType = 'person' | 'company' | 'file';

export interface PalResult {
  id: string;
  type: PalResultType;
  name: string;
  sub: string;
  /** Avatar/mark initials. */
  initials: string;
  color: string;
  /** Which source the hit came from (drives the small source badge). */
  source: 'whatsapp' | 'linkedin' | 'rethink';
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Return matches for the typed query. Empty query => return []. */
  search: (query: string) => PalResult[];
  /** User picked a result (Enter or click) — pull it into the chat. */
  onPick: (result: PalResult) => void;
}

const GROUPS: { key: PalResultType; label: string }[] = [
  { key: 'person', label: 'People' },
  { key: 'company', label: 'Companies' },
  { key: 'file', label: 'Files' },
];

function sourceBadge(r: PalResult) {
  if (r.source === 'whatsapp') return <span className="pal-src wa"><Icon name="whatsapp-logo" /></span>;
  if (r.source === 'linkedin') return <span className="pal-src li"><Icon name="linkedin-logo" /></span>;
  return <span className="pal-src rt"><Icon name={r.type === 'file' ? 'file' : 'check-bold'} /></span>;
}

export default function CommandPalette({ open, onClose, search, onPick }: CommandPaletteProps) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 20); } }, [open]);

  const results = q.trim() ? search(q.trim()) : [];
  useEffect(() => { if (sel >= results.length) setSel(0); }, [results.length, sel]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) { onPick(results[sel]); onClose(); } }
  };

  if (!open) return null;

  return (
    <div className="pal-overlay on" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pal" role="dialog" aria-label="Search">
        <div className="pal-search">
          <span className="si"><Icon name="magnifying-glass" /></span>
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="Search people, companies and files…" autoComplete="off" spellCheck={false} />
          <kbd>esc</kbd>
        </div>

        <div className="pal-results">
          {!q.trim() && (
            <div className="pal-hint">
              <Icon name="magnifying-glass" />
              <span>Start typing to pull a person, company or file into the chat —<br />across WhatsApp, LinkedIn and reThink.</span>
            </div>
          )}
          {q.trim() && results.length === 0 && (
            <div className="pal-hint"><span>No matches for “{q}”.<br />Try a name, company or file.</span></div>
          )}
          {GROUPS.map(g => {
            const list = results.filter(r => r.type === g.key);
            if (!list.length) return null;
            return (
              <React.Fragment key={g.key}>
                <div className="pal-group">{g.label}</div>
                {list.map(r => {
                  const idx = results.indexOf(r);
                  return (
                    <div key={r.id} className={`pal-res ${idx === sel ? 'sel' : ''}`}
                      onMouseMove={() => setSel(idx)} onClick={() => { onPick(r); onClose(); }}>
                      <div className="pr-av"><span className="av-mono" style={{ background: r.color }}>{r.initials}</span></div>
                      <div className="pr-info"><div className="pr-name">{r.name}</div><div className="pr-sub">{r.sub}</div></div>
                      {sourceBadge(r)}
                      <span className="pr-enter"><kbd>↵</kbd></span>
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>

        <div className="pal-foot">
          <span className="fk"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span className="fk"><kbd>↵</kbd> bring into chat</span>
          <span className="grow" />
          <span className="fk">WhatsApp · LinkedIn · reThink</span>
        </div>
      </div>
    </div>
  );
}
