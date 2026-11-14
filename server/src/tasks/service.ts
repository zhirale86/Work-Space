import type {
  Comment,
  CreateTaskRequest,
  Page,
  TaskDetail,
  TaskDocumentRef,
  TaskListItem,
  TaskPermissions,
  TaskScope,
  UpdateTaskRequest,
  UserRef,
} from '../api-types';
import { audit } from '../audit/service';
import {
  type Actor,
  type Paging,
  clean,
  iso,
  like,
  loadUserRefs,
  pageOf,
  parseDueAt,
  refOf,
  requireActiveUsers,
  requireText,
  uniq,
} from '../common';
import { type Db, one, rows, tx } from '../db';
import { docVisibleSql, requireDocument } from '../documents/access';
import { loadComments, nextNumber } from '../documents/service';
import { conflict, forbidden, unprocessable } from '../errors';
import { listFiles } from '../files/service';
import { TASK_STATUS_LABELS, q } from '../labels';
import { notify, notifyMany } from '../notifications/service';
import { Params } from '../sql';
import { type TaskRow, TASK_OVERDUE_SQL, isTaskOverdue, requireTask, taskVisibleSql } from './access';

export const TASK_PREFIX = 'ПОР';

interface ListRow extends TaskRow {
  doc_number: string | null;
  doc_title: string | null;
  doc_accessible: boolean | null;
}

export interface TaskFilters {
  q?: string;
  scope?: TaskScope;
  statuses?: string[];
  overdue?: boolean;
  documentId?: number;
  assigneeId?: number;
  /** Просрочено и действие ожидается от текущего пользователя. */
  overdueMine?: boolean;
}

function buildWhere(actor: Actor, f: TaskFilters, p: Params): string {
  const u = p.add(actor.id);
  const cond = [taskVisibleSql(actor, 't', p)];
  if (f.q?.trim()) {
    const pat = p.add(like(f.q.trim()));
    cond.push(`(t.number ILIKE ${pat} OR t.title ILIKE ${pat})`);
  }
  if (f.scope === 'assigned') cond.push(`t.assignee_id = ${u}`);
  if (f.scope === 'authored') cond.push(`t.author_id = ${u}`);
  if (f.statuses?.length) cond.push(`t.status = ANY(${p.add(f.statuses)}::text[])`);
  if (f.overdue) cond.push(TASK_OVERDUE_SQL('t'));
  if (f.documentId) cond.push(`t.document_id = ${p.add(f.documentId)}`);
  if (f.assigneeId) cond.push(`t.assignee_id = ${p.add(f.assigneeId)}`);
  if (f.overdueMine) {
    cond.push(
      `${TASK_OVERDUE_SQL('t')} AND ((t.status IN ('new','in_progress') AND t.assignee_id = ${u}) OR (t.status = 'review' AND t.author_id = ${u}))`,
    );
  }
  return cond.join(' AND ');
}

export async function countTasks(db: Db, actor: Actor, f: TaskFilters): Promise<number> {
  const p = new Params();
  const where = buildWhere(actor, f, p);
  return (await one<{ c: number }>(db, `SELECT count(*)::int AS c FROM tasks t WHERE ${where}`, p.values))?.c ?? 0;
}

