# Conversations — SPEC

> **Status:** v2 — shipped through Phase 7
> **Date:** 2026-04-17
> **Replaces:** `~/Documents/NetworkHub` (Tauri, abandoned)
> **Related:** `~/Documents/reThink-2026/extension/` (Chrome extension, kept alive for LinkedIn only)
> **Live tracker:** [`PROGRESS.md`](./PROGRESS.md) — this file is the long-term contract. `PROGRESS.md` is the weekly state. Don't confuse them.

---

## 1. What this is

A **macOS-native desktop app** that embeds WhatsApp Web and acts as the user's primary WhatsApp client (replaces the official WhatsApp macOS app in the dock). While the user chats normally, the app:

1. **Shows a collapsible sidebar** with the current contact's reThink profile — goals, focus areas, interaction history, health score, active opportunities, pending next-steps ("tubos"), and value-given timeline.
2. **Passively observes** every inbound and outbound message. No automation, no auto-replies.
3. **Groups messages into sessions** using a 6-hour **sliding** window: session stays open as long as a new message arrives within 6h of the previous one.
4. **On session close**, sends the full conversation text to Gemini 2.0 Flash → gets a 2-line summary → writes it to Supabase as `interactions.notes`.
5. **Matches WhatsApp contacts** to existing reThink people by normalized phone number. Unknown numbers trigger a "Create in reThink" modal with data pre-filled from WhatsApp.
6. **Feeds weekly goals** via a new KPI: `conversation_uniques_per_day` (distinct contacts with ≥1 closed session that day).
7. **Secondary LinkedIn tab** (added in Phase 2.6) embeds LinkedIn with the same sidebar. Profile detection by slug, ✨ Enrich button, ⌘K command palette for global search.

**Explicitly out of scope** (v1): auto-replies, multi-user hosting, mobile, Windows/Linux, iMessage/SMS.

---

## 2. Core decisions (locked — do not revisit without a fresh discussion)

