const { test, expect } = require('@playwright/test');

const PAGES = [
  { path: '/', name: 'index' },
  { path: '/play.html', name: 'play' },
  { path: '/browse.html', name: 'browse' },
  { path: '/leaderboard.html', name: 'leaderboard' },
  { path: '/guide.html', name: 'guide' },
  { path: '/games-info.html', name: 'games-info' },
];

test.describe('Public navigation', () => {
  for (const entry of PAGES) {
    test(`${entry.name} shows the mafia-first nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/play.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/browse.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/leaderboard.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/guide.html"]').first()).toBeVisible();
      await expect(page.locator('nav .nav-links a[href="/dashboard.html"]')).toHaveCount(0);
    });

    test(`${entry.name} has an agent-first primary CTA`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a.btn-primary').first()).toContainText(/Copy message/);
    });
  }
});

test.describe('Homepage', () => {
  test('focuses on Agent Mafia and agent onboarding', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Send your OpenClaw agent into a live room of lies');
    await expect(page.locator('#liveRoomsList')).toBeVisible();
    await expect(page.locator('text=Public social deduction')).toBeVisible();
    await expect(page.locator('a.btn-primary.btn-hero')).toContainText('Copy message for your agent');
    await expect(page.locator('text=Six connected agents enter the room')).toBeVisible();
  });

  test('does not advertise playable non-mafia CTAs', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('a[href*="amongus"], button[data-instant-play="amongus"]')).toHaveCount(0);
    await expect(page.locator('a[href*="villa"], button[data-instant-play="villa"]')).toHaveCount(0);
  });
});

test.describe('Play page', () => {
  test('is the live transcript page', async ({ page }) => {
    await page.goto('/play.html');
    await expect(page.locator('#startArenaBtn')).toBeVisible();
    await expect(page.locator('h1')).toContainText('Follow a live Claw of Deceit table');
    await expect(page.locator('text=Public transcript')).toBeVisible();
    await expect(page.locator('#joinBtn')).toHaveCount(0);
    await expect(page.locator('#quickMatchBtn')).toHaveCount(0);
    await expect(page.locator('#rematchBtn')).toHaveCount(0);
  });
});

test.describe('Watch page', () => {
  test('shows transcript-first spectator copy and a rankings CTA', async ({ page }) => {
    await page.goto('/browse.html');
    await expect(page.locator('text=public transcript')).toBeVisible();
    await expect(page.locator('a[href="/leaderboard.html"]').filter({ hasText: 'Open leaderboard' })).toBeVisible();
  });
});

test.describe('Leaderboard page', () => {
  test('has a dedicated current-winners view', async ({ page }) => {
    await page.goto('/leaderboard.html');
    await expect(page.locator('h1')).toContainText('Who is winning in Claw of Deceit right now?');
    await expect(page.locator('#leaderboardWindowControls [data-window="12h"].is-active')).toBeVisible();
    await expect(page.locator('text=completed Mafia matches')).toBeVisible();
  });
});

test.describe('Roadmap and docs', () => {
  test('games page is mafia-only', async ({ page }) => {
    await page.goto('/games-info.html');
    await expect(page.locator('#mafia')).toBeVisible();
    await expect(page.locator('text=Why it is fun to watch')).toBeVisible();
    await expect(page.locator('text=Six connected agents enter the room')).toBeVisible();
    await expect(page.locator('#amongus')).toHaveCount(0);
    await expect(page.locator('#villa')).toHaveCount(0);
  });

  test('guide stays lightweight and setup-focused', async ({ page }) => {
    await page.goto('/guide.html');
    await expect(page.locator('#join')).toBeVisible();
    await expect(page.locator('#generateCmdBtn')).toBeVisible();
    await expect(page.locator('text=What Claw of Deceit handles')).toBeVisible();
    await expect(page.locator('details')).toHaveCount(1);
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

  test('watch endpoint returns a Mafia watch URL', async ({ request }) => {
    const res = await request.get('/api/play/watch');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.found).toBe(false);
    expect(body.requiredAgents).toBe(6);
    expect(body.message).toContain('No live agent-only Mafia');
  });
});
