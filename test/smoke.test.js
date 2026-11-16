'use strict';

/*
 * Zonebuddy smoke + API contract tests.
 * Boots the real server (node main.js) against a throwaway store and drives the
 * public HTTP surface exactly as a browser would.
 */

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEMO = { email: 'cenius@cenius.ai', password: 'cenius' };

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonebuddy-test-'));
  const dbPath = path.join(dir, 'db.json');
  const port = await freePort();
  const child = spawn(process.execPath, ['main.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', ZONEBUDDY_DB: dbPath }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}):\n${log}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not become ready:\n${log}`);
    await sleep(100);
  }

  return {
    base,
    dbPath,
    log: () => log,
    async stop() {
      child.kill('SIGKILL');
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeClient(base) {
  const cookies = new Map();
  async function request(pathname, options) {
    const opts = options || {};
    const headers = Object.assign({ accept: 'application/json' }, opts.headers);
    if (cookies.size) headers.cookie = [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(base + pathname, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: 'manual',
    });
    const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const pair = raw.split(';')[0];
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || /max-age=0/i.test(raw)) cookies.delete(name);
      else cookies.set(name, value);
    }
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, headers: response.headers, text, json, setCookie };
  }
  return {
    request,
    hasSession: () => cookies.has('zb_session'),
    clearSession: () => cookies.clear(),
  };
}

let main;
let alice;
let platformTeamId;

before(async () => {
  main = await startServer();
  alice = makeClient(main.base);
});

after(async () => {
  if (main) await main.stop();
});

test('serves the SPA shell, static assets and health endpoint', async () => {
  const root = await fetch(main.base + '/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/login');

  const login = await fetch(main.base + '/login');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-type') || '', /text\/html/);
  const loginHtml = await login.text();
  assert.match(loginHtml, /Zonebuddy/);
  assert.match(loginHtml, /\/app\.js/);
  assert.match(loginHtml, /\/styles\.css/);

  const appShell = await fetch(main.base + '/app', { redirect: 'manual' });
  assert.equal(appShell.status, 302);
  assert.match(appShell.headers.get('location') || '', /^\/login/);

  const health = await fetch(main.base + '/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');

  for (const [assetPath, expectedType] of [
    ['/styles.css', /text\/css/],
    ['/app.js', /javascript/],
    ['/favicon.svg', /svg/],
    ['/fonts/manrope-latin.woff2', /font\/woff2/],
  ]) {
    const response = await fetch(main.base + assetPath);
    assert.equal(response.status, 200, assetPath);
    assert.match(response.headers.get('content-type') || '', expectedType, assetPath);
  }

  const missing = await fetch(main.base + '/definitely-not-a-route');
  assert.equal(missing.status, 404);

  const headers = login.headers;
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.ok(headers.get('referrer-policy'));
});

test('package manifest keeps main.js as the entry point and ships no start/dev scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.main, 'main.js');
  assert.equal(manifest.scripts.start, undefined);
  assert.equal(manifest.scripts.dev, undefined);
  assert.ok(manifest.scripts.test);
  assert.equal(manifest.dependencies, undefined);
});

test('signup validates email, password and confirmation', async () => {
  const client = makeClient(main.base);
  const badEmail = await client.request('/api/auth/signup', {
    method: 'POST',
    body: { email: 'not-an-email', password: 'longenough1', confirmPassword: 'longenough1' },
  });
  assert.equal(badEmail.status, 400);
  assert.ok(badEmail.json.errors.email);

  const shortPassword = await client.request('/api/auth/signup', {
    method: 'POST',
    body: { email: 'new@example.com', password: 'short', confirmPassword: 'short' },
  });
  assert.equal(shortPassword.status, 400);
  assert.ok(shortPassword.json.errors.password);

  const mismatch = await client.request('/api/auth/signup', {
    method: 'POST',
    body: { email: 'new@example.com', password: 'longenough1', confirmPassword: 'different1' },
  });
  assert.equal(mismatch.status, 400);
  assert.ok(mismatch.json.errors.confirmPassword);

  const ok = await client.request('/api/auth/signup', {
    method: 'POST',
    body: { email: 'new@example.com', password: 'longenough1', confirmPassword: 'longenough1' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.email, 'new@example.com');
  assert.ok(client.hasSession());
  assert.match(ok.setCookie.join(';'), /HttpOnly/i);
  assert.match(ok.setCookie.join(';'), /SameSite=Lax/i);
});

test('demo login works and the session resolves to the demo user', async () => {
  const response = await alice.request('/api/auth/login', { method: 'POST', body: DEMO });
  assert.equal(response.status, 200);
  assert.equal(response.json.user.email, DEMO.email);
  assert.match(response.setCookie.join(';'), /HttpOnly/i);
  assert.match(response.setCookie.join(';'), /SameSite=Lax/i);
  assert.match(response.setCookie.join(';'), /Max-Age=\d+/);

  const me = await alice.request('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, DEMO.email);
  assert.equal(me.json.user.passwordHash, undefined);
});

test('failed logins are rejected with one non-enumerating message', async () => {
  const wrongPassword = await makeClient(main.base).request('/api/auth/login', {
    method: 'POST',
    body: { email: DEMO.email, password: 'wrong-password' },
  });
  const unknownUser = await makeClient(main.base).request('/api/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.com', password: 'whatever1' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  assert.equal(wrongPassword.json.error, unknownUser.json.error);
});

test('time zone list requires auth and includes real IANA zones', async () => {
  const anonymous = await makeClient(main.base).request('/api/timezones');
  assert.equal(anonymous.status, 401);

  const authed = await alice.request('/api/timezones');
  assert.equal(authed.status, 200);
  assert.ok(Array.isArray(authed.json.timeZones));
  assert.ok(authed.json.timeZones.includes('America/New_York'));
  assert.ok(authed.json.timeZones.includes('Europe/Berlin'));
  assert.ok(authed.json.timeZones.length > 100);
});

test('seeded demo data populates the dashboard with shared windows', async () => {
  const teams = await alice.request('/api/teams');
  assert.equal(teams.status, 200);
  assert.ok(teams.json.teams.length >= 3);
  const platform = teams.json.teams.find((team) => team.name === 'Platform Sync');
  assert.ok(platform, 'seeded Platform Sync team exists');
  assert.equal(platform.memberCount, 4);
  assert.equal(platform.shareLinkCount, 1);
  assert.ok(platform.weekHours.some((hours) => hours > 0), 'seeded team has a shared window');
  platformTeamId = platform.id;

  const detail = await alice.request(`/api/teams/${platform.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.team.members.length, 4);
  assert.equal(detail.json.team.shareLinks.length, 1);
  assert.ok(detail.json.team.defaultDate);
});

