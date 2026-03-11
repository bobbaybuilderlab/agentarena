# ARENA_002_PLAN.md
## Agent Arena — Final Polish & Vercel Publish Pipeline
**Created:** 2026-02-27  
**Deadline:** Thursday (hard)  
**Priority:** P1  
**Author:** Donna (planning agent)

---

## 1. Executive Summary

This plan ships the final polish pass on Agent Arena — a competitive AI social deduction game platform — from its current 86%-tested state to a production-ready, publicly-shareable URL at `https://agent-arena-vert.vercel.app`. The work covers: (a) UI polish to Figma/Apple/Linear standard applied to all six pages (index, play, games-info, browse, guide, agent-villa), (b) fixing three real gaps — mobile navigation, self-referential play.html CTA, and missing static assets — (c) Playwright test selector fixes so CI is clean, and (d) a locked-down deploy pipeline with pre-flight checklist, production verification steps, and rollback procedure. The backend already runs on Railway; this PR ships the static frontend to Vercel via `npm run deploy:vercel`.

---

## 2. Current State Assessment

### Architecture (understood from code)
| Layer | Host | Status |
|-------|------|--------|
| Frontend (static) | Vercel → `dist/` | Live at agent-arena-vert.vercel.app |
| Backend (Node + Socket.IO) | Railway | Live at agent-arena-api-production-5778.up.railway.app |
| DB | SQLite on Railway | Migrated (001_initial, 002_reports) |
| Build | `npm run build` → `cp public/* dist/` | Working |
| Deploy | `npm run deploy:vercel` → `npx vercel@50.15.1 --prod --yes` | Working (pinned) |

### What's Working
- ✅ Dark theme with animated grid hero, gradient text, stagger animations
- ✅ Four-link nav (Play, Games, Feed, Docs) consistent across all pages
- ✅ Game picker cards (Mafia, Among Us, Villa) with coloured top borders
- ✅ Phase timeline component, player cards, post-game leaderboard widget
- ✅ Socket.IO reconnect banner with aria-live
- ✅ Hero stats (rooms, agents, games played) fetched from API
- ✅ Match HUD, action views, dev/ops panel
- ✅ config.js pointing to Railway backend correctly

### What Looks Rough
- ⚠️ **Mobile nav is broken** — `.nav-links { display: none }` at 760px with zero fallback. Users see only brand + "Play Now" button. No hamburger, no drawer.
- ⚠️ **play.html nav CTA is self-referential** — the "Play Now" button in the nav links back to `/play.html` when you're already on `/play.html`. Confusing.
- ⚠️ **og-image.svg and favicon.svg** — referenced in every HTML `<head>` but not confirmed to exist in `public/`. Will produce 404s in link previews and browser tabs.
- ⚠️ **games-info.html uses inline styles throughout** — `style="margin-top:24px; padding:20px; background:rgba(255,255,255,0.03)..."` — not using design system classes, looks inconsistent.
- ⚠️ **Battle ticker is static** — shows hardcoded "Agents battling now" text. Should reflect real room names or rotate game events.
- ⚠️ **Hero stats show "—" on initial load** — no loading skeleton, just dashes until API responds (can look broken on slow connections).
- ⚠️ **Roast Battles missing from game cards** — task description mentions "Roast Battles" as a fourth game mode, but only 3 appear (Mafia, Among Us, Villa).
- ⚠️ **No Inter font** — task says "Inter 700 inspired by Figma/Linear". Currently using Plus Jakarta Sans + Sora. Need to decide: keep or swap.
- ⚠️ **Raw JSON logs** — `logStructured()` outputs JSON to stdout. No impact on frontend, cosmetic server issue.

### What's Broken (Test-level, not runtime)
- ❌ **6 Playwright nav tests** — strict mode violation: `nav a[href="/play.html"]` matches two elements (nav link + CTA button). Test code bug, not app bug.
- ❌ **1 Playwright CTA test** — `play.html` nav "Play Now" selector times out. Test selector issue.
- ❌ **Test suite hangs** — `node --test` hangs on socket teardown. Test infra issue; not blocking deploy.

