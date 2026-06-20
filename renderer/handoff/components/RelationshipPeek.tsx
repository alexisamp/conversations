// RelationshipPeek.tsx — the reThink relationship panel that sits to the right of a
// conversation. Pure presentation + local UI state (expand value, inline-add rows).
// All data mutations and record-opening are delegated to props so you can wire them
// to your store / API.
//
// Styling: uses the class names in styles/styles.css (the ".rp-*", ".r-ring", ".peekcol",
// ".pk-*" slice) + styles/tokens.css. Ship those two stylesheets alongside this component,
// or port the classes into your design system.
//
// Icons: this uses Phosphor (`<i className="ph ph-<name>">`). Swap <Icon> for your icon lib.

import React, { useState } from 'react';
import type {
  RelationshipPerson, ValueItem, KeyDate, Todo, RecordRef,
} from './types';

const Icon = ({ name }: { name: string }) => <i className={`ph ph-${name}`} aria-hidden />;

const CHAN: Record<string, { ic: string; c: string }> = {
  whatsapp: { ic: 'whatsapp-logo', c: '#1FA855' },
  linkedin: { ic: 'linkedin-logo', c: '#2D6DA3' },
  gmail:    { ic: 'envelope-simple', c: '#C5462F' },
};

/** reThink companies that have a real record — only these open the company peek. */
const RT_COMPANIES = new Set([
  'Sequoia', 'Index Ventures', 'Stripe', 'Airbnb', 'Notion', 'Wander', 'Pinpoint', 'Lemontech',
]);

export interface RelationshipPeekProps {
  person: RelationshipPerson;
  /** Open a reThink record overlay (company / opp / person). */
  onOpenRecord: (ref: RecordRef) => void;
  /** Persist a toggled todo. */
  onToggleTodo?: (personId: string, index: number, done: boolean) => void;
  /** Persist a newly added key date. */
  onAddDate?: (personId: string, date: KeyDate) => void;
  /** Persist a newly added todo. */
  onAddTodo?: (personId: string, todo: Todo) => void;
  /** Add this person to a list / open the classify picker. */
  onClassify?: (personId: string) => void;
  /**
   * Ask the AI to re-check the conversation and update `context` if needed.
   * INTEGRATION: call your AI endpoint; resolve when done. Returns nothing —
   * push the refreshed person down via props when the context changes.
   */
  onRecheckContext?: (personId: string) => Promise<void>;
  /** Lightweight toast hook (optional). */
  onToast?: (msg: string) => void;
}

function Avatar({ initials, color, size = 24 }: { initials: string; color: string; size?: number }) {
  return (
    <span
      className="av-mono"
      style={{ background: color, width: size, height: size, display: 'grid', placeItems: 'center' }}
    >
      {initials}
    </span>
  );
}

function ValueColumn({ title, count, items }: { title: string; count: number; items: ValueItem[] }) {
  return (
    <div className="rpv-col">
      <div className="rpv-col-hd">{title}<span>{count}</span></div>
      {items.length === 0
        ? <div className="rpv-none">Nothing logged yet.</div>
        : items.map((v, i) => (
          <div className="rpv-item" key={i}>
            <span className="rpv-tag">{v.tag}</span>
            <div className="rpv-body">
              <div className="rpv-tx">{v.text}</div>
              <div className="rpv-dt">{v.date}</div>
            </div>
          </div>
        ))}
    </div>
  );
}

/** Inline "+ add" row for key dates / todos. */
function AddRow({ kind, onSubmit, onCancel }: {
  kind: 'date' | 'todo';
  onSubmit: (a: string, b?: string) => void;
  onCancel: () => void;
}) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const submit = () => { if (!a.trim()) { onCancel(); return; } onSubmit(a.trim(), b.trim() || undefined); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') onCancel();
  };
  return (
    <div className="rp-add-row">
      <input className="rp-add-in" autoFocus placeholder={kind === 'date' ? 'What’s the date?' : 'Add a to-do…'}
        value={a} onChange={e => setA(e.target.value)} onKeyDown={key} />
      {kind === 'date' && (
        <input className="rp-add-in when" placeholder="When" value={b}
          onChange={e => setB(e.target.value)} onKeyDown={key} />
      )}
      <button className="rp-add-ok" title="Save" onClick={submit}><Icon name="check-bold" /></button>
    </div>
  );
}

