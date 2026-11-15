/** Поручения (server/src/tasks): видимость, переходы машины состояний, уведомления. */
import type { Comment, CreateTaskRequest, Page, TaskDetail, TaskListItem, TaskPermissions, TaskScope, UpdateTaskRequest } from '../api/types';
import { TASK_STATUS_LABELS } from '../../../server/src/labels';
import { conflict, forbidden, unprocessable } from '../../../server/src/errors';
import {
  type Actor,
  type Paging,
  audit,
  clean,
  docVisible,
  fail422,
  ilike,
  iso,
  isoReq,
  isTaskOverdue,
  nextNumber,
  notify,
  notifyMany,
  pageOf,
  parseDueAt,
  q,
  refOf,
  requireActiveUsers,
  requireDocument,
  requireTask,
  requireText,
  taskVisible,
  uniq,
} from './core';
import { type TaskRow, db, nextId, now } from './db';
import { loadComments } from './documents';
import { listFiles } from './files';

export const TASK_PREFIX = 'ПОР';

export interface TaskFilters {
  q?: string;
  scope?: TaskScope;
  statuses?: string[];
  overdue?: boolean;
  documentId?: number;
  assigneeId?: number;
  overdueMine?: boolean;
}

export function filterTasks(actor: Actor, f: TaskFilters): TaskRow[] {
  const me = actor.id;
  return db.tasks
    .filter((t) => {
      if (!taskVisible(actor, t)) return false;
      if (f.q?.trim() && !ilike(t.number, f.q.trim()) && !ilike(t.title, f.q.trim())) return false;
      if (f.scope === 'assigned' && t.assignee_id !== me) return false;
      if (f.scope === 'authored' && t.author_id !== me) return false;
      if (f.statuses?.length && !f.statuses.includes(t.status)) return false;
      if (f.overdue && !isTaskOverdue(t)) return false;
      if (f.documentId && t.document_id !== f.documentId) return false;
      if (f.assigneeId && t.assignee_id !== f.assigneeId) return false;
      if (f.overdueMine) {
        if (!isTaskOverdue(t)) return false;
        const mine = (['new', 'in_progress'].includes(t.status) && t.assignee_id === me) || (t.status === 'review' && t.author_id === me);
        if (!mine) return false;
      }
      return true;
    })
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}

function toListItem(t: TaskRow, actor: Actor): TaskListItem {
  const d = t.document_id ? db.documents.find((x) => x.id === t.document_id) : undefined;
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    status: t.status,
    statusLabel: TASK_STATUS_LABELS[t.status],
    author: refOf(t.author_id),
    assignee: refOf(t.assignee_id),
    dueAt: iso(t.due_at),
    overdue: isTaskOverdue(t),
    createdAt: isoReq(t.created_at),
    document: d ? { id: d.id, number: d.number, title: d.title, accessible: docVisible(actor, d) } : null,
  };
}

export function queryTasks(actor: Actor, f: TaskFilters, p: Paging): Page<TaskListItem> {
  const page = pageOf(filterTasks(actor, f), p);
  return { ...page, items: page.items.map((t) => toListItem(t, actor)) };
}

export const getTaskDetail = (actor: Actor, id: number): TaskDetail => buildTaskDetail(actor, requireTask(actor, id));

const observersOf = (taskId: number): number[] =>
  db.taskObservers
    .filter((o) => o.task_id === taskId)
    .map((o) => o.user_id)
    .sort((a, b) => a - b);

function buildTaskDetail(actor: Actor, task: TaskRow): TaskDetail {
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
    ...toListItem(task, actor),
    body: task.body,
    resultText: task.result_text,
    updatedAt: isoReq(task.updated_at),
    completedAt: iso(task.completed_at),
    observers: observersOf(task.id).map(refOf),
    files: listFiles('task', task.id),
    comments: loadComments('task', task.id),
    permissions,
  };
}

function setObservers(taskId: number, ids: number[]): void {
  db.taskObservers = db.taskObservers.filter((o) => o.task_id !== taskId);
  for (const user_id of ids) db.taskObservers.push({ task_id: taskId, user_id });
}

const taskRef = (t: Pick<TaskRow, 'number' | 'title'>): string => `${t.number} ${q(t.title)}`;

