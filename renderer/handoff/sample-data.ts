// sample-data.ts — one fully-populated RelationshipPerson so you can render the peek
// immediately. Mirrors the prototype's Carla Díaz record. Replace with API data.

import type { RelationshipPerson } from './types';

export const SAMPLE_PERSON: RelationshipPerson = {
  id: 'carla',
  name: 'Carla Díaz',
  initials: 'CD',
  avColor: '#7a5b3e',
  tier: 1,
  role: 'Partner',
  company: 'Sequoia',
  channels: ['whatsapp', 'linkedin', 'gmail'],
  active: true,
  lastSeen: '2h ago',
  lists: ['Personal Board', 'Q2 Fundraise'],
  context: 'Moved to CDMX in March; misses Medellín. Road cyclist — you planned to ride together.',
  facts: [
    { icon: 'baby', text: 'Daughter starts at Montessori in August' },
    { icon: 'bicycle', text: 'Road cyclist — you owe her a Sunday ride' },
  ],
  ledger: {
    given: 4,
    received: 5,
    gaveItems: [
      { tag: 'Intro', text: 'Warm intro to her daughter’s school director', date: '2026-05-02' },
      { tag: 'Content', text: 'Shared the LATAM GTM teardown', date: '2026-04-10' },
    ],
    receivedItems: [
      { tag: 'Intro', text: 'Forwarded your deck to two LPs', date: 'May 14' },
      { tag: 'Signal', text: 'Flagged strong LP interest early', date: 'May 10' },
    ],
  },
  dates: [
    { label: 'Pilot kickoff', date: 'Thu Jun 13', soon: true },
    { label: 'Met', date: '2019' },
  ],
  todos: [
    { text: 'Send the scope agenda', due: 'Thu 13' },
    { text: 'Prep LP-ready data room', due: 'Thu 13' },
    { text: 'Confirm call time', done: true },
  ],
  intros: [
    { pid: 'p7', initials: 'AF', color: '#46708a', name: 'Ana Fuentes', role: 'Analyst', last: '21d cold', note: 'Preps the partner memos — a quiet path to the IC.' },
  ],
  opp: {
    title: 'Q2 Seed — intro to LPs',
    role: 'champion',
    due: '18d',
    progress: { done: 3, total: 7 },
    recordId: 'o1',
  },
};
