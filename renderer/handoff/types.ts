// types.ts — Data contracts for the Conversations feature.
// These are the shapes the UI components consume. Map your API / DB models onto
// these (or adapt the components to your existing models). Nothing here is bound
// to a transport — fetch however your app fetches.

/** Channels a contact can be reached on. Drives the icon-only row in the peek. */
export type ChannelKey = 'whatsapp' | 'linkedin' | 'gmail';

/** Relationship tier (reThink "Jacob framework"). 1 = closest. */
export type Tier = 1 | 2 | 3;

/** Value-ledger direction class, derived from given - received. */
export type ValueKind = 'owe' | 'credit' | 'even';

export interface ValueItem {
  /** Short category tag shown as a mono chip, e.g. "Intro", "Content". */
  tag: string;
  /** One-line description of the value exchanged. */
  text: string;
  /** Human date string, e.g. "May 14" or "2019". */
  date: string;
}

export interface ValueLedger {
  /** Count of value units you have given. */
  given: number;
  /** Count of value units you have received. */
  received: number;
  /** Itemised list of what you gave (shown when expanded). */
  gaveItems: ValueItem[];
  /** Itemised list of what you received (shown when expanded). */
  receivedItems: ValueItem[];
}

export interface KeyDate {
  /** Label, e.g. "Pilot kickoff", "Birthday". */
  label: string;
  /** Date string, e.g. "Thu Jun 13", "Mar 14", "2019". */
  date: string;
  /** Highlight as time-sensitive (warm accent). */
  soon?: boolean;
}

export interface Todo {
  /** The task text. */
  text: string;
  /** Optional due label, e.g. "Thu 13", "overdue". "overdue" renders in the warm accent. */
  due?: string;
  done?: boolean;
}

/** An AI-surfaced personal memory fact ("Daughter starts school in August"). */
export interface MemoryFact {
  /** Phosphor icon name (without the "ph-" prefix), e.g. "baby", "bicycle". */
  icon: string;
  text: string;
}

/**
 * An intro suggestion: another person at the SAME company who already exists in
 * reThink but with whom you have no interaction. `pid` is the reThink person id
 * so clicking can open that person's record peek.
 */
export interface IntroSuggestion {
  /** reThink person id; if present, the row opens that person's RecordPeek. */
  pid?: string;
  initials: string;
  /** Avatar background colour (hex or CSS var). */
  color: string;
  name: string;
  role: string;
  /** Freshness label, e.g. "21d cold", "no touch". */
  last: string;
  /** Why this intro matters — shown as the row's tooltip. */
  note: string;
}

/** A linked reThink opportunity. If `recordId` is set, the row opens the real opp peek. */
export interface LinkedOpp {
  title: string;
  /** Your stakeholder role on the deal, e.g. "champion", "connector". */
  role: string;
  /** Time-left label, e.g. "18d". */
  due: string;
  progress: { done: number; total: number };
  /** reThink opportunity id (e.g. "o1"). When set, the row opens that opp's RecordPeek. */
  recordId?: string;
}

/**
 * The full relationship record the peek renders. This is the join of your
 * conversation contact and their reThink relationship intelligence.
 */
export interface RelationshipPerson {
  id: string;
  name: string;
  initials: string;
  /** Avatar background colour. */
  avColor: string;
  tier: Tier;
  role: string;
  /** Company name. If it matches a reThink company, the chip opens the company peek. */
  company: string;
  /** Channels this contact is on (icon-only row). */
  channels: ChannelKey[];
  active: boolean;
  /** e.g. "2h ago". */
  lastSeen: string;
  /** reThink list names this person belongs to. */
  lists: string[];
  /** AI-written relationship context paragraph. INTEGRATION: generated server-side. */
  context: string;
  /** AI-surfaced personal memory facts. */
  facts: MemoryFact[];
  ledger: ValueLedger;
  dates: KeyDate[];
  todos: Todo[];
  /** Same-company reThink contacts with no interaction. */
  intros: IntroSuggestion[];
  /** Linked opportunity, or null. */
  opp: LinkedOpp | null;
}

/** Top-level app channels/surfaces (the tab bar). */
export type AppMode = 'wa' | 'li' | 'review' | 'focus' | 'search';

/** A record-overlay request: which reThink record to slide over the app. */
export type RecordRef =
  | { kind: 'company'; name: string }
  | { kind: 'opp'; id: string }
  | { kind: 'person'; id: string };
