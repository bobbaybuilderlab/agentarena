const { test, expect } = require('@playwright/test');

const PAGES = [
  { path: '/', name: 'index' },
  { path: '/play.html', name: 'play' },
  { path: '/browse.html', name: 'browse' },
  { path: '/dashboard.html', name: 'dashboard' },
  { path: '/guide.html', name: 'guide' },
  { path: '/games-info.html', name: 'games-info' },
];

test.describe('Public navigation', () => {
  for (const entry of PAGES) {
    test(`${entry.name} shows the mafia-first nav`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a[href="/play.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/browse.html"]').first()).toBeVisible();
      await expect(page.locator('nav a[href="/guide.html"]').first()).toBeVisible();
      await expect(page.locator('nav .nav-links a[href="/dashboard.html"]')).toHaveCount(0);
    });

    test(`${entry.name} has an agent-first primary CTA`, async ({ page }) => {
      await page.goto(entry.path);
      await expect(page.locator('nav a.btn-primary').first()).toContainText(/Connect your agent|Watch live|Back to Arena/);
    });
  }
});

test.describe('Homepage', () => {
  test('focuses on Agent Mafia and agent onboarding', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Watch agents lie, accuse, and expose the Mafia');
    await expect(page.locator('#liveRoomsList')).toBeVisible();
    await expect(page.locator('text=Live agent deception')).toBeVisible();
    await expect(page.locator('a.btn-primary.btn-hero')).toContainText('Connect your agent');
    await expect(page.locator('.mvp-hero .mvp-copy')).toContainText('six agents bluff');
    await expect(page.locator('text=Six connected agents enter the room')).toBeVisible();
  });

  test('does not advertise playable non-mafia CTAs', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('a[href*="amongus"], button[data-instant-play="amongus"]')).toHaveCount(0);
    await expect(page.locator('a[href*="villa"], button[data-instant-play="villa"]')).toHaveCount(0);
  });
});

test.describe('Play page', () => {
  test('is the live owner arena page', async ({ page }) => {
    await page.goto('/play.html');
    await expect(page.locator('#startArenaBtn')).toBeVisible();
    await expect(page.locator('h1')).toContainText('Your live Agent Mafia control room');
    await expect(page.locator('text=Every public seat belongs to a connected OpenClaw agent')).toBeVisible();
    await expect(page.locator('#joinBtn')).toHaveCount(0);
    await expect(page.locator('#quickMatchBtn')).toHaveCount(0);
  });
});

test.describe('Watch page', () => {
  test('shows six-seat spectator copy and leaderboard windows', async ({ page }) => {
    await page.goto('/browse.html');
    await expect(page.locator('text=next six-agent table')).toBeVisible();
    await expect(page.locator('#leaderboardWindowControls [data-window="12h"]')).toBeVisible();
    await expect(page.locator('#leaderboardWindowControls [data-window="24h"]')).toBeVisible();
    await expect(page.locator('#leaderboardWindowControls [data-window="all"]')).toBeVisible();
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
    await expect(page.locator('#quickstart code').filter({ hasText: '--decision-cmd' }).first()).toBeVisible();
    await expect(page.locator('text=What Agent Arena handles')).toBeVisible();
    await expect(page.locator('details')).toHaveCount(0);
  });
});

test.describe('Dashboard', () => {
  test('shows the owner dashboard empty state before an agent is connected', async ({ page }) => {
    await page.goto('/dashboard.html');
    await expect(page.locator('h1')).toContainText('Track your agent');
    await expect(page.locator('text=Use this after matches, not during them')).toBeVisible();
    await expect(page.locator('#dashboardEmptyState')).toBeVisible();
    await expect(page.locator('#dashboardEmptyState')).toContainText('No agent connected yet');
    await expect(page.locator('#dashboardShell')).toBeHidden();
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
