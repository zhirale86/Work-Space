import type { BitrixLinkState, DocKind, DocStatus, StepState, TaskStatus } from '../api/types';

/** Статус документа → модификатор метки (docs/03-ux.md, 3.1). */
export const DOC_BADGE: Record<DocStatus, string> = {
  draft: 'badge--draft',
  in_review: 'badge--review',
  rework: 'badge--rework',
  on_signing: 'badge--signing',
  approved: 'badge--approved',
  rejected: 'badge--rejected',
  cancelled: 'badge--cancelled',
  archived: 'badge--archived',
};

export const TASK_BADGE: Record<TaskStatus, string> = {
  new: 'badge--new',
  in_progress: 'badge--work',
  review: 'badge--check',
  done: 'badge--done',
  cancelled: 'badge--cancelled',
};

export const APPROVAL_STATUS_LABELS: Record<DocStatus, string> = {
  draft: 'Черновик',
  in_review: 'На согласовании',
  rework: 'На доработке',
  on_signing: 'На утверждении',
  approved: 'Согласовано',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
  archived: 'В архиве',
};

export const ORDER_STATUS_LABELS: Record<DocStatus, string> = {
  draft: 'Черновик',
  in_review: 'На согласовании',
  rework: 'На доработке',
  on_signing: 'На утверждении',
  approved: 'Утверждён',
  rejected: 'Отклонён',
  cancelled: 'Отменён',
  archived: 'В архиве',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  new: 'Новое',
  in_progress: 'В работе',
  review: 'На проверке',
  done: 'Выполнено',
  cancelled: 'Отменено',
};

export const APPROVAL_STATUSES: DocStatus[] = ['draft', 'in_review', 'rework', 'approved', 'rejected', 'cancelled'];
export const ORDER_STATUSES: DocStatus[] = ['draft', 'in_review', 'rework', 'on_signing', 'approved', 'rejected', 'cancelled', 'archived'];
export const TASK_STATUSES: TaskStatus[] = ['new', 'in_progress', 'review', 'done', 'cancelled'];

export const statusLabel = (kind: DocKind, s: DocStatus) => (kind === 'order' ? ORDER_STATUS_LABELS[s] : APPROVAL_STATUS_LABELS[s]);

/** Шаг маршрута → модификатор (3.1, последний абзац). */
export const STEP_CLASS: Record<StepState, string> = {
  waiting: 'route__step--waiting',
  pending: 'route__step--current',
  approved: 'route__step--done',
  rework: 'route__step--rework',
  rejected: 'route__step--rejected',
  skipped: 'route__step--skipped',
  replaced: 'route__step--replaced',
};

/** Метка решения участника. `waiting` — без метки. */
export const STEP_BADGE: Record<StepState, { cls: string; text: string } | null> = {
  waiting: null,
  pending: { cls: 'badge--review', text: 'Ожидается решение' },
  approved: { cls: 'badge--approved', text: 'Согласовано' },
  rework: { cls: 'badge--rework', text: 'Вернул на доработку' },
  rejected: { cls: 'badge--rejected', text: 'Отклонено' },
  skipped: { cls: 'badge--muted', text: 'Не потребовалось' },
  replaced: { cls: 'badge--muted', text: 'Заменён' },
};

export const SYNC_BADGE: Record<BitrixLinkState, { cls: string; text: string }> = {
  synced: { cls: 'badge--sync-ok', text: 'Статус передан' },
  pending: { cls: 'badge--sync-pending', text: 'Ожидает отправки' },
  error: { cls: 'badge--sync-error', text: 'Ошибка передачи' },
};

export const FINISHED_DOC: DocStatus[] = ['approved', 'rejected', 'cancelled', 'archived'];

/** Адрес карточки документа по виду. */
export const docPath = (kind: DocKind, id: number) => (kind === 'order' ? `/orders/${id}` : `/approvals/${id}`);
export const docEditPath = (kind: DocKind, id: number) => `${docPath(kind, id)}/edit`;

export const ROLE_HINTS: Record<string, string> = {
  employee: 'Создаёт документы и поручения, согласует по назначению. Включена всегда.',
  signer: 'Может быть выбран утверждающим приказов.',
  admin: 'Управляет пользователями, справочниками и интеграцией; содержимое документов не видит без доступа.',
  auditor: 'Видит отчёты и сводки ознакомления по всей компании.',
};

/** Полный адрес страницы приложения (в демонстрационной сборке — с hash-маршрутом для file://). */
export function absoluteUrl(path: string): string {
  return import.meta.env.VITE_DEMO === '1' ? `${window.location.href.split('#')[0]}#${path}` : `${window.location.origin}${path}`;
}
