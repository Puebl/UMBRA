import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createApp } from './app.js';
import type { MailSender } from './mail.js';

type App = Awaited<ReturnType<typeof createApp>>;
const apps: App[] = [];
const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const oldPassword = 'old-password-123';
const newPassword = 'new-password-123';
const email = 'ada@example.com';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function temporaryDb() {
  const dir = mkdtempSync(join(tmpdir(), 'umbra-reset-'));
  dirs.push(dir);
  return join(dir, 'test.sqlite');
}
async function setup(path = ':memory:', senderOverride?: MailSender) {
  let time = 1_800_000_000_000;
  const messages: { to: string; url: string; expiresAt: number }[] = [];
  const sender: MailSender = senderOverride ?? { async send(message) { messages.push(message); } };
  const app = await createApp({ dbPath: path, serveStatic: false, recovery: { origin: 'https://typing.example', sender }, clock: () => time });
  apps.push(app);
  return { app, messages, advance: (ms: number) => { time += ms; }, token: () => messages.at(-1)!.url.split('=')[1]! };
}
async function register(app: App, address = email, name = 'Ada') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name, email: address, password: oldPassword } });
  expect(response.statusCode).toBe(201);
  return { user: response.json().user, cookie: response.headers['set-cookie']!.toString().split(';')[0]! };
}
const forgot = (app: App, address = email, ip = '127.0.0.1') => app.inject({ method: 'POST', url: '/api/auth/forgot-password', remoteAddress: ip, payload: { email: address } });
const reset = (app: App, token: string, cookie?: string, password = newPassword) => app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password }, headers: cookie ? { cookie } : {} });
const login = (app: App, password: string, address = email) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: address, password } });
async function delivered(state: Awaited<ReturnType<typeof setup>>) {
  expect((await forgot(state.app)).statusCode).toBe(200);
  await tick();
  expect(state.messages).toHaveLength(1);
  return state.token();
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('recovery mailbox policy', () => {
  it.each([
    'ada,attacker@example.com', 'ada@example.com,attacker@example.com',
    'ada;attacker@example.com', 'Group:ada@example.com;',
    'Ada<ada@example.com>', '<ada@example.com>', 'ada(comment)@example.com',
    '"ada"@example.com', 'ada\\attacker@example.com', '[ada]@example.com',
    'ada\0@example.com', 'ada\u0085@example.com', 'ada\u0001@example.com',
    'ada@example.com\r\nBcc:attacker@example.com',
  ])('rejects unsafe registration and recovery without sending: %j', async address => {
    const state = await setup();
    const registration = await state.app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Ada', email: address, password: oldPassword } });
    expect(registration.statusCode).toBe(400);
    const response = await forgot(state.app, address);
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_EMAIL');
    await tick();
    expect(state.messages).toEqual([]);
  });
  it.each(['Ada+drill@Example.com', 'Пользователь@Пример.РФ', '用户@例子.中国', 'élève+réinitialisation@exemple.fr'])(
    'keeps registration, normalization and recovery compatible for %s', async address => {
      const state = await setup();
      const { user } = await register(state.app, `  ${address}  `);
      expect(user.email).toBe(address.toLowerCase());
      expect((await forgot(state.app, `  ${address.toUpperCase()}  `)).statusCode).toBe(200);
      await tick();
      expect(state.messages.map(message => message.to)).toEqual([user.email]);
      expect((await reset(state.app, state.token())).statusCode).toBe(200);
      expect((await login(state.app, newPassword, address)).statusCode).toBe(200);
    },
  );
  it('preserves legacy login and stored addresses without accepting unsafe recovery', async () => {
    const path = temporaryDb(); const state = await setup(path);
    const { user } = await register(state.app);
    const db = new DatabaseSync(path); dbs.push(db);
    const address = 'ada,legacy@example.com';
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(address, user.id);
    const response = await login(state.app, oldPassword, `  ${address.toUpperCase()}  `);
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: user.id, email: address });
    expect((await forgot(state.app, address)).json().code).toBe('INVALID_EMAIL');
    await tick();
    expect(state.messages).toEqual([]);
    expect(db.prepare('SELECT email FROM users WHERE id = ?').get(user.id)).toEqual({ email: address });
  });
});

