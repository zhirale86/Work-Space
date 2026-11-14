import type { TaskStatus } from '../api-types';
import { type Actor, isAuditor } from '../common';
import { type Db, one } from '../db';
import { notFound } from '../errors';
import { Params } from '../sql';

export interface TaskRow {
  id: number;
  number: string;
  title: string;
  body: string;
  author_id: number;
  assignee_id: number;
  due_at: Date | null;
  document_id: number | null;
  status: TaskStatus;
  result_text: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export const TASK_NOT_FOUND = 'Поручение не найдено или нет доступа';

/** Поручение видят: постановщик, исполнитель, наблюдатели поручения, роль «Контроль документов». */
export function taskVisibleSql(actor: Actor, alias: string, p: Params): string {
  if (isAuditor(actor)) return 'TRUE';
  const u = p.add(actor.id);
  return `(${alias}.author_id = ${u} OR ${alias}.assignee_id = ${u}
           OR EXISTS (SELECT 1 FROM task_observers vo WHERE vo.task_id = ${alias}.id AND vo.user_id = ${u}))`;
}

export async function findTask(db: Db, actor: Actor, id: number, opts: { lock?: boolean } = {}): Promise<TaskRow | null> {
  const p = new Params();
  const idRef = p.add(id);
  return one<TaskRow>(
    db,
    `SELECT t.* FROM tasks t WHERE t.id = ${idRef} AND ${taskVisibleSql(actor, 't', p)} ${opts.lock ? 'FOR UPDATE OF t' : ''}`,
    p.values,
  );
}

/** Общая проверка доступа к поручению; нет доступа — 404 без раскрытия существования. */
export async function requireTask(db: Db, actor: Actor, id: number, opts: { lock?: boolean } = {}): Promise<TaskRow> {
  const task = await findTask(db, actor, id, opts);
  if (!task) throw notFound(TASK_NOT_FOUND);
  return task;
}

export const isTaskOverdue = (t: Pick<TaskRow, 'due_at' | 'status'>, now = new Date()): boolean =>
  !!t.due_at && t.due_at.getTime() < now.getTime() && !['done', 'cancelled'].includes(t.status);

export const TASK_OVERDUE_SQL = (alias: string): string =>
  `(${alias}.due_at IS NOT NULL AND ${alias}.due_at < now() AND ${alias}.status NOT IN ('done','cancelled'))`;
