const { defineConfig } = require('@playwright/test');

const PORT = 4173;
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === '1';

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: reuseExistingServer
    ? undefined
    : {
        command: `PORT=${PORT} DISABLE_AUTOBATTLE=1 node server.js`,
        port: PORT,
        timeout: 10000,
        reuseExistingServer: false,
      },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
