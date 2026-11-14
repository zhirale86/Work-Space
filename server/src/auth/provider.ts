import { type Db, one } from '../db';
import { hashPassword, verifyPassword } from './passwords';

export interface AuthUserRow {
  id: number;
  login: string;
  full_name: string;
  position: string;
  department_id: number | null;
  roles: string[];
  active: boolean;
  must_change_password: boolean;
}

/**
 * Точка расширения: источник учётных записей. Сейчас — локальные записи в таблице users;
 * позднее может быть заменён корпоративным входом (LDAP, OIDC, единый вход с Битрикс24).
 */
export interface AuthProvider {
  /** Возвращает пользователя при верных учётных данных, иначе null. */
  authenticate(db: Db, login: string, password: string): Promise<AuthUserRow | null>;
}

// Хэш несуществующего пароля — чтобы время ответа не выдавало отсутствие логина.
let dummyHash: Promise<string> | null = null;

export class LocalAuthProvider implements AuthProvider {
  async authenticate(db: Db, login: string, password: string): Promise<AuthUserRow | null> {
    const row = await one<AuthUserRow & { password_hash: string }>(
      db,
      `SELECT id, login, full_name, position, department_id, roles, active, must_change_password, password_hash
         FROM users WHERE login = $1`,
      [login],
    );
    if (!row) {
      dummyHash ??= hashPassword('несуществующий-пароль');
      await verifyPassword(password, await dummyHash);
      return null;
    }
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) return null;
    const { password_hash: _ignored, ...user } = row;
    void _ignored;
    return user;
  }
}

let provider: AuthProvider = new LocalAuthProvider();
export const getAuthProvider = (): AuthProvider => provider;
export const setAuthProvider = (p: AuthProvider): void => {
  provider = p;
};