test('team create, rename and cascade delete', async () => {
  const created = await alice.request('/api/teams', { method: 'POST', body: { name: 'Launch' } });
  assert.equal(created.status, 201);
  const teamId = created.json.team.id;
  assert.equal(created.json.team.name, 'Launch');

  const renamed = await alice.request(`/api/teams/${teamId}`, { method: 'PATCH', body: { name: 'Launch Plan' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.team.name, 'Launch Plan');

  const list = await alice.request('/api/teams');
  assert.ok(list.json.teams.some((team) => team.id === teamId && team.name === 'Launch Plan'));

  const member = await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'Nina Patel', timeZone: 'America/Chicago', workStart: '09:00', workEnd: '17:00' },
  });
  assert.equal(member.status, 201);
  const link = await alice.request(`/api/teams/${teamId}/share-links`, { method: 'POST' });
  assert.equal(link.status, 201);
  const token = link.json.shareLink.token;

  const publicBefore = await fetch(`${main.base}/api/share/${token}`);
  assert.equal(publicBefore.status, 200);

  const deleted = await alice.request(`/api/teams/${teamId}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);

  assert.equal((await alice.request(`/api/teams/${teamId}`)).status, 404);
  assert.equal((await fetch(`${main.base}/api/share/${token}`)).status, 404);

  const store = JSON.parse(fs.readFileSync(main.dbPath, 'utf8'));
  assert.ok(!store.teams.some((team) => team.id === teamId));
  assert.ok(!store.members.some((row) => row.teamId === teamId));
  assert.ok(!store.shareLinks.some((row) => row.teamId === teamId));
});

test('member CRUD validates name, IANA zone and working hours', async () => {
  const team = await alice.request('/api/teams', { method: 'POST', body: { name: 'Validation Team' } });
  const teamId = team.json.team.id;

  const badZone = await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'Casey Reed', timeZone: 'Mars/Olympus_Mons', workStart: '09:00', workEnd: '17:00' },
  });
  assert.equal(badZone.status, 400);
  assert.ok(badZone.json.errors.timeZone);

  const badHours = await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'Casey Reed', timeZone: 'Europe/Berlin', workStart: '17:00', workEnd: '09:00' },
  });
  assert.equal(badHours.status, 400);
  assert.ok(badHours.json.errors.workEnd);

  const noName = await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: '   ', timeZone: 'Europe/Berlin', workStart: '09:00', workEnd: '17:00' },
  });
  assert.equal(noName.status, 400);
  assert.ok(noName.json.errors.name);

  const good = await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'Casey Reed', timeZone: 'America/New_York', workStart: '09:00', workEnd: '17:00' },
  });
  assert.equal(good.status, 201);
  const memberId = good.json.member.id;

  const patched = await alice.request(`/api/teams/${teamId}/members/${memberId}`, {
    method: 'PATCH',
    body: { name: 'Casey Reed-Holt', workStart: '08:30' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.member.name, 'Casey Reed-Holt');
  assert.equal(patched.json.member.workStart, '08:30');

  const removed = await alice.request(`/api/teams/${teamId}/members/${memberId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const detail = await alice.request(`/api/teams/${teamId}`);
  assert.equal(detail.json.team.members.length, 0);

  await alice.request(`/api/teams/${teamId}`, { method: 'DELETE' });
});

test('suggestions only return slots inside every member\u2019s working hours', async () => {
  const team = await alice.request('/api/teams', { method: 'POST', body: { name: 'Overlap Check' } });
  const teamId = team.json.team.id;
  await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'Berliner', timeZone: 'Europe/Berlin', workStart: '09:00', workEnd: '17:00' },
  });
  await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'New Yorker', timeZone: 'America/New_York', workStart: '09:00', workEnd: '17:00' },
  });

  // A Tuesday, so weekday working hours apply in both zones.
  const suggestions = await alice.request(
    `/api/teams/${teamId}/suggestions?date=2026-03-17&duration=60&referenceZone=Europe/Berlin`,
  );
  assert.equal(suggestions.status, 200);
  assert.ok(suggestions.json.slots.length > 0, 'shared slot exists for Berlin/New York');
  assert.ok(suggestions.json.slots.length <= 6);

  suggestions.json.slots.forEach((slot, index) => {
    assert.equal(slot.rank, index + 1);
    assert.equal(slot.members.length, 2);
    slot.members.forEach((member) => {
      const start = member.localStart;
      const end = member.localEnd;
      assert.ok(start >= '09:00' && start <= '17:00', `${member.name} starts inside hours (${start})`);
      assert.ok(end >= '09:00' && end <= '17:00', `${member.name} ends inside hours (${end})`);
    });
  });

  const tooLong = await alice.request(
    `/api/teams/${teamId}/suggestions?date=2026-03-17&duration=90&referenceZone=Europe/Berlin`,
  );
  assert.equal(tooLong.status, 200);
  assert.ok(tooLong.json.slots.length >= 1);

  const invalidDuration = await alice.request(`/api/teams/${teamId}/suggestions?date=2026-03-17&duration=45`);
  assert.equal(invalidDuration.status, 400);

  const invalidDate = await alice.request(`/api/teams/${teamId}/suggestions?date=17-03-2026`);
  assert.equal(invalidDate.status, 400);

  await alice.request(`/api/teams/${teamId}`, { method: 'DELETE' });
});

