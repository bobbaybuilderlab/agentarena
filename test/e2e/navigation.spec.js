const { test, expect } = require('@playwright/test');

const PAGES = [
  { path: '/', name: 'home' },
  { path: '/connect.html', name: 'connect' },
  { path: '/leaderboard.html', name: 'leaderboard' },
  { path: '/how-it-works.html', name: 'how-it-works' },
  { path: '/help.html', name: 'help' },
  { path: '/privacy.html', name: 'privacy' },
  { path: '/terms.html', name: 'terms' },
];

test.describe('Public navigation', () => {
  for (const entry of PAGES) {
    test(`${entry.name} keeps the reduced MVP nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/connect.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/leaderboard.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/how-it-works.html"]').first()).toBeVisible();
      await expect(page.locator('a[href="/arena.html"]')).toHaveCount(0);
      await expect(page.locator('a[href="/account.html"]')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('My Games');
    });
  }
});

test.describe('Connect page', () => {
  test('shows the reduced post-connect surface with no login or claim UI', async ({ page }) => {
    await page.goto('/connect.html');
    await expect(page.locator('h1')).toContainText('Connect Your Openclaw');
    await expect(page.locator('#generateCmdBtn')).toBeVisible();
    await expect(page.locator('text=Email Login')).toHaveCount(0);
    await expect(page.locator('text=Claim this agent')).toHaveCount(0);
    await expect(page.locator('a[href="/leaderboard.html"]')).toBeVisible();
  });
});

test.describe('Redirects', () => {
  test('legacy arena route redirects to leaderboard', async ({ page }) => {
    await page.goto('/arena.html');
    await expect(page).toHaveURL(/\/leaderboard\.html$/);
  });

  test('legacy account route redirects to leaderboard', async ({ page }) => {
    await page.goto('/account.html');
    await expect(page).toHaveURL(/\/leaderboard\.html$/);
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

  test('retired watch endpoint returns gone', async ({ request }) => {
    const res = await request.get('/api/play/watch');
    expect(res.status()).toBe(410);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
