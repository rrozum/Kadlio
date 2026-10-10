import { openSQLite } from '../connectors/sqlite.js';

// SQL и схема принадлежат репозиторию. Сервис авторизации отвечает только
// за проверку пароля, лимит попыток и правила выпуска cookie/сессии.
export class AuthRepository {
  constructor(file, { connect = openSQLite } = {}) {
    this.database = connect(file);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts(client TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    `);
  }
  close() {
    this.database.close();
  }
  hasUsers() {
    return Boolean(this.database.prepare('SELECT 1 FROM users LIMIT 1').get());
  }
  createFirstUser(username, salt, passwordHash) {
    // Проверка пустой базы и вставка — одна операция: параллельный запуск
    // или CLI не должны перезаписать уже созданного владельца.
    return (
      this.database
        .prepare(
          'INSERT INTO users(username, salt, password_hash) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM users)',
        )
        .run(username, salt, passwordHash).changes > 0
    );
  }
  setUser(username, salt, passwordHash) {
    this.database
      .prepare(
        'INSERT INTO users VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash',
      )
      .run(username, salt, passwordHash);
  }
  invalidateSessions(username) {
    this.database.prepare('DELETE FROM sessions WHERE username=?').run(username);
  }
  expire(now) {
    this.database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.database.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').run(now);
  }
  attempts(client) {
    return this.database.prepare('SELECT attempts FROM login_attempts WHERE client=?').get(client);
  }
  recordAttempt(client, expiresAt) {
    this.database
      .prepare(
        'INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(client) DO UPDATE SET attempts=attempts+1',
      )
      .run(client, expiresAt);
  }
  findUser(username) {
    return this.database.prepare('SELECT * FROM users WHERE username=?').get(username);
  }
  clearAttempts(client) {
    this.database.prepare('DELETE FROM login_attempts WHERE client=?').run(client);
  }
  createSession(tokenHash, username, expiresAt) {
    this.database.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash, username, expiresAt);
  }
  sessionUser(tokenHash, now) {
    return (
      this.database
        .prepare('SELECT username FROM sessions WHERE token_hash=? AND expires_at>?')
        .get(tokenHash, now)?.username || null
    );
  }
  deleteSession(tokenHash) {
    this.database.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
  }
}