---

## 3. Scope of Work

### 3.1 Critical Fixes (must ship)

**Fix 1: Mobile navigation**
- `public/styles.css`: Remove `display: none` from `.nav-links` at 760px breakpoint
- Replace with hamburger button in `topnav` that toggles a mobile menu drawer
- Add `.nav-mobile-open` class to `<body>` when menu open
- Add CSS: `.nav-drawer` — fullscreen overlay, bg `rgba(7,11,20,0.96)`, flex column, gap 24px, padding 32px
- Add to all 6 HTML files: `<button class="nav-hamburger" id="navHamburger" aria-label="Open menu">☰</button>`
- Add JS snippet (inline in each page or shared `app.js`): toggles `.nav-mobile-open` on click

**Fix 2: play.html nav CTA**
- `public/play.html`: Change nav CTA from `<a class="btn btn-primary btn-sm" href="/play.html">Play Now</a>` to `<a class="btn btn-primary btn-sm" href="/#play">Browse games</a>` or simply remove it (play.html already has game picker)
- On play.html specifically, the nav "Play Now" CTA should become: `<a class="btn btn-ghost btn-sm" href="/">← Home</a>`

**Fix 3: favicon.svg**
- Create `public/favicon.svg` — a minimal SVG: black background, `⚔` text or stylised `AA` monogram
- Use primary color `#45b9ff` for the glyph on `#070b14` background

**Fix 4: og-image.svg**
- Create `public/og-image.svg` — 1200×630 SVG card with dark bg, headline "Agent Arena", subtext "AI agents play social deduction", primary gradient accent
- Reference: `<meta property="og:image" content="https://agent-arena-vert.vercel.app/og-image.svg" />`

### 3.2 UI Polish (must ship)

**Fix 5: Upgrade typography to Inter**
- `public/styles.css` line 1: Add `Inter` to Google Fonts import:
  ```
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
  ```
- Change `--font-display: 'Plus Jakarta Sans', 'Sora', sans-serif;` → `--font-display: 'Inter', 'Plus Jakarta Sans', sans-serif;`
- Change `body { font: 15px/1.6 'Sora', sans-serif; }` → `body { font: 15px/1.6 'Inter', 'Plus Jakarta Sans', sans-serif; }`
- Keep Space Mono for code/ticker elements

**Fix 6: Hero H1 polish**
- `public/styles.css`: `.hero-simple h1` — set `font-family: var(--font-display)` (already set), increase weight to `font-weight: 800` (already 800), increase max-size from `96px` → keep at `96px` but add `color: #eef5ff` explicitly to prevent any opacity bleed from gradient child
- Add `text-shadow: 0 2px 40px rgba(69, 185, 255, 0.15)` to `.hero-simple h1`
- `.text-gradient`: change gradient from `linear-gradient(120deg, var(--primary) 0%, var(--secondary) 100%)` → `linear-gradient(135deg, #45b9ff 0%, #7c3aed 40%, #27d5ad 100%)` — adds violet mid-stop for depth (Figma/Linear aesthetic)

**Fix 7: Elevated card style**
- `public/styles.css`: Add to `.card, .panel` base styles: `backdrop-filter: blur(8px)` (already on `.topnav`, extend to cards)
- Change `.card, .panel` background from `var(--panel)` (`rgba(16,29,48,0.78)`) to `rgba(13, 24, 42, 0.82)` for slightly more depth
- Add subtle inner highlight to card `::before`: change opacity from `0.05` to `0.06`

**Fix 8: Button system refinement**
- `public/styles.css`: `.btn-primary` — upgrade shadow from `0 8px 20px rgba(28,154,235,0.33)` → `0 4px 14px rgba(69,185,255,0.3), 0 1px 3px rgba(0,0,0,0.4)` (tighter, Linear-style)
- `.btn-primary:hover` — add `transform: translateY(-1px) scale(1.01)` (subtle lift)
- Remove existing `btn-primary::after` glow-ring animation — too distracting for production, only enable on hero CTA by adding `.btn-hero` modifier class
- Add `.btn-hero` class to just the hero "Play Now (15 sec)" button in index.html; it gets the glow ring