test('no shared working hours returns an explained empty result', async () => {
  const team = await alice.request('/api/teams', { method: 'POST', body: { name: 'Night Shift' } });
  const teamId = team.json.team.id;
  await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'Angelino', timeZone: 'America/Los_Angeles', workStart: '09:00', workEnd: '17:00' },
  });
  await alice.request(`/api/teams/${teamId}/members`, {
    method: 'POST',
    body: { name: 'Tokyoite', timeZone: 'Asia/Tokyo', workStart: '09:00', workEnd: '17:00' },
  });

  const suggestions = await alice.request('/api/teams/' + teamId + '/suggestions?date=2026-03-17&duration=60');
  assert.equal(suggestions.status, 200);
  assert.equal(suggestions.json.slots.length, 0);
  assert.match(suggestions.json.reason, /working hours/i);

  await alice.request(`/api/teams/${teamId}`, { method: 'DELETE' });
});

test('share links are public, revocable and scoped to live teams', async () => {
  const created = await alice.request(`/api/teams/${platformTeamId}/share-links`, { method: 'POST' });
  assert.equal(created.status, 201);
  const token = created.json.shareLink.token;
  assert.equal(created.json.shareLink.url, `/share/${token}`);

  const publicPlan = await fetch(`${main.base}/api/share/${token}`);
  assert.equal(publicPlan.status, 200);
  const payload = await publicPlan.json();
  assert.equal(payload.team.name, 'Platform Sync');
  assert.equal(payload.members.length, 4);
  assert.ok(payload.suggestions.slots.length > 0);
  assert.ok(payload.timeZones.includes('Europe/Berlin'));

  const list = await alice.request(`/api/teams/${platformTeamId}/share-links`);
  assert.equal(list.status, 200);
  assert.ok(list.json.shareLinks.some((link) => link.token === token));

  const linkId = list.json.shareLinks.find((link) => link.token === token).id;
  const revoked = await alice.request(`/api/teams/${platformTeamId}/share-links/${linkId}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(`${main.base}/api/share/${token}`)).status, 404);
  assert.equal((await fetch(`${main.base}/api/share/not-a-real-token`)).status, 404);
});

test('another account cannot read or touch someone else\u2019s team', async () => {
  const intruder = makeClient(main.base);
  const signup = await intruder.request('/api/auth/signup', {
    method: 'POST',
    body: { email: 'intruder@example.com', password: 'longenough1', confirmPassword: 'longenough1' },
  });
  assert.equal(signup.status, 201);

  assert.equal((await intruder.request(`/api/teams/${platformTeamId}`)).status, 404);
  assert.equal((await intruder.request(`/api/teams/${platformTeamId}`, { method: 'PATCH', body: { name: 'Hijacked' } })).status, 404);
  assert.equal((await intruder.request(`/api/teams/${platformTeamId}`, { method: 'DELETE' })).status, 404);
  assert.equal((await intruder.request(`/api/teams/${platformTeamId}/suggestions`)).status, 404);
  assert.equal((await intruder.request(`/api/teams/${platformTeamId}/share-links`, { method: 'POST' })).status, 404);
  assert.equal((await intruder.request('/api/teams')).json.teams.length, 0);
});

test('logout deletes the session server-side', async () => {
  const client = makeClient(main.base);
  await client.request('/api/auth/login', { method: 'POST', body: DEMO });
  assert.equal((await client.request('/api/auth/me')).status, 200);
  const logout = await client.request('/api/auth/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  assert.equal((await client.request('/api/auth/me')).status, 401);
  assert.equal((await client.request('/api/teams')).status, 401);
});

test('an expired session is unauthenticated, cleared and pruned from the store', async () => {
  const shortLived = await startServer({ SESSION_TTL_HOURS: '0.0005' });
  try {
    const client = makeClient(shortLived.base);
    const login = await client.request('/api/auth/login', { method: 'POST', body: DEMO });
    assert.equal(login.status, 200);
    assert.equal((await client.request('/api/auth/me')).status, 200);

    await sleep(2400);

    const expired = await client.request('/api/auth/me');
    assert.equal(expired.status, 401);
    assert.match(expired.setCookie.join(';'), /Max-Age=0/i);

    const guarded = await client.request('/api/teams');
    assert.equal(guarded.status, 401);

    const store = JSON.parse(fs.readFileSync(shortLived.dbPath, 'utf8'));
    assert.equal(store.sessions.length, 0, 'expired session pruned on write');
  } finally {
    await shortLived.stop();
  }
});
