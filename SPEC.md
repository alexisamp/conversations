# Conversations — SPEC

> **Status:** draft v1 — awaiting approval
> **Date:** 2026-04-14
> **Replaces:** `~/Documents/NetworkHub` (Tauri, abandoned)
> **Related:** `~/Documents/reThink-2026/extension/` (Chrome extension, kept alive for LinkedIn only)

---

## 1. What this is

A **macOS-native desktop app** that embeds WhatsApp Web and acts as the user's primary WhatsApp client (replaces the official WhatsApp macOS app in the dock). While the user chats normally, the app:

1. **Shows a collapsible sidebar** with the current contact's RedThink profile — goals, focus areas, interaction history, health score.
2. **Passively observes** every inbound and outbound message. No automation, no auto-replies.
3. **Groups messages into sessions** using a 6-hour **sliding** window: session stays open as long as a new message arrives within 6h of the previous one.
4. **On session close**, sends the full conversation text to Gemini 2.0 Flash → gets a 2-line summary → writes it to Supabase as `interactions.notes`.
5. **Matches WhatsApp contacts** to existing RedThink people by normalized phone number. Unknown numbers trigger a "Create in RedThink" modal with data pre-filled from WhatsApp.
6. **Feeds weekly goals** via a new KPI: `conversation_uniques_per_day` (distinct contacts with ≥1 closed session that day).

**Explicitly out of scope** (for now): LinkedIn, other channels, auto-replies, any generative feature other than session summaries, multi-user hosting, mobile. LinkedIn stays in the Chrome extension for now.

---

## 2. Core decisions (locked in this doc)