**Fix 9: Section title accent**
- `public/styles.css`: `.section-title` currently has `border-left: 2px solid var(--primary); padding-left: 10px`
- Add `font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; color: #8bb8dd`
- This matches Linear's section header pattern

**Fix 10: games-info.html — extract inline styles to classes**
- `public/styles.css`: Add `.game-detail-article` class:
  ```css
  .game-detail-article {
    margin-top: 16px;
    padding: 20px;
    background: rgba(255,255,255,0.03);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }
  .game-detail-article + .game-detail-article { margin-top: 16px; }
  .game-detail-h4 { font-size: 13px; color: var(--primary); margin-bottom: 8px; font-weight: 700; }
  ```
- `public/games-info.html`: Replace all inline `style="margin-top:24px; padding:20px; ..."` on `<article>` elements with `class="game-detail-article"`
- Replace all inline `style="font-size:13px; color:var(--primary); margin-bottom:8px;"` on `<h4>` with `class="game-detail-h4"`

**Fix 11: Hero stats loading state**
- `public/index.html`: Replace initial dash `—` in `statRooms`, `statAgents`, `statGames` spans with `<span class="stat-skeleton">…</span>`
- `public/styles.css`: Add:
  ```css
  .stat-skeleton {
    display: inline-block;
    width: 32px;
    height: 1em;
    background: linear-gradient(90deg, rgba(69,185,255,0.08) 25%, rgba(69,185,255,0.16) 50%, rgba(69,185,255,0.08) 75%);
    background-size: 200% 100%;
    border-radius: 4px;
    animation: skeleton-shimmer 1.4s ease-in-out infinite;
  }
  @keyframes skeleton-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  ```

**Fix 12: Battle ticker — make it live**
- `public/index.html` → inline `<script>` block: Update the ticker to pull room data:
  ```javascript
  // After updateHeroStats(), build ticker content from API rooms
  fetch(API + '/api/play/rooms?mode=all').then(r=>r.json()).then(d=>{
    const rooms = d.rooms || [];
    if (rooms.length) {
      const track = document.getElementById('tickerTrack');
      const items = rooms.map(r => `${r.gameEmoji||'⚔'} ${r.mode||'Mafia'} · ${r.players||0} players`);
      // Duplicate for seamless loop
      const content = [...items, ...items].map(t => `<span>${t}</span>`).join('');
      track.innerHTML = content;
    }
  }).catch(()=>{});
  ```
- Game emoji map in inline script: `{ mafia:'🔫', amongus:'👽', villa:'🏝' }`

**Fix 13: Add Roast Battles game card**
- `public/index.html` games section: Add 4th game card:
  ```html
  <a class="game-card-mini game-card-roast" href="/play.html?game=roast" data-animate="4">
    <span class="game-card-mini-icon">🎤</span>
    <div class="game-card-mini-text">
      <strong>Roast Battle</strong>
      <span class="text-muted">Wit. Burns. Crowd vote.</span>
    </div>
    <span class="btn btn-primary btn-sm">Play</span>
  </a>
  ```
- `public/styles.css`: Add `.game-card-roast { border-left: 3px solid #a78bfa; }` (violet accent, distinct from existing three)
- `public/play.html` game picker: Add 4th card similarly with `game-picker-roast` class

### 3.3 Playwright Test Fixes

**Fix 14: Nav selector specificity**
- `playwright.config.js` or test files: Find all instances of `p.locator('nav a[href="/play.html"]')` and change to `p.locator('nav .nav-links a[href="/play.html"]')`
- Fix `play.html` "Play Now" CTA test: since play.html nav will change to "← Home", update test expectation accordingly
- These are test code changes, zero app logic changes

### 3.4 Deploy Config

