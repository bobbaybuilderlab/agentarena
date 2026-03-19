const { test, expect } = require('@playwright/test');

const PAGES = [
  { path: '/', name: 'home' },
  { path: '/connect.html', name: 'connect' },
  { path: '/leaderboard.html', name: 'leaderboard' },
  { path: '/how-it-works.html', name: 'how-it-works' },
];

test.describe('Public navigation', () => {
  for (const entry of PAGES) {
    test(`${entry.name} keeps the reduced MVP nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/connect.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/leaderboard.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/how-it-works.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/arena.html"]')).toHaveCount(0);
      await expect(page.locator('nav a[href="/account.html"]')).toHaveCount(0);
    });
  }
});

test.describe('Connect page', () => {
  test('shows the reduced post-connect surface with no login or claim UI', async ({ page }) => {
    await page.goto('/connect.html');
    await expect(page.locator('h1')).toContainText('Connect Your Openclaw');
    await expect(page.locator('#generateCmdBtn')).toBeVisible();
    const packageSummary = page.locator('.connect-fallback summary');
    await expect(packageSummary).toContainText('Want to review the package?');
    await packageSummary.click();
    await expect(page.locator('a[href="https://www.npmjs.com/package/@clawofdeceit/clawofdeceit-connect"]')).toBeVisible();
    await expect(page.locator('text=Email Login')).toHaveCount(0);
    await expect(page.locator('text=Claim this agent')).toHaveCount(0);
    await expect(page.locator('a[href="/leaderboard.html"]').first()).toBeVisible();
  });
});

test.describe('Ops page', () => {
  test('loads locally without an admin-token prompt', async ({ page }) => {
    await page.goto('/ops.html');
    await expect(page.locator('h1')).toContainText('Ops Dashboard');
    await expect(page.locator('text=Local-only diagnostics')).toBeVisible();
    await expect(page.locator('text=Admin token')).toHaveCount(0);
  });
});

test.describe('Leaderboard page', () => {
  test('does not render raw agent ids and search is name-only', async ({ page }) => {
    await page.route('**/api/leaderboard**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          window: 'all',
          windowLabel: 'All time',
          source: 'test',
          topAgents: [
            {
              id: 'agent_alpha_secret',
              name: 'Alpha',
              gamesPlayed: 12,
              wins: 8,
              winRate: 66.7,
              mmr: 1320,
              lastRatingDelta: 18,
              isProvisional: false,
              queueStatus: 'idle',
              isLive: false,
            },
            {
              id: 'agent_bravo_secret',
              name: 'Bravo',
              gamesPlayed: 10,
              wins: 6,
              winRate: 60,
              mmr: 1250,
              lastRatingDelta: -4,
              isProvisional: false,
              queueStatus: 'in_match',
              isLive: true,
            },
            {
              id: 'agent_charlie_secret',
              name: 'Charlie',
              gamesPlayed: 9,
              wins: 5,
              winRate: 55.6,
              mmr: 1190,
              lastRatingDelta: 0,
              isProvisional: true,
              queueStatus: 'reserved',
              isLive: false,
            },
          ],
          windows: [
            { key: '12h', label: '12h' },
            { key: '24h', label: '24h' },
            { key: 'all', label: 'All' },
          ],
        }),
      });
    });

    await page.goto('/leaderboard.html');
    await expect(page.locator('#leaderboardList .lb-table-row')).toHaveCount(3);
    await expect(page.locator('#leaderboardPodium')).not.toContainText('agent_alpha_secret');
    await expect(page.locator('#leaderboardList')).not.toContainText('agent_alpha_secret');
    await expect(page.locator('.lb-table-header')).not.toContainText('AGENT');

    const search = page.locator('#leaderboardSearch');
    await search.fill('agent_alpha_secret');
    await expect(page.locator('.lb-empty')).toContainText('No agents found.');

    await search.fill('Alpha');
    await expect(page.locator('#leaderboardList')).toContainText('Alpha');
    await expect(page.locator('#leaderboardList')).not.toContainText('agent_alpha_secret');
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
  test('public room and play endpoints are retired', async ({ request }) => {
    const instantRes = await request.post('/api/play/instant', {
      data: { mode: 'mafia' },
    });
    expect(instantRes.status()).toBe(410);
    const instantBody = await instantRes.json();
    expect(instantBody.ok).toBe(false);

    const roomsRes = await request.get('/api/play/rooms?status=open');
    expect(roomsRes.status()).toBe(410);
    const roomsBody = await roomsRes.json();
    expect(roomsBody.ok).toBe(false);
  });

  test('retired watch endpoint returns gone', async ({ request }) => {
    const res = await request.get('/api/play/watch');
    expect(res.status()).toBe(410);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
