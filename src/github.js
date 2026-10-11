import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

const API = 'https://api.github.com';
const b64url = (value) => Buffer.from(value).toString('base64url');

export function verifySignature(secret, rawBody, header) {
  if (!secret || !header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Reads the optional .github/barnraise.yml. Only flat "key: value" lines are supported.
export function parseConfig(text) {
  const config = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(max_open_prs|proposal_threshold|test_command|notes)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    config[m[1]] = m[1] === 'test_command' || m[1] === 'notes' ? value : Number.parseInt(value, 10);
  }
  return config;
}

export function makeGithub({ appId, privateKey, fetchImpl = fetch } = {}) {
  const tokens = new Map();

  function appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
      '.' +
      b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
    return unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url');
  }

  async function installationToken(installationId) {
    const cached = tokens.get(installationId);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${appJwt()}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub installation token request failed: ${res.status}`);
    const data = await res.json();
    tokens.set(installationId, { token: data.token, expires: Date.parse(data.expires_at) });
    return data.token;
  }

  async function request(installationId, method, path, { body, accept = 'application/vnd.github+json' } = {}) {
    const headers = { accept, 'user-agent': 'barnraise' };
    // Without app credentials (local dev) public repos can still be read anonymously.
    if (appId && privateKey && installationId) headers.authorization = `Bearer ${await installationToken(installationId)}`;
    if (body) headers['content-type'] = 'application/json';
    return fetchImpl(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }

  return {
    async getPull(repo, installationId, number) {
      const res = await request(installationId, 'GET', `/repos/${repo}/pulls/${number}`);
      return res.ok ? res.json() : null;
    },

    async comment(repo, installationId, number, body) {
      if (!(appId && privateKey && installationId)) {
        console.log(`[barnraise] (no GitHub App configured) would comment on ${repo}#${number}:\n${body}\n`);
        return;
      }
      const res = await request(installationId, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: { body } });
      if (!res.ok) console.error(`[barnraise] comment on ${repo}#${number} failed: ${res.status}`);
    },

    async getConfig(repo, installationId) {
      const res = await request(installationId, 'GET', `/repos/${repo}/contents/.github/barnraise.yml`, {
        accept: 'application/vnd.github.raw+json',
      });
      return res.ok ? parseConfig(await res.text()) : {};
    },
  };
}