**Fix 15: Verify vercel.json completeness**
- `vercel.json` current content is minimal and correct. Add `headers` for security:
  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": null,
    "buildCommand": "npm run build",
    "outputDirectory": "dist",
    "cleanUrls": true,
    "headers": [
      {
        "source": "/(.*)",
        "headers": [
          { "key": "X-Content-Type-Options", "value": "nosniff" },
          { "key": "X-Frame-Options", "value": "DENY" },
          { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
        ]
      }
    ]
  }
  ```

**Fix 16: Verify manifest.json exists**
- `public/manifest.json` — referenced in index.html `<link rel="manifest">`. Create if missing:
  ```json
  {
    "name": "Agent Arena",
    "short_name": "AgentArena",
    "description": "AI agents play social deduction games",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#070b14",
    "theme_color": "#45b9ff",
    "icons": [{ "src": "/favicon.svg", "sizes": "any", "type": "image/svg+xml" }]
  }
  ```

---

## 4. UI Polish Spec

### Color Palette (locked)
```
Background layer 0:  #070b14  (deepest, page bg)
Background layer 1:  #0c1424  (panels)
Background layer 2:  #13233b  (elevated elements)
Panel:               rgba(13, 24, 42, 0.82)  (glassmorphism)
Border subtle:       rgba(104, 148, 194, 0.28)
Border strong:       rgba(111, 177, 239, 0.52)
Text primary:        #eef5ff
Text muted:          #9cb0ca
Primary (blue):      #45b9ff
Primary strong:      #2a9fea
Secondary (teal):    #27d5ad
Gradient mid:        #7c3aed  (new: violet mid-stop for hero gradient)
Warning:             #ffc978
Danger:              #ff8799
Success:             #44e5ae
Roast accent:        #a78bfa  (violet, for Roast Battles)
```

### Typography
```
Display font:    Inter → Plus Jakarta Sans (fallback)
Mono font:       Space Mono (code, ticker, badges)
Body:            Inter 400, 15px/1.6
H1 hero:         Inter 800, clamp(48px, 7vw, 96px), ls -0.03em
H2:              Inter 700, 1.8rem, ls -0.02em
H3:              Inter 600, 0.98rem
Section labels:  Inter 700, 0.72rem, ls 0.12em, uppercase
Buttons:         Inter 700, 0.82rem, ls 0.01em
Muted/meta:      Inter 500, 0.76rem
Code:            Space Mono 400, 0.76rem
```

### Spacing System
```
4px base unit. Scale: 4, 8, 12, 16, 20, 24, 32, 48, 64, 96
Section gaps:   48px (.mb-48)
Card padding:   20px
Nav padding:    13px 18px
Hero padding:   clamp(48px, 6vw, 96px) clamp(28px, 4.2vw, 64px)
Wrap max:       1120px, calc(100% - 48px) mobile margin
```

### Component Styles

**Nav**
```
bg: rgba(9, 18, 31, 0.72) + backdrop-filter: blur(10px)
border: 1px solid rgba(104, 148, 194, 0.28)
border-radius: 20px
sticky, top: 14px
mobile: static, border-radius: 14px
```

**Buttons**
```
btn-primary:  linear-gradient(140deg, #45b9ff, #2a9fea)
              shadow: 0 4px 14px rgba(69,185,255,0.3), 0 1px 3px rgba(0,0,0,0.4)
              hover: translateY(-1px) scale(1.01)
btn-ghost:    bg rgba(21,40,67,0.68), border #345c84, color #d8e8ff
btn-hero:     btn-primary + glow-ring animation (hero CTA only)
btn-sm:       min-height 34px, font-size 0.72rem, padding 7px 12px
```

**Cards**
```
border: 1px solid rgba(104,148,194,0.28)
border-radius: 20px
bg: rgba(13,24,42,0.82) + backdrop-filter: blur(8px)
shadow: 0 8px 24px rgba(4,11,24,0.28)
::before: linear-gradient(180deg, rgba(255,255,255,0.06), transparent 18%)
hover: translateY(-3px), border-color rgba(111,177,239,0.52)
```

**Inputs**
```
border: 1px solid #34577f
border-radius: 14px
bg: rgba(10,20,35,0.82)
focus: outline 2px solid rgba(58,180,255,0.42)
placeholder: color #6f87aa
```

**Game Mode Cards**
```
Mafia:  border-left 3px solid #ff8799 (danger red)
AmongUs: border-left 3px solid #ffc978 (warning amber)
Villa:  border-left 3px solid #27d5ad (secondary teal)
Roast:  border-left 3px solid #a78bfa (roast violet)
```

### Animations / Transitions
```
Card hover:     transform 200ms ease, box-shadow 200ms ease
Button hover:   transform 120ms ease, background 120ms ease
Hero entrance:  fadeUp 0.6s cubic-bezier(0.22,1,0.36,1), staggered 0-0.75s
Arena grid:     perspective tilt drift 8s ease-in-out infinite alternate
Live dot:       pulse-dot 1.7s ease-in-out infinite
Battle ticker:  marquee 24s linear infinite (pauses on hover)
Skeleton:       skeleton-shimmer 1.4s ease-in-out infinite
Glow ring:      glow-ring 2.4s ease-in-out infinite (hero CTA only)
```

### Dark Mode
**Default: dark.** No light mode toggle needed at launch. The `#070b14` deep navy background is the identity. Adding a light mode toggle is post-launch.

---

## 5. Gameplay Polish

### UX Gaps to Fix Before Launch

**Gap 1: No error state for "no rooms available"**
- When `POST /api/play/instant` fails, buttons reset with no user-facing explanation
- Fix: Show `<p class="status-warn">No open rooms right now. Try again in a few seconds.</p>` below the button on API failure
- Location: `public/index.html` inline script, instantPlay() catch block

**Gap 2: "Watch a Live Game" with no live games**
- When `GET /api/play/watch` returns no watchUrl, button resets silently
- Fix: Same pattern — show `<p class="status-warn">No live games right now. Be the first to start one!</p>`

**Gap 3: Quick match without backend connectivity**
- If Railway backend is down, the play.html loads but all actions fail silently
- Fix: Add a connection health indicator near the game picker. In `play.html`, after page loads, ping `API + '/api/health'` or `API + '/api/play/rooms'` and show a banner if unreachable:
  ```html
  <div id="backendStatus" class="status-bar mb-8" style="display:none;"></div>
  ```

**Gap 4: Dev panel visibility on production**
- The `<details class="dev-panel">` block is visible to all users on play.html
- Fix: Add `data-dev-only="true"` attribute and a script snippet that hides it unless `?dev=1` is in the URL:
  ```javascript
  if (!new URLSearchParams(location.search).has('dev')) {
    document.querySelector('.dev-panel')?.remove();
  }
  ```

**Gap 5: play.html with ?game= param doesn't pre-select game mode**
- `index.html` game cards link to `/play.html?game=mafia` etc. but there's no code to auto-scroll to or highlight the matching game card
- Fix: In `play.html` or `games.js`, read `new URLSearchParams(location.search).get('game')` and add `.is-selected` highlight class to the matching `.game-picker-card`
- Add CSS: `.game-picker-card.is-selected { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(69,185,255,0.2); }`

**Gap 6: No explicit "Roast Battles" game support visible**
- Task description names it as a game mode. If the backend doesn't support `mode=roast` yet, the card should show a "Coming soon" badge rather than a broken Play button
- Add to the Roast card: `<span class="coming-soon-badge">Coming soon</span>` with CSS pill styling
- `public/styles.css`: `.coming-soon-badge { font-size: 0.62rem; background: rgba(167,139,250,0.15); border: 1px solid rgba(167,139,250,0.4); border-radius: 999px; padding: 2px 8px; color: #c4b5fd; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }`

---

## 6. Deploy Pipeline

### Pre-Deploy Checklist (run in order)

```bash
# 1. Navigate to repo
cd /Users/bobbybola/Desktop/agent-arena

# 2. Verify server starts cleanly
node server.js &
SERVER_PID=$!
sleep 2
curl -s http://localhost:3000/api/health | head -1
kill $SERVER_PID

# 3. Run DB migration check
node -e "const { initDb, closeDb } = require('./server/db'); initDb(); closeDb(); console.log('DB OK');"

# 4. Lint check (no eslint configured, so do a quick syntax check)
node --check server.js && echo "Server syntax OK"
node --check public/games.js && echo "games.js syntax OK"

# 5. Build frontend
npm run build
# Expected: dist/ directory with all public/ files copied

# 6. Verify dist/ contents
ls dist/
# Must include: index.html, play.html, styles.css, games.js, app.js, config.js, favicon.svg, og-image.svg, manifest.json, games-info.html, browse.html, guide.html

# 7. Verify config.js has correct API URLs
cat dist/config.js
# Must show: API_URL and SOCKET_URL pointing to Railway backend

# 8. Run Playwright tests (expect 50/51+ passing)
npx playwright test --reporter=line
# Acceptable: ≥50/51. The 1 remaining failure is test selector (not app)

# 9. Spot-check pages locally
# Open: http://localhost:3000 (if server still running)
# Or: open dist/index.html in browser and inspect

# 10. Deploy
npm run deploy:vercel
```

### Vercel Deploy Command
```bash
npm run deploy:vercel
# → npx --yes vercel@50.15.1 --prod --yes
```

### Post-Deploy Verification (visit each in browser)

| Step | URL | What to Check |
|------|-----|---------------|
| 1 | https://agent-arena-vert.vercel.app | Hero loads, gradient H1, stats fetch, ticker scrolls |
| 2 | https://agent-arena-vert.vercel.app/play | Game picker shows 4 cards, no broken layout |
| 3 | https://agent-arena-vert.vercel.app/games-info | All 3 game articles render without inline style mess |
| 4 | https://agent-arena-vert.vercel.app/browse | Feed shell loads, leaderboard sidebar visible |
| 5 | https://agent-arena-vert.vercel.app/guide | Connect runtime section, checklist, CLI box visible |
| 6 | Resize to 375px | Mobile nav hamburger visible, tap opens drawer |
| 7 | View source → `<head>` | favicon.svg and og-image.svg links present |
| 8 | Open DevTools Network | No 404s for critical assets (favicon, og-image, manifest) |
| 9 | Click "Play Now (15 sec)" | API call to Railway, room created, redirect to play.html |
| 10 | Open Twitter card validator | https://cards-dev.twitter.com/validator → og-image renders |

### Rollback Procedure

Vercel maintains deployment history. If post-deploy verification fails:

```bash
# Option A: Rollback via Vercel CLI
npx vercel@50.15.1 rollback --yes

# Option B: Redeploy previous commit
git revert HEAD --no-edit
npm run build
npm run deploy:vercel

# Option C: Vercel dashboard
# https://vercel.com/bobbaybuilderlab/agentarena
# Deployments tab → click previous deployment → "Promote to Production"
```

The Railway backend is NOT affected by Vercel rollbacks. If the Railway backend breaks independently:
```bash
# Check Railway logs at: https://railway.app/project/[project-id]
# Or: locally test backend separately
node server.js  # should start on :3000
```

---

## 7. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | Railway backend down on deploy day | Low | High | Test API health before deploy: `curl https://agent-arena-api-production-5778.up.railway.app/api/health` |
| 2 | Vercel build fails (npm build error) | Low | High | `npm run build` locally first, verify dist/ has all files |
| 3 | `og-image.svg` and `favicon.svg` missing → 404 on link preview | Medium | Medium | Create them as Fix 3 + Fix 4 above. Simple SVG files. |
| 4 | Roast Battles backend not implemented → broken Play button | Medium | Medium | Gate with "Coming soon" badge (Fix in section 5, Gap 6) |
| 5 | Google Fonts load slow → FOUT on Inter swap | Low | Low | Add `font-display: swap` — already handled by Google Fonts URL param |
| 6 | Mobile hamburger JS not loading on slower devices | Low | Medium | Use minimal vanilla JS, no deps. Test at 3G throttle. |
| 7 | CORS error from Vercel frontend → Railway backend | Low | High | `ALLOWED_ORIGINS` must include `https://agent-arena-vert.vercel.app` on Railway env vars |
| 8 | Playwright tests still hanging on teardown | Medium | Low | Use `--timeout=30000` flag, add `--reporter=line` to skip hanging reporter |
| 9 | vercel.json `cleanUrls: true` breaks `/play.html` links | Very Low | High | Test that `/play` and `/play.html` both resolve before finalising |
| 10 | SQLite DB data loss on Railway restart | Low | Medium | DB is ephemeral on Railway free tier. Document this as known limitation. |

---

## 8. Execution Order

The coding agent must execute in this exact order:

```
STEP 1: Create public/favicon.svg
STEP 2: Create public/og-image.svg
STEP 3: Create public/manifest.json (if missing)
STEP 4: Add Inter to Google Fonts import in styles.css
STEP 5: Update --font-display and body font to Inter in styles.css
STEP 6: Update .text-gradient gradient to 3-stop version (#45b9ff → #7c3aed → #27d5ad) in styles.css
STEP 7: Add text-shadow to .hero-simple h1 in styles.css
STEP 8: Refine .btn-primary shadow (tighter, Linear-style) in styles.css
STEP 9: Remove .btn-primary::after glow-ring from base styles; add .btn-hero class with glow-ring instead in styles.css
STEP 10: Add backdrop-filter: blur(8px) to .card and .panel in styles.css
STEP 11: Add .game-detail-article, .game-detail-h4 CSS classes to styles.css
STEP 12: Add .coming-soon-badge CSS to styles.css
STEP 13: Add .game-picker-card.is-selected CSS to styles.css
STEP 14: Add .nav-hamburger, .nav-drawer, .nav-mobile-open CSS to styles.css
STEP 15: Add skeleton shimmer CSS (.stat-skeleton, @keyframes skeleton-shimmer) to styles.css
STEP 16: Replace hero stats "—" with skeleton spans in index.html
STEP 17: Add Roast Battle 4th game card to index.html game-showcase section
STEP 18: Update .btn-hero class on hero "Play Now (15 sec)" button in index.html
STEP 19: Fix battle ticker to pull from API in index.html inline script
STEP 20: Add error state copy to instantPlay() and watchLive() in index.html inline script
STEP 21: Update play.html nav CTA from "Play Now" → "← Home" with btn-ghost styling
STEP 22: Add Roast Battle 4th card to play.html game-picker-grid (with "Coming soon" badge)
STEP 23: Add backend health check to play.html (ping API, show banner if unreachable)
STEP 24: Add dev panel hide logic to play.html (hide unless ?dev=1)
STEP 25: Add ?game= param pre-selection logic to play.html (highlight matching card)
STEP 26: Add hamburger button HTML to topnav in ALL 6 HTML files (index, play, games-info, browse, guide, agent-villa)
STEP 27: Add hamburger toggle JS to each page (or to shared app.js if loaded on all pages)
STEP 28: Replace inline styles in games-info.html articles with .game-detail-article class
STEP 29: Replace inline h4 styles in games-info.html with .game-detail-h4 class
STEP 30: Update vercel.json to add security headers
STEP 31: Find and fix Playwright test selectors (nav strict mode violations, play.html CTA)
STEP 32: Run `npm run build` — verify dist/ has all 13+ expected files
STEP 33: Run `npx playwright test --reporter=line` — verify ≥50/51 passing
STEP 34: Run `npm run deploy:vercel`
STEP 35: Run post-deploy verification checklist (all 10 checks)
```

---

## 9. Acceptance Criteria

The work is complete ("shipped") when ALL of the following are true:

### Functional
- [ ] `https://agent-arena-vert.vercel.app` loads without console errors
- [ ] favicon.svg appears in browser tab (no generic globe icon)
- [ ] og-image.svg renders correctly in Twitter Card Validator
- [ ] Hero stats load from Railway API (not stuck on skeleton/dash)
- [ ] Battle ticker scrolls with live or realistic room data
- [ ] "Play Now (15 sec)" button creates a room and redirects
- [ ] "Watch a Live Game" button finds a room or shows graceful empty state
- [ ] All 4 game mode cards visible on homepage and play page
- [ ] Roast Battles shows "Coming soon" badge (not a broken button)
- [ ] Dev panel hidden on production (only visible at `?dev=1`)

### UI / Visual
- [ ] Inter font loaded and rendering (check DevTools → Fonts)
- [ ] Hero gradient uses 3-stop violet mid-tone (visible gradient shift)
- [ ] Mobile view (375px): hamburger visible, tap opens nav drawer
- [ ] Nav links visible on desktop (Play, Games, Feed, Docs)
- [ ] play.html nav shows "← Home" not "Play Now"
- [ ] games-info.html has no inline `style=` attributes on `<article>` tags
- [ ] Game cards have distinct left-border colors (red/amber/teal/violet)

### Performance
- [ ] Lighthouse Performance score ≥ 85 on homepage
- [ ] No render-blocking resources beyond Google Fonts
- [ ] `dist/` total size < 1MB (static files only)

### Tests
- [ ] `npx playwright test` passes ≥ 50 of 51 tests
- [ ] `npm run build` exits 0

### Deploy
- [ ] `npm run deploy:vercel` exits 0
- [ ] Vercel dashboard shows deployment marked as Production
- [ ] Production URL returns HTTP 200 for `/`, `/play`, `/games-info`, `/browse`, `/guide`

---

## 10. Time Estimates

| # | Task | Hours |
|---|------|-------|
| 1 | Create favicon.svg + og-image.svg + manifest.json | 0.5h |
| 2 | Typography upgrade (Inter, styles.css) | 0.25h |
| 3 | Hero gradient + H1 polish | 0.25h |
| 4 | Button system refinement (remove glow ring, add .btn-hero) | 0.25h |
| 5 | Card backdrop-filter, card polish | 0.25h |
| 6 | Add .game-detail-article CSS + fix games-info.html inline styles | 0.5h |
| 7 | Skeleton loading states for hero stats | 0.5h |
| 8 | Battle ticker API integration | 0.5h |
| 9 | Add Roast Battles 4th card (homepage + play.html) | 0.5h |
| 10 | Error states for Play Now / Watch Live | 0.25h |
| 11 | Mobile hamburger nav (CSS + HTML + JS across 6 pages) | 1.5h |
| 12 | play.html nav CTA fix + dev panel hide logic | 0.25h |
| 13 | ?game= param pre-selection on play.html | 0.25h |
| 14 | Backend health check indicator on play.html | 0.25h |
| 15 | vercel.json security headers | 0.25h |
| 16 | Fix Playwright test selectors (6 tests + 1 CTA test) | 0.5h |
| 17 | `npm run build` + `npx playwright test` verification | 0.25h |
| 18 | Deploy + post-deploy 10-point checklist | 0.5h |
| **TOTAL** | | **~7h** |

**Aggressive estimate if mobile nav is simplified to just showing links stacked:** 5h  
**Conservative estimate with full testing + iteration:** 9h  

---

## Appendix: File Map

### Files to Create (new)
```
public/favicon.svg
public/og-image.svg
public/manifest.json  (if missing — check: ls public/manifest.json)
```

### Files to Edit
```
public/styles.css         (bulk of design changes)
public/index.html         (hero skeleton, ticker fix, Roast card, btn-hero class, error states)
public/play.html          (nav CTA, dev panel, ?game= selection, Roast card, health check)
public/games-info.html    (replace inline styles with classes)
public/browse.html        (add hamburger button)
public/guide.html         (add hamburger button)
public/agent-villa.html   (add hamburger button)
vercel.json               (add security headers)
test/ (playwright tests)  (fix nav selector specificity)
```

### Files NOT to Touch
```
public/games.js           (core game logic — too risky to edit without full test pass)
public/app.js             (mostly working — only ticker update in index.html inline script)
public/config.js          (production URLs correct — do not change)
server.js                 (backend — not deployed to Vercel)
server/**                 (backend — not deployed to Vercel)
games/**                  (backend game logic — not deployed to Vercel)
```

---

*Plan generated by Donna (planning subagent) on 2026-02-27. A coding agent can execute this plan top-to-bottom without clarification.*
