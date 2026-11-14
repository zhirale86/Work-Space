import type {
  ApprovalsByDepartmentItem,
  ApprovalsByEmployeeItem,
  DashboardResponse,
  OrderAcknowledgementReportItem,
  ReportCode,
  ReportResponse,
  ReportSummaryResponse,
} from '../api-types';
import { type Actor, type Paging, deptRef, loadUserRefs, pageOf, paging, refOf } from '../common';
import { type Db, one, rows } from '../db';
import { docVisibleSql } from '../documents/access';
import { type DocumentFilters, acknowledgementSummary, countDocuments, queryDocuments } from '../documents/service';
import { notFound } from '../errors';
import { REPORT_LABELS } from '../labels';
import { unreadCount } from '../notifications/service';
import { Params } from '../sql';
import { type TaskFilters, countTasks, queryTasks } from '../tasks/service';

const SHORT = paging({ page: 1, pageSize: 5 });

/** Главная страница: счётчики и короткие списки — только по объектам, доступным пользователю. */
export async function dashboard(db: Db, actor: Actor): Promise<DashboardResponse> {
  const docBlock = async (f: DocumentFilters) => {
    const p = await queryDocuments(db, actor, f, SHORT);
    return { count: p.total, items: p.items };
  };
  const taskBlock = async (f: TaskFilters) => {
    const p = await queryTasks(db, actor, f, SHORT);
    return { count: p.total, items: p.items };
  };
  const overdueDocs = await queryDocuments(db, actor, { overdueMine: true }, SHORT);
  const overdueTasks = await queryTasks(db, actor, { overdueMine: true }, SHORT);
  return {
    toApprove: await docBlock({ scope: 'to_approve' }),
    rework: await docBlock({ scope: 'mine', statuses: ['rework'] }),
    toSign: await docBlock({ scope: 'to_sign' }),
    toAcknowledge: await docBlock({ scope: 'to_acknowledge' }),
    myTasks: await taskBlock({ scope: 'assigned', statuses: ['new', 'in_progress'] }),
    tasksToReview: await taskBlock({ scope: 'authored', statuses: ['review'] }),
    overdue: { count: overdueDocs.total + overdueTasks.total, documents: overdueDocs.items, tasks: overdueTasks.items },
    unreadNotifications: await unreadCount(db, actor.id),
  };
}

