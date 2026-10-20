import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './app.js';
import { sessionXp, type SessionResult } from '../shared/types.js';

type App = Awaited<ReturnType<typeof createApp>>;
const apps: App[] = [];
const dirs: string[] = [];
async function setup(dbPath = ':memory:') {
  const app = await createApp({ dbPath, serveStatic: false });
  apps.push(app);
  return app;
}
const result = (overrides: Partial<SessionResult> = {}): SessionResult => ({
  id: 'result-1', createdAt: '1990-01-01T00:00:00.000Z', mode: 'words', language: 'en', difficulty: 'easy',
  durationMs: 30000, correct: 120, errors: 2, maxCombo: 60, score: 1200,
  xp: 999999, cpm: 999999, wpm: 999999, accuracy: 100,
  mistakes: [{ expected: 'a', count: 2 }], ...overrides,
});
async function register(app: App, email = 'Ada@Example.com', name = email.trim().split('@')[0]) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name, email, password: 'strong-password' } });
  expect(response.statusCode).toBe(201);
  return { cookie: response.headers['set-cookie']!.toString().split(';')[0]!, response };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('authentication and security', () => {
  it('registers normalized users, authenticates, hides credentials and invalidates logout', async () => {
    const app = await setup();
    expect((await app.inject('/api/health')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/api/me')).json()).toEqual({ user: null });
    expect((await app.inject('/api/profile')).statusCode).toBe(401);
    const { cookie, response } = await register(app, '  Ada@Example.com  ');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    expect(response.json().user).toEqual(expect.objectContaining({ email: 'ada@example.com', name: 'Ada', xp: 0, sessions: [] }));
    expect(response.body).not.toContain('password');
    expect((await app.inject({ url: '/api/profile', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json()).toEqual({ user: null });
    const invalid = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ada@example.com', password: 'wrong-password' } });
    expect(invalid.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ADA@example.com', password: 'strong-password' } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toBeDefined();
  });
  it('validates registration and rate limits login', async () => {
    const app = await setup();
    for (const payload of [ { name: 'A', email: 'a@example.com', password: 'password1' }, { name: 'Ada', email: 'bad', password: 'password1' }, { name: 'Ada', email: 'a@example.com', password: 'short' } ]) {
      expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload })).statusCode).toBe(400);
    }
    for (let i = 0; i < 10; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'missing@example.com', password: 'password1' } });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'missing@example.com', password: 'password1' } })).statusCode).toBe(429);
  });
  it('uses secure cookies and configured origins in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ORIGIN', 'https://typing.example');
    const app = await setup();
    const { response } = await register(app);
    expect(response.headers['set-cookie']).toContain('Secure');
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost:5173' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://typing.example' } })).statusCode).toBe(200);
  });
  it('blocks hostile unsafe origins without blocking own or dev origin', async () => {
    const app = await setup();
    const payload = { email: 'a@example.com', password: 'password1' };
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload, headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'null' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost:80', host: 'localhost:80' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'http://localhost:5173' } })).statusCode).toBe(200);
  });
});

