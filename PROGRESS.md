# PROGRESS — Conversations

> Handoff doc for future agents. **Update this whenever you finish something big.**
> Keep it terse. The SPEC is the source of truth for *what* the app is; this doc tracks *where we are* and *what to do next*.

---

## Current status (as of 2026-04-19)

**Local HEAD:** `4b4c690 fix(backfill): persistent scroll+click — up to 5 attempts before stopping`
**Local tag:** `v0.0.7` at HEAD (unpushed — see below)
**Remote HEAD (origin/master):** still at `b92a858` from 2026-04-18
**Remote tags:** v0.0.1 – v0.0.6 on GitHub
**Latest GH Release:** [v0.0.6](https://github.com/alexisamp/conversations/releases/tag/v0.0.6) — DMG published with old code
**User's installed app:** `/Applications/Conversations.app` reports v0.0.6 in Info.plist, but its `app.asar` has been **hot-patched in place** with a fresh build that contains all of v0.0.7's features (see Local vs Remote mismatch).
**Working tree:** clean.

### Local vs Remote mismatch

Four commits are local-only, and the asar of the installed app has them applied via a `npx asar extract → copy dist → npx asar pack` swap:

| Commit | Contents |
|---|---|
| `5f3f476` | `preload-whatsapp` Array.from for NodeList iteration (strict tsc fix) |
| `60f417d` | `attachWaName` map-once for saved WA contacts (new contact_channels row with `channel_identifier='waname:<name>'`) + findContactByName checks this channel before outreach_logs |
| `837eb03` | Phase 5b: Gemini summaries per 6h window in backfill import + retro-upgrade of `[backfill]` placeholder rows to real summaries |
| `5f3cfca` | Auto-scroll in Import History: BACKFILL_SCROLL_AND_SCAN_SCRIPT walks chat pane to top, scan after each step, stop after 2 stable scrollHeight readings (max 80 iter). UI has primary 📥 and secondary `quick` |
| `ccf7227` | Click 'Click here to get older messages from your phone' button when scroll stabilizes — WA only pre-streams a few days; deeper history requires the button click to fetch from the linked phone. Cap raised to 400 iterations. |
| `4b4c690` | Persistent scroll+click — 5 cycles without new entries before giving up (was 2). Click fires regardless of whether the button was found, to handle the race where the button is mid-render. Cap 400 → 600 iter. |

**To fix the mismatch:** push + build DMG + release v0.0.7 when memory allows. The hot-patched asar works for the author's Mac; wife's Mac (if she ever needs to reinstall) needs the proper DMG.

---

## Phases complete ✅

| # | What | Commit | Notes |
|---|---|---|---|
| 0 | Electron shell + WhatsApp Web embedded | `522194b` | Chrome UA spoof, persistent session, zoom 0.80 |
| 1 | Sidebar + Supabase OAuth (PKCE loopback) + read-only contact lookup | `429fdcd` | |
| 1.5 | Rich contact detail (health, context, tubos, value logs, `+ Log` / `+ Add`) | `8c7246b` | |
| 2 | Auto-detect active WA chat (DOM polling 600ms) | `e7956f8` | Original DOM-based. Broken by 2026-04 WA update. |
| 2.5 | Group sidebar + participants + LID `map-once-forever` | `4c2effe` | Group detection currently disabled (see Known issues) |
| 2.6 | Tab bar + LinkedIn tab + `⌘1/⌘2` + nav buttons | `fc808a8` | |
| 2.7 | LID map-once + LI profile detection | `b1ad55b` | |
| 2.7b | ⌘K LI search overlay + Create-from-LI + ✨ Enrich | `282c92c` / `df2bdbd` | |
| 3a | `better-sqlite3` + local schema + LocalDB wrapper | `0b89835` | |
| 3b | Per-message capture to SQLite | `7f243c5` | 5s rehydration skip, 1:1 only |
| 3c | SessionManager (6h sliding) | `1abd298` | `CONV_SESSION_WINDOW_SECONDS=30` for dev |
| 3d | Gemini 2-line summarizer | `1abd298` | `VITE_GEMINI_API_KEY` |
| 3e | SupabaseSync worker (10s poll) | `8683ddb` | |
| 3f | E2E verified with 30s window | `b1223a4` | |
| 4 | Create person from unmapped WA chat | `f2dfe54` → `5721eab` | |
| 7 | electron-builder + electron-updater + GH Releases | `b649c5f` | |
| Icon | Custom app icon | `b90d8d6` / v0.0.2 | |
| Settings | ⚙︎ gear + manual updater + custom installer (bypass codesign) | `c6ab78d` / v0.0.3 | |
| Installer path fix | runCustomInstaller uses `~/Library/Caches/conversations-updater/` | `4f5160c` / v0.0.5 | |
| WA DOM rewrite | 2026-04 WA broke data-id (now opaque 20-char hex). Detector rewritten to use `[aria-selected="true"]` + header span. findContactByName fallback for saved contacts. | `3134a60` / v0.0.6 | Group detection regressed — temp disabled |
| Array.from fix | tsc strict iteration compliance | `5f3f476` | **unpushed, in hot-patched asar** |
| attachWaName | map-once-forever for saved contacts by display name (saves `contact_channels.channel_identifier='waname:<name>'`) | `60f417d` | **unpushed, in hot-patched asar** |
| Phase 5a | "📥 Import history" button — timestamps + direction only, `[backfill]` placeholder notes | `2b35faf` / v0.0.4 | |
| Phase 5b | Gemini summaries per 6h window + retro-upgrade of placeholder rows | `837eb03` | **unpushed, in hot-patched asar** |
| Auto-scroll | Import History now scrolls chat pane to top. Loads months/years of history in one click. | `5f3cfca` | **unpushed, in hot-patched asar** |
| Click 'get older' button | WA shows a "Click here to get older messages from your phone" button once in-browser cache is exhausted. Scroll loop now clicks it to pull further back from the linked phone. | `ccf7227` | **unpushed, in hot-patched asar** |
| Persistent scroll+click (5 attempts) | Up to 5 scroll+click cycles without new entries before stopping (was 2). Handles archives where the button re-renders between fetches. | `4b4c690` | **unpushed, in hot-patched asar** |

---

## Open in-flight work 🟡

**In-place asar hot-patch on installed app.** The user's `/Applications/Conversations.app/Contents/Resources/app.asar` was manually re-packed from `dist/` to include the **six** unpushed commits' features. Mappings/summaries in Supabase created via this patched app are real and persistent. But the state is fragile — any future gear-icon-triggered update will *overwrite* the hot-patched asar with whatever is on GitHub (v0.0.6, missing all six features). The fix is to properly release v0.0.7. **Do this first next session when memory allows.**

**Pending KPI conversation_uniques_per_day planning.** User asked to evaluate the logic of the reThink habits/goals system *before* implementing. Didn't get to read the code — ripgrep hit memory pressure timeouts. Files to inspect first next session:
- `~/Documents/reThink-2026/src/hooks/useGoals.ts`
- `~/Documents/reThink-2026/src/components/GoalKPIWidget.tsx`
- `~/Documents/reThink-2026/src/components/WeeklyGoalsModal.tsx`
- `~/Documents/reThink-2026/src/screens/GoalDetail.tsx`
- search for `updateNetworkingHabit` and `tracks_outreach` across reThink source

Goal is to understand: (a) how a new `conversation_uniques_per_day` habit would plug into the existing weekly-goal pipeline, (b) whether the habit schema supports adding a new type without a DB migration, (c) the mental model we want (per-day unique-contact count from `interactions` where type='whatsapp'). Discuss with user before writing any code.

---

## Phases pending 🔜

| # | What | Est. | Why now |
|---|---|---|---|
| **v0.0.7 release** | Push master + tags, package DMG, `gh release create v0.0.7` | 15 min when memory OK | Back up the four unpushed commits + ship proper auto-updatable DMG. Blocked today by persistent memory pressure. |
| 6 | New KPI `conversation_uniques_per_day` wired to reThink weekly goals | 1-2h | Counts distinct contacts with ≥1 closed session per day. Consumed by `useHabits.ts` in reThink — needs investigation of schema (ripgrep timed out under memory pressure). |
| 5.1 | Upload LI photos to Supabase Storage | 1h | `media.licdn.com` URLs expire; port `uploadLinkedInPhotoFromBase64` from extension |
| 5.2 | Deep LI enrichment + fix `location` and `company` scraping | 3-4h | See Known issue #1 |
| Re-enable group detection | New DOM-based group probe (old one used `@g.us` in data-id which is gone) | 1-2h | Current groups show "No active chat" |
| UX-1 | Full UI polish pass — typography, density, spacing, animations, maybe dark mode | 1 day | User explicitly asked |
| 8 | Remove WhatsApp content-script from Chrome extension (`~/Documents/reThink-2026/extension/`) | 15 min | Prevents duplicate interactions |

---

## Known issues / rough edges 🐛

1. **LinkedIn `location` and `company` scraping** — location returns the headline text (pattern-on-comma), company via `parseCompanyFromHeadline` is fragile. Fix approach: positional — location = last non-junk `<p>` before `/\d+ (followers|connections)$/`; company = the `<p>` between headline and location. Add clear-on-scrape so corrupted data gets wiped.
2. **✨ Enrich overwrites LI-sourced fields on click.** Intentional. Hand-edited fields will be overwritten if they map to LI fields.
3. **Google OAuth in LinkedIn view rejected** by Google despite `Sec-CH-UA*` header stripping. Workaround: email/password.
4. **Group message capture** explicitly skipped (SPEC §2 decision). Groups visual-only in sidebar.
5. **Scan-all-members for groups** — currently disabled entirely (WA 2026-04 DOM broke the group probe). When it's re-enabled, it only sees participants who have spoken (silent members not shown).
6. **No code signing** — no Apple Developer account. First launch needs right-click → Open → Open per Mac.
7. **Disk-full hazard** — APFS silently corrupts freshly-extracted files when disk > 93%. Symptom: `tsc --version` prints nothing, compiler emits zero files. Fix: disk cleanup + `rm -rf node_modules && npm cache clean --force && npm install`.
8. **Universal DMG fails on this machine** — hdiutil needs ~10 GB scratch. Config pinned to `arm64` only.
9. **Memory-pressure tooling failures** — 8 GB machine + Claude Desktop + Claude Code + Dia + Granola = swap full → `tsc`, `mmap`, `git push`, `electron-builder` all hang silently for 5+ min. Symptoms: `mmap failed: Operation timed out`, 0.5s CPU in 5 min. Fix: close Granola, wait for swap to flush, or reboot.
10. **Nested semver corruption in `node-api-version`** — `@electron/rebuild` crashed with `Cannot read properties of undefined (reading 'COMPARATOR')`. `internal/re.js` was a partial install missing `exports.t`. Fix: `rm -rf node_modules/node-api-version/node_modules/semver && npm install`, OR bootstrap semver@^7.3.5 in /tmp and copy it over.
11. **Vite bundle cache trap** — it's possible to ship a stale renderer bundle even after `npm run build` if Vite decides nothing changed but main.ts / preload changed. Seen in v0.0.6 where the renderer still ran v0.0.4 bundle. Fix: `rm -rf dist` before build whenever backend API surface changes.

---

## How to resume work (quickstart)

```bash
cd ~/Documents/Conversations
git status              # should be clean; local HEAD ahead of origin
git log --oneline -10   # see the unpushed commits above
npm run dev             # vite (5173) + tsc + electron
```

### Useful env vars
- `CONV_DEV=1` — dev mode (auto-set by `dev:electron`)
- `CONV_DEVTOOLS=1` — auto-opens sidebar + LI DevTools
- `CONV_SESSION_WINDOW_SECONDS=30` — fast E2E of capture→Gemini→sync

### Developer menu (added in v0.0.6)
- `⌘⌥W` — Open WhatsApp DevTools
- `⌘⌥L` — Open LinkedIn DevTools
- `⌘⌥I` — Open sidebar DevTools
- `⌘⌥R` — Reload WhatsApp

### Remote debugging trick (CDP bypass when DevTools menu isn't available)
```bash
osascript -e 'tell app "Conversations" to quit'
open -a /Applications/Conversations.app --args --remote-debugging-port=9222 '--remote-allow-origins=*'
curl -s http://localhost:9222/json   # find the WS URL for the WA view
# then use any CDP client (python websocket-client lib, etc.) with origin='http://localhost'
```

### Hot-patch asar (when electron-builder is too slow to run)
```bash
osascript -e 'tell app "Conversations" to quit'; sleep 2
rm -rf /tmp/conv-asar-unpacked
cd ~/Documents/Conversations
npm run build   # produces fresh dist/
npx asar extract /Applications/Conversations.app/Contents/Resources/app.asar /tmp/conv-asar-unpacked
rm -rf /tmp/conv-asar-unpacked/dist
cp -R dist /tmp/conv-asar-unpacked/dist
npx asar pack /tmp/conv-asar-unpacked /Applications/Conversations.app/Contents/Resources/app.asar
open /Applications/Conversations.app
```

### Shipping a new version (when memory allows)
```bash
npm version patch
npm run release              # build DMG + create GH release
git push origin master --tags
```

### Where things live
- `electron/main.ts` — orchestrator (layout, IPC, session lifecycle, sync boot, updater, backfill scripts)
- `electron/preload-whatsapp.ts` — DOM observer, chat-change detection (NEW: `[aria-selected="true"]` + header span), message capture, LID/phone participant scraping
- `electron/preload-linkedin.ts` — LI profile detection, scrapers (name, jobTitle, location, about, photoUrl), `[li-dom-diagnostic]` one-shot dump
- `electron/session-manager.ts` — sliding 6h timers, open/bump/close → sync_queue
- `electron/sync/supabase-sync.ts` — drains sync_queue every 10s
- `electron/ai/gemini.ts` — `gemini-2.0-flash` REST, 2-line Spanish summary
- `electron/db/{schema.sql,local.ts}` — better-sqlite3 messages/sessions/sync_queue
- `electron/supabase/contacts.ts` — `findContactByPhone`, `findContactByName` (+ waname channel check), `findContactByLinkedinUrl` (slug ilike), `attachWaName`, `resolveContactIdByPhone`, `createContactFromParticipant`, `enrichContactFromLinkedinProfile`
- `renderer/screens/*` — React UI (Login, Main, ContactDetail w/ BackfillButton, Group, LinkedinProfile, SettingsScreen, MapParticipantModal, CommandPalette)
- `renderer/styles/tokens.css` — all styling; UI polish pass lives here

### Database paths
- Local SQLite: `~/Library/Application Support/Conversations/conv.db`
- Auth session cache: `~/Library/Application Support/Conversations/auth-session.json`
- Updater cache (downloaded ZIPs): `~/Library/Caches/conversations-updater/`

**Supabase project:** `amvezbymrnvrwcypivkf` (reused from reThink). Tables we touch: `outreach_logs`, `interactions`, `contact_channels`, `contact_phone_mappings`, `extension_interaction_windows`, `habits`, `habit_logs`, `value_logs`, `opportunities`.

---

## Update protocol for future agents

- Bump "Current status" when the working tree or latest commit changes.
- Move rows from **Pending** to **Complete** when shipped. Add the commit hash.
- Add to **Known issues** when you discover something weird; remove when fixed with a commit link.
- Don't narrate history. If a future agent needs *why* a decision was made, that goes in SPEC.md or the commit message.
- Keep this file under 400 lines. If it grows, archive old completed rows into a `PROGRESS-archive.md`.
