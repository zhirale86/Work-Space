import type {
  BitrixLinkState,
  Decision,
  DocKind,
  DocStatus,
  FileRole,
  LabeledCode,
  MockTaskStatus,
  MyDocumentAction,
  NotificationType,
  ReportCode,
  RoundOutcome,
  RouteMode,
  StepState,
  SystemRole,
  TaskStatus,
} from './api-types';

export const ROLE_LABELS: Record<SystemRole, string> = {
  employee: 'Сотрудник',
  signer: 'Утверждающий',
  admin: 'Администратор',
  auditor: 'Контроль документов',
};

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  approval: 'Согласование',
  order: 'Приказ',
};

export const DOC_STATUS_LABELS: Record<DocStatus, string> = {
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
  ...DOC_STATUS_LABELS,
  approved: 'Утверждён',
  rejected: 'Отклонён',
  cancelled: 'Отменён',
};

export function docStatusLabel(status: string, kind: string): string {
  const map = kind === 'order' ? ORDER_STATUS_LABELS : DOC_STATUS_LABELS;
  return map[status as DocStatus] ?? status;
}

export const ROUTE_MODE_LABELS: Record<RouteMode, string> = {
  sequential: 'Последовательное',
  parallel: 'Параллельное',
};

export const ROUND_OUTCOME_LABELS: Record<RoundOutcome, string> = {
  approved: 'Согласовано',
  rework: 'Возвращено на доработку',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};

export const STEP_STATE_LABELS: Record<StepState, string> = {
  waiting: 'Очередь не дошла',
  pending: 'Ожидается решение',
  approved: 'Согласовано',
  rework: 'Возвращено на доработку',
  rejected: 'Отклонено',
  skipped: 'Не потребовалось',
  replaced: 'Участник заменён',
};

export const DECISION_LABELS: Record<Decision, string> = {
  approve: 'Согласовать',
  rework: 'Вернуть на доработку',
  reject: 'Отклонить',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  new: 'Новое',
  in_progress: 'В работе',
  review: 'На проверке',
  done: 'Выполнено',
  cancelled: 'Отменено',
};

export const FILE_ROLE_LABELS: Record<FileRole, string> = {
  main: 'Основной документ',
  attachment: 'Приложение',
  result: 'Результат исполнения',
};

export const BITRIX_STATE_LABELS: Record<BitrixLinkState, string> = {
  pending: 'Ожидает передачи',
  synced: 'Передано',
  error: 'Ошибка передачи',
};

export const MOCK_TASK_STATUS_LABELS: Record<MockTaskStatus, string> = {
  in_progress: 'Выполняется',
  completed: 'Завершена',
};

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  approval_requested: 'Документ на согласование',
  approval_rework: 'Возврат на доработку',
  approval_rejected: 'Отклонение',
  approval_completed: 'Согласование завершено',
  approval_cancelled: 'Процесс отменён',
  sign_requested: 'Приказ на утверждение',
  order_signed: 'Приказ утверждён',
  acknowledge_requested: 'Ознакомление с приказом',
  route_changed: 'Изменение маршрута',
  reminder: 'Напоминание',
  participant_blocked: 'Требуется замена участника',
  task_assigned: 'Новое поручение',
  task_submitted: 'Результат на проверку',
  task_accepted: 'Поручение принято',
  task_returned: 'Поручение возвращено в работу',
  task_cancelled: 'Поручение отменено',
  task_changed: 'Поручение изменено',
  deadline_soon: 'Срок приближается',
  deadline_overdue: 'Срок нарушен',
  comment_added: 'Новый комментарий',
};

export const REPORT_LABELS: Record<ReportCode, string> = {
  approvals_in_progress: 'Согласования в работе',
  approvals_overdue: 'Согласования с нарушенным сроком',
  documents_rework: 'Документы на доработке',
  tasks_in_progress: 'Поручения в работе',
  tasks_overdue: 'Просроченные поручения',
  orders_pending_acknowledgement: 'Приказы, ожидающие ознакомления',
  approvals_by_employee: 'Согласования по сотрудникам',
  approvals_by_department: 'Согласования по подразделениям',
};

export const MY_ACTION_LABELS: Record<Exclude<MyDocumentAction, null>, string> = {
  approve: 'Ожидает вашего решения',
  sign: 'Ожидает вашего утверждения',
  acknowledge: 'Требуется ознакомление',
  rework: 'Требуется доработка',
};

export function labeled<T extends string>(map: Record<T, string>): LabeledCode<T>[] {
  return (Object.keys(map) as T[]).map((code) => ({ code, label: map[code] }));
}

/** «ёлочки» вокруг текста. */
export const q = (s: string): string => `«${s}»`;
