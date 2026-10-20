import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_IDS, sessionXp, type AvatarId, type InterfaceLanguage, type Profile, type SessionResult, type LeaderboardEntry } from '../shared/types.js';
import { nickname } from '../shared/nickname.js';
import { migrateNicknames } from './nickname-migration.js';
import { migrateProfile } from './profile-migration.js';
import { createMailTransport, type RecoveryMailConfig } from './mail.js';
import { migratePasswordReset, registerPasswordRecovery } from './password-reset.js';
import { safeMailbox } from './email.js';

export interface AppOptions {
  dbPath?: string; logger?: boolean; serveStatic?: boolean;
  recovery?: RecoveryMailConfig | null;
  clock?: () => number;
  /** Trusted embedding/test seam; never controlled by HTTP requests or environment. */
  passwordHasher?: { hash(password: string): Promise<string>; verify(password: string, encoded?: string): Promise<boolean> };
}
type UserRow = {
  id: string; name: string; email: string; password_hash: string; xp: number;
  avatar: AvatarId; interface_language: InterfaceLanguage; show_in_leaderboard: number; profile_version: number;
};
type ResultRow = { user_id: string; result: string };
const COOKIE = 'hero_session';
const SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const derive = (password: string, salt: string) => new Promise<Buffer>((resolveKey, reject) => {
  scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolveKey(key));
});
const dummySalt = '00000000000000000000000000000000';

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await derive(password, salt)).toString('hex')}`;
}
async function verifyPassword(password: string, encoded?: string) {
  const [salt, hash] = encoded?.split(':') ?? [dummySalt, '00'.repeat(64)];
  const actual = await derive(password, salt!);
  const expected = Buffer.from(hash!, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) && Boolean(encoded);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function normalizedEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function recoveryEmail(value: unknown): string | null {
  const email = normalizedEmail(value);
  return email && safeMailbox(email) ? email : null;
}
export const validPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= 128;
function credentials(value: unknown, register: boolean) {
  if (!record(value) || !validPassword(value.password)) return null;
  const email = register ? recoveryEmail(value.email) : normalizedEmail(value.email);
  if (!email) return null;
  const parsed = register ? nickname(value.name) : null;
  if (register && !parsed) return null;
  return { name: parsed?.name ?? '', nameKey: parsed?.key ?? '', email, password: value.password };
}
function canonicalSession(value: unknown): SessionResult | null {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)) return null;
  if (typeof value.mode !== 'string' || !['words', 'sentences', 'code', 'symbols'].includes(value.mode) || typeof value.language !== 'string' || !['ru', 'en'].includes(value.language) || typeof value.difficulty !== 'string' || !['easy', 'medium', 'hard'].includes(value.difficulty)) return null;
  if (!integer(value.durationMs) || value.durationMs < 1000 || value.durationMs > 125000 || !integer(value.correct) || !integer(value.errors) || !integer(value.maxCombo)) return null;
  const { durationMs, correct, errors, maxCombo } = value;
  if (maxCombo > correct || correct * 60000 / durationMs > 2500 || (correct + errors) * 60000 / durationMs > 6000 || !integer(value.score) || value.score > correct * 100) return null;
  if (!Array.isArray(value.mistakes) || value.mistakes.length > 1000) return null;
  const mistakes: SessionResult['mistakes'] = [];
  const seen = new Set<string>();
  let mistakeCount = 0;
  for (const entry of value.mistakes) {
    if (!record(entry) || typeof entry.expected !== 'string' || entry.expected.length < 1 || entry.expected.length > 16 || !integer(entry.count) || entry.count < 1 || entry.count > errors || seen.has(entry.expected)) return null;
    seen.add(entry.expected);
    mistakeCount += entry.count;
    mistakes.push({ expected: entry.expected, count: entry.count });
  }
  if (mistakeCount !== errors) return null;
  const cpm = Math.round(correct * 60000 / durationMs);
  const accuracy = correct + errors ? Math.round(correct / (correct + errors) * 10000) / 100 : 0;
  return {
    id: value.id, createdAt: new Date().toISOString(), mode: value.mode as SessionResult['mode'],
    language: value.language as SessionResult['language'], difficulty: value.difficulty as SessionResult['difficulty'],
    durationMs, correct, errors, maxCombo, score: value.score,
    cpm, wpm: Math.round(correct * 60000 / durationMs / 5), accuracy,
    xp: sessionXp(correct, accuracy, maxCombo), mistakes,
  };
}

/** Each application owns its SQLite connection; closing Fastify closes it too. */
export async function createApp(options: AppOptions = {}) {
  const recovery = options.recovery === undefined ? createMailTransport() : options.recovery;
  const passwords = options.passwordHasher ?? { hash: hashPassword, verify: verifyPassword };
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024, trustProxy: false });
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? resolve('data', 'hero-type.sqlite');
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, correct INTEGER NOT NULL,
      cpm REAL NOT NULL, accuracy REAL NOT NULL, xp INTEGER NOT NULL, result TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_time ON sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_time ON sessions(created_at);
  `);
  try {
    await migrateNicknames(db, dbPath);
    await migrateProfile(db, dbPath);
    await migratePasswordReset(db, dbPath);
  } catch (error) { db.close(); await recovery?.sender.close?.(); throw error; }
  let stopRecovery: (() => Promise<void>) | undefined;
  app.addHook('onClose', async () => {
    try { await stopRecovery?.(); } finally { db.close(); }
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 240, timeWindow: '1 minute' });
  const production = process.env.NODE_ENV === 'production';
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure: production, path: '/' };
  const configuredOrigin = recovery?.origin ?? (process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : undefined);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const origin = request.headers.origin;
    const ownOrigin = `${request.protocol}://${request.host}`;
    const allowed = new Set([ownOrigin, configuredOrigin]);
    if (!production) { allowed.add('http://localhost:5173'); allowed.add('http://127.0.0.1:5173'); }
    if ((origin && !allowed.has(origin)) || (!origin && request.headers['sec-fetch-site'] === 'cross-site')) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = record(error) && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    if (status >= 500) request.log.error('Request failed');
    reply.code(status).send({ error: status === 429 ? 'Too many requests. Please try again later.' : status >= 500 ? 'Internal server error' : 'Invalid request' });
  });
  const findUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const findEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const findName = db.prepare('SELECT id FROM users WHERE name_key = ?');
  const findAuth = db.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?');
  const findResults = db.prepare('SELECT result FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500');
  const findResult = db.prepare('SELECT user_id, result FROM sessions WHERE id = ?');
  const insertResult = db.prepare('INSERT INTO sessions (id, user_id, created_at, duration_ms, correct, cpm, accuracy, xp, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const incrementXp = db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?');
  function currentUser(request: FastifyRequest): UserRow | undefined {
    const token = request.cookies[COOKIE];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    const auth = findAuth.get(tokenHash(token), Date.now()) as { user_id: string } | undefined;
    return auth ? findUser.get(auth.user_id) as UserRow | undefined : undefined;
  }
  function profile(user: UserRow): Profile {
    return {
      id: user.id, name: user.name, email: user.email, xp: user.xp,
      avatar: user.avatar, interfaceLanguage: user.interface_language,
      showInLeaderboard: user.show_in_leaderboard === 1, profileVersion: user.profile_version,
      sessions: (findResults.all(user.id) as { result: string }[]).map(row => JSON.parse(row.result) as SessionResult),
    };
  }
  function issueSession(userId: string, request: FastifyRequest, reply: FastifyReply) {
    if (request.cookies[COOKIE]) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(request.cookies[COOKIE]!));
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_AGE_SECONDS * 1000;
    db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), userId, expiresAt);
    reply.setCookie(COOKIE, token, { ...cookieOptions, maxAge: SESSION_AGE_SECONDS, expires: new Date(expiresAt) });
  }
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/me', async request => {
    const user = currentUser(request);
    return { user: user ? profile(user) : null };
  });
  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const input = credentials(request.body, true);
    if (!input) return reply.code(400).send({ error: 'Enter a nickname (2–32 characters, no control or formatting characters), a valid email and a password (8–128 characters)' });
    const passwordHash = await passwords.hash(input.password);
    const id = randomUUID();
    try {
      db.prepare('INSERT INTO users (id, name, name_key, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.name, input.nameKey, input.email, passwordHash, Date.now());
    } catch (error) {
      if (findEmail.get(input.email)) return reply.code(409).send({ error: 'Unable to register with these details' });
      if (findName.get(input.nameKey)) return reply.code(409).send({ error: 'Nickname already taken', code: 'NICKNAME_TAKEN' });
      throw error;
    }
    issueSession(id, request, reply);
    return reply.code(201).send({ user: profile(findUser.get(id) as UserRow) });
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = credentials(request.body, false);
    if (!input) return reply.code(400).send({ error: 'Enter a valid email and password' });
    const user = findEmail.get(input.email) as UserRow | undefined;
    if (!await passwords.verify(input.password, user?.password_hash) || !user) return reply.code(401).send({ error: 'Invalid email or password' });
    let current: UserRow | undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      current = findUser.get(user.id) as UserRow | undefined;
      if (!current || current.password_hash !== user.password_hash) {
        db.exec('COMMIT');
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      issueSession(user.id, request, reply);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { user: profile(current) };
  });
  stopRecovery = registerPasswordRecovery(app, db, recovery ?? undefined, {
    normalizedEmail: recoveryEmail, validPassword, hashPassword: passwords.hash, cookieOptions, cookieName: COOKIE,
    now: options.clock ?? Date.now,
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[COOKIE];
    if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token));
    reply.clearCookie(COOKIE, cookieOptions);
    return { ok: true };
  });
  app.get('/api/profile', async (request, reply) => {
    const user = currentUser(request);
    return user ? { user: profile(user) } : reply.code(401).send({ error: 'Authentication required' });
  });
  app.patch('/api/profile', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Authentication required' });
    const input = request.body;
    const supported = ['name', 'avatar', 'interfaceLanguage', 'showInLeaderboard'];
    if (!record(input) || !Object.keys(input).length || Object.keys(input).some(key => !supported.includes(key))) {
      return reply.code(400).send({ error: 'Invalid profile settings' });
    }
    const updates: string[] = [];
    const values: (string | number)[] = [];
    let nameKey: string | undefined;
    if (Object.hasOwn(input, 'name')) {
      const parsed = nickname(input.name);
      if (!parsed) return reply.code(400).send({ error: 'Invalid nickname' });
      updates.push('name = ?', 'name_key = ?');
      values.push(parsed.name, parsed.key);
      nameKey = parsed.key;
    }
    if (Object.hasOwn(input, 'avatar')) {
      if (typeof input.avatar !== 'string' || !AVATAR_IDS.includes(input.avatar as AvatarId)) return reply.code(400).send({ error: 'Invalid avatar' });
      updates.push('avatar = ?'); values.push(input.avatar);
    }
    if (Object.hasOwn(input, 'interfaceLanguage')) {
      if (input.interfaceLanguage !== 'ru' && input.interfaceLanguage !== 'en') return reply.code(400).send({ error: 'Invalid interface language' });
      updates.push('interface_language = ?'); values.push(input.interfaceLanguage);
    }
    if (Object.hasOwn(input, 'showInLeaderboard')) {
      if (typeof input.showInLeaderboard !== 'boolean') return reply.code(400).send({ error: 'Invalid leaderboard visibility' });
      updates.push('show_in_leaderboard = ?'); values.push(Number(input.showInLeaderboard));
    }
    let updated: UserRow;
    try {
      // A single statement is atomic, and only supplied fields change: parallel partial
      // edits cannot overwrite one another's unrelated settings with a stale snapshot.
      updated = db.prepare(`UPDATE users SET ${updates.join(', ')}, profile_version = profile_version + 1 WHERE id = ? RETURNING *`).get(...values, user.id) as UserRow;
    } catch (error) {
      const owner = nameKey ? findName.get(nameKey) as { id: string } | undefined : undefined;
      if (owner && owner.id !== user.id) return reply.code(409).send({ error: 'Nickname already taken', code: 'NICKNAME_TAKEN' });
      throw error;
    }
    return { user: profile(updated) };
  });
  app.post('/api/sessions', async (request, reply) => {
    const user = currentUser(request);
    if (!user) return reply.code(401).send({ error: 'Authentication required' });
    const result = canonicalSession(request.body);
    if (!result) return reply.code(400).send({ error: 'Invalid session result' });
    db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck under the write lock: independent processes may share this file.
      const existing = findResult.get(result.id) as ResultRow | undefined;
      if (existing && existing.user_id !== user.id) {
        db.exec('COMMIT');
        return reply.code(409).send({ error: 'Session id unavailable' });
      }
      if (!existing) {
        insertResult.run(result.id, user.id, Date.parse(result.createdAt), result.durationMs, result.correct, result.cpm, result.accuracy, result.xp, JSON.stringify(result));
        incrementXp.run(result.xp, user.id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { user: profile(findUser.get(user.id) as UserRow) };
  });
  app.get('/api/leaderboard', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const metric = query.metric ?? 'cpm';
    const period = query.period ?? 'all';
    if (typeof metric !== 'string' || !['cpm', 'accuracy', 'xp'].includes(metric) || typeof period !== 'string' || !['today', 'week', 'all'].includes(period)) return reply.code(400).send({ error: 'Invalid leaderboard filters' });
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // UTC calendar periods; week starts Monday.
    const from = period === 'today' ? today : period === 'week' ? today - ((now.getUTCDay() + 6) % 7) * 86400000 : 0;
    const rows = db.prepare(`SELECT s.user_id, u.name, u.avatar, s.cpm, s.accuracy, s.xp
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.show_in_leaderboard = 1 AND s.created_at >= ? AND s.duration_ms >= 15000 AND s.correct >= 20`).all(from) as { user_id: string; name: string; avatar: AvatarId; cpm: number; accuracy: number; xp: number }[];
    const grouped = new Map<string, LeaderboardEntry>();
    for (const row of rows) {
      const entry = grouped.get(row.user_id);
      if (!entry) grouped.set(row.user_id, { userId: row.user_id, name: row.name, avatar: row.avatar, cpm: row.cpm, accuracy: row.accuracy, xp: row.xp, sessions: 1 });
      else {
        entry.xp += row.xp;
        entry.sessions++;
        if (metric === 'accuracy' ? row.accuracy > entry.accuracy || (row.accuracy === entry.accuracy && row.cpm > entry.cpm) : row.cpm > entry.cpm || (row.cpm === entry.cpm && row.accuracy > entry.accuracy)) {
          entry.cpm = row.cpm; entry.accuracy = row.accuracy;
        }
      }
    }
    const key = metric as 'cpm' | 'accuracy' | 'xp';
    const entries = [...grouped.values()].sort((a, b) => b[key] - a[key] || b.cpm - a.cpm || b.accuracy - a.accuracy || a.userId.localeCompare(b.userId)).slice(0, 100);
    return { entries, updatedAt: now.toISOString() };
  });
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  if (options.serveStatic ?? production) {
    if (existsSync(dist)) {
      await app.register(fastifyStatic, { root: dist, prefix: '/', index: ['index.html'] });
      app.setNotFoundHandler((request, reply) => {
        const path = request.url.split('?')[0]!;
        if (!['GET', 'HEAD'].includes(request.method) || path === '/api' || path.startsWith('/api/') || path.startsWith('/assets/') || extname(path) || !request.headers.accept?.includes('text/html')) return reply.code(404).send({ error: 'Not found' });
        return reply.sendFile('index.html');
      });
    }
  }
  return app;
}
