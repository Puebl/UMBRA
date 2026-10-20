import { backup, type DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { nickname } from '../shared/nickname.js';

export async function migrateNicknames(db: DatabaseSync, dbPath: string) {
  const hasKey = () => (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).some(column => column.name === 'name_key');
  if (hasKey()) return;
  // SQLite's backup API includes committed WAL contents; copying just the file would not.
  if (dbPath !== ':memory:' && db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    await backup(db, `${dbPath}.before-nicknames-${randomUUID()}.sqlite`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (hasKey()) { db.exec('COMMIT'); return; }
    const users = db.prepare('SELECT id, name FROM users ORDER BY id').all() as { id: string; name: string }[];
    const keys = new Map<string, string>();
    const updates = users.map(user => {
      const parsed = nickname(user.name);
      if (!parsed) throw new Error(`Nickname migration blocked: invalid nickname for user ${user.id}. No accounts were changed.`);
      const owner = keys.get(parsed.key);
      if (owner) throw new Error(`Nickname migration blocked: conflicting nicknames for users ${owner} and ${user.id}. No accounts were changed.`);
      keys.set(parsed.key, user.id);
      return { id: user.id, key: parsed.key };
    });
    db.exec('ALTER TABLE users ADD COLUMN name_key TEXT');
    const update = db.prepare('UPDATE users SET name_key = ? WHERE id = ?');
    for (const user of updates) update.run(user.key, user.id);
    db.exec(`
      CREATE UNIQUE INDEX users_name_key ON users(name_key);
      CREATE TRIGGER users_name_key_insert BEFORE INSERT ON users
        WHEN NEW.name_key IS NULL OR NEW.name_key = ''
        BEGIN SELECT RAISE(ABORT, 'Nickname key is required'); END;
      CREATE TRIGGER users_name_key_update BEFORE UPDATE OF name_key ON users
        WHEN NEW.name_key IS NULL OR NEW.name_key = ''
        BEGIN SELECT RAISE(ABORT, 'Nickname key is required'); END;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
