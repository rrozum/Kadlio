import { AuthRepository } from '../../storage/repositories/auth.js';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback),
  hash = (value) => createHash('sha256').update(value).digest('hex');
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
function validateCredentials(username, password) {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(username) ||
    typeof password !== 'string' ||
    password.length < 16 ||
    password.length > 256
  )
    throw new Error('Логин: 1–64 букв/цифр; пароль: 16–256 символов.');
}
export class AuthStore {
  constructor(file, { secure = true, repository } = {}) {
    this.repository = repository || new AuthRepository(file);
    this.secure = secure;
    this.cookieName = secure ? '__Host-rozum-session' : 'rozum-session';
  }
  close() {
    this.repository.close();
  }
  async bootstrapOwner({ username = '', password = '' } = {}) {
    // Env задаёт только первого владельца. Перезапуск не меняет пароль,
    // не создаёт дополнительный аккаунт и не отзывает действующие сессии.
    if (this.repository.hasUsers() || (!username && !password)) return false;
    if (!username || !password)
      throw new Error('Для первого входа задайте ADMIN_USERNAME и ADMIN_PASSWORD в .env.');
    validateCredentials(username, password);
    const salt = randomBytes(32).toString('hex'),
      derived = await scrypt(password, salt, 64);
    return this.repository.createFirstUser(username, salt, derived.toString('hex'));
  }
  async setUser(username, password) {
    validateCredentials(username, password);
    const salt = randomBytes(32).toString('hex'),
      derived = await scrypt(password, salt, 64);
    this.repository.setUser(username, salt, derived.toString('hex'));
    this.repository.invalidateSessions(username);
  }
  async login(username, password, client) {
    const now = Date.now();
    this.repository.expire(now);
    const key = hash(client),
      attempt = this.repository.attempts(key);
    if (attempt?.attempts >= 10) {
      const error = new Error('Слишком много попыток. Попробуйте через 15 минут.');
      error.status = 429;
      throw error;
    }
    this.repository.recordAttempt(key, now + 15 * 60 * 1000);
    const user = typeof username === 'string' ? this.repository.findUser(username) : null;
    // Неизвестный логин тоже проходит scrypt: время ответа не раскрывает наличие пользователя.
    const candidate = await scrypt(
      typeof password === 'string' && password.length <= 256 ? password : '',
      user?.salt || 'unknown-user',
      64,
    );
    if (
      !user ||
      typeof password !== 'string' ||
      password.length > 256 ||
      !timingSafeEqual(candidate, Buffer.from(user.password_hash, 'hex'))
    )
      return null;
    this.repository.clearAttempts(key);
    const token = randomBytes(32).toString('base64url');
    this.repository.createSession(hash(token), username, now + sessionLifetime);
    return token;
  }
  token(req) {
    return (
      (req.headers.cookie || '')
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(this.cookieName + '='))
        ?.slice(this.cookieName.length + 1) || ''
    );
  }
  user(req) {
    const token = this.token(req);
    if (!/^[\w-]{43}$/.test(token)) return null;
    return this.repository.sessionUser(hash(token), Date.now());
  }
  logout(req) {
    this.repository.deleteSession(hash(this.token(req)));
  }
  cookie(token) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? sessionLifetime / 1000 : 0}${this.secure ? '; Secure' : ''}`;
  }
}
