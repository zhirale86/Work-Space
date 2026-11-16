/**
 * Общие функции имитации сервера: сотрудники, журнал действий, уведомления, правила доступа.
 * Перенесены из server/src/common.ts, audit, notifications, documents/access, tasks/access.
 */
import type { DepartmentRef, EntityType, ErrorDetail, HistoryEntry, NotificationType, Page, SystemRole, UserRef } from '../api/types';
import { AppError, badRequest, notFound, unprocessable } from '../../../server/src/errors';
import { type DocRow, type Ms, type TaskRow, type UserRow, db, nextId, now } from './db';

export { AppError };

export interface Actor {
  id: number;
  login: string;
  fullName: string;
  roles: SystemRole[];
  departmentId: number | null;
}

export const isAdmin = (a: Actor): boolean => a.roles.includes('admin');
export const isAuditor = (a: Actor): boolean => a.roles.includes('auditor');

export function actorOfUser(u: UserRow): Actor {
  return { id: u.id, login: u.login, fullName: u.full_name, roles: u.roles, departmentId: u.department_id };
}

export const clean = (s: string | null | undefined): string => (s ?? '').trim();
export const uniq = (ids: number[]): number[] => [...new Set(ids)];
export const iso = (ms: Ms | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
export const isoReq = (ms: Ms): string => new Date(ms).toISOString();

/** Регистронезависимый поиск подстроки (аналог ILIKE '%…%'). */
export const ilike = (value: string | null | undefined, q: string): boolean => (value ?? '').toLowerCase().includes(q.toLowerCase());

export function formatDateTimeRu(ms: Ms): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Срок: ISO-дата-время либо «ГГГГ-ММ-ДД» — тогда конец этого дня. */
export function parseDueAt(value: string | null | undefined, field = 'dueAt'): Ms | null {
  if (value === null || value === undefined || value === '') return null;
  let t: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, day] = value.split('-').map(Number);
    const d = new Date(y, m - 1, day, 23, 59, 59, 0);
    t = d.getMonth() !== m - 1 || d.getDate() !== day ? NaN : d.getTime();
  } else {
    t = new Date(value).getTime();
  }
  if (Number.isNaN(t)) throw badRequest('Некорректные данные запроса', [{ field, message: 'Некорректная дата' }]);
  return t;
}

export function requireText(value: string | null | undefined, message: string, field: string): string {
  const t = clean(value);
  if (!t) throw unprocessable(message, [{ field, message }]);
  return t;
}

// ───────────── Страницы ─────────────

export interface Paging {
  page: number;
  pageSize: number;
}
export function paging(q: Record<string, string>, defSize = 20): Paging {
  const page = Number(q.page) || 1;
  const pageSize = Number(q.pageSize) || defSize;
  if (page < 1 || pageSize < 1 || pageSize > 100 || !Number.isInteger(page) || !Number.isInteger(pageSize)) {
    throw badRequest('Некорректные данные запроса', [{ field: page < 1 ? 'page' : 'pageSize', message: 'Недопустимое значение' }]);
  }
  return { page, pageSize };
}
export function pageOf<T>(all: T[], p: Paging): Page<T> {
  return { items: all.slice((p.page - 1) * p.pageSize, p.page * p.pageSize), total: all.length, page: p.page, pageSize: p.pageSize };
}

// ───────────── Сотрудники ─────────────

export const userById = (id: number | null | undefined): UserRow | undefined => (id ? db.users.find((u) => u.id === id) : undefined);

export function deptRef(id: number | null): DepartmentRef | null {
  if (!id) return null;
  const d = db.departments.find((x) => x.id === id);
  return { id, name: d?.name ?? '' };
}

export function toUserRef(u: UserRow): UserRef {
  return { id: u.id, fullName: u.full_name, position: u.position, active: u.active, department: deptRef(u.department_id) };
}

export function refOf(id: number): UserRef {
  const u = userById(id);
  return u ? toUserRef(u) : { id, fullName: 'Неизвестный сотрудник', position: '', active: false, department: null };
}

/** Проверяет, что все сотрудники существуют и активны. */
export function requireActiveUsers(ids: number[], field: string): void {
  for (const id of ids) {
    const u = userById(id);
    if (!u) throw unprocessable('Сотрудник не найден', [{ field, message: `Сотрудник с идентификатором ${id} не найден` }]);
    if (!u.active) {
      const m = `Учётная запись сотрудника ${u.full_name} заблокирована`;
      throw unprocessable(m, [{ field, message: m }]);
    }
  }
}

export const byName = (a: number, b: number): number => (userById(a)?.full_name ?? '').localeCompare(userById(b)?.full_name ?? '', 'ru');

// ───────────── Журнал действий ─────────────

export interface AuditInput {
  actorId: number | null;
  entityType: 'document' | 'task' | 'user' | 'department' | 'doc_type' | 'bitrix' | 'auth' | 'file';
  entityId: number | null;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}

export function audit(e: AuditInput): void {
  db.audit.push({
    id: nextId('audit'),
    at: now(),
    actor_id: e.actorId,
    entity_type: e.entityType,
    entity_id: e.entityId,
    action: e.action,
    summary: e.summary,
    details: e.details ?? {},
  });
}

export const SYSTEM_ACTOR_NAME = 'Системный процесс';

export function mapHistory(list: typeof db.audit): HistoryEntry[] {
  return list.map((r) => {
    const u = r.actor_id ? userById(r.actor_id) : undefined;
    const actor = u ? toUserRef(u) : null;
    return {
      id: r.id,
      at: isoReq(r.at),
      actor,
      actorName: actor ? actor.fullName : SYSTEM_ACTOR_NAME,
      action: r.action,
      summary: r.summary,
      details: r.details ?? {},
    };
  });
}