/** Общий запрос списка поручений строго в пределах прав пользователя. */
export async function queryTasks(db: Db, actor: Actor, f: TaskFilters, pg: Paging): Promise<Page<TaskListItem>> {
  const total = await countTasks(db, actor, f);
  const p = new Params();
  const where = buildWhere(actor, f, p);
  const list = await rows<ListRow>(
    db,
    `SELECT t.*, d.number AS doc_number, d.title AS doc_title,
            (d.id IS NOT NULL AND ${docVisibleSql(actor, 'd', p)}) AS doc_accessible
       FROM tasks t LEFT JOIN documents d ON d.id = t.document_id
      WHERE ${where}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
    p.values,
  );
  const users = await loadUserRefs(db, list.flatMap((t) => [t.author_id, t.assignee_id]));
  return pageOf(list.map((t) => toListItem(t, users)), total, pg);
}

function toListItem(t: ListRow, users: Map<number, UserRef>): TaskListItem {
  // Участник поручения видит только номер и название документа-основания.
  const document: TaskDocumentRef | null =
    t.document_id && t.doc_number !== null
      ? { id: t.document_id, number: t.doc_number, title: t.doc_title ?? '', accessible: !!t.doc_accessible }
      : null;
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    status: t.status,
    statusLabel: TASK_STATUS_LABELS[t.status],
    author: refOf(users, t.author_id),
    assignee: refOf(users, t.assignee_id),
    dueAt: iso(t.due_at),
    overdue: isTaskOverdue(t),
    createdAt: iso(t.created_at)!,
    document,
  };
}

export async function getTaskDetail(db: Db, actor: Actor, id: number): Promise<TaskDetail> {
  const task = await requireTask(db, actor, id);
  return buildTaskDetail(db, actor, task);
}

async function buildTaskDetail(db: Db, actor: Actor, task: TaskRow): Promise<TaskDetail> {
  const p = new Params();
  const idRef = p.add(task.id);
  const row = (await one<ListRow>(
    db,
    `SELECT t.*, d.number AS doc_number, d.title AS doc_title,
            (d.id IS NOT NULL AND ${docVisibleSql(actor, 'd', p)}) AS doc_accessible
       FROM tasks t LEFT JOIN documents d ON d.id = t.document_id WHERE t.id = ${idRef}`,
    p.values,
  ))!;
  const observers = await rows<{ user_id: number }>(db, 'SELECT user_id FROM task_observers WHERE task_id = $1 ORDER BY user_id', [task.id]);
  const users = await loadUserRefs(db, [task.author_id, task.assignee_id, ...observers.map((o) => o.user_id)]);
  const isAuthor = task.author_id === actor.id;
  const isAssignee = task.assignee_id === actor.id;
  const open = task.status !== 'done' && task.status !== 'cancelled';
  const permissions: TaskPermissions = {
    canEdit: isAuthor && open,
    canStart: isAssignee && task.status === 'new',
    canSubmit: isAssignee && (task.status === 'new' || task.status === 'in_progress'),
    canAccept: isAuthor && task.status === 'review',
    canReturn: isAuthor && task.status === 'review',
    canCancel: isAuthor && open,
    canUploadFiles: (isAuthor || isAssignee) && open,
    canComment: true,
  };
  return {
    ...toListItem(row, users),
    body: task.body,
    resultText: task.result_text,
    updatedAt: iso(task.updated_at)!,
    completedAt: iso(task.completed_at),
    observers: observers.map((o) => refOf(users, o.user_id)),
    files: await listFiles(db, 'task', task.id),
    comments: await loadComments(db, 'task', task.id),
    permissions,
  };
}

async function setObservers(db: Db, taskId: number, ids: number[]): Promise<void> {
  await db.query('DELETE FROM task_observers WHERE task_id = $1', [taskId]);
  for (const u of ids) await db.query('INSERT INTO task_observers (task_id, user_id) VALUES ($1, $2)', [taskId, u]);
}

const taskRef = (t: Pick<TaskRow, 'number' | 'title'>): string => `${t.number} ${q(t.title)}`;

export async function createTask(actor: Actor, input: CreateTaskRequest): Promise<TaskDetail> {
  return tx(async (db) => {
    const title = requireText(input.title, 'Укажите название поручения', 'title');
    await requireActiveUsers(db, [input.assigneeId], 'assigneeId');
    const observers = uniq(input.observerIds ?? []);
    await requireActiveUsers(db, observers, 'observerIds');
    let docNumber: string | null = null;
    if (input.documentId) {
      // Основанием может быть только документ, доступный постановщику.
      const doc = await requireDocument(db, actor, input.documentId);
      docNumber = doc.number;
    }
    const number = await nextNumber(db, TASK_PREFIX);
    const task = (await one<TaskRow>(
      db,
      `INSERT INTO tasks (number, title, body, author_id, assignee_id, due_at, document_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [number, title, clean(input.body), actor.id, input.assigneeId, parseDueAt(input.dueAt), input.documentId ?? null],
    ))!;
    await setObservers(db, task.id, observers);
    await audit(db, {
      actorId: actor.id,
      entityType: 'task',
      entityId: task.id,
      action: 'task.created',
      summary: docNumber ? `Создано поручение ${number} на основании документа ${docNumber}` : `Создано поручение ${number} (без документа-основания)`,
      details: { number, assigneeId: input.assigneeId, documentId: input.documentId ?? null },
    });
    if (input.documentId) {
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: input.documentId,
        action: 'task.created',
        summary: `По документу создано поручение ${number}`,
        details: { taskId: task.id, number, assigneeId: input.assigneeId },
      });
    }
    if (input.assigneeId !== actor.id) {
      await notify(db, {
        userId: input.assigneeId,
        type: 'task_assigned',
        title: `Новое поручение ${number}`,
        body: `Вам назначено поручение ${taskRef(task)}. Постановщик — ${actor.fullName}.`,
        entityType: 'task',
        entityId: task.id,
      });
    }
    return buildTaskDetail(db, actor, task);
  });
}