export default function RelationshipPeek(props: RelationshipPeekProps) {
  const { person: p, onOpenRecord, onToggleTodo, onAddDate, onAddTodo, onClassify, onRecheckContext, onToast } = props;
  const ring = `t${p.tier}`;

  const [valueOpen, setValueOpen] = useState(false);
  const [adding, setAdding] = useState<null | 'date' | 'todo'>(null);
  const [rechecking, setRechecking] = useState(false);

  // value math
  const { given, received } = p.ledger;
  const net = given - received;
  const vk = net < 0 ? 'owe' : net > 0 ? 'credit' : 'even';
  const vLabel = net < 0 ? 'You owe value' : net > 0 ? 'You’re in credit' : 'Balanced';
  const vNet = net > 0 ? `+${net}` : `${net}`;
  const vIcon = net < 0 ? 'arrow-down-right' : net > 0 ? 'arrow-up-right' : 'equals';

  const pending = p.todos.filter(t => !t.done).length;
  const companyClickable = RT_COMPANIES.has(p.company);

  const recheck = async () => {
    if (!onRecheckContext) return;
    setRechecking(true);
    try { await onRecheckContext(p.id); onToast?.('Context reviewed — still current ✓'); }
    finally { setRechecking(false); }
  };

  return (
    <div className="rp-scope">
      {/* header */}
      <div className="rp-head">
        <div className={`r-ring ${ring}`}><div className="r-av"><Avatar initials={p.initials} color={p.avColor} size={51} /></div></div>
        <div className="rp-id">
          <div className="rp-name-row">
            <span className="rp-name">{p.name}</span>
            <span className={`rp-tier ${ring}`}>T{p.tier}</span>
          </div>
          <div className="rp-role">
            {p.role} ·{' '}
            {companyClickable
              ? <button className="rp-co" onClick={() => onOpenRecord({ kind: 'company', name: p.company })}>{p.company}<Icon name="arrow-up-right" /></button>
              : <span className="rp-co-static">{p.company}</span>}
          </div>
        </div>
      </div>

      {/* channels (icon only) + activity meta */}
      <div className="rp-bar">
        <div className="rp-chans">
          {p.channels.map(k => {
            const c = CHAN[k] ?? CHAN.gmail;
            return <span key={k} className="rp-chan" style={{ ['--cc' as any]: c.c }} title={k}><Icon name={c.ic} /></span>;
          })}
        </div>
        <span className="rp-bar-meta">
          <span className={`rp-dot ${p.active ? 'on' : ''}`} />
          {p.active ? 'Active' : 'Dormant'} · {p.lastSeen}
        </span>
      </div>

      {/* lists — directly under the channels */}
      <div className="rp-listrow">
        <div className="rp-lists">
          {p.lists.map(l => <span key={l} className="rp-listchip">{l}</span>)}
          <button className="rp-classify" onClick={() => onClassify?.(p.id)}><Icon name="plus" /> classify</button>
        </div>
      </div>

      {/* AI context */}
      <div className="rp-ctx">
        <div className="rp-ctx-hd">
          <span className="rp-ai"><Icon name="sparkle" />AI</span>Context
          <button className={`rp-recheck ${rechecking ? 'spin' : ''}`} title="Re-check context with AI" onClick={recheck}>
            <Icon name="arrows-clockwise" />
          </button>
        </div>
        <p className="rp-ctx-body">{p.context}</p>
        {p.facts.length > 0 && (
          <div className="rp-facts">
            {p.facts.map((f, i) => <span key={i} className="rp-fact"><Icon name={f.icon} />{f.text}</span>)}
          </div>
        )}
      </div>

      {/* value — collapsed signal, expand for given/received */}
      <button className={`rp-value ${vk} ${valueOpen ? 'open' : ''}`} aria-expanded={valueOpen} onClick={() => setValueOpen(o => !o)}>
        <span className="rpv-badge"><Icon name={vIcon} /></span>
        <span className="rpv-lbl">{vLabel}</span>
        <span className="rpv-net">{vNet}</span>
        <span className="rpv-chev"><Icon name="caret-down" /></span>
      </button>
      {valueOpen && (
        <div className="rp-value-detail" style={{ display: 'grid' }}>
          <ValueColumn title="You gave" count={given} items={p.ledger.gaveItems} />
          <ValueColumn title="You received" count={received} items={p.ledger.receivedItems} />
        </div>
      )}

      {/* key dates (creatable) */}
      <section className="rp-sec">
        <div className="rp-sec-hd">
          <span className="rp-lbl">Key dates</span>
          <button className="rp-add" onClick={() => setAdding('date')}><Icon name="plus" /> add</button>
        </div>
        <div className="rp-dates">
          {p.dates.map((d, i) => (
            <div className="rp-date" key={i}>
              <span className={`rp-date-ic ${d.soon ? 'soon' : ''}`}><Icon name="calendar-blank" /></span>
              <span className="rp-date-lb">{d.label}</span>
              <span className="rp-date-dt">{d.date}</span>
            </div>
          ))}
          {adding === 'date' && (
            <AddRow kind="date"
              onSubmit={(label, when) => { onAddDate?.(p.id, { label, date: when ?? 'TBD', soon: true }); setAdding(null); }}
              onCancel={() => setAdding(null)} />
          )}
        </div>
      </section>

      {/* to-dos (creatable) */}
      <section className="rp-sec">
        <div className="rp-sec-hd">
          <span className="rp-lbl">To-do’s</span>
          <span className="rp-ct">{pending}</span>
          <button className="rp-add" onClick={() => setAdding('todo')}><Icon name="plus" /> add</button>
        </div>
        <div className="rp-todos">
          {p.todos.map((t, i) => (
            <div className={`rp-todo ${t.done ? 'done' : ''}`} key={i} onClick={() => onToggleTodo?.(p.id, i, !t.done)}>
              <span className="rp-cb"><Icon name="check-bold" /></span>
              <span className="rp-todo-tx">
                {t.text}
                {t.due && <span className={`rp-due ${/over/i.test(t.due) ? 'late' : ''}`}>{t.due}</span>}
              </span>
            </div>
          ))}
          {adding === 'todo' && (
            <AddRow kind="todo"
              onSubmit={(text) => { onAddTodo?.(p.id, { text, done: false }); setAdding(null); }}
              onCancel={() => setAdding(null)} />
          )}
        </div>
      </section>

      {/* intros — same company, in reThink, no touch */}
      {p.intros.length > 0 && (
        <section className="rp-sec">
          <div className="rp-sec-hd"><span className="rp-lbl">Also at {p.company}</span><span className="rp-sub">in reThink · no touch</span></div>
          <div className="rp-intros">
            {p.intros.map((it, i) => (
              <button className="rp-intro" key={i} title={it.note}
                onClick={() => { onToast?.(`Intro draft to ${it.name} ready`); if (it.pid) onOpenRecord({ kind: 'person', id: it.pid }); }}>
                <span className="rp-intro-av"><Avatar initials={it.initials} color={it.color} /></span>
                <span className="rp-intro-name">{it.name}</span>
                <span className="rp-intro-role">{it.role}</span>
                <span className="rp-intro-last">{it.last}</span>
                <span className="rp-intro-go"><Icon name="arrow-up-right" /></span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* linked opportunity — single minimal row */}
      {p.opp && (
        <section className="rp-sec">
          <div className="rp-sec-hd"><span className="rp-lbl">Linked opportunity</span></div>
          <button className={`rp-opp ${p.opp.recordId ? 'live' : 'flat'}`}
            onClick={() => p.opp?.recordId && onOpenRecord({ kind: 'opp', id: p.opp.recordId })}>
            <span className="rp-opp-ic"><Icon name="target" /></span>
            <span className="rp-opp-name">{p.opp.title}</span>
            <span className="rp-opp-meta">{p.opp.role} · {p.opp.due}</span>
            <span className="rp-opp-go"><Icon name={p.opp.recordId ? 'arrow-up-right' : 'plus'} /></span>
          </button>
        </section>
      )}
    </div>
  );
}
