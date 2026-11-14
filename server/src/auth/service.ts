import { createHash, randomBytes } from 'node:crypto';
import type { CurrentUser, SystemRole } from '../api-types';
import { audit } from '../audit/service';
import { type Actor, loadUserRefs, refOf } from '../common';
import { config } from '../config';
import { type Db, getPool, one, tx } from '../db';
import { AppError, unprocessable } from '../errors';
import { ROLE_LABELS } from '../labels';
import { hashPassword, verifyPassword } from './passwords';
import { type AuthUserRow, getAuthProvider } from './provider';

export const SESSION_COOKIE = 'docflow_session';
const MAX_FAILED_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MIN = 15;

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface SessionInfo {
  actor: Actor;
  mustChangePassword: boolean;
  sessionId: string;
}

export function sessionCookie(token: string | null): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.cookieSecure) attrs.push('Secure');
  if (token === null) return `${SESSION_COOKIE}=; ${attrs.join('; ')}; Max-Age=0`;
  return `${SESSION_COOKIE}=${token}; ${attrs.join('; ')}; Max-Age=${Math.round(config.sessionTtlHours * 3600)}`;
}

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      const v = part.slice(idx + 1).trim();
      return /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

function toActor(u: AuthUserRow): Actor {
  return {
    id: u.id,
    login: u.login,
    fullName: u.full_name,
    roles: u.roles as SystemRole[],
    departmentId: u.department_id,
  };
}

export async function login(loginRaw: string, password: string): Promise<{ token: string; user: CurrentUser }> {
  const loginName = loginRaw.trim().toLowerCase();
  const pool = getPool();
  const failed = await one<{ c: number }>(
    pool,
    `SELECT count(*)::int AS c FROM login_attempts WHERE login = $1 AND at > now() - make_interval(mins => $2)`,
    [loginName, ATTEMPT_WINDOW_MIN],
  );
  if ((failed?.c ?? 0) >= MAX_FAILED_ATTEMPTS) {
    throw new AppError(
      429,
      'too_many_requests',
      `Слишком много неудачных попыток входа. Повторите через ${ATTEMPT_WINDOW_MIN} минут`,
    );
  }
  const user = await getAuthProvider().authenticate(pool, loginName, password);
  if (!user || !user.active) {
    await pool.query('INSERT INTO login_attempts (login) VALUES ($1)', [loginName]);
    // Одинаковый ответ для неверного пароля, несуществующей и заблокированной записи.
    throw new AppError(401, 'invalid_credentials', 'Неверный логин или пароль');
  }
  const token = randomBytes(32).toString('base64url');
  await tx(async (db) => {
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [tokenHash(token), user.id, config.sessionTtlHours * 3600],
    );
    await db.query('DELETE FROM login_attempts WHERE login = $1', [loginName]);
    await audit(db, { actorId: user.id, entityType: 'auth', entityId: user.id, action: 'auth.login', summary: 'Вход в систему' });
  });
  return { token, user: await currentUser(pool, toActor(user), user.must_change_password) };
}

/** Проверяет сессию и продлевает её (срок — часы бездействия). */
export async function resolveSession(token: string): Promise<SessionInfo | null> {
  const id = tokenHash(token);
  const row = await one<AuthUserRow & { last_seen_at: Date }>(
    getPool(),
    `SELECT u.id, u.login, u.full_name, u.position, u.department_id, u.roles, u.active, u.must_change_password,
            s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.active`,
    [id],
  );
  if (!row) return null;
  // Продление не чаще раза в минуту — чтобы не писать в базу на каждый запрос.
  if (Date.now() - row.last_seen_at.getTime() > 60_000) {
    await getPool().query(
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(secs => $2) WHERE id = $1`,
      [id, config.sessionTtlHours * 3600],
    );
  }
  return { actor: toActor(row), mustChangePassword: row.must_change_password, sessionId: id };
}

export async function logout(sessionId: string, actorId: number): Promise<void> {
  await tx(async (db) => {
    await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await audit(db, { actorId, entityType: 'auth', entityId: actorId, action: 'auth.logout', summary: 'Выход из системы' });
  });
}

export async function currentUser(db: Db, actor: Actor, mustChangePassword: boolean): Promise<CurrentUser> {
  const ref = refOf(await loadUserRefs(db, [actor.id]), actor.id);
  return {
    ...ref,
    login: actor.login,
    roles: actor.roles,
    roleLabels: actor.roles.map((r) => ROLE_LABELS[r] ?? r),
    mustChangePassword,
  };
}

export function checkPasswordStrength(password: string, field = 'newPassword'): void {
  if (password.length < 8 || password.length > 200) {
    throw unprocessable('Пароль должен быть не короче 8 символов', [
      { field, message: 'Пароль должен быть не короче 8 символов' },
    ]);
  }
}

export async function changePassword(
  actor: Actor,
  sessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  checkPasswordStrength(newPassword);
  await tx(async (db) => {
    const row = await one<{ password_hash: string }>(db, 'SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [actor.id]);
    if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
      throw unprocessable('Текущий пароль указан неверно', [
        { field: 'currentPassword', message: 'Текущий пароль указан неверно' },
      ]);
    }
    await db.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [
      actor.id,
      await hashPassword(newPassword),
    ]);
    // Остальные сессии сотрудника завершаются.
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [actor.id, sessionId]);
    await audit(db, { actorId: actor.id, entityType: 'user', entityId: actor.id, action: 'user.password_changed', summary: 'Пароль изменён' });
  });
}

export async function purgeExpiredSessions(db: Db = getPool()): Promise<number> {
  const r = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  await db.query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
  return r.rowCount ?? 0;
}
