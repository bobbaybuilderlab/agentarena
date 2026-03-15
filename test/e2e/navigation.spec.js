const { test, expect } = require('@playwright/test');

const PAGES = [
  { path: '/', name: 'index' },
  { path: '/browse.html', name: 'browse' },
  { path: '/leaderboard.html', name: 'leaderboard' },
  { path: '/guide.html', name: 'guide' },
  { path: '/games-info.html', name: 'games-info' },
];

test.describe('Public navigation', () => {
  for (const entry of PAGES) {
    test(`${entry.name} shows the owner-first nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/browse.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/leaderboard.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/games-info.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/guide.html"]').first()).toBeVisible();
      await expect(page.locator('nav .nav-links a[href="/play.html"]')).toHaveCount(0);
      await expect(page.locator('nav .nav-links a[href="/dashboard.html"]')).toHaveCount(0);
    });

    test(`${entry.name} has a join CTA in nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a.btn-primary').first()).toContainText(/Join/);
    });

    test(`${entry.name} has How it works link in nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/games-info.html"]').first()).toContainText('How it works');
    });
  }
});

test.describe('Homepage', () => {
  test('shows bold headline, CTA, and stats strip', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('AI Agent Mafia');
    await expect(page.locator('#statsStrip')).toBeVisible();
    await expect(page.locator('a.btn-primary.btn-hero')).toContainText('Send in your agent');
  });
});

test.describe('Legacy play route', () => {
  test('redirects /play.html to the owner watch route', async ({ page }) => {
    await page.goto('/play.html?mode=mafia&room=ABC123&spectate=1');
    await expect(page).toHaveURL(/\/browse\.html\?mode=mafia&room=ABC123&spectate=1/);
  });
});

test.describe('Watch page', () => {
  test('shows the owner-first watch shell instead of public room browsing', async ({ page }) => {
    await page.goto('/browse.html');
    await expect(page.locator('#ownerWatchCard')).toBeVisible();
    await expect(page.locator('#ownerWatchCard')).toBeVisible();
    await expect(page.locator('text=While the room fills')).toBeVisible();
    await expect(page.locator('text=Watch live tables')).toHaveCount(0);
    await expect(page.locator('text=Follow the rankings')).toHaveCount(0);
  });
});

test.describe('Leaderboard page', () => {
  test('keeps the ranking table large and removes the old hero copy', async ({ page }) => {
    await page.goto('/leaderboard.html');
    await expect(page.locator('#leaderboardWindowControls [data-window="12h"].is-active')).toBeVisible();
    await expect(page.locator('#leaderboardList')).toBeVisible();
    await expect(page.locator('text=Ranks are based on completed Mafia matches')).toHaveCount(0);
    await expect(page.locator('main h1')).toHaveCount(0);
  });
});

test.describe('Roadmap and docs', () => {
  test('games page shows How Mafia Works with diagram placeholders', async ({ page }) => {
    await page.goto('/games-info.html');
    await expect(page.locator('h1')).toContainText('How it works');
    await expect(page.locator('#mafia')).toBeVisible();
    await expect(page.locator('.diagram-placeholder')).toHaveCount(4);
    await expect(page.locator('#amongus')).toHaveCount(0);
    await expect(page.locator('#villa')).toHaveCount(0);
  });

  test('guide is account-first and links to games-info for rules', async ({ page }) => {
    await page.goto('/guide.html');
    await expect(page.locator('#join')).toBeVisible();
    await expect(page.locator('#registerForm')).toBeVisible();
    await expect(page.locator('#registerBtn')).toBeVisible();
    await expect(page.locator('#stepGenerate')).toBeVisible();
    await expect(page.locator('#stepConnect')).toBeVisible();
    await expect(page.locator('#viewSkillBtn')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Learn how it works' })).toBeVisible();
    await expect(page.locator('text=Generate one message. Your agent does the rest.')).toBeVisible();
    await expect(page.locator('text=Install the connector')).toHaveCount(0);
  });
});

test.describe('Dashboard', () => {
  test('redirects legacy dashboard traffic to the join flow', async ({ page }) => {
    await page.goto('/dashboard.html');
    await expect(page).toHaveURL(/\/guide\.html#join$/);
  });
});

test.describe('Launch API smoke', () => {
  test('instant play requires a connected agent', async ({ request }) => {
    const res = await request.post('/api/play/instant', {
      data: { mode: 'mafia' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('AGENT_REQUIRED');
  });

  test('instant play blocks non-mafia modes', async ({ request }) => {
    const res = await request.post('/api/play/instant', {
      data: { mode: 'villa' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MODE_DISABLED');
  });

  test('watch endpoint still reports the six-agent requirement', async ({ request }) => {
    const res = await request.get('/api/play/watch');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.found).toBe(false);
    expect(body.requiredAgents).toBe(6);
    expect(body.message).toContain('No live agent-only Mafia');
  });
});
