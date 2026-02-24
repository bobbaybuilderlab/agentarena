const { test, expect } = require('@playwright/test');

// All public-facing pages and whether they should have a "Games" nav link
const PAGES = [
  { path: '/', name: 'index' },
  { path: '/play.html', name: 'play' },
  { path: '/browse.html', name: 'browse' },
  { path: '/guide.html', name: 'guide' },
  { path: '/games-info.html', name: 'games-info' },
  { path: '/for-agents.html', name: 'for-agents' },
  { path: '/how-it-works.html', name: 'how-it-works' },
  { path: '/agent-villa.html', name: 'agent-villa' },
  { path: '/dobby-dashboard.html', name: 'dobby-dashboard' },
];

test.describe('Navigation consistency', () => {
  for (const page of PAGES) {
    test(`${page.name} has "Games" nav link`, async ({ page: p }) => {
      await p.goto(page.path);
      const gamesLink = p.locator('nav a[href="/games-info.html"]');
      await expect(gamesLink).toBeVisible();
    });

    test(`${page.name} returns 200`, async ({ page: p }) => {
      const res = await p.goto(page.path);
      expect(res.status()).toBe(200);
    });
  }
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
      // Verify element is in viewport (scrolled to)
      await expect(target).toBeInViewport();
    });
  }
});

test.describe('How to play CTAs on index', () => {
  test('Mafia "How to play" links to games-info.html#mafia', async ({ page: p }) => {
    await p.goto('/');
    const links = p.locator('a[href="/games-info.html#mafia"]');
    await expect(links.first()).toBeVisible();
  });

  test('Among Us "How to play" links to games-info.html#amongus', async ({ page: p }) => {
    await p.goto('/');
    const links = p.locator('a[href="/games-info.html#amongus"]');
    await expect(links.first()).toBeVisible();
  });

  test('Villa "How to play" links to games-info.html#villa', async ({ page: p }) => {
    await p.goto('/');
    const links = p.locator('a[href="/games-info.html#villa"]');
    await expect(links.first()).toBeVisible();
  });

  test('"All games" section link points to games-info.html', async ({ page: p }) => {
    await p.goto('/');
    const link = p.locator('a.section-action[href="/games-info.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('All games →');
  });
});

test.describe('Guide page trimmed correctly', () => {
  test('guide.html has no #game-modes section', async ({ page: p }) => {
    await p.goto('/guide.html');
    const section = p.locator('#game-modes');
    await expect(section).toHaveCount(0);
  });

  test('guide.html has no #tips section', async ({ page: p }) => {
    await p.goto('/guide.html');
    const section = p.locator('#tips');
    await expect(section).toHaveCount(0);
  });

  test('guide.html has cross-link to games-info.html', async ({ page: p }) => {
    await p.goto('/guide.html');
    const link = p.locator('a[href="/games-info.html"]');
    await expect(link.first()).toBeVisible();
  });

  test('guide.html retains quickstart section', async ({ page: p }) => {
    await p.goto('/guide.html');
    await expect(p.locator('#quickstart')).toBeVisible();
  });

  test('guide.html retains socket events section', async ({ page: p }) => {
    await p.goto('/guide.html');
    await expect(p.locator('#events')).toBeVisible();
  });

  test('guide.html retains persona section', async ({ page: p }) => {
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
