# PROGRESS — Conversations

> Handoff doc for future agents. **Update this whenever you finish something big.**
> Keep it terse. The SPEC is the source of truth for *what* the app is; this doc tracks *where we are* and *what to do next*.

---

## Current status (as of 2026-04-17)

**Last commit on `master`:** `b649c5f phase 7: electron-builder + auto-update + first distributable`
**Remote:** https://github.com/alexisamp/conversations (private)
**First release:** [v0.0.1](https://github.com/alexisamp/conversations/releases/tag/v0.0.1) — DMG 99 MB, arm64 only, unsigned
**Working tree dirty:** `electron-builder.yml`, `renderer/index.html`, `renderer/screens/LoginScreen.tsx`, `renderer/styles/tokens.css`, plus untracked `assets/` (icon) and `renderer/{favicon,icon}.png` — these are the mid-flight icon integration from the session that got cut off. Don't blow them away before reading the *Open in-flight work* section.

---

## Phases complete ✅

| # | What | Commit | Notes |
|---|---|---|---|
| 0 | Electron shell + WhatsApp Web embedded | `522194b` | Chrome UA spoof, persistent session, zoom 0.80 |
| 1 | Sidebar + Supabase OAuth (PKCE loopback) + read-only contact lookup | `429fdcd` | BaseWindow + 2 WebContentsView layout. Redirect URL `http://localhost:54321/callback` must be whitelisted in Supabase |
| 1.5 | Rich contact detail (health, context, opportunities, next-step tubos, value logs, `+ Log` / `+ Add` inline forms) | `8c7246b` | |
| 2 | Auto-detect active WA chat, drive sidebar from DOM polling (600ms) | `e7956f8` | `[data-id*="@c.us"]` for 1:1 phone extraction |
| 2.5 | Group sidebar with participants, LID `map-once-forever`, mapping modal | `4c2effe` | Camino A (participants who have spoken). Scan-all-members TODO |
| 2.6 | Tab bar + LinkedIn tab + `⌘1/⌘2` + nav buttons (← → ⟳ ⌂) + unified sidebar context | `fc808a8` | Strips `Sec-CH-UA*` client hints so Google OAuth doesn't flag Electron — **still rejected** by Google (use LinkedIn email/password) |
| 2.7 | LID map-once-forever + ignore-self filter + LI profile detection emits immediately on `/in/<slug>/` | `b1ad55b` | |
| 2.7b | LI search overlay `⌘K` + Create-from-LI-profile + ✨ Enrich button | `282c92c` / `df2bdbd` | |
| 3a | `better-sqlite3` + schema + `LocalDB` wrapper | `0b89835` | macOS APFS disk-full once left `typescript/lib/_tsc.js` as a 0-byte phantom — if `tsc` ever silently emits nothing, `rm -rf node_modules && npm cache clean --force && npm install` |
| 3b | Per-message capture to SQLite via MutationObserver in `preload-whatsapp.ts` | `7f243c5` | 5s rehydration skip on chat-change to avoid capturing history. Only 1:1 (`@c.us`); groups filtered. Verified: 59 messages captured in conv.db |
| 3c | `SessionManager` — sliding 6h window, in-memory timers | `1abd298` | Env var `CONV_SESSION_WINDOW_SECONDS` for testing (defaults 21600) |
| 3d | `GeminiSummarizer` — REST to `gemini-2.0-flash` in Spanish | `1abd298` | Uses `VITE_GEMINI_API_KEY` from `.env` |
| 3e | `SupabaseSync` worker drains `sync_queue` every 10s, retry/backoff | `8683ddb` | |
| 3f | End-to-end verified with 30s window: WA msg → SQLite → interaction row → Supabase → 30s silence → Gemini summary → `interactions.notes` updated | `b1223a4` | Contact-id resolution via `resolveContactIdByPhone` |
| 4 | Create person from unmapped 1:1 WA chat (sidebar modal, name auto-selected for fast replace) | `f2dfe54` → `4d7c681` → `5721eab` | `4d7c681` fixes the "had to switch chats to see it" bug by setting `lastHitPhoneRef` on `not-found` too |
| 7 | `electron-builder` + `electron-updater` + GitHub Releases | `b649c5f` | `npm run release` builds DMG and publishes. arm64-only to keep DMG small and dodge the disk-full trap during universal build |

---

## Open in-flight work 🟡 (session cut off mid-task)

**Icon integration** — started after v0.0.1 ship, never finished, never committed.

- `~/Downloads/Conversations Favicon.png` → processed into `assets/icon.png`, `assets/icon.icns`, `assets/icon-source.png`, `renderer/icon.png`, `renderer/favicon.png`.
- `electron-builder.yml` was updated to reference `assets/icon.icns` for macOS build.
- `renderer/index.html`, `renderer/screens/LoginScreen.tsx`, `renderer/styles/tokens.css` were edited to use the icon (login header, favicon link, and probably a brand mark in tab bar).
- **The tab bar brand-mark integration was interrupted** — a base64 data-URL was being embedded inline and then repeated API image-processing errors stopped the work.
- **To finish:** verify current dirty diff still makes sense, test `npm run dev` visually, then commit as `feat: add app icon to macOS bundle + login + tab bar`.
- **Then:** bump version to `0.0.2`, `npm run release` so the user and his wife get the new icon via auto-update.

---

## Phases pending 🔜

In the order the user agreed to. Roadmap is in SPEC.md §9 but this is the live view.

| # | What | Est. | Why now |
|---|---|---|---|
| **Icon finish** | Commit the icon work above and ship v0.0.2 | 15 min | Smallest possible first win after handoff |
| 5 | Retroactive message import (button "Import history") | 3-4h | Scrolls WA Web, scrapes visible messages, groups into historical 6h windows, Gemini-summarizes each, writes retroactive `interactions`. Reuses Phase 3 pipeline. The extension has `scanWhatsAppMessageHistory` + `groupInto6HourWindows` + `autoBackfillWhatsApp` that port almost directly. |
| 5.1 | Upload LinkedIn photos to Supabase Storage (port `uploadLinkedInPhotoFromBase64` from extension) | 1h | `media.licdn.com` URLs expire; store in `contact-photos` bucket for permanence |
| 5.2 | Deep LI enrichment — followers, connections, skills, birthday (JSON-LD), company_domain via Gemini `google_search`, approach_angles, etc. Also fixes the **LI location + company scraping bug** (see Known issues). | 3-4h | Polish after the core loop works |
| 6 | New KPI `conversation_uniques_per_day` + wire to weekly goals in reThink | 1h | Requires a new `habit_type` in reThink and a consumer in `useHabits.ts` |
| UX-1 | Full UI polish pass (user explicitly asked "UI not just UX") — tipografía, densidad, animaciones, iconos, maybe dark mode, responsive sidebar. Style tokens live in `renderer/styles/tokens.css` | 1 día | User said repeatedly "no me gusta el UI, pero lo vemos más adelante" — that time is now |
| 8 | Disable WhatsApp content-script in the Chrome extension | 15 min | Prevents duplicate interactions once everyone's on Conversations. Touch `manifest.json` + service-worker in `~/Documents/reThink-2026/extension/`. Keep LinkedIn content scripts intact |

---

## Known issues / rough edges 🐛

1. **LinkedIn `location` and `company` scraping** — `scrapeLocation` returns the headline text (pattern "text with comma"), and `scrapeCompany` relies on `parseCompanyFromHeadline` which is fragile. Commit `c5e68be` moved the top-card scraper to **`<p>`-only** atoms, which fixed `job_title`, but location+company still wrong. Fix approach documented in the old session: **positional** — `location` = last non-junk `<p>` before the `/\d+ (followers|connections)$/` block; `company` = the `<p>` between headline (`p[0]`) and location. Also add clear-on-scrape semantics so existing corrupted data (e.g. Lenny's `location = "Deeply researched no-nonsense…"`) gets wiped on re-Enrich.
2. **`✨ Enrich` overwrite semantics** — currently overwrites LI-sourced fields when user clicks. Intentional. Hand-edited fields in reThink will also be overwritten if they map to LI fields. If the user complains, switch to "overwrite only when scraped value is non-null AND differs".
3. **Google OAuth in LinkedIn view is rejected** — Google detects Electron despite `Sec-CH-UA*` header stripping. Workaround: LinkedIn email/password. Don't spend more time on this — it's Google's anti-automation, not our bug.
4. **Grup/group message capture** — explicitly skipped (SPEC §2 decision #4). Groups are visual-only in the sidebar. Don't capture to SQLite.
5. **Scan-all-members for groups** — only participants who have spoken are visible. Silent members not shown. Future work: programmatically open/close the group-info panel and scrape the roster.
6. **No code signing** — user explicitly confirmed: no Apple Developer account, ever. First-launch needs *right-click → Open → Open* on every Mac. Document this in the GitHub release body.
7. **Disk-full hazard** — `/dev/disk3s5` was at 94% earlier. APFS can silently corrupt freshly-extracted native modules (symptom: `tsc --version` prints nothing, compiler emits zero files). If you ever see `fatal: unable to write new_index file` or silent tsc, the fix is disk cleanup + `rm -rf node_modules && npm cache clean --force && npm install`.
8. **Universal DMG fails on this machine** — hdiutil needs ~10 GB free scratch. `electron-builder.yml` is pinned to `arm64` only. If a future Intel-Mac user appears, build on a bigger disk or a CI runner.

---

## How to resume work (quickstart for a fresh agent)

```bash
cd ~/Documents/Conversations
git status              # check the in-flight icon work
npm run dev             # vite (5173) + tsc + electron
```

**Useful env vars for dev:**
- `CONV_DEV=1` — enables dev mode (auto-set by `dev:electron`)
- `CONV_DEVTOOLS=1` — auto-opens DevTools on sidebar + LinkedIn views
- `CONV_SESSION_WINDOW_SECONDS=30` — override 6h window for fast e2e testing of the capture→Gemini→sync pipeline

**Where things live:**
- `electron/main.ts` — orchestrator (layout, IPC, session lifecycle, sync worker boot)
- `electron/preload-whatsapp.ts` — DOM observer, message capture, chat-change detection, banner hider, LID/phone participant scraping
- `electron/preload-linkedin.ts` — profile detection, scrapers (name, jobTitle, location, about, photoUrl), the one-shot `[li-dom-diagnostic]` dump (gated on "name was scraped")
- `electron/session-manager.ts` — sliding 6h window, timers, open/bump/close, enqueues to sync_queue
- `electron/sync/supabase-sync.ts` — drains sync_queue every 10s
- `electron/ai/gemini.ts` — `gemini-2.0-flash` REST call, "resume en 2 líneas" prompt
- `electron/db/{schema.sql,local.ts}` — `better-sqlite3` (messages, sessions, sync_queue)
- `electron/supabase/contacts.ts` — `findContactByPhone`, `findContactByLinkedinUrl` (slug-based `ilike`), `resolveContactIdByPhone`, `createContactFromParticipant`, `enrichContactFromLinkedinProfile`
- `renderer/screens/*` — React UI (Login, Main, ContactDetail, Group, LinkedinProfile, command palette overlay)
- `renderer/styles/tokens.css` — all styling; UI polish pass lives here

**Database paths:**
- Local SQLite: `~/Library/Application Support/Conversations/conv.db`
- Auth session cache: `~/Library/Application Support/Conversations/auth-session.json`

**Supabase project:** `amvezbymrnvrwcypivkf` (reused from reThink). Schema is read-only to us — don't migrate anything from this app. Tables we touch: `outreach_logs`, `interactions`, `contact_channels`, `contact_phone_mappings`, `extension_interaction_windows`, `habits`, `habit_logs`, `value_logs`, `opportunities`.

**Shipping a new version:**
```bash
npm version patch               # bumps package.json
npm run release                 # builds DMG + creates GH release with auto-update metadata
git push origin master --tags
```
Users get the update on next app launch (electron-updater polls on boot).

---

## Update protocol for future agents

- Bump "Current status" at the top when the working tree or latest commit changes.
- Move rows from **Pending** to **Complete** when shipped. Add the commit hash.
- Add to **Known issues** when you discover something weird; remove when fixed with a link to the fix commit.
- Don't narrate. If a future agent needs *why* a decision was made, that goes in SPEC.md or the commit message, not here.
- Keep this file under 300 lines. If it grows, archive old completed rows into a `PROGRESS-archive.md`.