function requireOpen(task: TaskRow): void {
  if (task.status === 'done' || task.status === 'cancelled') {
    throw conflict(`Поручение завершено (статус ${q(TASK_STATUS_LABELS[task.status])}) и не может быть изменено`);
  }
}

export async function updateTask(actor: Actor, id: number, input: UpdateTaskRequest): Promise<TaskDetail> {
  return tx(async (db) => {
    const task = await requireTask(db, actor, id, { lock: true });
    if (task.author_id !== actor.id) throw forbidden('Изменять поручение может только постановщик');
    requireOpen(task);
    const p = new Params();
    const sets: string[] = [];
    const changed: string[] = [];
    const changes: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const title = requireText(input.title, 'Укажите название поручения', 'title');
      if (title !== task.title) {
        sets.push(`title = ${p.add(title)}`);
        changed.push('название');
      }
    }
    if (input.body !== undefined && clean(input.body) !== task.body) {
      sets.push(`body = ${p.add(clean(input.body))}`);
      changed.push('содержание');
    }
    if (input.dueAt !== undefined) {
      const due = parseDueAt(input.dueAt);
      if ((due?.getTime() ?? null) !== (task.due_at?.getTime() ?? null)) {
        sets.push(`due_at = ${p.add(due)}`);
        changed.push('срок');
        changes.dueAt = { from: iso(task.due_at), to: iso(due) };
      }
    }
    let newAssignee: number | null = null;
    if (input.assigneeId !== undefined && input.assigneeId !== task.assignee_id) {
      await requireActiveUsers(db, [input.assigneeId], 'assigneeId');
      if (task.status === 'review') throw conflict('Нельзя сменить исполнителя, пока результат находится на проверке');
      sets.push(`assignee_id = ${p.add(input.assigneeId)}`, `status = 'new'`);
      changed.push('исполнитель');
      changes.assigneeId = { from: task.assignee_id, to: input.assigneeId };
      newAssignee = input.assigneeId;
    }
    if (input.observerIds !== undefined) {
      const next = uniq(input.observerIds);
      const old = (await rows<{ user_id: number }>(db, 'SELECT user_id FROM task_observers WHERE task_id = $1 ORDER BY user_id', [id])).map(
        (r) => r.user_id,
      );
      if (old.length !== next.length || old.some((o) => !next.includes(o))) {
        await requireActiveUsers(db, next.filter((n) => !old.includes(n)), 'observerIds');
        await setObservers(db, id, next);
        changed.push('наблюдатели');
        changes.observerIds = { from: old, to: next };
      }
    }
    if (!changed.length) return buildTaskDetail(db, actor, task);
    sets.push('updated_at = now()');
    const updated = (await one<TaskRow>(db, `UPDATE tasks SET ${sets.join(', ')} WHERE id = ${p.add(id)} RETURNING *`, p.values))!;
    await audit(db, {
      actorId: actor.id,
      entityType: 'task',
      entityId: id,
      action: 'task.updated',
      summary: `Поручение изменено: ${changed.join(', ')}`,
      details: { changes },
    });
    if (newAssignee) {
      if (newAssignee !== actor.id) {
        await notify(db, {
          userId: newAssignee,
          type: 'task_assigned',
          title: `Новое поручение ${task.number}`,
          body: `Вам назначено поручение ${taskRef(updated)}. Постановщик — ${actor.fullName}.`,
          entityType: 'task',
          entityId: id,
        });
      }
      if (task.assignee_id !== actor.id) {
        await notify(db, {
          userId: task.assignee_id,
          type: 'task_changed',
          title: `Поручение ${task.number} передано другому исполнителю`,
          body: 'Ваше участие в поручении больше не требуется.',
        });
      }
    } else if (changes.dueAt && task.assignee_id !== actor.id) {
      await notify(db, {
        userId: task.assignee_id,
        type: 'task_changed',
        title: `Изменён срок поручения ${task.number}`,
        body: `Постановщик изменил срок поручения ${taskRef(updated)}.`,
        entityType: 'task',
        entityId: id,
      });
    }
    return buildTaskDetail(db, actor, updated);
  });
}

