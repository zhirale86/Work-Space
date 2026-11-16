/** Главная, отчёты и проверка сроков (server/src/reports, jobs/deadlines). */
import type {
  ApprovalsByDepartmentItem,
  ApprovalsByEmployeeItem,
  DashboardResponse,
  OrderAcknowledgementReportItem,
  ReportCode,
  ReportResponse,
  ReportSummaryResponse,
} from '../api/types';
import { REPORT_LABELS } from '../../../server/src/labels';
import { notFound } from '../../../server/src/errors';
import { type Actor, type Paging, byName, deptRef, docVisible, formatDateTimeRu, notify, pageOf, refOf, uniq, userById } from './core';
import { db, now } from './db';
import { type DocumentFilters, acknowledgementSummary, filterDocuments, queryDocuments } from './documents';
import { type TaskFilters, filterTasks, queryTasks } from './tasks';
import { approverMatch, stepsOf } from './reportsExt';

const SHORT: Paging = { page: 1, pageSize: 5 };

export function dashboard(actor: Actor): DashboardResponse {
  const docBlock = (f: DocumentFilters) => {
    const p = queryDocuments(actor, f, SHORT);
    return { count: p.total, items: p.items };
  };
  const taskBlock = (f: TaskFilters) => {
    const p = queryTasks(actor, f, SHORT);
    return { count: p.total, items: p.items };
  };
  const overdueDocs = queryDocuments(actor, { overdueMine: true }, SHORT);
  const overdueTasks = queryTasks(actor, { overdueMine: true }, SHORT);
  return {
    toApprove: docBlock({ scope: 'to_approve' }),
    rework: docBlock({ scope: 'mine', statuses: ['rework'] }),
    toSign: docBlock({ scope: 'to_sign' }),
    toAcknowledge: docBlock({ scope: 'to_acknowledge' }),
    myTasks: taskBlock({ scope: 'assigned', statuses: ['new', 'in_progress'] }),
    tasksToReview: taskBlock({ scope: 'authored', statuses: ['review'] }),
    overdue: { count: overdueDocs.total + overdueTasks.total, documents: overdueDocs.items, tasks: overdueTasks.items },
    unreadNotifications: db.notifications.filter((n) => n.user_id === actor.id && n.read_at === null).length,
  };
}

const DOC_REPORTS: Partial<Record<ReportCode, DocumentFilters>> = {
  approvals_in_progress: { statuses: ['in_review', 'on_signing'] },
  approvals_overdue: { overdue: true },
  documents_rework: { statuses: ['rework'] },
  orders_pending_acknowledgement: { pendingAcknowledgement: true },
};
const TASK_REPORTS: Partial<Record<ReportCode, TaskFilters>> = {
  tasks_in_progress: { statuses: ['new', 'in_progress', 'review'] },
  tasks_overdue: { overdue: true },
};

export interface ReportFilter {
  userId?: number;
  departmentId?: number;
}

/** Каждый показатель — число различных документов (совпадает со списком при провале в цифру). */
function byEmployee(actor: Actor, f: ReportFilter): ApprovalsByEmployeeItem[] {
  const map = new Map<number, ApprovalsByEmployeeItem>();
  for (const d of db.documents) {
    if (!docVisible(actor, d)) continue;
    const users = uniq(db.steps.filter((s) => db.rounds.some((r) => r.id === s.round_id && r.document_id === d.id)).map((s) => s.user_id));
    for (const uid of users) {
      if (!stepsOf(uid, d.id).length) continue;
      if (f.userId && uid !== f.userId) continue;
      if (f.departmentId && userById(uid)?.department_id !== f.departmentId) continue;
      const it = map.get(uid) ?? { user: refOf(uid), pending: 0, overdue: 0, approved: 0, returned: 0, rejected: 0, total: 0 };
      if (approverMatch(d, uid, 'pending')) it.pending++;
      if (approverMatch(d, uid, 'overdue')) it.overdue++;
      if (approverMatch(d, uid, 'approved')) it.approved++;
      if (approverMatch(d, uid, 'rework')) it.returned++;
      if (approverMatch(d, uid, 'rejected')) it.rejected++;
      it.total++;
      map.set(uid, it);
    }
  }
  return [...map.keys()].sort((a, b) => byName(a, b) || a - b).map((k) => map.get(k)!);
}

function byDepartment(actor: Actor, f: ReportFilter): ApprovalsByDepartmentItem[] {
  const map = new Map<number, ApprovalsByDepartmentItem>();
  for (const d of db.documents) {
    if (!docVisible(actor, d) || d.status === 'draft') continue;
    if (f.userId && d.initiator_id !== f.userId) continue;
    if (f.departmentId && d.department_id !== f.departmentId) continue;
    const key = d.department_id ?? 0;
    const it = map.get(key) ?? { department: deptRef(d.department_id), inProgress: 0, rework: 0, approved: 0, rejected: 0, cancelled: 0, total: 0 };
    if (d.status === 'in_review' || d.status === 'on_signing') it.inProgress++;
    if (d.status === 'rework') it.rework++;
    if (d.status === 'approved' || d.status === 'archived') it.approved++;
    if (d.status === 'rejected') it.rejected++;
    if (d.status === 'cancelled') it.cancelled++;
    it.total++;
    map.set(key, it);
  }
  return [...map.values()].sort((a, b) => (a.department ? (b.department ? a.department.name.localeCompare(b.department.name, 'ru') : -1) : 1));
}