export function entityHistory(entityType: 'document' | 'task', entityId: number, p: Paging): Page<HistoryEntry> {
  const list = db.audit.filter((a) => a.entity_type === entityType && a.entity_id === entityId).sort((a, b) => b.id - a.id);
  const page = pageOf(list, p);
  return { ...page, items: mapHistory(page.items as typeof db.audit) };
}

// ───────────── Уведомления ─────────────

export interface NotifyInput {
  userId: number;
  type: NotificationType;
  title: string;
  body?: string;
  entityType?: EntityType;
  entityId?: number;
  dedupeKey?: string;
}

/** Уведомление внутри системы; заблокированным сотрудникам не создаётся. */
export function notify(n: NotifyInput): void {
  const u = userById(n.userId);
  if (!u || !u.active) return;
  if (n.dedupeKey && db.notifications.some((x) => x.dedupe_key === n.dedupeKey)) return;
  db.notifications.push({
    id: nextId('notifications'),
    user_id: n.userId,
    type: n.type,
    title: n.title,
    body: n.body ?? '',
    entity_type: n.entityType ?? null,
    entity_id: n.entityId ?? null,
    dedupe_key: n.dedupeKey ?? null,
    created_at: now(),
    read_at: null,
  });
}

export function notifyMany(userIds: number[], n: Omit<NotifyInput, 'userId'>): void {
  for (const userId of new Set(userIds)) notify({ ...n, userId });
}

// ───────────── Доступ к документам ─────────────

export const DOC_NOT_FOUND = 'Документ не найден или нет доступа';
export const TASK_NOT_FOUND = 'Поручение не найдено или нет доступа';

/**
 * Единое правило видимости документа (архитектура, п. 2.7): инициатор; согласующие, получившие
 * документ; утверждающий и наблюдатели — после первого запуска; список ознакомления — после
 * утверждения приказа; индивидуальный доступ и доступ подразделения; роль «Контроль документов».
 */
export function docVisible(actor: Actor, d: DocRow): boolean {
  // Администратор и «Контроль документов» видят все документы, включая завершённые (только просмотр).
  if (isAuditor(actor) || isAdmin(actor)) return true;
  if (d.initiator_id === actor.id) return true;
  const roundIds = new Set(db.rounds.filter((r) => r.document_id === d.id).map((r) => r.id));
  if (db.steps.some((s) => roundIds.has(s.round_id) && s.user_id === actor.id && s.activated_at !== null && s.state !== 'replaced')) return true;
  if (d.signer_id === actor.id && d.launch_count > 0) return true;
  const part = (role: string) => db.participants.some((p) => p.document_id === d.id && p.user_id === actor.id && p.role === role);
  if (d.launch_count > 0 && part('observer')) return true;
  if (d.kind === 'order' && (d.status === 'approved' || d.status === 'archived') && part('acquaintance')) return true;
  return db.access.some(
    (a) => a.document_id === d.id && (a.user_id === actor.id || (a.department_id !== null && a.department_id === actor.departmentId)),
  );
}

export function findDocument(actor: Actor, id: number): DocRow | null {
  const d = db.documents.find((x) => x.id === id);
  return d && docVisible(actor, d) ? d : null;
}

export function requireDocument(actor: Actor, id: number): DocRow {
  const d = findDocument(actor, id);
  if (!d) throw notFound(DOC_NOT_FOUND);
  return d;
}

/** Управляющие действия: участник с доступом либо администратор (по служебным сведениям). */
export function requireDocumentForManage(actor: Actor, id: number): DocRow {
  if (isAdmin(actor)) {
    const d = db.documents.find((x) => x.id === id);
    if (!d) throw notFound(DOC_NOT_FOUND);
    return d;
  }
  return requireDocument(actor, id);
}

export function requireInitiator(doc: DocRow, actor: Actor, message = 'Действие доступно только инициатору документа'): void {
  if (doc.initiator_id !== actor.id) throw new AppError(403, 'forbidden', message);
}

export function requireInitiatorOrAdmin(doc: DocRow, actor: Actor): void {
  if (doc.initiator_id !== actor.id && !isAdmin(actor)) {
    throw new AppError(403, 'forbidden', 'Действие доступно только инициатору документа и администратору');
  }
}

export const isDocOverdue = (d: Pick<DocRow, 'due_at' | 'status'>): boolean =>
  !!d.due_at && d.due_at < now() && ['in_review', 'on_signing', 'rework'].includes(d.status);

// ───────────── Доступ к поручениям ─────────────

export function taskVisible(actor: Actor, t: TaskRow): boolean {
  if (isAuditor(actor)) return true;
  return t.author_id === actor.id || t.assignee_id === actor.id || db.taskObservers.some((o) => o.task_id === t.id && o.user_id === actor.id);
}

export function requireTask(actor: Actor, id: number): TaskRow {
  const t = db.tasks.find((x) => x.id === id);
  if (!t || !taskVisible(actor, t)) throw notFound(TASK_NOT_FOUND);
  return t;
}

export const isTaskOverdue = (t: Pick<TaskRow, 'due_at' | 'status'>): boolean =>
  !!t.due_at && t.due_at < now() && !['done', 'cancelled'].includes(t.status);

// ───────────── Нумерация ─────────────

/** Следующий номер: отдельный счётчик на префикс и год. */
export function nextNumber(prefix: string): string {
  const year = new Date(now()).getFullYear();
  const key = `${prefix}-${year}`;
  db.counters[key] = (db.counters[key] ?? 0) + 1;
  return `${prefix}-${year}-${String(db.counters[key]).padStart(6, '0')}`;
}

export const q = (s: string): string => `«${s}»`;

export function fail422(message: string, field: string): AppError {
  return unprocessable(message, [{ field, message }]);
}

export type { ErrorDetail };