export function createTask(actor: Actor, input: CreateTaskRequest): TaskDetail {
  const title = requireText(input.title, 'Укажите название поручения', 'title');
  requireActiveUsers([input.assigneeId], 'assigneeId');
  const observers = uniq(input.observerIds ?? []);
  requireActiveUsers(observers, 'observerIds');
  let docNumber: string | null = null;
  if (input.documentId) docNumber = requireDocument(actor, input.documentId).number;
  const dueAt = parseDueAt(input.dueAt);
  const number = nextNumber(TASK_PREFIX);
  const t = now();
  const task: TaskRow = {
    id: nextId('tasks'),
    number,
    title,
    body: clean(input.body),
    author_id: actor.id,
    assignee_id: input.assigneeId,
    due_at: dueAt,
    document_id: input.documentId ?? null,
    status: 'new',
    result_text: null,
    created_at: t,
    updated_at: t,
    completed_at: null,
  };
  db.tasks.push(task);
  setObservers(task.id, observers);
  audit({
    actorId: actor.id,
    entityType: 'task',
    entityId: task.id,
    action: 'task.created',
    summary: docNumber ? `Создано поручение ${number} на основании документа ${docNumber}` : `Создано поручение ${number} (без документа-основания)`,
    details: { number, assigneeId: input.assigneeId, documentId: input.documentId ?? null },
  });
  if (input.documentId) {
    audit({
      actorId: actor.id,
      entityType: 'document',
      entityId: input.documentId,
      action: 'task.created',
      summary: `По документу создано поручение ${number}`,
      details: { taskId: task.id, number, assigneeId: input.assigneeId },
    });
  }
  if (input.assigneeId !== actor.id) {
    notify({
      userId: input.assigneeId,
      type: 'task_assigned',
      title: `Новое поручение ${number}`,
      body: `Вам назначено поручение ${taskRef(task)}. Постановщик — ${actor.fullName}.`,
      entityType: 'task',
      entityId: task.id,
    });
  }
  return buildTaskDetail(actor, task);
}

function requireOpen(task: TaskRow): void {
  if (task.status === 'done' || task.status === 'cancelled') {
    throw conflict(`Поручение завершено (статус ${q(TASK_STATUS_LABELS[task.status])}) и не может быть изменено`);
  }
}

export function updateTask(actor: Actor, id: number, input: UpdateTaskRequest): TaskDetail {
  const task = requireTask(actor, id);
  if (task.author_id !== actor.id) throw forbidden('Изменять поручение может только постановщик');
  requireOpen(task);
  const patch: Partial<TaskRow> = {};
  const changed: string[] = [];
  const changes: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const title = requireText(input.title, 'Укажите название поручения', 'title');
    if (title !== task.title) {
      patch.title = title;
      changed.push('название');
    }
  }
  if (input.body !== undefined && clean(input.body) !== task.body) {
    patch.body = clean(input.body);
    changed.push('содержание');
  }
  if (input.dueAt !== undefined) {
    const due = parseDueAt(input.dueAt);
    if (due !== task.due_at) {
      patch.due_at = due;
      changed.push('срок');
      changes.dueAt = { from: iso(task.due_at), to: iso(due) };
    }
  }
  let newAssignee: number | null = null;
  if (input.assigneeId !== undefined && input.assigneeId !== task.assignee_id) {
    requireActiveUsers([input.assigneeId], 'assigneeId');
    if (task.status === 'review') throw conflict('Нельзя сменить исполнителя, пока результат находится на проверке');
    patch.assignee_id = input.assigneeId;
    patch.status = 'new';
    changed.push('исполнитель');
    changes.assigneeId = { from: task.assignee_id, to: input.assigneeId };
    newAssignee = input.assigneeId;
  }
  if (input.observerIds !== undefined) {
    const next = uniq(input.observerIds);
    const old = observersOf(id);
    if (old.length !== next.length || old.some((o) => !next.includes(o))) {
      requireActiveUsers(next.filter((n) => !old.includes(n)), 'observerIds');
      setObservers(id, next);
      changed.push('наблюдатели');
      changes.observerIds = { from: old, to: next };
    }
  }
  if (!changed.length) return buildTaskDetail(actor, task);
  const prevAssignee = task.assignee_id;
  Object.assign(task, patch, { updated_at: now() });
  audit({ actorId: actor.id, entityType: 'task', entityId: id, action: 'task.updated', summary: `Поручение изменено: ${changed.join(', ')}`, details: { changes } });
  if (newAssignee) {
    if (newAssignee !== actor.id) {
      notify({
        userId: newAssignee,
        type: 'task_assigned',
        title: `Новое поручение ${task.number}`,
        body: `Вам назначено поручение ${taskRef(task)}. Постановщик — ${actor.fullName}.`,
        entityType: 'task',
        entityId: id,
      });
    }
    if (prevAssignee !== actor.id) {
      notify({ userId: prevAssignee, type: 'task_changed', title: `Поручение ${task.number} передано другому исполнителю`, body: 'Ваше участие в поручении больше не требуется.' });
    }
  } else if (changes.dueAt && task.assignee_id !== actor.id) {
    notify({
      userId: task.assignee_id,
      type: 'task_changed',
      title: `Изменён срок поручения ${task.number}`,
      body: `Постановщик изменил срок поручения ${taskRef(task)}.`,
      entityType: 'task',
      entityId: id,
    });
  }
  return buildTaskDetail(actor, task);
}

