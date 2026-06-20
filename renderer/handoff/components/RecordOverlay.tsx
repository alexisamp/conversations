// RecordOverlay.tsx — slides a reThink record (company / opportunity / person) OVER
// the app, dimming what's behind instead of replacing it.
//
// IMPORTANT — this is where the real reThink components live. The overlay renders the
// kit's <RecordPeek> with kind="company" | "opp" | "person". In THIS prototype those
// run in an isolated iframe (rethink-host.html) to avoid CSS collisions; in your real
// app you import RecordPeek directly:
//
//     import { RecordPeek } from '@rethink/crm';   // your real path
//
// RecordPeek brings its own ".peek-bg" scrim (translucent green) and its own slide-in
// panel — so the only thing the host must guarantee is that the layer BEHIND the scrim
// is the live app (transparent container), NOT an opaque fill. That was the one bug to
// avoid: never give the overlay container/host an opaque background.

import React from 'react';
import type { RecordRef } from './types';

// In the real app, import the kit components + data:
//   import { RecordPeek } from '@rethink/crm';
//   import { COMPANIES, OPPORTUNITIES, PEOPLE } from '@rethink/crm-data';
declare const RecordPeek: React.ComponentType<any>;
declare const COMPANIES: any[];
declare const OPPORTUNITIES: any[];
declare const PEOPLE: any[];

export interface RecordOverlayProps {
  record: RecordRef | null;
  onClose: () => void;
}

export default function RecordOverlay({ record, onClose }: RecordOverlayProps) {
  if (!record) return null;

  let node: React.ReactNode = null;
  if (record.kind === 'company') {
    const idx = Math.max(0, COMPANIES.findIndex(c => c.name === record.name));
    node = <RecordPeek record={COMPANIES[idx]} kind="company" index={idx} total={COMPANIES.length}
      viewName="Companies" onClose={onClose} onPrev={() => {}} onNext={() => {}} />;
  } else if (record.kind === 'opp') {
    const idx = Math.max(0, OPPORTUNITIES.findIndex(o => o.id === record.id));
    node = <RecordPeek record={OPPORTUNITIES[idx]} kind="opp" index={idx} total={OPPORTUNITIES.length}
      viewName="Opportunities" onClose={onClose} onPrev={() => {}} onNext={() => {}} />;
  } else {
    const idx = Math.max(0, PEOPLE.findIndex(p => p.id === record.id));
    node = <RecordPeek record={PEOPLE[idx]} kind="person" index={idx} total={PEOPLE.length}
      viewName="People" onClose={onClose} onPrev={() => {}} onNext={() => {}} />;
  }

  // The container is a transparent full-viewport layer. RecordPeek paints its own
  // scrim + panel inside it, so the app stays visible (dimmed) behind.
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 96, background: 'transparent' }}>
      {node}
    </div>
  );
}