type Transition = 'start' | 'submit' | 'accept' | 'return' | 'cancel';

/** Переходы машины состояний поручения. */
export async function transitionTask(actor: Actor, id: number, action: Transition, textRaw?: string): Promise<TaskDetail> {
  return tx(async (db) => {
    const task = await requireTask(db, actor, id, { lock: true });
    const text = clean(textRaw);
    const isAuthor = task.author_id === actor.id;
    const isAssignee = task.assignee_id === actor.id;
    const set = async (sql: string, params: unknown[] = []): Promise<TaskRow> =>
      (await one<TaskRow>(db, `UPDATE tasks SET ${sql}, updated_at = now() WHERE id = $1 RETURNING *`, [id, ...params]))!;
    let updated: TaskRow;
    switch (action) {
      case 'start': {
        if (!isAssignee) throw forbidden('Взять поручение в работу может только исполнитель');
        if (task.status === 'in_progress') return buildTaskDetail(db, actor, task);
        if (task.status !== 'new') throw conflict(`Действие недоступно в статусе ${q(TASK_STATUS_LABELS[task.status])}`);
        updated = await set(`status = 'in_progress'`);
        await audit(db, { actorId: actor.id, entityType: 'task', entityId: id, action: 'task.started', summary: 'Поручение взято в работу' });
        break;
      }
      case 'submit': {
        if (!isAssignee) throw forbidden('Передать результат на проверку может только исполнитель');
        if (!text) throw unprocessable('Укажите результат исполнения', [{ field: 'resultText', message: 'Результат исполнения обязателен' }]);
        if (task.status === 'review' && task.result_text === text) return buildTaskDetail(db, actor, task);
        if (task.status !== 'new' && task.status !== 'in_progress') {
          throw conflict(`Действие недоступно в статусе ${q(TASK_STATUS_LABELS[task.status])}`);
        }
        updated = await set(`status = 'review', result_text = $2`, [text]);
        await audit(db, {
          actorId: actor.id,
          entityType: 'task',
          entityId: id,
          action: 'task.submitted',
          summary: 'Результат передан постановщику на проверку',
          details: { resultText: text },
        });
        await notify(db, {
          userId: task.author_id,
          type: 'task_submitted',
          title: `Результат по поручению ${task.number} передан на проверку`,
          body: `${actor.fullName}: ${text.slice(0, 300)}`,
          entityType: 'task',
          entityId: id,
        });
        break;
      }
      case 'accept': {
        if (!isAuthor) throw forbidden('Принять результат может только постановщик');
        if (task.status === 'done') return buildTaskDetail(db, actor, task);
        if (task.status !== 'review') throw conflict('Принять можно только результат, переданный на проверку');
        updated = await set(`status = 'done', completed_at = now()`);
        await audit(db, { actorId: actor.id, entityType: 'task', entityId: id, action: 'task.accepted', summary: 'Результат принят, поручение выполнено' });
        await notify(db, {
          userId: task.assignee_id,
          type: 'task_accepted',
          title: `Поручение ${task.number} принято`,
          body: `Постановщик принял результат по поручению ${taskRef(task)}.`,
          entityType: 'task',
          entityId: id,
        });
        break;
      }
      case 'return': {
        if (!isAuthor) throw forbidden('Вернуть поручение в работу может только постановщик');
        if (!text) throw unprocessable('Укажите комментарий к возврату', [{ field: 'comment', message: 'Комментарий обязателен' }]);
        if (task.status !== 'review') throw conflict('Вернуть в работу можно только результат, переданный на проверку');
        updated = await set(`status = 'in_progress'`);
        await db.query(`INSERT INTO comments (entity_type, entity_id, author_id, body) VALUES ('task', $1, $2, $3)`, [id, actor.id, text]);
        await audit(db, {
          actorId: actor.id,
          entityType: 'task',
          entityId: id,
          action: 'task.returned',
          summary: 'Поручение возвращено в работу',
          details: { comment: text },
        });
        await notify(db, {
          userId: task.assignee_id,
          type: 'task_returned',
          title: `Поручение ${task.number} возвращено в работу`,
          body: `${actor.fullName}: ${text.slice(0, 300)}`,
          entityType: 'task',
          entityId: id,
        });
        break;
      }
      case 'cancel': {
        if (!isAuthor) throw forbidden('Отменить поручение может только постановщик');
        if (!text) throw unprocessable('Укажите причину отмены', [{ field: 'reason', message: 'Причина обязательна' }]);
        if (task.status === 'cancelled') return buildTaskDetail(db, actor, task);
        requireOpen(task);
        updated = await set(`status = 'cancelled', completed_at = now()`);
        await audit(db, {
          actorId: actor.id,
          entityType: 'task',
          entityId: id,
          action: 'task.cancelled',
          summary: `Поручение отменено. Причина: ${text}`,
          details: { reason: text },
        });
        if (!isAssignee) {
          await notify(db, {
            userId: task.assignee_id,
            type: 'task_cancelled',
            title: `Поручение ${task.number} отменено`,
            body: `Причина: ${text.slice(0, 300)}`,
            entityType: 'task',
            entityId: id,
          });
        }
        break;
      }
    }
    return buildTaskDetail(db, actor, updated);
  });
}

