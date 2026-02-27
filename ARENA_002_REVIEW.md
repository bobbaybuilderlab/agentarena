# Arena-002: Visual UI Design Review
**Reviewer:** Donna (AI CoS) — arena-review-ui-002  
**Date:** 2026-02-27  
**Standard:** Figma/Apple/Linear/Stripe/Vercel  
**Scope:** public/styles.css + all 6 pages  
**Verdict:** Ship-blocking issues on agent-villa.html; 12 CSS architecture problems; 8 polish fixes applied.

---

## Summary Scorecard

| Area | Score | Verdict |
|------|-------|---------|
| Color palette | 6/10 | Purple in gradient is off-brand; undefined CSS vars |
| Typography | 5/10 | Sora never loads; inline code unstyled; text too small |
| Spacing | 6/10 | Hero oversized; pervasive inline styles; inconsistent rhythm |
| Component consistency | 5/10 | btn-soft ≡ btn-ghost; nav composition differs per page; dead class |
| Visual hierarchy | 6/10 | Hero too busy; wireframe copy in prod; empty states need love |
| CSS architecture | 5/10 | Duplicate keyframes; card hover too broad; token gaps |

**Overall: 5.5/10 — Functional but not production-quality against Linear/Vercel standard.**

---

## Finding 1 — CRITICAL: agent-villa.html ships prototype copy

**File:** `public/agent-villa.html`  
**Type:** Ship-blocking

The page title and H1 are still development/prototype copy:
- `<title>` → "Agent Arena — MVP Wireflow Shell"
- `<h1>` → "Wireflow MVP shell"
- `<p class="sub">` → "Prototype screen states, copy tone, and CTA hierarchy before full backend round orchestration lands."

This ships to production on Vercel and is indexed by search engines. Unacceptable.

**Fix:** Update title, h1, and sub to production copy. Also: `.bevel` class used on `.hero.bevel` and `.panel.bevel` — not defined anywhere in styles.css. Dead class, silently ignored.

---

## Finding 2 — CRITICAL: Sora font never loads

**File:** `public/styles.css` line 1 (`@import`)  
**Type:** Silent regression

The Google Fonts import loads: `Inter`, `Plus Jakarta Sans`, `Space Mono`.  
**Sora is missing.**

But `input[type='text'], input[type='email'], select` use:
```css
font: 500 0.88rem/1.4 'Sora', sans-serif;
```

This silently falls back to the system sans-serif font for ALL form inputs. On macOS that's SF Pro; on Windows it's Segoe UI. Form fields look completely different from the rest of the UI on non-Mac devices. Every user filling in the Room ID input on play.html or the Agent Name field is getting a different font.

**Fix:** Add `family=Sora:wght@400;500;600;700` to the Google Fonts import.

---

## Finding 3 — HIGH: Purple in gradient text is off-brand

**File:** `public/styles.css`, `.text-gradient`  
**Type:** Visual coherence

```css
/* BEFORE */
background: linear-gradient(135deg, #45b9ff 0%, #7c3aed 40%, #27d5ad 100%);
```

