import { z } from 'zod';
import type { DepartmentRef, Page, SystemRole, UserRef } from './api-types';
import { type Db, rows } from './db';
import { badRequest, unprocessable } from './errors';

/** Пользователь, от имени которого выполняется действие. */
export interface Actor {
  id: number;
  login: string;
  fullName: string;
  roles: SystemRole[];
  departmentId: number | null;
}

export const isAdmin = (a: Actor): boolean => a.roles.includes('admin');
export const isAuditor = (a: Actor): boolean => a.roles.includes('auditor');

/** Русские сообщения стандартных проверок zod. */
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return { message: issue.received === 'undefined' ? 'Обязательное поле' : 'Недопустимый тип значения' };
    case z.ZodIssueCode.too_small:
      return {
        message:
          issue.type === 'string'
            ? issue.minimum === 1
              ? 'Поле не может быть пустым'
              : `Не короче ${issue.minimum} символов`
            : `Значение не меньше ${issue.minimum}`,
      };
    case z.ZodIssueCode.too_big:
      return {
        message:
          issue.type === 'string'
            ? `Не длиннее ${issue.maximum} символов`
            : issue.type === 'array'
              ? `Не более ${issue.maximum} элементов`
              : `Значение не больше ${issue.maximum}`,
      };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `Недопустимое значение. Возможные: ${issue.options.join(', ')}` };
    case z.ZodIssueCode.invalid_string:
      return { message: 'Недопустимый формат значения' };
    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Неизвестные поля: ${issue.keys.join(', ')}` };
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: 'Недопустимое значение' };
    default:
      return { message: ctx.defaultError === 'Required' ? 'Обязательное поле' : 'Недопустимое значение' };
  }
});

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest(
      'Некорректные данные запроса',
      r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })),
    );
  }
  return r.data;
}

export const zId = z.coerce.number().int().positive().max(2147483647);
export const zIdList = z.array(z.number().int().positive().max(2147483647)).max(200);
export const zBoolQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД');
export const zPage = {
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
};
export const idParams = z.object({ id: zId });

export interface Paging {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}
export function paging(q: { page?: number; pageSize?: number }): Paging {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
export function pageOf<T>(items: T[], total: number, p: Paging): Page<T> {
  return { items, total, page: p.page, pageSize: p.pageSize };
}

/** Экранирование шаблона ILIKE. */
export function like(s: string): string {
  return '%' + s.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** Текст без пробелов по краям; строка из одних пробелов считается пустой. */
export function clean(s: string | null | undefined): string {
  return (s ?? '').trim();
}

/**
 * Срок: ISO-дата-время либо «ГГГГ-ММ-ДД» — тогда конец этого дня по часовому поясу сервера (TZ).
 */
export function parseDueAt(value: string | null | undefined, field = 'dueAt'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, day] = value.split('-').map(Number);
    d = new Date(y, m - 1, day, 23, 59, 59, 0);
    if (d.getMonth() !== m - 1 || d.getDate() !== day) d = new Date(NaN);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) {
    throw badRequest('Некорректные данные запроса', [{ field, message: 'Некорректная дата' }]);
  }
  return d;
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

export function formatDateTimeRu(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function requireText(value: string | null | undefined, message: string, field: string): string {
  const t = clean(value);
  if (!t) throw unprocessable(message, [{ field, message }]);
  return t;
}

export function uniq(ids: number[]): number[] {
  return [...new Set(ids)];
}

// ───────────── Сведения о сотрудниках для ответов ─────────────

interface UserRefRow {
  id: number;
  full_name: string;
  position: string;
  active: boolean;
  department_id: number | null;
  department_name: string | null;
}

export async function loadUserRefs(db: Db, ids: Array<number | null | undefined>): Promise<Map<number, UserRef>> {
  const list = uniq(ids.filter((x): x is number => typeof x === 'number'));
  const map = new Map<number, UserRef>();
  if (!list.length) return map;
  const rs = await rows<UserRefRow>(
    db,
    `SELECT u.id, u.full_name, u.position, u.active, u.department_id, d.name AS department_name
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.id = ANY($1::int[])`,
    [list],
  );
  for (const r of rs) map.set(r.id, toUserRef(r));
  return map;
}

export function toUserRef(r: UserRefRow): UserRef {
  return {
    id: r.id,
    fullName: r.full_name,
    position: r.position,
    active: r.active,
    department: r.department_id ? { id: r.department_id, name: r.department_name ?? '' } : null,
  };
}

export function refOf(map: Map<number, UserRef>, id: number): UserRef {
  return map.get(id) ?? { id, fullName: 'Неизвестный сотрудник', position: '', active: false, department: null };
}

export function deptRef(id: number | null, name: string | null): DepartmentRef | null {
  return id ? { id, name: name ?? '' } : null;
}

/** Проверяет, что все сотрудники существуют и активны; возвращает их имена. */
export async function requireActiveUsers(db: Db, ids: number[], field: string): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (!ids.length) return result;
  const rs = await rows<{ id: number; full_name: string; active: boolean }>(
    db,
    'SELECT id, full_name, active FROM users WHERE id = ANY($1::int[])',
    [ids],
  );
  for (const r of rs) result.set(r.id, r.full_name);
  for (const id of ids) {
    const r = rs.find((x) => x.id === id);
    if (!r) throw unprocessable('Сотрудник не найден', [{ field, message: `Сотрудник с идентификатором ${id} не найден` }]);
    if (!r.active) {
      throw unprocessable(`Учётная запись сотрудника ${r.full_name} заблокирована`, [
        { field, message: `Учётная запись сотрудника ${r.full_name} заблокирована` },
      ]);
    }
  }
  return result;
}
