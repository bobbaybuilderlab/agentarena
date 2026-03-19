const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
  };
}

function createElement(id = '') {
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    href: '',
    style: {},
    listeners: Object.create(null),
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    parentNode: {
      insertBefore() {},
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    querySelectorAll() {
      return [];
    },
    getAttribute() {
      return null;
    },
    setAttribute() {},
    closest() {
      return null;
    },
    remove() {},
  };
}

test('connect page creates a site session before requesting a one-time connect message', async () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const fetchCalls = [];
  const localStorage = createStorage();
  const sessionStorage = createStorage();

  const elements = {
    generateCmdBtn: createElement('generateCmdBtn'),
    status: createElement('status'),
    cliBox: createElement('cliBox'),
    cliCommand: createElement('cliCommand'),
  };

  const document = {
    body: {
      classList: {
        contains(name) {
          return name === 'page-connect';
        },
      },
    },
    getElementById(id) {
      return elements[id] || null;
    },
    querySelectorAll() {
      return [];
    },
    createElement() {
      return createElement();
    },
    addEventListener() {},
  };

  async function fetch(url, options = {}) {
    fetchCalls.push({ url, options });
    if (String(url).endsWith('/api/auth/session')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            session: {
              token: 'site-session-token',
            },
          };
        },
      };
    }
    if (String(url).endsWith('/api/openclaw/connect-session')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            connect: {
              id: 'connect-123',
              accessToken: 'connect-access-token',
              expiresAt: Date.now() + 5 * 60 * 1000,
              onboarding: {
                agentPrompt: 'Read the skill and connect.',
                connectCommand: 'openclaw --profile clawofdeceit clawofdeceit connect',
                skillUrl: '/api/openclaw/connect-session/connect-123/skill.md',
              },
            },
          };
        },
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }

  const window = {
    __RUNTIME_CONFIG__: {
      API_URL: 'https://clawofdeceit.com',
    },
    location: {
      origin: 'https://clawofdeceit.com',
      search: '',
      pathname: '/connect.html',
      hash: '',
      href: 'https://clawofdeceit.com/connect.html',
    },
    history: {
      replaceState() {},
    },
  };

  const context = {
    window,
    document,
    fetch,
    navigator: {
      clipboard: {
        async writeText() {},
      },
    },
    localStorage,
    sessionStorage,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout() {
      return 1;
    },
    clearTimeout() {},
    URLSearchParams,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Boolean,
    JSON,
    console,
  };
  context.globalThis = context;

  vm.runInNewContext(script, context, { filename: 'public/app.js' });

  const clickHandler = elements.generateCmdBtn.listeners.click;
  assert.equal(typeof clickHandler, 'function');

  await clickHandler();

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].url, 'https://clawofdeceit.com/api/auth/session');
  assert.equal(fetchCalls[0].options.credentials, 'include');
  assert.equal(fetchCalls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(Object.keys(fetchCalls[0].options.headers).length, 1);

  assert.equal(fetchCalls[1].url, 'https://clawofdeceit.com/api/openclaw/connect-session');
  assert.equal(fetchCalls[1].options.credentials, 'include');
  assert.equal(fetchCalls[1].options.headers.Authorization, 'Bearer site-session-token');
  assert.equal(fetchCalls[1].options.headers['Content-Type'], 'application/json');

  assert.equal(elements.status.textContent, 'Ready. Paste this into OpenClaw.');
  assert.equal(elements.cliCommand.textContent, 'Read the skill and connect.');
  assert.equal(elements.cliBox.style.display, 'block');
  assert.equal(localStorage.getItem('clawofdeceit_connect_session_id'), 'connect-123');
  assert.equal(sessionStorage.getItem('clawofdeceit_connect_access_token'), 'connect-access-token');
});
