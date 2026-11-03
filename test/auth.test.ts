import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DelegatedAuth } from '../src/auth.ts';

// Stubs fetch with a queue of token-endpoint answers and records each request's form.
let calls: { url: string; form: URLSearchParams }[] = [];
let answers: { status: number; body: unknown }[] = [];
const realFetch = globalThis.fetch;
let dir: string;

beforeEach(() => {
  calls = [];
  answers = [];
  dir = mkdtempSync(join(tmpdir(), 'sm-auth-'));
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, form: new URLSearchParams(init.body as URLSearchParams) });
    const a = answers.shift();
    if (!a) throw new Error('unexpected fetch');
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const make = (file = join(dir, 'tok.json')) => ({ file, auth: new DelegatedAuth({ tenantId: 't', clientId: 'c', tokenFile: file }) });
const saved = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

test('no token file: a clear "run npm run login" error', async () => {
  const { auth } = make();
  assert.throws(() => auth.identity(), /npm run login/);
  await assert.rejects(auth.accessToken(), /npm run login/);
});

test('a fresh access token is used without calling Entra', async () => {
  const { file, auth } = make();
  writeFileSync(file, JSON.stringify({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 3600_000, name: 'Ann' }));
  assert.equal(await auth.accessToken(), 'A1');
  assert.equal(calls.length, 0);
  assert.equal(auth.identity().name, 'Ann');
});

test('an expiring token is refreshed; the rotated refresh token is saved privately; identity is kept', async () => {
  const { file, auth } = make();
  writeFileSync(file, JSON.stringify({ accessToken: 'A1', refreshToken: 'R1', expiresAt: Date.now() + 10_000, oid: 'o1', name: 'Ann' }));
  answers.push({ status: 200, body: { access_token: 'A2', refresh_token: 'R2', expires_in: 3600 } });
  assert.equal(await auth.accessToken(), 'A2');
  assert.equal(calls[0].url, 'https://login.microsoftonline.com/t/oauth2/v2.0/token');
  assert.equal(calls[0].form.get('grant_type'), 'refresh_token');
  assert.equal(calls[0].form.get('refresh_token'), 'R1');
  assert.equal(calls[0].form.get('client_secret'), null);
  const s = saved(file);
  assert.equal(s.refreshToken, 'R2');
  assert.equal(s.oid, 'o1');
  assert.equal(s.name, 'Ann');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a revoked sign-in says to log in again', async () => {
  const { file, auth } = make();
  writeFileSync(file, JSON.stringify({ accessToken: 'A1', refreshToken: 'R1', expiresAt: 0 }));
  answers.push({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'AADSTS70043: The refresh token has expired.\r\nTrace ID: 123' },
  });
  await assert.rejects(auth.accessToken(), (err: Error) => {
    assert.match(err.message, /AADSTS70043: The refresh token has expired\..*npm run login/);
    assert.doesNotMatch(err.message, /Trace ID/);
    return true;
  });
});

test('device code login waits through authorization_pending, then saves tokens and identity', async () => {
  const { file, auth } = make();
  answers.push(
    { status: 200, body: { device_code: 'D', user_code: 'U', message: 'go to the page', expires_in: 60, interval: 0 } },
    { status: 400, body: { error: 'authorization_pending' } },
    {
      status: 200,
      body: {
        access_token: 'A',
        refresh_token: 'R',
        expires_in: 3600,
        id_token: idToken({ oid: 'o1', name: 'Ann Example', preferred_username: 'ann@example.com' }),
      },
    },
  );
  const shown: string[] = [];
  const who = await auth.login((m) => shown.push(m));
  assert.deepEqual(shown, ['go to the page']);
  assert.deepEqual(who, { oid: 'o1', name: 'Ann Example', username: 'ann@example.com' });
  assert.match(calls[0].form.get('scope')!, /Presence\.Read offline_access/);
  assert.equal(calls[2].form.get('device_code'), 'D');
  assert.equal(saved(file).refreshToken, 'R');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a confidential app registration gets a hint about public client flows', async () => {
  const { auth } = make();
  answers.push(
    { status: 200, body: { device_code: 'D', message: 'm', expires_in: 60, interval: 0 } },
    { status: 401, body: { error: 'invalid_client', error_description: "AADSTS7000218: The request body must contain 'client_assertion' or 'client_secret'." } },
  );
  await assert.rejects(auth.login(() => {}), /Allow public client flows/);
});
