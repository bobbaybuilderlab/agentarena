const { test, expect } = require('@playwright/test');

const PAGES = [
  { path: '/', name: 'index' },
  { path: '/leaderboard.html', name: 'leaderboard' },
  { path: '/how-it-works.html', name: 'how-it-works' },
  { path: '/connect.html', name: 'connect' },
];

test.describe('Public navigation', () => {
  for (const entry of PAGES) {
    test(`${entry.name} shows the connect-first nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/connect.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/leaderboard.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/how-it-works.html"]').first()).toBeVisible();
      await expect(page.locator('nav a.btn-primary[href="/connect.html"]').first()).toBeVisible();
      await expect(page.locator('nav .nav-links a[href="/arena.html"]')).toHaveCount(0);
      await expect(page.locator('nav .nav-links a[href="/dashboard.html"]')).toHaveCount(0);
      await expect(page.locator('nav .nav-links a[href="/guide.html"]')).toHaveCount(0);
      await expect(page.locator('nav .nav-links a[href="/games-info.html"]')).toHaveCount(0);
    });

    test(`${entry.name} has a join CTA in nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a.btn-primary').first()).toContainText(/Deploy Agent/);
    });

    test(`${entry.name} has How it works link in nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/how-it-works.html"]').first()).toContainText('How It Works');
    });
  }
});

test.describe('Homepage', () => {
  test('shows bold headline, CTA, and stats strip', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText(/Openclaw/i);
    await expect(page.locator('.home-stats')).toBeVisible();
    await expect(page.locator('a.btn-red-glow').first()).toContainText('Connect Your Openclaw');
    await expect(page.locator('text=847 agents deployed')).toBeVisible();
    await expect(page.locator('text=847 watching')).toHaveCount(0);
  });
});

test.describe('Legacy arena redirect', () => {
  test('old arena links redirect into connect', async ({ page }) => {
    await page.goto('/arena.html?mode=mafia&room=ABC123&spectate=1');
    await expect(page).toHaveURL(/\/connect\.html$/);
    await expect(page.locator('#stepWatch')).toBeVisible();
    await expect(page.locator('#dashboardMain')).toHaveCount(0);
    await expect(page.locator('#ownerWatchCard')).toHaveCount(0);
    await expect(page.locator('text=Open live transcript')).toHaveCount(0);
  });
});

test.describe('Connect flow', () => {
  test('uses connect language instead of retired private-surface prompts', async ({ page }) => {
    await page.goto('/connect.html');
    await expect(page.locator('#stepWatch')).toContainText('Open Connect');
    await expect(page.locator('text=Check Connect Status')).toBeVisible();
    await expect(page.locator('text=Watch It Play')).toHaveCount(0);
    await expect(page.locator('text=My Games')).toHaveCount(0);
  });
});

test.describe('How it works', () => {
  test('describes the current Mafia roles and round flow', async ({ page }) => {
    await page.goto('/how-it-works.html');
    await expect(page.locator('h1')).toContainText('How It Works');
    await expect(page.locator('text=Know Your Role')).toBeVisible();
    await expect(page.locator('text=How Each Round Plays Out')).toBeVisible();
  });
});

test.describe('Terminal page', () => {
  test('removes live-watch prompts and retired private-surface CTAs', async ({ page }) => {
    await page.goto('/terminal-agent.html');
    await expect(page.locator('text=Watch a Live Game')).toHaveCount(0);
    await expect(page.locator('text=Open live transcript')).toHaveCount(0);
    await expect(page.locator('text=View My Games')).toHaveCount(0);
    await expect(page.locator('#pulseJoinBtn')).toContainText(/Connect your Openclaw/i);
  });
});

test.describe('Launch API smoke', () => {
  test('instant play route is unavailable', async ({ request }) => {
    const res = await request.post('/api/play/instant', {
      data: { mode: 'mafia' },
    });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('ROUTE_UNAVAILABLE');
  });

  test('watch endpoint exposes status-only arena availability', async ({ request }) => {
    const res = await request.get('/api/play/watch');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.found).toBe(false);
    expect(body.liveMatchActive).toBe(false);
    expect(body.activeMatches).toBe(0);
    expect(body.watchUrl).toBeNull();
    expect(body.requiredAgents).toBe(6);
    expect(body.message).toContain('No live agent-only Mafia rooms yet');
  });
});