export type Transition = 'start' | 'submit' | 'accept' | 'return' | 'cancel';

/** Переходы машины состояний поручения. */
export function transitionTask(actor: Actor, id: number, action: Transition, textRaw?: string): TaskDetail {
  const task = requireTask(actor, id);
  const text = clean(textRaw);
  const isAuthor = task.author_id === actor.id;
  const isAssignee = task.assignee_id === actor.id;
  const set = (patch: Partial<TaskRow>) => Object.assign(task, patch, { updated_at: now() });
  switch (action) {
    case 'start': {
      if (!isAssignee) throw forbidden('Взять поручение в работу может только исполнитель');
      if (task.status === 'in_progress') return buildTaskDetail(actor, task);
      if (task.status !== 'new') throw conflict(`Действие недоступно в статусе ${q(TASK_STATUS_LABELS[task.status])}`);
      set({ status: 'in_progress' });
      audit({ actorId: actor.id, entityType: 'task', entityId: id, action: 'task.started', summary: 'Поручение взято в работу' });
      break;
    }
    case 'submit': {
      if (!isAssignee) throw forbidden('Передать результат на проверку может только исполнитель');
      if (!text) throw unprocessable('Укажите результат исполнения', [{ field: 'resultText', message: 'Результат исполнения обязателен' }]);
      if (task.status === 'review' && task.result_text === text) return buildTaskDetail(actor, task);
      if (task.status !== 'new' && task.status !== 'in_progress') throw conflict(`Действие недоступно в статусе ${q(TASK_STATUS_LABELS[task.status])}`);
      set({ status: 'review', result_text: text });
      audit({ actorId: actor.id, entityType: 'task', entityId: id, action: 'task.submitted', summary: 'Результат передан постановщику на проверку', details: { resultText: text } });
      notify({
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
      if (task.status === 'done') return buildTaskDetail(actor, task);
      if (task.status !== 'review') throw conflict('Принять можно только результат, переданный на проверку');
      set({ status: 'done', completed_at: now() });
      audit({ actorId: actor.id, entityType: 'task', entityId: id, action: 'task.accepted', summary: 'Результат принят, поручение выполнено' });
      notify({
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
      set({ status: 'in_progress' });
      db.comments.push({ id: nextId('comments'), entity_type: 'task', entity_id: id, author_id: actor.id, body: text, created_at: now() });
      audit({ actorId: actor.id, entityType: 'task', entityId: id, action: 'task.returned', summary: 'Поручение возвращено в работу', details: { comment: text } });
      notify({
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
      if (task.status === 'cancelled') return buildTaskDetail(actor, task);
      requireOpen(task);
      set({ status: 'cancelled', completed_at: now() });
      audit({ actorId: actor.id, entityType: 'task', entityId: id, action: 'task.cancelled', summary: `Поручение отменено. Причина: ${text}`, details: { reason: text } });
      if (!isAssignee) {
        notify({ userId: task.assignee_id, type: 'task_cancelled', title: `Поручение ${task.number} отменено`, body: `Причина: ${text.slice(0, 300)}`, entityType: 'task', entityId: id });
      }
      break;
    }
  }
  return buildTaskDetail(actor, task);
}

export function addTaskComment(actor: Actor, id: number, bodyRaw: string): Comment {
  const task = requireTask(actor, id);
  const body = clean(bodyRaw);
  if (!body) throw fail422('Комментарий не может быть пустым', 'body');
  const c = { id: nextId('comments'), entity_type: 'task' as const, entity_id: id, author_id: actor.id, body, created_at: now() };
  db.comments.push(c);
  audit({ actorId: actor.id, entityType: 'task', entityId: id, action: 'comment.added', summary: 'Добавлен комментарий', details: { commentId: c.id } });
  notifyMany([task.author_id, task.assignee_id].filter((u) => u !== actor.id), {
    type: 'comment_added',
    title: `Новый комментарий к поручению ${task.number}`,
    body: `В поручении ${task.number} новый комментарий. Автор — ${actor.fullName}.`,
    entityType: 'task',
    entityId: id,
  });
  return { id: c.id, author: refOf(actor.id), body, createdAt: isoReq(c.created_at) };
}
