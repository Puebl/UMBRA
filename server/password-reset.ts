import { backup, type DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RecoveryMailConfig } from './mail.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const TTL = 30 * 60_000;
const WINDOW = 15 * 60_000;
const CAPACITY = 1000;
const accepted = { ok: true, message: 'Если аккаунт с такой почтой существует, мы отправим инструкцию для восстановления' };

export async function migratePasswordReset(db: DatabaseSync, path: string) {
  const exists = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'password_reset_tokens'").get());
  if (exists()) return;
  if (path !== ':memory:' && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    await backup(db, `${path}.before-password-reset-${randomUUID()}.sqlite`);
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS password_reset_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS password_reset_expiry ON password_reset_tokens(expires_at);
    COMMIT;`);
}

type Services = {
  now: () => number;
  normalizedEmail: (value: unknown) => string | null;
  validPassword: (value: unknown) => value is string;
  hashPassword: (password: string) => Promise<string>;
  cookieName: string;
  cookieOptions: { httpOnly: boolean; sameSite: 'strict'; secure: boolean; path: string };
};
type ResetRow = { user_id: string; expires_at: number };

export function registerPasswordRecovery(app: FastifyInstance, db: DatabaseSync, config: RecoveryMailConfig | undefined, services: Services) {
  const { now } = services;
  if (!config) app.log.warn('Password recovery is disabled: no mail transport configured');
  const cooldown = new Map<string, number>();
  const limits = {
    forgot: new Map<string, { count: number; expires: number }>(),
    reset: new Map<string, { count: number; expires: number }>(),
  };
  const queue: string[] = [];
  let working: Promise<void> | undefined;
  let closing = false;
  const findToken = db.prepare('SELECT user_id, expires_at FROM password_reset_tokens WHERE token_hash = ?');
  const cleanup = () => {
    const time = now();
    for (const [key, expires] of cooldown) if (expires <= time) cooldown.delete(key);
    for (const entries of Object.values(limits)) {
      for (const [key, entry] of entries) if (entry.expires <= time) entries.delete(key);
    }
  };
  // One active delivery and a bounded queue, including unknown addresses. Requests never
  // inspect account existence, and capacity/cooldown decisions are account-independent.
  async function drain() {
    while (queue.length) {
      const email = queue.shift()!;
      try {
        const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
        db.prepare('DELETE FROM password_reset_tokens WHERE expires_at <= ?').run(now());
        if (!user || !config) continue;
        const token = randomBytes(32).toString('hex');
        const expiresAt = now() + TTL;
        db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(digest(token), user.id, expiresAt);
        await config.sender.send({ to: email, url: `${config.origin}/#reset-password=${token}`, expiresAt });
      } catch {
        app.log.error('Password recovery delivery failed');
      }
    }
  }
  function startWorker() {
    if (working || !queue.length) return;
    // Defer DB lookup and transport until after the request has returned its generic reply.
    working = new Promise<void>(resolve => setImmediate(resolve)).then(drain).finally(() => {
      working = undefined;
      // A request can enqueue after drain resolves but before this finalizer runs.
      // Restart even during shutdown: accepted work must finish before SQLite closes.
      startWorker();
    });
  }
  function enqueue(email: string) {
    queue.push(email);
    startWorker();
  }
  const routeOptions = { config: { rateLimit: false as const } };
  function limited(ip: string, route: 'forgot' | 'reset', max: number) {
    cleanup();
    const entries = limits[route];
    const entry = entries.get(ip);
    if (entry) return ++entry.count > max;
    if (entries.size >= CAPACITY) return true;
    entries.set(ip, { count: 1, expires: now() + WINDOW });
    return false;
  }
  const unavailable = { code: 'RECOVERY_UNAVAILABLE', error: 'Password recovery is unavailable' };
  const rateLimited = { code: 'RECOVERY_RATE_LIMITED', error: 'Please try again later' };
  const invalidLink = { code: 'RESET_LINK_INVALID', error: 'Reset link is invalid or expired' };
  app.post('/api/auth/forgot-password', routeOptions, async (request, reply) => {
    if (limited(request.ip, 'forgot', 5)) return reply.code(429).send(rateLimited);
    const body = request.body as { email?: unknown } | null;
    const email = services.normalizedEmail(body?.email);
    if (!email) return reply.code(400).send({ code: 'INVALID_EMAIL', error: 'Enter a valid email' });
    if (!config || closing) return reply.code(503).send(unavailable);
    const key = digest(email);
    if (cooldown.has(key) || cooldown.size >= CAPACITY) return reply.code(429).send(rateLimited);
    if (queue.length >= 100) return reply.code(503).send(unavailable);
    cooldown.set(key, now() + 60_000);
    enqueue(email);
    return accepted;
  });
  app.post('/api/auth/reset-password', routeOptions, async (request, reply) => {
    if (limited(request.ip, 'reset', 10)) return reply.code(429).send(rateLimited);
    if (!config || closing) return reply.code(503).send(unavailable);
    const body = request.body as { token?: unknown; password?: unknown } | null;
    if (!services.validPassword(body?.password)) return reply.code(400).send({ code: 'INVALID_PASSWORD', error: 'Password must contain 8–128 characters' });
    if (typeof body?.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) return reply.code(400).send(invalidLink);
    const hash = digest(body.token);
    const initial = findToken.get(hash) as ResetRow | undefined;
    if (!initial || initial.expires_at <= now()) return reply.code(400).send(invalidLink);
    const passwordHash = await services.hashPassword(body.password);
    db.exec('BEGIN IMMEDIATE');
    let clearCookie = false;
    try {
      const current = findToken.get(hash) as ResetRow | undefined;
      if (!current || current.expires_at <= now()) {
        db.exec('COMMIT');
        return reply.code(400).send(invalidLink);
      }
      const cookie = request.cookies[services.cookieName];
      if (cookie) {
        const session = db.prepare('SELECT user_id FROM auth_sessions WHERE token_hash = ?').get(digest(cookie)) as { user_id: string } | undefined;
        clearCookie = session?.user_id === current.user_id;
      }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, current.user_id);
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(current.user_id);
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(current.user_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (clearCookie) reply.clearCookie(services.cookieName, services.cookieOptions);
    return { ok: true };
  });
  return async () => {
    closing = true;
    // Do not close SQLite (or sender) while queued work still uses it.
    while (working) await working;
    try { await config?.sender.close?.(); }
    catch { app.log.error('Password recovery transport close failed'); }
  };
}