export async function addTaskComment(actor: Actor, id: number, bodyRaw: string): Promise<Comment> {
  return tx(async (db) => {
    const task = await requireTask(db, actor, id);
    const body = clean(bodyRaw);
    if (!body) throw unprocessable('Комментарий не может быть пустым', [{ field: 'body', message: 'Комментарий не может быть пустым' }]);
    const c = (await one<{ id: number; created_at: Date }>(
      db,
      `INSERT INTO comments (entity_type, entity_id, author_id, body) VALUES ('task', $1, $2, $3) RETURNING id, created_at`,
      [id, actor.id, body],
    ))!;
    await audit(db, { actorId: actor.id, entityType: 'task', entityId: id, action: 'comment.added', summary: 'Добавлен комментарий', details: { commentId: c.id } });
    await notifyMany(db, [task.author_id, task.assignee_id].filter((u) => u !== actor.id), {
      type: 'comment_added',
      title: `Новый комментарий к поручению ${task.number}`,
      body: `В поручении ${task.number} новый комментарий. Автор — ${actor.fullName}.`,
      entityType: 'task',
      entityId: id,
    });
    const users = await loadUserRefs(db, [actor.id]);
    return { id: c.id, author: refOf(users, actor.id), body, createdAt: iso(c.created_at)! };
  });
}