describe('password recovery API', () => {
  it('preserves identity, nickname key, XP and history; revokes all sessions and links', async () => {
    const path = temporaryDb();
    const state = await setup(path);
    const { app } = state;
    const first = await register(app);
    const second = await login(app, oldPassword);
    const secondCookie = second.headers['set-cookie']!.toString().split(';')[0]!;
    const db = new DatabaseSync(path); dbs.push(db);
    const id = first.user.id as string;
    db.prepare('UPDATE users SET xp = 345 WHERE id = ?').run(id);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('history', id, 1, 1000, 1, 60, 100, 345, JSON.stringify({ id: 'history', xp: 345 }));
    const before = db.prepare('SELECT id, name, name_key, email, xp, created_at FROM users WHERE id = ?').get(id);
    const token = await delivered(state);
    state.advance(60_000);
    expect((await forgot(app)).statusCode).toBe(200); await tick();
    const later = state.token();
    const response = await reset(app, token, first.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect(db.prepare('SELECT id, name, name_key, email, xp, created_at FROM users WHERE id = ?').get(id)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) n FROM sessions').get()).toEqual({ n: 1 });
    for (const cookie of [first.cookie, secondCookie]) expect((await app.inject({ url: '/api/me', headers: { cookie } })).json()).toEqual({ user: null });
    expect((await login(app, oldPassword)).statusCode).toBe(401);
    const logged = await login(app, newPassword);
    expect(logged.statusCode).toBe(200);
    expect(logged.json().user).toMatchObject({ id, xp: 345, sessions: [{ id: 'history', xp: 345 }] });
    for (const invalid of [token, later, 'x', 'a'.repeat(64)]) expect((await reset(app, invalid)).json().code).toBe('RESET_LINK_INVALID');
  });
  it('returns identical known/unknown responses, normalizes emails and applies cooldown equally', async () => {
    const state = await setup(); await register(state.app);
    const known = await forgot(state.app, '  ADA@EXAMPLE.COM  ');
    const unknown = await forgot(state.app, 'missing@example.com');
    expect(known.statusCode).toBe(200); expect(unknown.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
    expect(known.headers['cache-control']).toBe('no-store');
    await tick();
    expect(state.messages.map(message => message.to)).toEqual([email]);
    expect((await forgot(state.app)).json().code).toBe('RECOVERY_RATE_LIMITED');
    expect((await forgot(state.app, ' MISSING@example.com ')).json().code).toBe('RECOVERY_RATE_LIMITED');
    state.advance(60_000);
    expect((await forgot(state.app)).statusCode).toBe(200);
  });
  it('uses hash-only persistent tokens and rejects TTL boundary after restart', async () => {
    const path = temporaryDb(); const state = await setup(path); await register(state.app);
    const token = await delivered(state);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const db = new DatabaseSync(path); dbs.push(db);
    const stored = db.prepare('SELECT * FROM password_reset_tokens').get()!;
    expect(stored.token_hash).toBe(hash(token)); expect(JSON.stringify(stored)).not.toContain(token);
    await state.app.close(); apps.splice(apps.indexOf(state.app), 1);
    const next = await setup(path);
    expect((await reset(next.app, token)).statusCode).toBe(200);
    const state2 = await setup(); await register(state2.app); const token2 = await delivered(state2);
    state2.advance(30 * 60_000);
    const expired = await reset(state2.app, token2);
    const unknown = await reset(state2.app, '0'.repeat(64));
    expect(expired.body).toBe(unknown.body); expect(expired.statusCode).toBe(400);
  });
  it('preserves unrelated cookie and account while resetting the target', async () => {
    const state = await setup(); await register(state.app);
    const other = await register(state.app, 'other@example.com', 'Other');
    const token = await delivered(state);
    const response = await reset(state.app, token, other.cookie);
    expect(response.statusCode).toBe(200); expect(response.headers['set-cookie']).toBeUndefined();
    expect((await state.app.inject({ url: '/api/me', headers: { cookie: other.cookie } })).json().user.id).toBe(other.user.id);
  });
  for (const sameConnection of [false, true]) for (const different of [false, true]) it(`allows exactly one concurrent reset (same connection: ${sameConnection}, different tokens: ${different})`, async () => {
    const path = temporaryDb(); const state = await setup(path); await register(state.app);
    const first = await delivered(state);
    let second = first;
    if (different) { state.advance(60_000); await forgot(state.app); await tick(); second = state.token(); }
    const peer = sameConnection ? state : await setup(path);
    const results = await Promise.all([reset(state.app, first), reset(peer.app, second)]);
    expect(results.map(response => response.statusCode).sort()).toEqual([200, 400]);
    expect(results.find(response => response.statusCode === 400)!.json().code).toBe('RESET_LINK_INVALID');
  });
  it('rechecks expiry after asynchronous password hashing before modifying anything', async () => {
    const path = temporaryDb(); const state = await setup(path); const account = await register(state.app);
    const token = await delivered(state);
    let time = 1_800_000_000_000;
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const peer = await createApp({ dbPath: path, clock: () => time,
      recovery: { origin: 'https://typing.example', sender: { async send() {} } },
      passwordHasher: {
        async hash() { entered(); await gate; return 'must-not-be-written'; },
        async verify() { return false; },
      },
    });
    apps.push(peer);
    const pending = reset(peer, token).then(response => response);
    await started; time += 30 * 60_000; release();
    expect((await pending).json().code).toBe('RESET_LINK_INVALID');
    expect((await login(state.app, oldPassword)).statusCode).toBe(200);
    expect((await state.app.inject({ url: '/api/me', headers: { cookie: account.cookie } })).json().user.id).toBe(account.user.id);
  });
  it('rejects login verified against a stale password after a reset commits', async () => {
    const path = temporaryDb(); const state = await setup(path); await register(state.app);
    const token = await delivered(state);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const peer = await createApp({ dbPath: path, recovery: null, passwordHasher: {
      async hash() { throw new Error('Not used by this login test'); },
      async verify() { entered(); await gate; return true; },
    } });
    apps.push(peer);
    const pending = login(peer, oldPassword).then(response => response);
    await started;
    expect((await reset(state.app, token)).statusCode).toBe(200);
    release();
    const response = await pending;
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await login(state.app, newPassword)).statusCode).toBe(200);
  });
  it('rolls back password, sessions and tokens if any atomic write fails', async () => {
    const path = temporaryDb(); const state = await setup(path); const account = await register(state.app);
    const token = await delivered(state); const db = new DatabaseSync(path); dbs.push(db);
    db.exec("CREATE TRIGGER fail_reset BEFORE DELETE ON password_reset_tokens BEGIN SELECT RAISE(ABORT, 'forced'); END");
    expect((await reset(state.app, token)).statusCode).toBe(500);
    expect((await state.app.inject({ url: '/api/me', headers: { cookie: account.cookie } })).json().user.id).toBe(account.user.id);
    expect((await login(state.app, oldPassword)).statusCode).toBe(200);
    db.exec('DROP TRIGGER fail_reset');
    expect((await reset(state.app, token)).statusCode).toBe(200);
  });
  it('validates input, enforces independent limits and origin protection', async () => {
    const state = await setup();
    expect((await forgot(state.app, 'bad')).json().code).toBe('INVALID_EMAIL');
    const invalid = await reset(state.app, 'bad', undefined, 'short');
    expect(invalid.json().code).toBe('INVALID_PASSWORD');
    const hostile = await state.app.inject({ method: 'POST', url: '/api/auth/forgot-password', headers: { origin: 'https://evil.example' }, payload: { email } });
    expect(hostile.statusCode).toBe(403);
    for (let i = 0; i < 4; i++) expect((await forgot(state.app, `unknown${i}@example.com`)).statusCode).toBe(200);
    expect((await forgot(state.app, 'last@example.com')).json().code).toBe('RECOVERY_RATE_LIMITED');
    for (let i = 0; i < 9; i++) expect((await reset(state.app, 'bad')).statusCode).toBe(400);
    expect((await reset(state.app, 'bad')).json().code).toBe('RECOVERY_RATE_LIMITED');
    state.advance(15 * 60_000);
    expect((await forgot(state.app)).statusCode).toBe(200);
  });
  it('disables recovery explicitly without faking delivery', async () => {
    const app = await createApp({ dbPath: ':memory:', recovery: null }); apps.push(app);
    for (const address of [email, 'unknown@example.com']) expect((await forgot(app, address)).json().code).toBe('RECOVERY_UNAVAILABLE');
    expect((await reset(app, 'bad')).statusCode).toBe(503);
  });
  it('bounds the delivery queue uniformly for known and unknown addresses', async () => {
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const state = await setup(':memory:', { async send() { entered(); await gate; } });
    await register(state.app); await register(state.app, 'other@example.com', 'Other');
    expect((await forgot(state.app)).statusCode).toBe(200); await started;
    try {
      for (let i = 0; i < 100; i++) {
        expect((await forgot(state.app, `queued${i}@example.com`, `10.0.0.${i + 1}`)).statusCode).toBe(200);
      }
      const known = await forgot(state.app, 'other@example.com', '10.0.1.1');
      const unknown = await forgot(state.app, 'unknown@example.com', '10.0.1.2');
      expect(known.statusCode).toBe(503); expect(unknown.statusCode).toBe(503);
      expect(known.body).toBe(unknown.body);
    } finally { release(); }
  });
  it('does not await transport, handles delivery failure, and waits safely at shutdown', async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let closed = false;
    const state = await setup(':memory:', { async send() { entered(); await blocked; throw new Error('secret must not be logged'); }, close() { closed = true; } });
    await register(state.app);
    expect((await forgot(state.app)).statusCode).toBe(200);
    await enteredPromise;
    expect((await forgot(state.app, 'unknown@example.com')).statusCode).toBe(200);
    const closing = state.app.close();
    await tick(); expect(closed).toBe(false);
    release(); await closing; expect(closed).toBe(true);
  });
  it('creates a WAL-safe backup before migrating a populated database, once', async () => {
    const path = temporaryDb(); const state = await setup(path); await register(state.app);
    await state.app.close(); apps.splice(apps.indexOf(state.app), 1);
    const db = new DatabaseSync(path); dbs.push(db); db.exec('DROP TABLE password_reset_tokens');
    await setup(path);
    const files = readdirSync(join(path, '..')).filter(name => name.includes('before-password-reset-') && name.endsWith('.sqlite'));
    expect(files).toHaveLength(1);
    const saved = new DatabaseSync(join(path, '..', files[0]!)); dbs.push(saved);
    expect(saved.prepare('SELECT email FROM users').get()).toEqual({ email });
    expect(saved.prepare("SELECT name FROM sqlite_master WHERE name='password_reset_tokens'").get()).toBeUndefined();
    await setup(path);
    expect(readdirSync(join(path, '..')).filter(name => name.includes('before-password-reset-') && name.endsWith('.sqlite'))).toEqual(files);
  });
});