describe('session persistence and integrity', () => {
  it('recomputes results, saves exactly once and rejects another user id collision', async () => {
    const app = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: result() })).statusCode).toBe(401);
    const first = await register(app);
    const submit = () => app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie: first.cookie }, payload: result() });
    const saved = (await submit()).json().user;
    expect(saved.sessions).toHaveLength(1);
    const canonical = saved.sessions[0];
    expect(canonical.cpm).toBe(240);
    expect(canonical.wpm).toBe(48);
    expect(canonical.score).toBe(1200);
    expect(canonical.accuracy).toBe(98.36);
    expect(canonical.xp).toBe(sessionXp(120, 98.36, 60));
    expect(saved.xp).toBe(canonical.xp);
    expect(canonical.createdAt).not.toBe(result().createdAt);
    expect((await submit()).json().user).toEqual(saved);
    const other = await register(app, 'other@example.com');
    expect((await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie: other.cookie }, payload: result() })).statusCode).toBe(409);
  });
  it('preserves client game scores within the inclusive zero-to-100-per-correct bound', async () => {
    const app = await setup();
    const { cookie } = await register(app);
    for (const score of [0, 12000]) {
      const response = await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie }, payload: result({ id: `score-${score}`, score }) });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.sessions.find((session: SessionResult) => session.id === `score-${score}`).score).toBe(score);
    }
  });
  it('rejects malformed or physically unreasonable sessions', async () => {
    const app = await setup();
    const { cookie } = await register(app);
    const invalid: Partial<SessionResult>[] = [
      { durationMs: 999 }, { durationMs: 125001 }, { correct: -1 }, { correct: 1.5 }, { correct: 1251, durationMs: 30000 },
      { errors: 10000 }, { errors: 1 }, { maxCombo: 121 }, { mistakes: [] }, { mistakes: [{ expected: 'a', count: 0 }] },
      { score: -1 }, { score: 12001 }, { score: 1.5 }, { score: Number.MAX_SAFE_INTEGER + 1 },
      { mistakes: [{ expected: 'a', count: 1 }, { expected: 'a', count: 1 }] }, { id: '../../bad' },
    ];
    for (const override of invalid) expect((await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie }, payload: result(override) })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/profile', headers: { cookie } })).json().user.xp).toBe(0);
  });
  it('returns only the latest 500 sessions while preserving total lifetime XP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hero-history-')); dirs.push(dir);
    const path = join(dir, 'test.sqlite');
    const app = await setup(path);
    const { cookie, response } = await register(app);
    const userId = response.json().user.id as string;
    const db = new DatabaseSync(path);
    const insert = db.prepare('INSERT INTO sessions (id, user_id, created_at, duration_ms, correct, cpm, accuracy, xp, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 501; i++) {
      const data = result({ id: `history-${i}`, createdAt: new Date(i * 1000).toISOString(), xp: 100 });
      insert.run(data.id, userId, i * 1000, data.durationMs, data.correct, 240, 98.36, 100, JSON.stringify(data));
    }
    db.prepare('UPDATE users SET xp = 50100 WHERE id = ?').run(userId);
    db.exec('COMMIT'); db.close();
    const profile = (await app.inject({ url: '/api/profile', headers: { cookie } })).json().user;
    expect(profile.xp).toBe(50100);
    expect(profile.sessions).toHaveLength(500);
    expect(profile.sessions[0].id).toBe('history-500');
    expect(profile.sessions[499].id).toBe('history-1');
    expect((await app.inject('/api/leaderboard?period=today')).json().entries).toEqual([]);
    expect((await app.inject('/api/leaderboard?period=week')).json().entries).toEqual([]);
    expect((await app.inject('/api/leaderboard?period=all&metric=xp')).json().entries[0].xp).toBe(50100);
  });
  it('persists users and hashed auth sessions across app instances and expires auth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hero-api-')); dirs.push(dir);
    const path = join(dir, 'test.sqlite');
    const app = await setup(path);
    const { cookie } = await register(app);
    await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie }, payload: result() });
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const reopened = await setup(path);
    expect((await reopened.inject({ url: '/api/profile', headers: { cookie } })).json().user.sessions).toHaveLength(1);
    const db = new DatabaseSync(path);
    const auth = db.prepare('SELECT token_hash FROM auth_sessions').get() as { token_hash: string };
    expect(auth.token_hash).not.toBe(cookie.split('=')[1]);
    const user = db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(user.password_hash).not.toContain('strong-password');
    db.prepare('UPDATE auth_sessions SET expires_at = 0').run(); db.close();
    expect((await reopened.inject({ url: '/api/me', headers: { cookie } })).json()).toEqual({ user: null });
  });
});

describe('leaderboards', () => {
  it('starts empty, requires eligibility, ranks real sessions and validates filters', async () => {
    const app = await setup();
    expect((await app.inject('/api/leaderboard')).json().entries).toEqual([]);
    const { cookie } = await register(app);
    const post = (data: SessionResult) => app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie }, payload: data });
    await post(result({ id: 'short', durationMs: 10000 }));
    await post(result({ id: 'few', correct: 19, maxCombo: 10 }));
    expect((await app.inject('/api/leaderboard')).json().entries).toEqual([]);
    await post(result());
    await post(result({ id: 'perfect', correct: 80, errors: 0, mistakes: [], maxCombo: 80 }));
    const fastest = (await app.inject('/api/leaderboard?metric=cpm&period=all')).json().entries[0];
    expect(fastest).toMatchObject({ name: 'Ada', cpm: 240, accuracy: 98.36, sessions: 2 });
    const accurate = (await app.inject('/api/leaderboard?metric=accuracy&period=today')).json().entries[0];
    expect(accurate).toMatchObject({ cpm: 160, accuracy: 100, sessions: 2 });
    expect(accurate.xp).toBe(sessionXp(120, 98.36, 60) + sessionXp(80, 100, 80));
    expect((await app.inject('/api/leaderboard?metric=xp&period=week')).json().entries).toHaveLength(1);
    expect((await app.inject('/api/leaderboard?metric=wrong')).statusCode).toBe(400);
    expect((await app.inject('/api/leaderboard?period=wrong')).statusCode).toBe(400);
    expect((await app.inject('/api/does-not-exist')).statusCode).toBe(404);
  });
});