export interface ReportFilter {
  userId?: number;
  departmentId?: number;
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

function byEmployeeSql(actor: Actor, f: ReportFilter, p: Params): string {
  const cond = [docVisibleSql(actor, 'd', p), `s.state IN ('pending','approved','rework','rejected')`];
  if (f.userId) cond.push(`s.user_id = ${p.add(f.userId)}`);
  if (f.departmentId) cond.push(`u.department_id = ${p.add(f.departmentId)}`);
  return `FROM approval_steps s
          JOIN approval_rounds r ON r.id = s.round_id
          JOIN documents d ON d.id = r.document_id
          JOIN users u ON u.id = s.user_id
         WHERE ${cond.join(' AND ')}`;
}

function byDepartmentSql(actor: Actor, f: ReportFilter, p: Params): string {
  const cond = [docVisibleSql(actor, 'd', p), `d.status <> 'draft'`];
  if (f.userId) cond.push(`d.initiator_id = ${p.add(f.userId)}`);
  if (f.departmentId) cond.push(`d.department_id = ${p.add(f.departmentId)}`);
  return `FROM documents d LEFT JOIN departments dep ON dep.id = d.department_id WHERE ${cond.join(' AND ')}`;
}

export async function reportSummary(db: Db, actor: Actor): Promise<ReportSummaryResponse> {
  const items: ReportSummaryResponse['items'] = [];
  for (const code of Object.keys(REPORT_LABELS) as ReportCode[]) {
    let count: number;
    if (DOC_REPORTS[code]) count = await countDocuments(db, actor, DOC_REPORTS[code]!);
    else if (TASK_REPORTS[code]) count = await countTasks(db, actor, TASK_REPORTS[code]!);
    else if (code === 'approvals_by_employee') {
      const p = new Params();
      const sql = byEmployeeSql(actor, {}, p);
      count = (await one<{ c: number }>(db, `SELECT count(DISTINCT s.user_id)::int AS c ${sql}`, p.values))?.c ?? 0;
    } else {
      const p = new Params();
      const sql = byDepartmentSql(actor, {}, p);
      count = (await one<{ c: number }>(db, `SELECT count(DISTINCT COALESCE(d.department_id, 0))::int AS c ${sql}`, p.values))?.c ?? 0;
    }
    items.push({ code, label: REPORT_LABELS[code], count });
  }
  return { items };
}

export async function report(db: Db, actor: Actor, code: string, f: ReportFilter, pg: Paging): Promise<ReportResponse> {
  if (!(code in REPORT_LABELS)) throw notFound('Отчёт не найден');
  const c = code as ReportCode;
  const label = REPORT_LABELS[c];
  switch (c) {
    case 'approvals_in_progress':
    case 'approvals_overdue':
    case 'documents_rework': {
      const page = await queryDocuments(db, actor, { ...DOC_REPORTS[c], initiatorId: f.userId, departmentId: f.departmentId }, pg);
      return { code: c, label, ...page };
    }
    case 'orders_pending_acknowledgement': {
      const page = await queryDocuments(db, actor, { ...DOC_REPORTS[c], initiatorId: f.userId, departmentId: f.departmentId }, pg);
      const items: OrderAcknowledgementReportItem[] = [];
      for (const d of page.items) {
        const s = await acknowledgementSummary(db, d.id);
        items.push({ ...d, ackTotal: s.total, ackDone: s.acknowledged, ackPending: s.pending });
      }
      return { code: c, label, ...page, items };
    }
    case 'tasks_in_progress':
    case 'tasks_overdue': {
      const page = await queryTasks(db, actor, { ...TASK_REPORTS[c], assigneeId: f.userId }, pg);
      return { code: c, label, ...page };
    }
    case 'approvals_by_employee': {
      const p = new Params();
      const sql = byEmployeeSql(actor, f, p);
      const total = (await one<{ c: number }>(db, `SELECT count(DISTINCT s.user_id)::int AS c ${sql}`, p.values))?.c ?? 0;
      const list = await rows<{ user_id: number; pending: number; overdue: number; approved: number; returned: number; rejected: number; total: number }>(
        db,
        `SELECT s.user_id,
                count(*) FILTER (WHERE s.state = 'pending')::int AS pending,
                count(*) FILTER (WHERE s.state = 'pending' AND d.due_at < now())::int AS overdue,
                count(*) FILTER (WHERE s.state = 'approved')::int AS approved,
                count(*) FILTER (WHERE s.state = 'rework')::int AS returned,
                count(*) FILTER (WHERE s.state = 'rejected')::int AS rejected,
                count(*)::int AS total
           ${sql}
          GROUP BY s.user_id, u.full_name ORDER BY u.full_name, s.user_id
          LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
        p.values,
      );
      const users = await loadUserRefs(db, list.map((r) => r.user_id));
      const items: ApprovalsByEmployeeItem[] = list.map((r) => ({
        user: refOf(users, r.user_id),
        pending: r.pending,
        overdue: r.overdue,
        approved: r.approved,
        returned: r.returned,
        rejected: r.rejected,
        total: r.total,
      }));
      return { code: c, label, ...pageOf(items, total, pg) };
    }
    case 'approvals_by_department': {
      const p = new Params();
      const sql = byDepartmentSql(actor, f, p);
      const total = (await one<{ c: number }>(db, `SELECT count(DISTINCT COALESCE(d.department_id, 0))::int AS c ${sql}`, p.values))?.c ?? 0;
      const list = await rows<{ department_id: number | null; name: string | null; in_progress: number; rework: number; approved: number; rejected: number; cancelled: number; total: number }>(
        db,
        `SELECT d.department_id, dep.name,
                count(*) FILTER (WHERE d.status IN ('in_review','on_signing'))::int AS in_progress,
                count(*) FILTER (WHERE d.status = 'rework')::int AS rework,
                count(*) FILTER (WHERE d.status IN ('approved','archived'))::int AS approved,
                count(*) FILTER (WHERE d.status = 'rejected')::int AS rejected,
                count(*) FILTER (WHERE d.status = 'cancelled')::int AS cancelled,
                count(*)::int AS total
           ${sql}
          GROUP BY d.department_id, dep.name ORDER BY dep.name NULLS LAST
          LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
        p.values,
      );
      const items: ApprovalsByDepartmentItem[] = list.map((r) => ({
        department: deptRef(r.department_id, r.name),
        inProgress: r.in_progress,
        rework: r.rework,
        approved: r.approved,
        rejected: r.rejected,
        cancelled: r.cancelled,
        total: r.total,
      }));
      return { code: c, label, ...pageOf(items, total, pg) };
    }
  }
}