| # | Decision | Rationale |
|---|---|---|
| 1 | Stack: **Electron** + TypeScript + React + `better-sqlite3` | WhatsApp Web DOM injection is Electron's sweet spot. Tauri/WKWebView bled us dry. |
| 2 | Platform: **macOS only**, **arm64-only DMG** | Universal build fails on our disk (hdiutil scratch). User + wife both on Apple Silicon. Re-evaluate only if an Intel user appears. |
| 3 | **No code signing, no notarization** | User opted out of Apple Developer account (confirmed 2026-04-14). First-launch needs *right-click → Open → Open* forever. Document this in every GH release body. |
| 4 | Message text storage: **SQLite local, never Supabase** | Privacy, offline, re-summarizable if prompt changes. Only the Gemini summary goes to the cloud. |
| 5 | Interaction granularity: **1 interaction per session** (not per day) | Each closed 6h session → one `interactions` row with its own summary. New KPI `conversation_uniques_per_day` protects the habit counters from inflation. |
| 6 | Session window: **sliding 6h from last message** | Every new message in the session resets a timer. Timer fires → Gemini → close session. |
| 7 | Auth: **Google OAuth → Supabase PKCE loopback** | Redirect URL `http://localhost:54321/callback` is whitelisted in the Supabase project. |
| 8 | AI: **Gemini 2.0 Flash via REST**, env var `VITE_GEMINI_API_KEY` (reused from reThink) | No SDK, direct `fetch` to `generativelanguage.googleapis.com/v1beta`. |
| 9 | Chrome extension coexistence: **disable WhatsApp in the extension eventually**; **keep LinkedIn** indefinitely | Two writers to `interactions` = duplicates. Phase 8 removes the WA branch. Extension keeps LI profile, LI DM, floating trigger, sidebar. |
| 10 | Contact matching: **strict by normalized phone**, 3-source lookup (`contact_channels`, `contact_phone_mappings`, `outreach_logs.phone`) with phone variants. Name uses reThink's value once matched. | Names in WhatsApp are noisy. Phone is stable. |
| 11 | **LIDs (`XXX@lid`) are opaque IDs, not phones** — map once to a reThink contact, that LID is saved to `contact_channels` as `channel='whatsapp', identifier='lid:<...>'`, future sightings auto-recognize | Modern WhatsApp hides phones in groups. Scraping for real phones would require whatsapp-web.js-style module-raiding, which Meta breaks every release. |
| 12 | **Groups are visual-only** — participants are listed in the sidebar but group messages are NOT captured to SQLite | Too noisy, and inflating per-participant interactions is its own product. Revisit only after v1 is stable. |
| 13 | LinkedIn profile data is scraped **client-side from the LinkedIn view** (user's authenticated session), **never from a server-side `linkedin-fetch` edge function** | LinkedIn blocks unauthenticated scraping. The old extension scraped client-side for the same reason. |
| 14 | **No generative features beyond session summaries and LI enrichment** | No AI composer, no auto-replies, no "suggested next message". User explicitly refused. |
| 15 | **Auto-update via GitHub Releases** with `electron-updater`, polling on app boot | Keeps the wife's machine up-to-date without manual DMG swapping. Repo `alexisamp/conversations` (private). |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Main Process                                       │
│  • BaseWindow + 4 WebContentsView (tab-bar, wa, li, sidebar) │
│  • IPC bus (type-safe channel registry)                      │
│  • SessionManager   (in-memory timers per active chat)       │
│  • LocalDB          (better-sqlite3 → messages, sessions)    │
│  • SupabaseSync     (drains sync_queue every 10s)            │
│  • GeminiSummarizer (gemini-2.0-flash REST)                  │
│  • SupabaseAuth     (Google OAuth → loopback → PKCE)         │
│  • ElectronUpdater  (polls GitHub Releases on boot)          │
└──────────────┬────────────────────┬─────────────────────────┘
               ↕ IPC                 ↕ IPC
┌──────────────────────────┐  ┌──────────────────────────────┐
│ BrowserView: WhatsApp    │  │ BrowserView: LinkedIn        │
│ preload-whatsapp.ts:     │  │ preload-linkedin.ts:         │
│  • MutationObserver msgs │  │  • Profile detection by URL  │
│  • Chat-change poll 600ms│  │  • Client-side scrapers      │
│  • Banner hider (rAF)    │  │  • DOM diagnostic (one-shot) │
│  • LID + phone extract   │  │                              │
└──────────────────────────┘  └──────────────────────────────┘
               ↓                                 ↓
┌──────────────────────────────────────────────────────────────┐
│ BrowserView: Sidebar (React, in-process, 340–400px)          │
│ ContactDetailScreen | GroupScreen | LinkedinProfileScreen |   │
│ CreateContactModal | CommandPalette (⌘K)                      │
└──────────────────────────────────────────────────────────────┘
               ↓                        ↓
         SQLite (local)            Supabase (reThink)
         messages                  outreach_logs
         sessions                  interactions
         sync_queue                contact_channels
                                   contact_phone_mappings
                                   extension_interaction_windows
                                   habits / habit_logs
                                   value_logs
                                   opportunities
```

---

## 4. Data model

### 4.1 Local SQLite schema (`~/Library/Application Support/Conversations/conv.db`)

See `electron/db/schema.sql` for the authoritative version. Summary:

- **`messages`** — `id, chat_phone, wa_data_id (UNIQUE, dedupe), direction, text, timestamp, session_id, created_at`
- **`sessions`** — `id, chat_phone, contact_id, started_at, last_message_at, closed_at, direction_first, message_count, summary, supabase_interaction_id, supabase_window_id`
- **`sync_queue`** — `id, op ('interaction:insert' | 'interaction:update_notes' | 'window:insert' | 'window:bump'), payload (JSON), attempts, last_error, created_at`

### 4.2 Supabase schema touchpoints

**No new tables introduced so far.** We read/write existing reThink tables. Fields we populate:
- `interactions.notes` — Gemini 2-line summary (historically null; we fill it)
- `interactions.type = 'whatsapp'`, `direction`, `interaction_date`, `contact_id`, `user_id`
- `extension_interaction_windows` — one row per session with `window_start`, `window_end`, `direction`, `message_count`
- `contact_channels` — insert on person creation + on LID mapping (`channel='whatsapp', identifier='lid:<...>' or '+<e164>'`)
- `outreach_logs.{job_title, company, location, personal_context, profile_photo_url, linkedin_url}` — populated by ✨ Enrich when available

**Pending migration (Phase 6):**
- Add habit type `conversation_uniques` (or whatever the actual column name is in the `habits` schema — confirm by reading `useHabits.ts` first).
- Add `updateConversationUniquesHabit(userId, date)` function mirroring `updateNetworkingHabit`.

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
    │      │        enqueue 'window:bump' + update message_count
    │      │
    │      └── NO  → create new session row locally
    │               resolve contact_id via 3-source phone lookup
    │               if matched:
    │                 enqueue 'interaction:insert' (notes=null, health goes up)
    │                 enqueue 'window:insert'
    │               else:
    │                 emit 'chat:unmapped' → sidebar shows "+ Add to reThink"
    │                 the session has contact_id=null; sync skips it
    │                 (once user creates/links, resolveContactIdByPhone
    │                  cache is invalidated and future sessions resolve OK)
    │               start 6h timer
    ▼
timer fires (6h after last_message_at)
    │
    ▼
SessionManager.closeSession(sessionId)
    │
    ├── load all messages.text for this session from SQLite
    ├── call Gemini 2.0 Flash:
    │     "Resume esta conversación de WhatsApp en exactamente 2 líneas
    │      en español. Línea 1: tema/contexto. Línea 2: resultado/
    │      compromiso/sentimiento."
    ├── write summary back to sessions.summary
    ├── enqueue 'interaction:update_notes' with the summary
    │      (only if session has contact_id — unmapped sessions are skipped)
    └── emit 'session:closed'
```

**Crash safety:** all state lives in SQLite. On boot, `SessionManager` replays `sessions WHERE closed_at IS NULL`, restarts timers for those still within their 6h window, immediately closes (and summarizes) any whose window expired while the app was off.

**Env var for dev:** `CONV_SESSION_WINDOW_SECONDS=30` overrides 6h for fast e2e testing.

---

## 6. Contact matching

Three lookup sources, in this order (first hit wins):

1. `contact_channels` where `channel='whatsapp'` and `identifier IN (variants)` — handles LIDs and phone canonicalization
2. `contact_phone_mappings.phone_number IN (variants)` — legacy extension table
3. `outreach_logs.phone IN (variants)` — direct legacy field

Phone variants are generated by `electron/utils/phone.ts` (ported from extension): with/without `+`, with/without country code, the raw digit string. LinkedIn URL variants use slug-based `ilike` (`%/in/<slug>%`) which survives `www`, trailing slash, query params, and case.

On unmapped chat → sidebar shows `PersonNotFound` component with `+ Add to reThink` button → opens `MapParticipantModal` with tabs: **Search existing** (ilike on name) and **Create new** (name from WA, pre-selected so one keystroke replaces it; optional LinkedIn URL).

---

## 7. File structure (as built)

```
Conversations/
├── SPEC.md                          ← this file (long-term contract)
├── PROGRESS.md                      ← live status tracker
├── README.md
├── package.json                     electron 33, react 18, supabase 2.46, better-sqlite3 12
├── electron-builder.yml             arm64 only, unsigned, GitHub publish
├── tsconfig.{json,main,renderer}.json
├── vite.config.ts
├── .env                             (gitignored) VITE_SUPABASE_URL, ANON_KEY, GEMINI_API_KEY
├── .env.example
├── assets/
│   ├── icon.icns                    macOS bundle icon (generated from icon-source.png)
│   ├── icon.png
│   └── icon-source.png
├── electron/
│   ├── main.ts                      BaseWindow + 4 views, IPC, updater, sync worker boot
│   ├── layout.ts                    4-view geometry, collapse/expand
│   ├── preload.ts                   (legacy stub)
│   ├── preload-whatsapp.ts          MutationObserver, chat-change poll, LID/phone extract, banner hider
│   ├── preload-linkedin.ts          profile detection, scrapers, one-shot DOM diagnostic
│   ├── preload-sidebar.ts           exposes window.conv.*
│   ├── preload-tabbar.ts            tab switcher + nav buttons + ⌘K dispatcher
│   ├── preload-overlay.ts           command palette overlay bridge
│   ├── session-manager.ts           6h sliding timers, open/bump/close
│   ├── ai/
│   │   └── gemini.ts                2-line summarizer REST
│   ├── db/
│   │   ├── schema.sql               messages, sessions, sync_queue
│   │   └── local.ts                 better-sqlite3 wrapper
│   ├── sync/
│   │   └── supabase-sync.ts         drains sync_queue every 10s, retry/backoff
│   ├── supabase/
│   │   ├── env.ts                   .env loader (no dotenv dep)
│   │   ├── storage.ts               file-based auth session cache
│   │   ├── client.ts                @supabase/supabase-js with PKCE + file storage
│   │   ├── auth.ts                  Google OAuth loopback flow
│   │   └── contacts.ts              findByPhone, findByLinkedinUrl, resolveContactIdByPhone,
│   │                                createContactFromParticipant, enrichFromLinkedinProfile
│   └── utils/
│       ├── phone.ts                 variants + E.164 normalization
│       └── logger.ts
├── renderer/
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx                      Login | Main routing
│   ├── conv-api.d.ts                window.conv.* types
│   ├── vite-env.d.ts
│   ├── lib/                         shared React utilities
│   ├── screens/
│   │   ├── LoginScreen.tsx
│   │   ├── MainScreen.tsx           orchestrates context → screen, handles refresh
│   │   ├── ContactDetailScreen.tsx  rich detail + + Log / + Add / ✨ Enrich
│   │   ├── GroupScreen.tsx          participants w/ health ring + map modal
│   │   ├── LinkedinProfileScreen.tsx
│   │   ├── PersonNotFound.tsx       empty state + Create flow
│   │   ├── MapParticipantModal.tsx  Search existing / Create new tabs
│   │   └── CommandPalette.tsx       ⌘K overlay
│   └── styles/
│       └── tokens.css               burnham/shuttle/mercury/pastel/gossip — ALL styling lives here
└── release/                         electron-builder output (gitignored)
    ├── Conversations-<ver>-arm64.dmg
    ├── Conversations-<ver>-arm64-mac.zip
    └── latest-mac.yml               auto-update manifest
```

---

## 8. Build phases (with shipped status)

> Status column: ✅ shipped, 🟡 in-flight, 🔜 planned. Commit hash when shipped.

| Phase | What | Status | Commit |
|---|---|---|---|
| 0 | Electron shell + WhatsApp Web embedded | ✅ | `522194b` |
| 1 | Sidebar + Supabase OAuth + read-only lookup | ✅ | `429fdcd` |
| 1.5 | Rich ContactDetail (health, context, opportunities, tubos, value logs) | ✅ | `8c7246b` |
| 2 | Auto-detect active WA chat from DOM (600ms poll on `[data-id*="@c.us"]`) | ✅ | `e7956f8` |
| 2.5 | Group sidebar + participant list + LID mapping modal | ✅ | `4c2effe` |
| 2.6 | Tab bar (WA + LI) + ⌘1/⌘2 + nav buttons (← → ⟳ ⌂) | ✅ | `fc808a8` |
| 2.7 | LID `map-once-forever` + ignore-self + LI profile detection | ✅ | `b1ad55b` |
| 2.7b | ⌘K command palette + Create-from-LI + ✨ Enrich | ✅ | `df2bdbd` |
| 3a | `better-sqlite3` + schema + `LocalDB` wrapper | ✅ | `0b89835` |
| 3b | Per-message capture to SQLite (MutationObserver) | ✅ | `7f243c5` |
| 3c | `SessionManager` — sliding 6h window with timers | ✅ | `1abd298` |
| 3d | `GeminiSummarizer` — Spanish 2-line summary | ✅ | `1abd298` |
| 3e | `SupabaseSync` — sync_queue drain with retry | ✅ | `8683ddb` |
| 3f | End-to-end verified (30s test window) | ✅ | `b1223a4` |
| 4 | Create person from unmapped 1:1 WA chat | ✅ | `f2dfe54` → `5721eab` |
| 7 | `electron-builder` + `electron-updater` + GH Releases v0.0.1 | ✅ | `b649c5f` |
| — | **App icon integration** (mid-flight when session was cut off) | 🟡 | see PROGRESS.md |
| 5 | Retroactive history import (button per chat) | 🔜 | — |
| 5.1 | Upload LI photos to Supabase Storage (port `uploadLinkedInPhotoFromBase64`) | 🔜 | — |
| 5.2 | Deep LI enrichment (followers, connections, skills, birthday, Gemini enrichment) + fix location/company scraping | 🔜 | — |
| 6 | `conversation_uniques_per_day` KPI + weekly goal wiring in reThink | 🔜 | — |
| UX-1 | Full UI polish pass — typography, density, spacing, iconography, maybe dark mode | 🔜 | — |
| 8 | Remove WA content-script from Chrome extension | 🔜 | — |

**Demo criteria** (one per phase) live in `PROGRESS.md`. Each phase must have a demoable outcome before the next starts.

---

## 9. Nice-to-haves (post-v1)

Not on the roadmap. Record here so we don't forget or re-pitch.

- **Live LinkedIn autocomplete** in ⌘K overlay via `voyager/api/typeahead` (requires calling from inside the authenticated LI view with CSRF token — frail).
- **Scan all group members** — open/close group-info panel programmatically to scrape the silent members. Opt-in button, not default.
- **Option B group capture** — per-participant interactions from group messages. Only if Opt-A (visual-only) feels insufficient after months of use.
- **Extensible tab bar** — pinnable custom tabs (Exit5, X, Gmail, Calendar). Needs per-tab partition handling.
- **Encrypted SQLite backup** to `~/Library/Application Support/Conversations/backups/` with user-passphrase AES.
- **Multi-device sync** (laptop ↔ desktop) — would require server-side message text storage, which we locked out in Decision #4. Revisit only if user explicitly asks.
- **Sentiment and topic analysis** on summaries — would require changing the Gemini prompt or adding a second pass. Easy if requested.
- **CRM-side AI nudges** ("you haven't talked to X in 30 days, here's the last thread summary") — belongs in reThink web, not here.
- **Windows build** — electron-builder already supports it; bumping `electron-builder.yml` and running on a Windows host is 15 min. Do it only when an actual Windows user appears.
- **iMessage / SMS capture** — macOS private-API territory. No.
- **In-app chat search** across all captured messages — SQLite FTS5. Cheap to add if user wants it.
- **"Who haven't I talked to this week"** sidebar section — reads `interactions`, filters by last_interaction < 7d, ranks by health_score. Tiny feature, could be fun.

---

## 10. Errors we shall not repeat 🚫

Compiled from actual mistakes made while building this. Read this list before starting a new phase.

### 10.1 Don't reinvent scrapers that the Chrome extension already solved
When we wrote the LI photo scraper from scratch it took 4 rounds and still grabbed the banner. When we finally just ported `findProfilePhotoUrl` from the extension verbatim (20 lines, "only inside `<main>`, prefer `profile-displayphoto`, fall back to any `media.licdn.com/dms/image` in main") it worked first try. Rule: **always look in `~/Documents/reThink-2026/extension/src/` first, port the logic, then adapt**.

### 10.2 Don't bomb the CPU in a MutationObserver
The first "hide Get WhatsApp for Mac banner" implementation queried `a, button, div, span` (thousands of nodes) on **every** DOM mutation during WA boot — WhatsApp went blank because the event loop was starved. Rule: **throttle to `requestAnimationFrame`**, narrow the query (`a, button` only), and short-circuit once the target is found.

### 10.3 Don't call `supabase.auth.*` awaitable methods from inside `onAuthStateChange`
Causes a deadlock because the listener is invoked while the auth lock is held. Symptom: the callback never returns, `exchangeCodeForSession` hangs. Rule: **use the `session` passed to the callback directly**. Never `await supabase.auth.getSession()` from within it.

### 10.4 Don't trust obfuscated CSS classes on WhatsApp or LinkedIn
They change every release. Anchor on stable attributes: `data-id` with `@c.us` / `@lid` / `@g.us` suffix, `/in/<slug>/` in the URL, `data-pre-plain-text`, `<p>` atoms, `<main>` scoping. **Never** target a class like `pv-top-card-profile-picture__image`.

### 10.5 LinkedIn LIDs are not phone numbers
`244482926760154` is not Angola country code — it's an opaque Linked ID. Don't try to E.164-format it, don't try to call a DM link with it, don't display it to the user as a phone. **Mark it as `lid`, show "WhatsApp LID" in the UI, no DM button, rely on `map-once-forever`** to attach it to a reThink contact. That mapping then powers auto-recognition everywhere.

### 10.6 Don't scrape LinkedIn server-side
The Supabase edge function `linkedin-fetch` gets blocked by LinkedIn's login wall (no session cookies, no CSRF). It returns empty or 401. **Scrape from inside the LinkedIn view's preload** — it has the user's authenticated session. The old extension did this for the same reason.

### 10.7 Don't fight Google OAuth in Electron
Even with `Sec-CH-UA*` header stripping, Google still detects Electron via other heuristics. Use **LinkedIn email/password** when signing into LinkedIn. Don't invest more hours in this — it's Google's anti-automation, not our bug.

### 10.8 Don't do universal DMG on this machine
`hdiutil` needs ~10 GB scratch. Disk at 93% → universal build fails silently. Config pinned to **arm64 only**. Revisit only on a machine with >30 GB free or via CI.

### 10.9 Don't commit secrets
User pasted a Gemini API key into chat once. Rule: the `.env` is **always gitignored**; `.env.example` has placeholders only. If a key leaks through chat, **rotate in Google AI Studio** — 30 seconds and gone.

### 10.10 Watch disk space — APFS silently corrupts native modules near full
When `/dev/disk3s5` hit 94%, `typescript/lib/_tsc.js` came out of npm install as a 0-byte phantom file — `tsc --version` printed nothing, compilation silently emitted nothing, and we spent an hour chasing it. Symptoms to watch: `fatal: unable to write new_index file`, silent tsc, `ENOSPC` in stderr. Fix: free disk space (at least 20 GB), then:
```bash
rm -rf node_modules package-lock.json dist
npm cache clean --force
npm install
```

### 10.11 Don't skip the 5-second rehydration window on chat change
When you first open a chat, WhatsApp renders the last ~50 messages. If you capture those as "new" you get a flood of fake inbound+outbound into SQLite. The preload **ignores all messages within 5 seconds of a chat-change event**. Mess with this threshold only with very careful testing.

### 10.12 Don't insert `interactions` with `status = 'new'`
reThink's `outreach_logs.status` has a check constraint: `{PROSPECT, INTRO, CONNECTED, RECONNECT, ENGAGED, NURTURING, DORMANT}`. Use **`'PROSPECT'`** for newly created contacts. Lowercase or `'new'` throws a constraint error.

### 10.13 Never do `git add .` or `git add -A` in this repo
Always stage explicit paths. The `release/` folder has 100 MB DMG+ZIP files that must not leak into git. The `.env` file is gitignored but mistakes happen.

### 10.14 Don't `amend` or `rebase -i` after push
First release is shipped to GH and wife's machine will auto-update from it. Rewriting history breaks both. Always **create new commits** going forward.

### 10.15 Don't put message text in Supabase
Decision #4. Period. The only thing that ever hits Supabase is the Gemini-generated 2-line summary (`interactions.notes`). If someone asks "can we just store the raw texts so we can re-query?", the answer is **no, store them locally and re-summarize with a new prompt**.

---

## 11. Learnings & working agreements 🤝

How we work on this project. Meta-rules that the user has validated in practice.

### 11.1 No phase skipping
Every phase has a demoable criterion. Don't write Phase 5 code before Phase 4 demos. If you think you need to cross phases, write a note in PROGRESS.md and wait for user approval.

### 11.2 Phasing order is sacred
The agreed order is: **icon finish → Fase 5 → 5.1 → 5.2 → 6 → UX-1 → 8**. UX-1 is explicitly the last infrastructure piece because the user wants to polish the app he has in hand, not re-polish half-built screens.

### 11.3 User wants UI polish, not only UX
UX = behavior. UI = look. The user has said multiple times "no me gusta el UI, pero lo vemos más adelante" — so when UX-1 arrives, expect typography/color/spacing work, not just interaction flows.

### 11.4 Port before you build
Before writing anything that touches LinkedIn, WhatsApp Web, phones, or reThink schemas: **grep the extension and reThink codebases for prior art**. Copy the pattern. Only deviate with a reason.

### 11.5 Confirm semantic intent before mutating reThink
If you're about to write to a column or change the meaning of a row, first `grep` how reThink web/mobile reads it. Example: flipping interactions from per-day to per-session required checking every `.from('interactions')` consumer first.

### 11.6 Gates are useful when they mean something
The "must be at least 5s since chat-change" gate. The "must have contact_id to sync" gate. The "must have scraped name to run diagnostic" gate. These aren't paranoia — each one exists because the thing they prevent actually happened. Don't remove a gate without reading why it was added.

### 11.7 Log before you guess
When something breaks, add a logging line before changing logic. The preload's `photo-dom-diagnostic` one-shot dump was written after 3 failed rounds of guessing selectors — and it solved the problem in one iteration.

### 11.8 Two doc files, not one
- `SPEC.md` is the **long-term contract** — locked decisions, architecture, phases, nice-to-haves, errors not to repeat, learnings. Update rarely, major versions.
- `PROGRESS.md` is the **weekly tracker** — latest commit, in-flight work, known bugs, how to resume. Update every significant commit.

### 11.9 Commit in separate semantic units
`docs:` separate from `feat:` separate from `fix:`. Two docs commits for two files is clearer than one mega-commit. In-flight dirty files stay out of docs commits.

### 11.10 First-launch Gatekeeper note goes in every release body
Without it, wife (and any other user) gets "Conversations is damaged" and deletes the app. Every GH release body must include:
> macOS will block the first launch. Right-click the app in Applications → Open → Open (only the first time).

### 11.11 30-second window for debugging the pipeline
Set `CONV_SESSION_WINDOW_SECONDS=30` and test the whole capture → SQLite → Supabase → Gemini → sync loop in under a minute. Don't wait 6 real hours to validate a change to `SessionManager`.

### 11.12 Spanish in user-facing text, English in code
Session summaries, empty states, modal labels: **Spanish** (user + wife speak it). Variable names, comments, commit messages, docs: **English**. Don't mix.

---

## 12. Open questions (live)

These are genuinely unresolved and will block a phase when we get there:

| # | Question | Where to look | Blocks |
|---|---|---|---|
| 12.1 | Does `useHabits.ts` in reThink accept a new habit type via config, or does it require code changes? | `~/Documents/reThink-2026/src/hooks/useHabits.ts` | Phase 6 |
| 12.2 | Is there any reThink UI that counts raw `interactions` rows (which will look inflated now that we're one-per-session)? | Search `.from('interactions')` across reThink source | Phase 6 final validation |
| 12.3 | Rate-limiting on WhatsApp Web history scroll — how fast can we scroll the pane before WA sends us to captcha? | Phase 5 spike | Phase 5 |
| 12.4 | LinkedIn `location` and `company` scrape reliability — need a positional strategy, not regex-on-comma | `electron/preload-linkedin.ts`, `scrapeLocation`, `scrapeCompany` | Phase 5.2 |
| 12.5 | `media.licdn.com` photo URL expiry — do they 404 after days, hours, minutes? | Phase 5.1 | Phase 5.1 |

---

## 13. What we are NOT building (and why)

Summary of locked-out items from throughout this doc:

- **Auto-reply / AI composer** (Decision #14) — user refuses automation.
- **Multi-user / hosted** — personal tool, one install per person.
- **Windows / Linux** — nobody needs it today.
- **iMessage / SMS capture** — macOS private APIs.
- **Server-side message text storage** (Decision #4) — privacy lock-in.
- **Group message capture** (Decision #12) — noise.
- **LinkedIn scraping via server-side edge function** (Decision #13) — blocked by LI.
- **Code signing / notarization** (Decision #3) — user declined Apple Developer.
- **Universal DMG** (Decision #2) — builds fail on our disk.
- **iCloud sync of local DB** — deliberately not in scope.
