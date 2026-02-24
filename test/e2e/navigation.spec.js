const { test, expect } = require('@playwright/test');

// All public-facing pages
const PAGES = [
  { path: '/', name: 'index' },
  { path: '/play.html', name: 'play' },
  { path: '/browse.html', name: 'browse' },
  { path: '/guide.html', name: 'guide' },
  { path: '/games-info.html', name: 'games-info' },
  { path: '/agent-villa.html', name: 'agent-villa' },
  { path: '/dobby-dashboard.html', name: 'dobby-dashboard' },
];

const NAV_LINKS = [
  { href: '/play.html', text: 'Play' },
  { href: '/games-info.html', text: 'Games' },
  { href: '/browse.html', text: 'Feed' },
  { href: '/guide.html', text: 'Docs' },
];

test.describe('Navigation consistency', () => {
  for (const page of PAGES) {
    test(`${page.name} has unified 4-link nav`, async ({ page: p }) => {
      await p.goto(page.path);
      for (const link of NAV_LINKS) {
        const navLink = p.locator(`nav a[href="${link.href}"]`);
        await expect(navLink).toBeVisible();
      }
    });

    test(`${page.name} has "Play Now" CTA`, async ({ page: p }) => {
      await p.goto(page.path);
      const cta = p.locator('nav a.btn-primary:has-text("Play Now")');
      await expect(cta).toBeVisible();
    });

    test(`${page.name} returns 200`, async ({ page: p }) => {
      const res = await p.goto(page.path);
      expect(res.status()).toBe(200);
    });

    test(`${page.name} does not link to deleted pages`, async ({ page: p }) => {
      await p.goto(page.path);
      const forAgentsLinks = p.locator('a[href*="for-agents.html"]');
      await expect(forAgentsLinks).toHaveCount(0);
      const howItWorksLinks = p.locator('a[href*="how-it-works.html"]');
      await expect(howItWorksLinks).toHaveCount(0);
    });
  }
});

test.describe('Deleted pages return 404', () => {
  test('for-agents.html returns 404', async ({ page: p }) => {
    const res = await p.goto('/for-agents.html');
    expect(res.status()).toBe(404);
  });

  test('how-it-works.html returns 404', async ({ page: p }) => {
    const res = await p.goto('/how-it-works.html');
    expect(res.status()).toBe(404);
  });
});

test.describe('No stale guide.html game anchors', () => {
  for (const page of PAGES) {
    test(`${page.name} has no guide.html#mafia/amongus/villa links`, async ({ page: p }) => {
      await p.goto(page.path);
      const staleLinks = p.locator('a[href*="guide.html#mafia"], a[href*="guide.html#amongus"], a[href*="guide.html#villa"]');
      await expect(staleLinks).toHaveCount(0);
    });
  }
});

test.describe('Games page anchors', () => {
  const anchors = ['#mafia', '#amongus', '#villa'];

  for (const anchor of anchors) {
    test(`games-info.html${anchor} scrolls to target`, async ({ page: p }) => {
      await p.goto(`/games-info.html${anchor}`);
      const target = p.locator(anchor);
      await expect(target).toBeVisible();
      await expect(target).toBeInViewport();
    });
  }
});

test.describe('Homepage simplified', () => {
  test('has minimal game cards', async ({ page: p }) => {
    await p.goto('/');
    const miniCards = p.locator('.game-card-mini');
    await expect(miniCards).toHaveCount(3);
  });

  test('no phase diagrams or role pills', async ({ page: p }) => {
    await p.goto('/');
    const phaseMini = p.locator('.phase-mini');
    await expect(phaseMini).toHaveCount(0);
    const rolePills = p.locator('.role-pill');
    await expect(rolePills).toHaveCount(0);
  });

  test('no CLI/connect section', async ({ page: p }) => {
    await p.goto('/');
    const joinSection = p.locator('#join');
    await expect(joinSection).toHaveCount(0);
    const onboarding = p.locator('.onboarding-steps');
    await expect(onboarding).toHaveCount(0);
  });

  test('"Learn how each game works" link to games-info.html', async ({ page: p }) => {
    await p.goto('/');
    const link = p.locator('a[href="/games-info.html"]:has-text("Learn how each game works")');
    await expect(link).toBeVisible();
  });
});

test.describe('Games page human-readable', () => {
  test('has plain English structure', async ({ page: p }) => {
    await p.goto('/games-info.html');
    await expect(p.locator('text=The setup').first()).toBeVisible();
    await expect(p.locator('text=How it plays').first()).toBeVisible();
    await expect(p.locator('text=How you win').first()).toBeVisible();
  });

  test('no code action names or tables', async ({ page: p }) => {
    await p.goto('/games-info.html');
    const tables = p.locator('table');
    await expect(tables).toHaveCount(0);
  });
});

test.describe('Guide page', () => {
  test('has Connect Runtime section', async ({ page: p }) => {
    await p.goto('/guide.html');
    await expect(p.locator('#join')).toBeVisible();
    await expect(p.locator('#generateCmdBtn')).toBeVisible();
  });

  test('retains quickstart section', async ({ page: p }) => {
    await p.goto('/guide.html');
    await expect(p.locator('#quickstart')).toBeVisible();
  });

  test('retains socket events section', async ({ page: p }) => {
    await p.goto('/guide.html');
    await expect(p.locator('#events')).toBeVisible();
  });

  test('retains persona section', async ({ page: p }) => {
    await p.goto('/guide.html');
    await expect(p.locator('#persona')).toBeVisible();
  });
});

test.describe('Internal links resolve (no 404s)', () => {
  test('all internal href targets return 200', async ({ page: p, request }) => {
    const checked = new Set();
    for (const pg of PAGES) {
      await p.goto(pg.path);
      const hrefs = await p.locator('a[href^="/"]').evaluateAll(els =>
        els.map(el => el.getAttribute('href').split('#')[0]).filter(Boolean)
      );
      for (const href of hrefs) {
        if (checked.has(href)) continue;
        checked.add(href);
        const res = await request.get(href);
        expect(res.status(), `${href} from ${pg.path}`).toBe(200);
      }
    }
  });
});
