import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openDb } from './db.js';
import { Coordinator } from './coordinator.js';
import { makeGithub, verifySignature } from './github.js';
import { handleWebhook } from './webhooks.js';
import { buildMcpServer } from './mcp.js';
import { connectedPage, homePage, joinPage, maintainersPage, messagePage, setupPage, termsPage } from './pages.js';

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const send = (res, status, body, type = 'text/html; charset=utf-8', headers = {}) => {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
};
const redirect = (res, location) => send(res, 302, '', 'text/plain', { location });

export function createApp({ dataDir = null, dev = false, publicUrl = 'http://localhost:8787', github = null, fetchImpl = fetch } = {}) {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const appFile = dataDir ? join(dataDir, 'app.json') : null;
  let app = appFile && existsSync(appFile) ? JSON.parse(readFileSync(appFile, 'utf8')) : null;

  const db = openDb(dataDir ? join(dataDir, 'barnraise.db') : ':memory:');
  let gh = github ?? makeGithub({ appId: app?.id, privateKey: app?.pem, fetchImpl });
  const coordinator = new Coordinator({ db, github: gh });

  // Short-lived values for the sign-in and app-creation round trips to GitHub.
  const pending = new Map();
  const newState = (kind) => {
    const state = randomBytes(16).toString('hex');
    pending.set(state, { kind, expires: Date.now() + 10 * 60 * 1000 });
    return state;
  };
  const takeState = (state, kind) => {
    const entry = pending.get(state);
    pending.delete(state);
    return Boolean(entry && entry.kind === kind && entry.expires > Date.now());
  };
  const setupKey = randomBytes(12).toString('hex');

  async function handle(req, res) {
    const url = new URL(req.url, publicUrl);
    const path = url.pathname;

    if (path === '/mcp') {
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const user = coordinator.userForToken(token);
      if (!user) {
        return send(res, 401, JSON.stringify({ error: `Missing or unknown token. Get one at ${publicUrl}/join` }), 'application/json');
      }
      if (req.method !== 'POST') return send(res, 405, '', 'text/plain', { allow: 'POST' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      // Stateless: each request gets its own server, bound to the signed-in volunteer.
      const mcp = buildMcpServer(coordinator, user.login);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (path === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      const signed = verifySignature(app?.webhook_secret, raw, req.headers['x-hub-signature-256']);
      if (!signed && !(dev && !app)) return send(res, 401, 'bad signature', 'text/plain');
      await handleWebhook(coordinator, gh, req.headers['x-github-event'], JSON.parse(raw.toString('utf8')), publicUrl);
      return send(res, 200, 'ok', 'text/plain');
    }

    if (req.method !== 'GET') return send(res, 405, '', 'text/plain', { allow: 'GET' });

    if (path === '/') return send(res, 200, homePage(coordinator.state()));
    if (path === '/api/state') return send(res, 200, JSON.stringify(coordinator.state()), 'application/json');
    if (path === '/terms') return send(res, 200, termsPage());
    if (path === '/maintainers') return send(res, 200, maintainersPage({ appSlug: app?.slug }));
    if (path === '/join') return send(res, 200, joinPage({ dev: dev && !app }));

    if (path === '/auth/dev' && dev && !app) {
      const login = url.searchParams.get('login') ?? '';
      if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) return send(res, 400, messagePage('Invalid username', 'Use a GitHub username.'));
      return send(res, 200, connectedPage({ login, token: coordinator.issueToken(login), publicUrl }));
    }

    if (path === '/auth/github') {
      if (!app) return send(res, 503, messagePage('Not set up yet', 'The GitHub App has not been created for this server.'));
      const params = new URLSearchParams({
        client_id: app.client_id,
        state: newState('login'),
        redirect_uri: `${publicUrl}/auth/callback`,
      });
      return redirect(res, `https://github.com/login/oauth/authorize?${params}`);
    }

    if (path === '/auth/callback') {
      if (!app || !takeState(url.searchParams.get('state'), 'login')) {
        return send(res, 400, messagePage('Sign-in expired', 'Please start again from the Volunteer page.'));
      }
      const tokenRes = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, code: url.searchParams.get('code') }),
      });
      const { access_token: accessToken } = await tokenRes.json();
      const userRes = accessToken
        ? await fetchImpl('https://api.github.com/user', {
            headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'barnraise' },
          })
        : null;
      if (!userRes?.ok) return send(res, 502, messagePage('Sign-in failed', 'GitHub did not confirm your account. Please try again.'));
      const { login } = await userRes.json();
      return send(res, 200, connectedPage({ login, token: coordinator.issueToken(login), publicUrl }));
    }

    if (path === '/setup') {
      if (app) return send(res, 200, messagePage('Already set up', 'This server already has its GitHub App.'));
      if (url.searchParams.get('key') !== setupKey) {
        return send(res, 403, messagePage('Setup key needed', 'Open the setup link printed in the server console.'));
      }
      return send(res, 200, setupPage({ publicUrl, state: newState('setup') }));
    }

    if (path === '/setup/callback') {
      if (app || !appFile || !takeState(url.searchParams.get('state'), 'setup')) {
        return send(res, 400, messagePage('Setup expired', 'Please start again from the setup link.'));
      }
      const conv = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get('code'))}/conversions`, {
        method: 'POST',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'barnraise' },
      });
      if (!conv.ok) return send(res, 502, messagePage('Setup failed', `GitHub answered ${conv.status}.`));
      const created = await conv.json();
      app = {
        id: created.id,
        slug: created.slug,
        pem: created.pem,
        webhook_secret: created.webhook_secret,
        client_id: created.client_id,
        client_secret: created.client_secret,
      };
      writeFileSync(appFile, JSON.stringify(app, null, 2), { mode: 0o600 });
      gh = makeGithub({ appId: app.id, privateKey: app.pem, fetchImpl });
      coordinator.github = gh;
      return redirect(res, '/maintainers');
    }

    return send(res, 404, messagePage('Not found', 'There is nothing at this address.'));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[barnraise]', err);
      if (!res.headersSent) send(res, 500, 'internal error', 'text/plain');
      else res.end();
    });
  });

  return { server, coordinator, setupKey, hasApp: () => Boolean(app) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dev = process.argv.includes('--dev');
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const dataDir = resolve(process.env.BARNRAISE_DATA ?? fileURLToPath(new URL('../data', import.meta.url)));
  const { server, setupKey, hasApp } = createApp({ dataDir, dev, publicUrl });
  server.listen(port, () => {
    console.log(`Barnraise is running at ${publicUrl}${dev ? ' (dev mode)' : ''}`);
    if (!hasApp()) console.log(`No GitHub App yet. To create one, open ${publicUrl}/setup?key=${setupKey}`);
  });
}
