/**
 * Расширение отчётов (утверждается на демо, затем реализуется на сервере).
 *
 * GET /report-ext/my                       → MyApprovalsReport
 * GET /report-ext/drill?as=&id=&state=     → DrillReport  (as: approver | initiator | department)
 * GET /report-ext/all?state=&kind=&q=      → AllApprovalsReport (только admin и auditor, иначе 403)
 *
 * Каждый показатель — число различных документов; список под цифрой содержит ровно эти документы.
 */
import type { DocumentListItem, Page } from './types';

export type ApproverState = 'pending' | 'overdue' | 'approved' | 'rework' | 'rejected' | 'all';
export type InitiatorState = 'in_progress' | 'rework' | 'approved' | 'rejected' | 'cancelled' | 'all';
export type DrillAs = 'approver' | 'initiator' | 'department';
export type AllState = 'all' | 'active' | 'rework' | 'approved' | 'rejected' | 'cancelled';

export interface MyApprovalsReport {
  approver: Record<ApproverState, number>;
  initiator: Record<InitiatorState, number>;
}

export interface DrillReport extends Page<DocumentListItem> {
  /** Готовый заголовок списка, например «Петрова М. С. — согласовано». */
  title: string;
}

export interface AllApprovalsReport extends Page<DocumentListItem> {
  counts: Record<AllState, number>;
}

export const APPROVER_LABELS: Record<ApproverState, string> = {
  pending: 'Ждут решения',
  overdue: 'Просрочено',
  approved: 'Согласовано',
  rework: 'Возвращено на доработку',
  rejected: 'Отклонено',
  all: 'Всего',
};

export const INITIATOR_LABELS: Record<InitiatorState, string> = {
  in_progress: 'В работе',
  rework: 'На доработке',
  approved: 'Согласовано',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
  all: 'Всего',
};

export const ALL_LABELS: Record<AllState, string> = {
  all: 'Все',
  active: 'В работе',
  rework: 'На доработке',
  approved: 'Согласовано',
  rejected: 'Отклонено',
  cancelled: 'Отменено',
};

/** Пока сервер не реализует расширение, оно включено только в демо-сборке. */
export const REPORTS_EXT_ENABLED = import.meta.env.VITE_DEMO === '1';