| # | Decision | Rationale |
|---|---|---|
| 1 | Stack: **Electron** + TypeScript + React + `better-sqlite3` | WhatsApp Web DOM injection is Electron's sweet spot. The old Chrome extension logic ports 1:1 into an Electron preload script. Tauri / WKWebView was bleeding us dry. |
| 2 | Platform: **macOS only** (Intel + Apple Silicon universal DMG) | User + wife both on Mac. One target, one signing cert. |
| 3 | Message text storage: **SQLite local**, never Supabase | Privacy, offline, re-summarizable if prompt changes. Only the Gemini summary goes to the cloud. |
| 4 | Interaction granularity: **1 interaction per session** (not per day) | Each closed 6h session → one `interactions` row with its own summary. |
| 5 | Session window: **sliding 6h from last message** | Every new message in the session resets a timer. Timer fires → Gemini → close session. |
| 6 | KPI for goals: **new metric `conversation_uniques_per_day`** | Distinct contacts with ≥1 closed session that day. Does NOT replace the existing `networking` habit — lives alongside. |
| 7 | Auth: **Google OAuth → Supabase `signInWithIdToken`** | Same flow as the current extension. Reuses existing Supabase project `amvezbymrnvrwcypivkf`. |
| 8 | AI: **Gemini 2.0 Flash via REST**, env var `VITE_GEMINI_API_KEY` (reuse reThink's key) | Already in use across reThink; no SDK, direct `fetch` to `generativelanguage.googleapis.com/v1beta`. |
| 9 | Chrome extension coexistence: **disable WhatsApp in the extension**, keep LinkedIn | Two writers to `interactions` = duplicates. WhatsApp becomes Conversations-only. The extension keeps `linkedin-profile.ts`, `linkedin-dm.ts`, floating trigger, sidebar. |
| 10 | Contact matching: **strict by normalized phone**; name uses RedThink's value once matched | Names in WhatsApp are noisy (emojis, nicknames). Phone is stable. |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Main Process                                       │
│  • Window + BrowserView lifecycle                            │
│  • IPC bus                                                    │
│  • SessionManager   (in-memory timers per active chat)       │
│  • LocalDB          (better-sqlite3 → messages, sessions)    │
│  • SupabaseSync     (writes interactions, windows, habits)   │
│  • GeminiSummarizer (gemini-2.0-flash REST)                  │
│  • SupabaseAuth     (Google OAuth → signInWithIdToken)       │
└──────────────┬────────────────────────────────┬─────────────┘
               ↕ IPC                             ↕ IPC
┌──────────────────────────────┐    ┌───────────────────────────┐
│  BrowserView: WhatsApp Web   │    │  BrowserWindow: Sidebar   │
│  (web.whatsapp.com)          │    │  (React, in-process)      │
│                              │    │                           │
│  preload-whatsapp.ts:        │    │  preload-sidebar.ts:      │
│  • MutationObserver → msgs   │    │  • Exposes ipcRenderer    │
│  • Conversation change poll  │    │    as `window.conv.*`     │
│  • Header / contact extract  │    │                           │
│  • Emits IPC events:         │    │  React app:               │
│    - wa:msg:new              │    │  • ContactDetailScreen    │
│    - wa:chat:changed         │    │  • ContactMappingScreen   │
│    - wa:history:chunk        │    │  • SessionCard (current)  │
│    (backfill)                │    │  • RetroactiveImportBtn   │
└──────────────────────────────┘    └───────────────────────────┘
               ↓                                 ↓
         SQLite (local)                    Supabase (RedThink)
         messages                          outreach_logs
         sessions                          interactions
         sync_queue                        extension_interaction_windows
                                           contact_phone_mappings
                                           habit_logs
```

---

## 4. Data model

### 4.1 Local SQLite schema (`~/Library/Application Support/Conversations/conv.db`)

```sql
-- Raw message log (never leaves the machine)
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_phone TEXT NOT NULL,              -- normalized +E164
  wa_data_id TEXT NOT NULL UNIQUE,       -- dedupe key from WhatsApp
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  text TEXT,                             -- full message text (best-effort)
  timestamp INTEGER NOT NULL,            -- unix ms
  session_id INTEGER REFERENCES sessions(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX idx_messages_chat_ts ON messages(chat_phone, timestamp);
CREATE INDEX idx_messages_session ON messages(session_id);

-- Session = one 6h sliding window with at least one message
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_phone TEXT NOT NULL,              -- normalized +E164
  contact_id TEXT,                       -- Supabase outreach_logs.id once matched
  started_at INTEGER NOT NULL,           -- first message ts
  last_message_at INTEGER NOT NULL,      -- updated every msg; window closes at +6h
  closed_at INTEGER,                     -- null = still open
  direction_first TEXT NOT NULL,         -- direction of the opening message
  message_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,                          -- Gemini 2-line summary (nullable until closed)
  supabase_interaction_id TEXT,          -- set when synced to Supabase
  supabase_window_id TEXT                -- set when synced to Supabase
);
CREATE INDEX idx_sessions_open ON sessions(chat_phone, closed_at) WHERE closed_at IS NULL;

-- Retry queue for Supabase writes that failed (offline, 500s, etc.)
CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,                      -- 'interaction:insert' | 'interaction:update_notes' | 'window:insert' | 'window:bump'
  payload TEXT NOT NULL,                 -- JSON
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
```

### 4.2 Supabase schema changes

**No new tables.** Existing tables and trigger `trg_update_contact_health` already cover us. The changes are:

1. **`interactions.notes`** — historically `null`. We now populate it with the Gemini 2-line summary on session close.
2. **New Supabase migration** `007_conversation_uniques_habit.sql`:
   - Add a row to `habits` (or equivalent table — to confirm against the actual `habits` schema) for `tracks_outreach = 'conversation_uniques'` so the weekly goal system can consume it.
   - New `updateConversationUniquesHabit(userId, date)` function (mirrors `updateNetworkingHabit`): counts **distinct `contact_id`s** from `interactions` where `type = 'whatsapp'` and `interaction_date = today` and `notes IS NOT NULL` (i.e., session was closed).

   ⚠️ Before writing this migration we need to read `useHabits.ts` and `useGoals.ts` in reThink to plug the new KPI correctly into the existing weekly-goal pipeline. **Open question 4.2.a.**

3. **Interaction granularity flip**: today the code inserts **1 row per (contact, day, 'whatsapp')** — we change to **1 row per session**. This has a subtle side effect: the existing `networking` habit (distinct contacts per day) is unaffected because it counts DISTINCT contacts. But any UI that displays "# of interactions today" will now show a higher number (one per session instead of one per day). **Open question 4.2.b — is there any UI in reThink that counts raw `interactions` rows?**

---

## 5. Session lifecycle (the heart of the app)

```
new message arrives (from preload)
    │
    ▼
SessionManager.handleMessage(phone, direction, text, ts)
    │
    ├─── open session exists for this phone?
    │      │
    │      ├── YES → append message, bump last_message_at,
    │      │        RESET 6h timer,
    │      │        enqueue sync_queue ('window:bump' + update count)
    │      │
    │      └── NO  → create new session row locally
    │               match contact (phone → outreach_logs)
    │               if matched:
    │                 enqueue ('interaction:insert' with notes=null)
    │                 enqueue ('window:insert')
    │               else:
    │                 emit 'chat:unmapped' → sidebar shows "Create person"
    │                 buffer the session locally until user maps it
    │               start 6h timer
    ▼
timer fires (6h after last_message_at)
    │
    ▼
SessionManager.closeSession(sessionId)
    │
    ├── load all messages.text for this session from SQLite
    ├── call Gemini 2.0 Flash with system prompt:
    │     "Resume esta conversación de WhatsApp en exactamente 2
    │      líneas en español. Línea 1: tema/contexto. Línea 2:
    │      resultado/compromiso/sentimiento."
    ├── write summary back to sessions.summary
    ├── enqueue ('interaction:update_notes' with the summary)
    └── emit 'session:closed' → sidebar refreshes card
```

**Crash safety:** all state lives in SQLite. On app boot, SessionManager replays open sessions from `sessions WHERE closed_at IS NULL` and restarts timers for whichever still have `last_message_at + 6h > now()`. If the window already expired while the app was closed, the session closes immediately on boot and fires the summarizer.

---

## 6. Contact matching

Reuses `contact_phone_mappings` 1:1 from the extension:

```
on wa:chat:changed(phone)
    normalized = normalizePhoneNumber(phone)
    match = findContactByPhone(userId, normalized)
    if match:
      sidebar.show(ContactDetailScreen, { contact: match, displayName: match.name })
    else:
      sidebar.show(ContactMappingScreen, {
        phone: normalized,
        waName: <from WhatsApp header, suggestion only>,
        waAvatar: <from WhatsApp header, if scraped>
      })
```

When the user creates a person from the modal, we:
1. `INSERT INTO outreach_logs (user_id, name, phone, status='new', ...)`
2. `INSERT INTO contact_phone_mappings (user_id, contact_id, phone_number)`
3. Resolve any buffered sessions for this phone → flush their pending `interaction:insert` + `window:insert` from `sync_queue`.

---

## 7. File structure (proposed)

```
Conversations/
├── SPEC.md                          ← this file
├── README.md
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── .env.example                     VITE_GEMINI_API_KEY=…
│                                    VITE_SUPABASE_URL=…
│                                    VITE_SUPABASE_ANON_KEY=…
├── electron/
│   ├── main.ts                      app lifecycle, windows, IPC bus
│   ├── ipc-channels.ts              type-safe channel names
│   ├── preload-whatsapp.ts          ← port of content-scripts/whatsapp.ts
│   ├── preload-sidebar.ts           exposes window.conv.*
│   ├── session-manager.ts           6h sliding timers, open/close logic
│   ├── ai/
│   │   └── gemini.ts                2-line summarizer
│   ├── db/
│   │   ├── schema.sql               CREATE TABLE messages/sessions/sync_queue
│   │   ├── local.ts                 better-sqlite3 wrapper
│   │   └── sync.ts                  drains sync_queue → Supabase
│   ├── supabase/
│   │   ├── client.ts                @supabase/supabase-js + file-based storage
│   │   ├── auth.ts                  Google OAuth flow for Electron
│   │   ├── contacts.ts              findContactByPhone, create person, mapping
│   │   ├── interactions.ts          insert / update notes
│   │   └── habits.ts                networking + conversation_uniques
│   └── utils/
│       ├── phone-normalizer.ts      ← copy from extension/src/lib
│       └── logger.ts
├── renderer/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx                      router: Login | NoChat | Detail | Mapping
│   ├── screens/
│   │   ├── LoginScreen.tsx
│   │   ├── ContactDetailScreen.tsx  ← adapted from extension/src/sidebar
│   │   └── ContactMappingScreen.tsx ← adapted
│   ├── components/
│   │   ├── SessionCard.tsx          live session status for current chat
│   │   ├── HealthBadge.tsx
│   │   └── RetroactiveImportButton.tsx
│   └── styles/
│       └── tokens.css               burnham/shuttle/mercury/pastel/gossip
├── assets/
│   └── icon.icns
└── migrations/
    └── 007_conversation_uniques_habit.sql
```

---

## 8. Build phases (no skipping, each has a demoable criterion)

### Phase 0 — Electron shell
- New repo, Electron + React + TS boilerplate
- Single `BrowserWindow` with a `BrowserView` loading `https://web.whatsapp.com`
- Custom user-agent (Chrome desktop) so WhatsApp doesn't show "unsupported"
- Traffic lights overlay fixed, window resizes cleanly
- **Demo:** Chatear en WhatsApp Web dentro de la app como si fuera la app nativa. QR scan funciona, mensajes llegan, nada crashea.

### Phase 1 — Sidebar + contact lookup (read-only)
- Collapsible sidebar `BrowserWindow` on the right
- Login screen with Google OAuth → Supabase session stored in `~/Library/Application Support/Conversations/auth.json`
- `preload-whatsapp.ts` emits `wa:chat:changed` events (port of `startConversationChangeDetector`)
- Sidebar listens, calls `findContactByPhone`, shows `ContactDetailScreen` or `ContactMappingScreen`
- **No writes yet.**
- **Demo:** Open a chat with a known RedThink contact → sidebar shows their card. Open a chat with an unknown number → sidebar shows "Create in RedThink".

### Phase 2 — Message capture + local SQLite
- Port `whatsapp.ts` MutationObserver into `preload-whatsapp.ts`
- Every detected message → IPC `wa:msg:new` → `LocalDB.insertMessage`
- `better-sqlite3` DB in `~/Library/Application Support/Conversations/conv.db`
- **No sessions, no Supabase yet.**
- **Demo:** Chat for 10 minutes, quit the app, open the DB in a SQLite browser, see all messages with correct direction and phone.

### Phase 3 — Sessions + sync to Supabase
- `SessionManager` with sliding 6h timers
- On first message: create session, match contact, enqueue `interaction:insert` + `window:insert` → `SupabaseSync` drains the queue → writes to Supabase
- On subsequent messages in the same session: enqueue `window:bump`
- On timer expire: call `GeminiSummarizer` → write `notes` to Supabase
- **Demo:** Chat with a known contact. Immediately see `health_score` go up in reThink. Wait 6h (or force-close via debug menu). See the 2-line summary appear in `interactions.notes` in reThink.

### Phase 4 — Create person modal
- `ContactMappingScreen` → "Create in RedThink" button → `outreach_logs.insert` + `contact_phone_mappings.insert`
- Any buffered sessions for that phone (sitting in `sync_queue` waiting for a contact) flush to Supabase
- Search-existing flow: find by name, attach phone to existing person
- **Demo:** New number writes to you. You click "Crear en RedThink", fill a name, submit. The person appears in reThink with a pending interaction already attached.

### Phase 5 — Retroactive import
- Port `scanWhatsAppMessageHistory` + `groupInto6HourWindows` from the extension
- Button in the sidebar: "Importar histórico de este chat"
- Scrolls WhatsApp Web chat panel to load older messages, scrapes them, groups into historical sessions, runs Gemini on each, writes to Supabase
- **Demo:** Open a long-standing chat, click the button, watch sessions + summaries populate in reThink.

### Phase 6 — `conversation_uniques_per_day` KPI + weekly goal wiring
- Migration 007 (subject to reading `useHabits.ts` / `useGoals.ts` first)
- `updateConversationUniquesHabit(userId, date)` called on every session close
- Wire it into the weekly goal UI in reThink (separate small PR in the reThink repo)
- **Demo:** Close 5 sessions today → weekly goal shows 5/X.

### Phase 7 — Ship
- `electron-builder` config for universal macOS DMG
- Apple code signing + notarization
- Auto-update via `electron-updater` pointing at a GitHub Releases feed (or skip for now, manual DMG swap)
- Install on wife's Mac, sanity check
- **Demo:** `npm run dist` → DMG → drag-drop → app in Launchpad → replaces native WhatsApp in Cmd-Tab loop.

### Phase 8 — Clean up the Chrome extension
- Remove `content-scripts/whatsapp.ts` from `extension/manifest.json`
- Delete the WhatsApp branch in `service-worker.ts`
- Extension keeps: LinkedIn profile, LinkedIn DM, floating trigger, sidebar (for LinkedIn flows)
- Commit to the reThink repo
- **Demo:** Reload extension in Chrome → opening WhatsApp Web does nothing from the extension side. Only Conversations writes WhatsApp interactions.

---

## 9. Open questions (need to resolve before or during Phase 3)

| # | Question | Where to look |
|---|---|---|
| 4.2.a | How exactly does `useHabits.ts` / `useGoals.ts` expect a new habit type? Is it a row in `habits` with a specific `tracks_outreach` enum value, or something else? | `~/Documents/reThink-2026/src/hooks/useHabits.ts`, `useGoals.ts` |
| 4.2.b | Does any reThink UI count raw `interactions` rows (which would get inflated when we move to one-per-session)? | `~/Documents/reThink-2026/src/screens/*`, search for `.from('interactions')` |
| 9.1 | Can WhatsApp Web actually expose **full message text** via the DOM reliably? The extension today only reads `data-id`, not text. Need a spike to confirm the text node is scrapable in both sent and received bubbles, including replies, images-with-caption, etc. | Phase 2 spike |
| 9.2 | OAuth redirect URL handling in Electron — do we register a custom protocol (`conversations://auth`) or use a loopback HTTP server? | Phase 1 implementation |
| 9.3 | How to scroll WhatsApp Web history programmatically without getting rate-limited for retroactive import? | Phase 5 spike |
| 9.4 | Group chats: current extension skips them. Do we want per-contact-in-group sessions later, or keep skipping? | Deferred — skip for v1 |

---

## 10. What we are NOT building (and why)

- **LinkedIn integration** — stays in the Chrome extension. Revisit after WhatsApp is rock solid.
- **Auto-reply / AI composer** — out of scope. User explicitly doesn't want automation.
- **Multi-user / hosted** — this is a personal tool. One install per person.
- **Windows / Linux builds** — only Mac needed today.
- **iMessage / SMS capture** — requires macOS private APIs, another planet.
- **Sentiment analysis, topic detection, CRM-side AI** — maybe later, not v1.
- **Encrypted backup of local SQLite** — nice to have; punt.
- **Real-time sync between two installs** (e.g., user's laptop + desktop) — punt.

---

## 11. What I need from you to start Phase 0

1. **Approve this SPEC** (or mark up what to change).
2. **Confirm the repo location**: I'll initialize `~/Documents/Conversations/` as a fresh git repo (`git init`). Acknowledge or propose elsewhere.
3. **Gemini API key**: is `VITE_GEMINI_API_KEY` set in `~/Documents/reThink-2026/.env.local` (I didn't see it in `.env`), or do I need to get it from you?
4. **macOS code signing**: do you have an Apple Developer Team ID I should use from day 0, or do we ship unsigned during dev and sign just before Phase 7?

Once these four are answered I start Phase 0 — nothing else until then.