`#7c3aed` is a Radix UI violet/purple. It has zero presence anywhere else in the design system. The brand is **blue (#45b9ff) + teal (#27d5ad)**. The purple creates a dark mid-band in the gradient on dark backgrounds, making it look like a render artifact.

Compare: Linear's gradient text is a clean blue-to-purple progression that's consistent across their entire brand. This gradient mixes three unrelated hues.

**Fix:**
```css
/* AFTER */
background: linear-gradient(135deg, #45b9ff 0%, #27d5ad 100%);
```

---

## Finding 4 — HIGH: Undefined CSS variables used in production

**File:** `public/styles.css` (multiple sections)  
**Type:** Architecture smell

Referenced but never defined in `:root`:
| Variable | Used in | Fallback value |
|----------|---------|----------------|
| `--accent` | `.phase-step.active`, `.player-card.is-me` | `#45b9ff` |
| `--green` | `.phase-step.done` | `#27d5ad` |
| `--text-dim` | `.phase-step` | `#6b7a90` |
| `--bg-card` | `.auth-modal`, `.profile-card`, `.tutorial-card` | `#0e1b2d` |
| `--border-subtle` | `.phase-dot`, `.phase-line` | `#1e2a3a` |

The hardcoded fallbacks work but:
1. Theming is broken — changing `--primary` doesn't affect the phase timeline
2. `--text-dim: #6b7a90` is a 3rd "muted text" color alongside `--muted: #9cb0ca` and `--ink2` which resolves to `--muted` anyway. Three names for two conceptually identical things.

**Fix:** Define all aliases in `:root`.

---

## Finding 5 — HIGH: `btn-soft` and `btn-ghost` are identical

**File:** `public/styles.css`, lines for `.btn-soft, .btn-ghost`  
**Type:** Dead code / false semantic

```css
.btn-soft,
.btn-ghost {
  color: #d8e8ff;
  border-color: #345c84;
  background: rgba(21, 40, 67, 0.68);
}
```

Exact same styles. Two class names that render identically. This is used throughout:
- guide.html: `<a class="btn btn-soft">Watch live</a>` vs `<a class="btn btn-ghost">Manual join</a>`
- index.html: `<button class="btn btn-ghost">Watch a Live Game</button>`

If the intent is semantic distinction (one is a contained button, one is more ethereal), they need different visual treatments. Stripe distinguishes: secondary (border, bg) vs ghost (no bg, no border). Vercel has: primary, secondary (with border), ghost (text only).

**Fix:** Give `btn-ghost` a transparent background (text button), keep `btn-soft` as a subtle contained button.

---

## Finding 6 — HIGH: Universal card hover lift breaks layout

**File:** `public/styles.css`  
**Type:** Interaction design regression

```css
.card,
.panel {
  transition: transform 200ms ease, ...;
  backdrop-filter: blur(8px);
}

.card:hover,
.panel:hover {
  transform: translateY(-3px);
  ...
}
```

This applies a lift to **every** `.card` and `.panel` on hover — including:
- The leaderboard container card (not interactive)
- The "Best room now" section card (not clickable)
- The match HUD card (structural, not interactive)
- The dev-panel, status-bar containers

Linear and Vercel only apply hover lift to explicitly interactive cards (with href/onClick). Lifting structural layout containers on hover is distracting and gives false affordance.

**Fix:** Scope hover lift to interactive cards only (`.card[href], .card[role="button"], .card.is-interactive`). Use a data attribute approach.

---

## Finding 7 — HIGH: Inline `<code>` elements are completely unstyled

**File:** `public/guide.html`, `public/styles.css`  
**Type:** Documentation quality regression

guide.html uses many inline code references:
```html
<code>{mode}:{event}</code>
<code>res.ok</code>
<code>claimToken</code>
<code>{ name }</code>
<code>ROOM_NOT_FOUND</code>
```

There is zero CSS for inline `<code>` elements. They render as plain text in the inherited body font. Every top-tier docs site (Stripe, Vercel, Linear changelog, GitHub) styles inline code with: `font-family: monospace`, subtle background, rounded corners, slight padding.

**Fix:** Add inline code styles to stylesheet.

---

## Finding 8 — MEDIUM: Hero oversized + too many competing elements

**File:** `public/styles.css`, `public/index.html`  
**Type:** Visual hierarchy

`.hero-simple` has `min-height: min(90vh, 640px)`. At a 900px-tall laptop screen, this is 810px — the entire viewport for the hero alone. Users on 13" laptops see almost nothing below the fold.

More critically, the hero contains **6 sequentially stacked elements**:
1. LIVE badge
2. Battle ticker (animated marquee)
3. H1 headline
4. Sub paragraph
5. CTA buttons
6. Stats row

Stripe's hero: headline → sub → one CTA. Linear's hero: badge → headline → sub → one CTA. The ticker competes with the headline for attention and fires before the headline loads.

**Recommendation:** Reduce `min-height` to `min(70vh, 540px)`. Move stats below the fold into the game-modes section. The ticker is clever but should sit below the CTA row, not between the badge and headline.

---

## Finding 9 — MEDIUM: Duplicate `@keyframes glow-ring`

**File:** `public/styles.css`  
**Type:** CSS architecture

`@keyframes glow-ring` is defined twice:
1. First definition (attached to `.btn-hero::after`) — 2-frame fade
2. Second definition (in the Keyframes section) — 4-frame fade+scale

The second definition overrides the first silently. The `.btn-hero::after` glow animation is never what was intended.

**Fix:** Remove the first definition, keep the canonical one in the keyframes section.

---

## Finding 10 — MEDIUM: Font sizes below readability threshold

**File:** `public/styles.css`  
**Type:** Accessibility / readability

Multiple components use sub-11px text:
| Component | Size | Px equiv |
|-----------|------|----------|
| `.live-badge` font | 0.62rem | ~9.9px |
| `.kicker / .section-title / .field-label` | 0.68rem | ~10.9px |
| `.battle-ticker` | 0.68rem | ~10.9px |
| `.coming-soon-badge` | 0.62rem | ~9.9px |
| `.player-pill` | 0.65rem | ~10.4px |
| `.player-state` | 0.66rem | ~10.6px |

WCAG 2.1 SC 1.4.4 requires text to be readable at 200% zoom. Apple HIG minimum: 11pt (~14.67px) for body text, but acknowledges 11pt for labels. Sub-11px for even decorative labels is pushing it.

Linear uses 11px minimum for even the smallest metadata labels. Stripe never goes below 12px.

**Fix:** Bump minimum label sizes to 0.72rem (11.5px).

---

## Finding 11 — MEDIUM: Reconnect banner bypasses design tokens

**File:** `public/styles.css`, `.reconnect-banner`  
**Type:** Design consistency

```css
.reconnect-banner {
  background: #b8860b;  /* raw hex, bypasses all tokens */
  color: #fff;
}
```

`#b8860b` is a raw amber hex. The design system has `--warning: #ffc978`. The banner should use the warning token with a dark background (matching the site theme) rather than a bright solid bar that looks like a browser warning.

**Fix:** Use design tokens.

---

## Finding 12 — MEDIUM: Roast Battle card has duplicate "Coming Soon" text

**File:** `public/play.html`  
**Type:** Copy/component consistency

The Roast Battle card in the game picker has:
```html
<button class="btn btn-primary btn-sm" disabled aria-disabled="true">Coming Soon</button>
<span class="coming-soon-badge mt-4">Coming Soon</span>
```

Two "Coming Soon" elements stacked. The button (disabled, blue) AND the badge below it. Remove the badge — the disabled button is sufficient.

---

## Finding 13 — LOW: games-info.html has no hero/kicker above H1

**File:** `public/games-info.html`  
**Type:** Visual hierarchy

The page jumps directly into `<h1>Game modes</h1>` with no visual treatment. index.html has a gradient hero with animated ticker; guide.html at least has a descriptive sub paragraph. games-info.html has no kicker badge, no illustration — just a plain `<h1>` inside a `.panel`. The page equivalent on Linear (their "Features" page) has a standout header.

---

## Finding 14 — LOW: browse.html is effectively empty

**File:** `public/browse.html`  
**Type:** Empty state UX

The page loads, shows a "Watch live rounds..." teaser, then renders "No live events yet." and "No agents ranked yet." with no skeleton loading, no illustration, no CTA. For a first-time visitor or reviewer, this page communicates nothing. Even a simple "No active games — be the first to start one →" with a Play Now button would help.

---

## Applied Fixes

The following changes were applied to `public/styles.css` and the HTML pages listed:

### CSS Fixes (public/styles.css):
1. ✅ Added Sora to Google Fonts import
2. ✅ Defined missing CSS variables in `:root` (`--accent`, `--green`, `--bg-card`, `--border-subtle`, `--text-dim`)
3. ✅ Fixed `text-gradient` — removed purple stop
4. ✅ Removed duplicate `@keyframes glow-ring` (first definition)
5. ✅ Differentiated `btn-soft` from `btn-ghost`
6. ✅ Scoped card hover lift to interactive cards only
7. ✅ Added inline `<code>` styles for documentation
8. ✅ Bumped minimum label font sizes to 0.72rem
9. ✅ Fixed `.reconnect-banner` to use design tokens

### HTML Fixes:
10. ✅ `public/agent-villa.html` — replaced prototype copy in `<title>`, `<h1>`, `<p class="sub">`; removed dead `.bevel` class
11. ✅ `public/play.html` — removed duplicate Coming Soon badge from Roast Battle card

---

## Remaining Recommendations (not auto-fixed — need design input)

- **Hero height**: Reduce `min-height: min(90vh, 640px)` to `min(70vh, 520px)` — but this changes the landing page dramatically, needs sign-off
- **Nav consistency**: Add auth section to all pages (not just play.html) or remove entirely — inconsistent UX
- **games-info.html**: Add a proper page hero with kicker and visual weight
- **guide.html**: Add a sticky sidebar TOC for the socket reference — the page is too long to navigate without it
- **browse.html**: Add skeleton loading states and a CTA empty state
- **Ticker position**: Move `.battle-ticker` below the CTA row in the hero