export function reportSummary(actor: Actor): ReportSummaryResponse {
  return {
    items: (Object.keys(REPORT_LABELS) as ReportCode[]).map((code) => {
      let count: number;
      if (DOC_REPORTS[code]) count = filterDocuments(actor, DOC_REPORTS[code]!).length;
      else if (TASK_REPORTS[code]) count = filterTasks(actor, TASK_REPORTS[code]!).length;
      else if (code === 'approvals_by_employee') count = byEmployee(actor, {}).length;
      else count = byDepartment(actor, {}).length;
      return { code, label: REPORT_LABELS[code], count };
    }),
  };
}

export function report(actor: Actor, code: string, f: ReportFilter, pg: Paging): ReportResponse {
  if (!(code in REPORT_LABELS)) throw notFound('Отчёт не найден');
  const c = code as ReportCode;
  const label = REPORT_LABELS[c];
  switch (c) {
    case 'approvals_in_progress':
    case 'approvals_overdue':
    case 'documents_rework':
      return { code: c, label, ...queryDocuments(actor, { ...DOC_REPORTS[c], initiatorId: f.userId, departmentId: f.departmentId }, pg) };
    case 'orders_pending_acknowledgement': {
      const page = queryDocuments(actor, { ...DOC_REPORTS[c], initiatorId: f.userId, departmentId: f.departmentId }, pg);
      const items: OrderAcknowledgementReportItem[] = page.items.map((d) => {
        const s = acknowledgementSummary(d.id);
        return { ...d, ackTotal: s.total, ackDone: s.acknowledged, ackPending: s.pending };
      });
      return { code: c, label, ...page, items };
    }
    case 'tasks_in_progress':
    case 'tasks_overdue':
      return { code: c, label, ...queryTasks(actor, { ...TASK_REPORTS[c], assigneeId: f.userId }, pg) };
    case 'approvals_by_employee':
      return { code: c, label, ...pageOf(byEmployee(actor, f), pg) };
    case 'approvals_by_department':
      return { code: c, label, ...pageOf(byDepartment(actor, f), pg) };
  }
}

const SOON_HOURS = 24;

/** Проверка сроков: «Срок приближается» — за 24 часа, «Срок нарушен» — при наступлении; каждое — один раз. */
export function checkDeadlines(): void {
  const t = now();
  const limit = t + SOON_HOURS * 3600_000;
  for (const d of db.documents) {
    if (d.due_at === null || d.due_at > limit || !['in_review', 'on_signing', 'rework'].includes(d.status)) continue;
    const overdue = d.due_at <= t;
    const open = db.rounds.find((r) => r.document_id === d.id && r.finished_at === null);
    const pending = open ? db.steps.filter((s) => s.round_id === open.id && s.state === 'pending').map((s) => s.user_id) : [];
    let recipients = d.status === 'in_review' ? pending : d.status === 'on_signing' ? (d.signer_id ? [d.signer_id] : []) : [d.initiator_id];
    if (overdue) recipients = uniq([...recipients, d.initiator_id]);
    const what = d.kind === 'order' ? 'приказу' : 'документу';
    for (const userId of recipients) {
      notify({
        userId,
        type: overdue ? 'deadline_overdue' : 'deadline_soon',
        title: overdue ? `Срок нарушен: ${d.number}` : `Срок приближается: ${d.number}`,
        body: overdue ? `Срок по ${what} ${d.number} истёк ${formatDateTimeRu(d.due_at)}.` : `Срок по ${what} ${d.number} — ${formatDateTimeRu(d.due_at)}.`,
        entityType: 'document',
        entityId: d.id,
        dedupeKey: `deadline:${overdue ? 'overdue' : 'soon'}:document:${d.id}:${userId}:${d.due_at}`,
      });
    }
  }
  for (const k of db.tasks) {
    if (k.due_at === null || k.due_at > limit || ['done', 'cancelled'].includes(k.status)) continue;
    const overdue = k.due_at <= t;
    let recipients = k.status === 'review' ? [k.author_id] : [k.assignee_id];
    if (overdue) recipients = uniq([...recipients, k.author_id]);
    for (const userId of recipients) {
      notify({
        userId,
        type: overdue ? 'deadline_overdue' : 'deadline_soon',
        title: overdue ? `Срок нарушен: поручение ${k.number}` : `Срок приближается: поручение ${k.number}`,
        body: overdue
          ? `Срок исполнения поручения ${k.number} истёк ${formatDateTimeRu(k.due_at)}.`
          : `Срок исполнения поручения ${k.number} — ${formatDateTimeRu(k.due_at)}.`,
        entityType: 'task',
        entityId: k.id,
        dedupeKey: `deadline:${overdue ? 'overdue' : 'soon'}:task:${k.id}:${userId}:${k.due_at}`,
      });
    }
  }
}
