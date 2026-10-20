import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AVATAR_IDS, type Profile, type SessionResult } from '../shared/types.js';
import { createApp } from './app.js';
import { migrateProfile } from './profile-migration.js';

type App = Awaited<ReturnType<typeof createApp>>;
const apps: App[] = [];
const dirs: string[] = [];
const password = 'strong-password';
const token = 'a'.repeat(64);
const defaults = { avatar: 'initials', interfaceLanguage: 'ru', showInLeaderboard: true, profileVersion: 0 };
const training = (id = 'training'): SessionResult => ({
  id, createdAt: '2020-01-01T00:00:00.000Z', mode: 'words', language: 'en', difficulty: 'easy',
  durationMs: 30000, correct: 120, errors: 0, maxCombo: 30, score: 1200, xp: 165,
  cpm: 240, wpm: 48, accuracy: 100, mistakes: [],
});
function temporaryPath() {
  const dir = mkdtempSync(join(tmpdir(), 'hero-profile-')); dirs.push(dir);
  return { dir, path: join(dir, 'test.sqlite') };
}
async function setup(dbPath = ':memory:') {
  const app = await createApp({ dbPath, serveStatic: false, recovery: null });
  apps.push(app);
  return app;
}
async function close(app: App) {
  await app.close(); apps.splice(apps.indexOf(app), 1);
}
async function register(app: App, name = 'Ada', email = 'ada@example.test') {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name, email, password } });
  expect(response.statusCode).toBe(201);
  return { cookie: response.headers['set-cookie']!.toString().split(';')[0]!, user: response.json().user as Profile };
}
const getProfile = async (app: App, cookie: string) => (await app.inject({ url: '/api/profile', headers: { cookie } })).json().user as Profile;
const patch = (app: App, cookie: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({
  method: 'PATCH', url: '/api/profile', headers: { cookie, 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload),
});
function legacyDatabase() {
  const { dir, path } = temporaryPath();
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, correct INTEGER NOT NULL, cpm REAL NOT NULL,
      accuracy REAL NOT NULL, xp INTEGER NOT NULL, result TEXT NOT NULL);
  `);
  const salt = '1'.repeat(32);
  const hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run('legacy-user', 'Герой Ada', 'legacy@example.test', hash, 42, 123);
  db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 'legacy-user', Date.now() + 600_000);
  const result = training('legacy-result');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(result.id, 'legacy-user', Date.parse(result.createdAt), result.durationMs, result.correct, result.cpm, result.accuracy, result.xp, JSON.stringify(result));
  return { db, path, dir, result };
}
function snapshot(db: DatabaseSync) {
  return {
    users: db.prepare('SELECT * FROM users ORDER BY id').all(),
    auth: db.prepare('SELECT * FROM auth_sessions').all(),
    sessions: db.prepare('SELECT * FROM sessions').all(),
  };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('additive profile migration', () => {
  it('backs up committed WAL data and preserves old credentials, cookies, XP and training over repeated startup', async () => {
    const { db, path, dir, result } = legacyDatabase();
    try {
      const before = snapshot(db);
      // Keep the source connection open so committed legacy rows remain in WAL.
      const app = await setup(path);
      expect(await getProfile(app, `hero_session=${token}`)).toMatchObject({ ...defaults, id: 'legacy-user', name: 'Герой Ada', xp: 42, sessions: [result] });
      expect(db.prepare('SELECT id, name, email, password_hash, xp, created_at FROM users').all()).toEqual(before.users);
      expect(db.prepare('SELECT * FROM auth_sessions').all()).toEqual(before.auth);
      expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before.sessions);
      const backups = readdirSync(dir).filter(file => file.includes('.before-profile-') && file.endsWith('.sqlite'));
      expect(backups).toHaveLength(1);
      const saved = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
      try {
        expect(saved.prepare('SELECT id, name, email, password_hash, xp, created_at FROM users').all()).toEqual(before.users);
        expect(saved.prepare('SELECT * FROM auth_sessions').all()).toEqual(before.auth);
        expect(saved.prepare('SELECT * FROM sessions').all()).toEqual(before.sessions);
        expect((saved.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(row => row.name)).not.toContain('avatar');
      } finally { saved.close(); }
      expect((await patch(app, `hero_session=${token}`, { avatar: 'orbit', interfaceLanguage: 'en', showInLeaderboard: false })).statusCode).toBe(200);
      await close(app);
      const reopened = await setup(path);
      expect(await getProfile(reopened, `hero_session=${token}`)).toMatchObject({ avatar: 'orbit', interfaceLanguage: 'en', showInLeaderboard: false, profileVersion: 1, xp: 42, sessions: [result] });
      expect(readdirSync(dir).filter(file => file.includes('.before-profile-') && file.endsWith('.sqlite'))).toHaveLength(1);
      const login = await reopened.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'legacy@example.test', password } });
      expect(login.statusCode).toBe(200);
      expect(login.json().user.avatar).toBe('orbit');
    } finally { db.close(); }
  });

  const definitions = [
    "avatar TEXT NOT NULL DEFAULT 'initials'",
    "interface_language TEXT NOT NULL DEFAULT 'ru'",
    'show_in_leaderboard INTEGER NOT NULL DEFAULT 1',
    'profile_version INTEGER NOT NULL DEFAULT 0',
  ];
  it.each(Array.from({ length: 16 }, (_, mask) => mask))('completes partial schema subset %i without replacing existing settings, and repeats safely', async mask => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users VALUES ('one', 'Ada');");
      for (const [index, definition] of definitions.entries()) if (mask & (1 << index)) db.exec(`ALTER TABLE users ADD COLUMN ${definition}`);
      const names = ['avatar', 'interface_language', 'show_in_leaderboard', 'profile_version'];
      const existing = ['crown', 'en', 0, 7];
      for (const [index, name] of names.entries()) if (mask & (1 << index)) db.prepare(`UPDATE users SET ${name} = ?`).run(existing[index]!);
      await migrateProfile(db, ':memory:');
      const expected = Object.fromEntries(names.map((name, index) => [name, mask & (1 << index) ? existing[index] : ['initials', 'ru', 1, 0][index]]));
      expect(db.prepare('SELECT avatar, interface_language, show_in_leaderboard, profile_version FROM users').get()).toEqual(expected);
      const schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      await migrateProfile(db, ':memory:');
      expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
      for (const [name, value] of [['avatar', 'invalid'], ['interface_language', 'de'], ['show_in_leaderboard', 2], ['show_in_leaderboard', 0.5], ['profile_version', -1], ['profile_version', 1.5]]) {
        expect(() => db.prepare(`UPDATE users SET ${name} = ?`).run(value!)).toThrow();
      }
      expect(() => db.exec("INSERT INTO users (id, name, avatar) VALUES ('bad', 'Bad', 'invalid')")).toThrow();
    } finally { db.close(); }
  });

  it('rolls back all newly added columns and keeps every row intact if existing partial settings are invalid', async () => {
    const { db, path, dir } = legacyDatabase();
    try {
      db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT 'initials'; UPDATE users SET avatar = 'broken';");
      const before = snapshot(db);
      const schema = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      await expect(migrateProfile(db, path)).rejects.toThrow(/Profile migration blocked/);
      expect(snapshot(db)).toEqual(before);
      expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
      const backup = readdirSync(dir).find(file => file.includes('.before-profile-'))!;
      const saved = new DatabaseSync(join(dir, backup), { readOnly: true });
      try { expect(snapshot(saved)).toEqual(before); } finally { saved.close(); }
      db.exec("UPDATE users SET avatar = 'shield';");
      await migrateProfile(db, path);
      expect(db.prepare('SELECT avatar, profile_version FROM users').get()).toEqual({ avatar: 'shield', profile_version: 0 });
    } finally { db.close(); }
  });

  it('rechecks the schema after independent connections race the backed-up migration', async () => {
    const { db, path } = legacyDatabase();
    const second = new DatabaseSync(path);
    try {
      await Promise.all([migrateProfile(db, path), migrateProfile(second, path)]);
      expect(db.prepare('SELECT avatar, profile_version FROM users').get()).toEqual({ avatar: 'initials', profile_version: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'users_profile_%'").get()).toEqual({ count: 2 });
    } finally { second.close(); db.close(); }
  });

  it('initializes fresh databases with defaults and database-level settings constraints', async () => {
    const { path, dir } = temporaryPath();
    const app = await setup(path);
    const { user } = await register(app);
    expect(user).toMatchObject(defaults);
    expect(readdirSync(dir).some(file => file.includes('.before-profile-'))).toBe(false);
    const db = new DatabaseSync(path);
    try {
      for (const name of ['avatar', 'interface_language', 'show_in_leaderboard', 'profile_version']) expect(() => db.exec(`UPDATE users SET ${name} = NULL`)).toThrow();
      for (const [name, value] of [['avatar', 'x'], ['interface_language', 'EN'], ['show_in_leaderboard', -1], ['show_in_leaderboard', 'true'], ['profile_version', -1], ['profile_version', 0.25], ['profile_version', 'bad']]) {
        expect(() => db.prepare(`UPDATE users SET ${name} = ?`).run(value!)).toThrow();
      }
    } finally { db.close(); }
  });
});

describe('PATCH /api/profile', () => {
  it('requires a live cookie and applies the existing unsafe-origin guard before writes', async () => {
    const app = await setup();
    const { cookie, user } = await register(app);
    for (const invalidCookie of ['', 'hero_session=invalid', `hero_session=${'b'.repeat(64)}`]) expect((await patch(app, invalidCookie, { avatar: 'bolt' })).statusCode).toBe(401);
    const hostileHeaders: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of hostileHeaders) {
      expect((await patch(app, cookie, { avatar: 'bolt' }, headers)).statusCode).toBe(403);
    }
    expect(await getProfile(app, cookie)).toEqual(user);
    expect((await patch(app, cookie, { avatar: 'bolt' }, { origin: 'http://localhost:80', host: 'localhost:80' })).statusCode).toBe(200);
    expect((await patch(app, cookie, { interfaceLanguage: 'en' }, { origin: 'http://localhost:5173' })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await patch(app, cookie, { avatar: 'crown' })).statusCode).toBe(401);
  });

  it('rejects expired auth and production cross-origin dev requests without mutation', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('APP_ORIGIN', 'https://typing.example');
    const { path } = temporaryPath();
    const app = await setup(path);
    const { cookie } = await register(app);
    expect((await patch(app, cookie, { avatar: 'orbit' }, { origin: 'http://localhost:5173' })).statusCode).toBe(403);
    expect((await patch(app, cookie, { avatar: 'orbit' }, { origin: 'https://typing.example' })).statusCode).toBe(200);
    const db = new DatabaseSync(path);
    try { db.exec('UPDATE auth_sessions SET expires_at = 0'); } finally { db.close(); }
    expect((await patch(app, cookie, { avatar: 'flame' })).statusCode).toBe(401);
  });

  it('strictly rejects empty, malformed, unknown and protected settings with no partial updates', async () => {
    const app = await setup();
    const { cookie, user } = await register(app);
    const invalid: unknown[] = [null, [], ['name'], 'Ada', 12, true, {},
      { name: null }, { name: 1 }, { name: 'A' }, { name: ' '.repeat(4) }, { name: 'x'.repeat(33) }, { name: 'Ada\n' }, { name: 'A​da' }, { name: 'A‮da' },
      { avatar: null }, { avatar: 'url:https://example.test' }, { avatar: 'Initials' }, { avatar: {} },
      { interfaceLanguage: null }, { interfaceLanguage: 'de' }, { interfaceLanguage: 'EN' },
      { showInLeaderboard: 1 }, { showInLeaderboard: 'false' }, { showInLeaderboard: null },
      { name: 'Changed', avatar: 'invalid' },
    ];
    for (const field of ['id', 'email', 'xp', 'sessions', 'profileVersion', 'profile_version', 'name_key', 'password', 'password_hash', 'created_at', 'interface_language', 'show_in_leaderboard', 'unknown', '__proto__', 'constructor']) {
      invalid.push({ avatar: 'crown', [field]: 'protected' });
    }
    for (const payload of invalid) {
      const response = await patch(app, cookie, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(await getProfile(app, cookie)).toEqual(user);
    const malformed = await app.inject({ method: 'PATCH', url: '/api/profile', headers: { cookie, 'content-type': 'application/json' }, payload: '{' });
    expect(malformed.statusCode).toBe(400);
  });

  it('returns the complete private profile, accepts every fixed avatar and bumps version only for accepted writes', async () => {
    const app = await setup();
    const { cookie, user } = await register(app);
    expect(user).toMatchObject(defaults);
    let version = 0;
    for (const avatar of AVATAR_IDS) {
      const response = await patch(app, cookie, { avatar });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ user: { ...user, avatar, profileVersion: ++version } });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const response = await patch(app, cookie, { name: '  Герой Ada  ', avatar: 'shield', interfaceLanguage: 'en', showInLeaderboard: false });
    expect(response.json().user).toMatchObject({ name: 'Герой Ada', avatar: 'shield', interfaceLanguage: 'en', showInLeaderboard: false, profileVersion: ++version, email: user.email, xp: 0, sessions: [] });
    expect(response.body).not.toContain('password');
    expect(response.body).not.toContain('name_key');
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().user).toEqual(response.json().user);
    expect((await patch(app, cookie, { interfaceLanguage: 'ru', showInLeaderboard: true })).json().user).toMatchObject({ interfaceLanguage: 'ru', showInLeaderboard: true, profileVersion: ++version });
  });

  it('allows own name, casing and canonical Unicode but rejects another owner with an atomic conflict', async () => {
    const app = await setup();
    const first = await register(app, 'Café');
    const second = await register(app, 'Герой Ada', 'second@example.test');
    expect((await patch(app, first.cookie, { name: 'Café' })).json().user.profileVersion).toBe(1);
    expect((await patch(app, first.cookie, { name: '  CAFÉ  ' })).json().user).toMatchObject({ name: 'CAFÉ', profileVersion: 2 });
    const before = await getProfile(app, first.cookie);
    for (const name of ['герой ada', 'ГЕРОЙ Ａｄａ', '  Герой Ada  ']) {
      const response = await patch(app, first.cookie, { name, avatar: 'crown', interfaceLanguage: 'en', showInLeaderboard: false });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('NICKNAME_TAKEN');
      expect(response.body).not.toContain('second@example.test');
      expect(await getProfile(app, first.cookie)).toEqual(before);
    }
    const conflict = await patch(app, second.cookie, { name: 'café' });
    expect(conflict.statusCode).toBe(409);
    expect((await patch(app, first.cookie, { name: 'New Hero' })).statusCode).toBe(200);
    expect((await patch(app, second.cookie, { name: 'café' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'NEW HERO', email: 'third@example.test', password } })).json().code).toBe('NICKNAME_TAKEN');
  });

  it('reserves concurrent renames once and keeps the losing settings and version unchanged', async () => {
    const app = await setup();
    const first = await register(app);
    const second = await register(app, 'Grace', 'second@example.test');
    const responses = await Promise.all([patch(app, first.cookie, { name: 'Shared Hero', avatar: 'bolt' }), patch(app, second.cookie, { name: 'ＳＨＡＲＥＤ HERO', avatar: 'flame' })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const loser = responses[0].statusCode === 409 ? first : second;
    expect(await getProfile(app, loser.cookie)).toEqual(loser.user);
    await Promise.all([patch(app, first.cookie, { avatar: 'orbit' }), patch(app, first.cookie, { interfaceLanguage: 'en' })]);
    expect(await getProfile(app, first.cookie)).toMatchObject({ avatar: 'orbit', interfaceLanguage: 'en' });
  });

  it('persists settings and normalized nickname across restart without rotating auth, changing XP or rewriting results', async () => {
    const { path } = temporaryPath();
    const app = await setup(path);
    const { cookie, user } = await register(app);
    const saved = await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie }, payload: training() });
    const before = saved.json().user as Profile;
    const changed = await patch(app, cookie, { name: 'Renamed Hero', avatar: 'flame', interfaceLanguage: 'en', showInLeaderboard: false });
    expect(changed.json().user).toMatchObject({ id: user.id, email: user.email, xp: before.xp, sessions: before.sessions, profileVersion: 1 });
    await close(app);
    const reopened = await setup(path);
    expect(await getProfile(reopened, cookie)).toEqual(changed.json().user);
    const login = await reopened.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password } });
    expect(login.json().user).toEqual(changed.json().user);
    const db = new DatabaseSync(path);
    try { expect(db.prepare('SELECT name_key FROM users').get()).toEqual({ name_key: 'renamed hero' }); } finally { db.close(); }
  });
});

describe('leaderboard profile privacy', () => {
  it('filters hidden users for all nine period/metric combinations, keeps training and restores historical entries without private fields', async () => {
    const app = await setup();
    const hidden = await register(app, 'Private Hero', 'private@example.test');
    const visible = await register(app, 'Visible Hero', 'visible@example.test');
    for (const [index, account] of [hidden, visible].entries()) {
      for (let session = 0; session < 2; session++) expect((await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie: account.cookie }, payload: training(`result-${index}-${session}`) })).statusCode).toBe(200);
    }
    await patch(app, hidden.cookie, { avatar: 'crown', interfaceLanguage: 'en' });
    await patch(app, visible.cookie, { avatar: 'orbit' });
    const combinations = ['today', 'week', 'all'].flatMap(period => ['cpm', 'accuracy', 'xp'].map(metric => `/api/leaderboard?period=${period}&metric=${metric}`));
    const publicKeys = ['userId', 'name', 'avatar', 'cpm', 'accuracy', 'xp', 'sessions'].sort();
    for (const url of combinations) {
      const response = await app.inject(url);
      expect(response.json().entries).toHaveLength(2);
      expect(response.json().entries.find((entry: { userId: string }) => entry.userId === hidden.user.id)).toMatchObject({ avatar: 'crown', sessions: 2, xp: 330 });
      for (const entry of response.json().entries) expect(Object.keys(entry).sort()).toEqual(publicKeys);
      for (const secret of ['private@example.test', 'visible@example.test', 'interfaceLanguage', 'showInLeaderboard', 'profileVersion', 'password', 'name_key']) expect(response.body).not.toContain(secret);
    }
    const before = await getProfile(app, hidden.cookie);
    expect((await patch(app, hidden.cookie, { showInLeaderboard: false })).statusCode).toBe(200);
    for (const url of combinations) {
      const response = await app.inject(url);
      expect(response.json().entries).toHaveLength(1);
      expect(response.json().entries[0]).toMatchObject({ userId: visible.user.id, avatar: 'orbit', sessions: 2, xp: 330 });
      expect(response.body).not.toContain(hidden.user.id);
      expect(response.body).not.toContain('Private Hero');
    }
    expect(await getProfile(app, hidden.cookie)).toMatchObject({ xp: before.xp, sessions: before.sessions, showInLeaderboard: false });
    const trained = await app.inject({ method: 'POST', url: '/api/sessions', headers: { cookie: hidden.cookie }, payload: training('while-hidden') });
    expect(trained.json().user).toMatchObject({ xp: before.xp + 165, showInLeaderboard: false });
    expect(trained.json().user.sessions).toHaveLength(3);
    expect((await patch(app, hidden.cookie, { showInLeaderboard: true, name: 'Restored Hero', avatar: 'shield' })).statusCode).toBe(200);
    for (const url of combinations) {
      const response = await app.inject(url);
      expect(response.json().entries).toHaveLength(2);
      expect(response.json().entries.find((entry: { userId: string }) => entry.userId === hidden.user.id)).toMatchObject({ name: 'Restored Hero', avatar: 'shield', sessions: 3, xp: 495 });
      for (const entry of response.json().entries) expect(Object.keys(entry).sort()).toEqual(publicKeys);
    }
  });
});
