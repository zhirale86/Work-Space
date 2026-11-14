import type {
  AcknowledgementSummary,
  ApprovalRound,
  ApprovalStep,
  Comment,
  CreateDocumentRequest,
  DealRef,
  DocStatus,
  DocType,
  DocumentDetail,
  DocumentListItem,
  DocumentPermissions,
  DocumentScope,
  DocumentTaskRef,
  MyDocumentAction,
  Page,
  RoundOutcome,
  RouteMode,
  StepState,
  UpdateDocumentRequest,
  UserRef,
} from '../api-types';
import { audit } from '../audit/service';
import { getBitrixAdapter } from '../bitrix/adapter';
import { getLink, toLinkInfo } from '../bitrix/sync';
import {
  type Actor,
  type Paging,
  clean,
  deptRef,
  iso,
  isAdmin,
  isAuditor,
  like,
  loadUserRefs,
  pageOf,
  parseDueAt,
  refOf,
  requireActiveUsers,
  uniq,
} from '../common';
import { type Db, one, rows, tx } from '../db';
import { AppError, conflict, notFound, unprocessable } from '../errors';
import { listFiles, roundFilesMap } from '../files/service';
import { removeStored } from '../files/storage';
import {
  DOC_KIND_LABELS,
  MY_ACTION_LABELS,
  ROUND_OUTCOME_LABELS,
  ROUTE_MODE_LABELS,
  STEP_STATE_LABELS,
  TASK_STATUS_LABELS,
  docStatusLabel,
} from '../labels';
import { notifyMany } from '../notifications/service';
import { Params } from '../sql';
import { type TaskRow, isTaskOverdue, taskVisibleSql } from '../tasks/access';
import { type DocRow, DOC_OVERDUE_SQL, docVisibleSql, isDocOverdue, requireDocument, requireInitiator } from './access';

// ───────────── Типы документов ─────────────

export interface DocTypeRow {
  id: number;
  code: string;
  name: string;
  kind: 'approval' | 'order';
  number_prefix: string;
  active: boolean;
  require_deal: boolean;
  require_file: boolean;
  require_excel: boolean;
  require_deadline: boolean;
  require_description: boolean;
}

export function toDocType(t: DocTypeRow): DocType {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    kind: t.kind,
    kindLabel: DOC_KIND_LABELS[t.kind],
    numberPrefix: t.number_prefix,
    active: t.active,
    requireDeal: t.require_deal,
    requireFile: t.require_file,
    requireExcel: t.require_excel,
    requireDeadline: t.require_deadline,
    requireDescription: t.require_description,
  };
}

/** Следующий номер: отдельный счётчик на префикс и год; атомарно даже при одновременном создании. */
export async function nextNumber(db: Db, prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const r = await one<{ value: number }>(
    db,
    `INSERT INTO counters (key, value) VALUES ($1, 1)
     ON CONFLICT (key) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [`${prefix}-${year}`],
  );
  return `${prefix}-${year}-${String(r!.value).padStart(6, '0')}`;
}

// ───────────── Списки ─────────────

interface ListRow extends DocRow {
  type_code: string;
  type_name: string;
  department_name: string | null;
  my_action: MyDocumentAction;
}

const pendingStepSql = (d: string, u: string): string =>
  `EXISTS (SELECT 1 FROM approval_steps ms JOIN approval_rounds mr ON mr.id = ms.round_id
            WHERE mr.document_id = ${d}.id AND mr.finished_at IS NULL AND ms.user_id = ${u} AND ms.state = 'pending')`;

const needAckSql = (d: string, u: string): string =>
  `(${d}.kind = 'order' AND ${d}.status = 'approved'
    AND EXISTS (SELECT 1 FROM document_participants ap WHERE ap.document_id = ${d}.id AND ap.user_id = ${u} AND ap.role = 'acquaintance')
    AND NOT EXISTS (SELECT 1 FROM acknowledgements ak WHERE ak.document_id = ${d}.id AND ak.user_id = ${u}))`;

function myActionSql(d: string, u: string): string {
  return `CASE
    WHEN ${d}.status = 'in_review' AND ${pendingStepSql(d, u)} THEN 'approve'
    WHEN ${d}.status = 'on_signing' AND ${d}.signer_id = ${u} THEN 'sign'
    WHEN ${d}.status = 'rework' AND ${d}.initiator_id = ${u} THEN 'rework'
    WHEN ${needAckSql(d, u)} THEN 'acknowledge'
    ELSE NULL END`;
}

export interface DocumentFilters {
  q?: string;
  scope?: DocumentScope;
  kind?: string;
  typeId?: number;
  statuses?: string[];
  initiatorId?: number;
  departmentId?: number;
  createdFrom?: string;
  createdTo?: string;
  deal?: string;
  overdue?: boolean;
  /** Просрочено и действие ожидается от текущего пользователя. */
  overdueMine?: boolean;
  /** Приказы с незавершённым ознакомлением, сводку которых пользователь вправе видеть. */
  pendingAcknowledgement?: boolean;
}

function dealRef(d: Pick<DocRow, 'deal_id' | 'deal_title' | 'deal_url'>): DealRef | null {
  return d.deal_id ? { id: d.deal_id, title: d.deal_title, url: d.deal_url ?? getBitrixAdapter().dealUrl(d.deal_id) } : null;
}

function buildWhere(actor: Actor, f: DocumentFilters, p: Params): string {
  const u = p.add(actor.id);
  const cond: string[] = [docVisibleSql(actor, 'd', p)];
  if (f.q && f.q.trim()) {
    const pat = p.add(like(f.q.trim()));
    cond.push(`(d.number ILIKE ${pat} OR d.title ILIKE ${pat} OR d.deal_title ILIKE ${pat})`);
  }
  switch (f.scope) {
    case 'mine':
      cond.push(`d.initiator_id = ${u}`);
      break;
    case 'to_approve':
      cond.push(`d.status = 'in_review' AND ${pendingStepSql('d', u)}`);
      break;
    case 'to_sign':
      cond.push(`d.status = 'on_signing' AND d.signer_id = ${u}`);
      break;
    case 'to_acknowledge':
      cond.push(needAckSql('d', u));
      break;
    default:
      break;
  }
  if (f.kind) cond.push(`d.kind = ${p.add(f.kind)}`);
  if (f.typeId) cond.push(`d.doc_type_id = ${p.add(f.typeId)}`);
  if (f.statuses?.length) cond.push(`d.status = ANY(${p.add(f.statuses)}::text[])`);
  if (f.initiatorId) cond.push(`d.initiator_id = ${p.add(f.initiatorId)}`);
  if (f.departmentId) cond.push(`d.department_id = ${p.add(f.departmentId)}`);
  if (f.createdFrom) cond.push(`d.created_at >= ${p.add(f.createdFrom)}::date`);
  if (f.createdTo) cond.push(`d.created_at < ${p.add(f.createdTo)}::date + 1`);
  if (f.deal && f.deal.trim()) {
    const v = f.deal.trim();
    cond.push(`(d.deal_id = ${p.add(v)} OR d.deal_title ILIKE ${p.add(like(v))})`);
  }
  if (f.overdue) cond.push(DOC_OVERDUE_SQL('d'));
  if (f.overdueMine) {
    cond.push(
      `${DOC_OVERDUE_SQL('d')} AND ((d.status = 'in_review' AND ${pendingStepSql('d', u)})
        OR (d.status = 'on_signing' AND d.signer_id = ${u}) OR (d.status = 'rework' AND d.initiator_id = ${u}))`,
    );
  }
  if (f.pendingAcknowledgement) {
    cond.push(`d.kind = 'order' AND d.status = 'approved' AND ${PENDING_ACK_SQL}`);
    if (!isAuditor(actor)) cond.push(`(d.initiator_id = ${u} OR d.signer_id = ${u})`);
  }
  return cond.join(' AND ');
}

/** Есть активные сотрудники из списка ознакомления, не подтвердившие ознакомление. */
const PENDING_ACK_SQL = `EXISTS (SELECT 1 FROM document_participants ap JOIN users au ON au.id = ap.user_id AND au.active
   WHERE ap.document_id = d.id AND ap.role = 'acquaintance'
     AND NOT EXISTS (SELECT 1 FROM acknowledgements ak WHERE ak.document_id = d.id AND ak.user_id = ap.user_id))`;

export async function countDocuments(db: Db, actor: Actor, f: DocumentFilters): Promise<number> {
  const p = new Params();
  const where = buildWhere(actor, f, p);
  const r = await one<{ c: number }>(db, `SELECT count(*)::int AS c FROM documents d WHERE ${where}`, p.values);
  return r?.c ?? 0;
}

/** Общий запрос списка документов строго в пределах прав пользователя. */
export async function queryDocuments(
  db: Db,
  actor: Actor,
  f: DocumentFilters,
  pg: Paging,
): Promise<Page<DocumentListItem>> {
  const total = await countDocuments(db, actor, f);
  const p = new Params();
  const where = buildWhere(actor, f, p);
  const u = p.add(actor.id);
  const list = await rows<ListRow>(
    db,
    `SELECT d.*, t.code AS type_code, t.name AS type_name, dep.name AS department_name,
            ${myActionSql('d', u)} AS my_action
       FROM documents d
       JOIN doc_types t ON t.id = d.doc_type_id
       LEFT JOIN departments dep ON dep.id = d.department_id
      WHERE ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${p.add(pg.limit)} OFFSET ${p.add(pg.offset)}`,
    p.values,
  );
  const users = await loadUserRefs(db, list.map((r) => r.initiator_id));
  return pageOf(list.map((r) => toListItem(r, users)), total, pg);
}

export function toListItem(r: ListRow, users: Map<number, UserRef>): DocumentListItem {
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    kindLabel: DOC_KIND_LABELS[r.kind],
    type: { id: r.doc_type_id, code: r.type_code, name: r.type_name },
    title: r.title,
    status: r.status,
    statusLabel: docStatusLabel(r.status, r.kind),
    initiator: refOf(users, r.initiator_id),
    department: deptRef(r.department_id, r.department_name),
    createdAt: iso(r.created_at)!,
    dueAt: iso(r.due_at),
    overdue: isDocOverdue(r),
    deal: dealRef(r),
    myAction: r.my_action,
    myActionLabel: r.my_action ? MY_ACTION_LABELS[r.my_action] : null,
  };
}

// ───────────── Карточка ─────────────

interface RoundRow {
  id: number;
  round_no: number;
  mode: RouteMode;
  started_at: Date;
  started_by: number;
  finished_at: Date | null;
  outcome: RoundOutcome | null;
}
export interface StepRow {
  id: number;
  round_id: number;
  user_id: number;
  position: number;
  state: StepState;
  comment: string | null;
  activated_at: Date | null;
  decided_at: Date | null;
}

export function toStep(s: StepRow, users: Map<number, UserRef>): ApprovalStep {
  return {
    id: s.id,
    user: refOf(users, s.user_id),
    position: s.position,
    state: s.state,
    stateLabel: STEP_STATE_LABELS[s.state],
    comment: s.comment,
    activatedAt: iso(s.activated_at),
    decidedAt: iso(s.decided_at),
  };
}

export async function loadComments(db: Db, entityType: 'document' | 'task', entityId: number): Promise<Comment[]> {
  const list = await rows<{ id: number; author_id: number; body: string; created_at: Date }>(
    db,
    'SELECT id, author_id, body, created_at FROM comments WHERE entity_type = $1 AND entity_id = $2 ORDER BY id',
    [entityType, entityId],
  );
  const users = await loadUserRefs(db, list.map((c) => c.author_id));
  return list.map((c) => ({ id: c.id, author: refOf(users, c.author_id), body: c.body, createdAt: iso(c.created_at)! }));
}

export async function acknowledgementSummary(db: Db, docId: number): Promise<AcknowledgementSummary> {
  const list = await rows<{ user_id: number; active: boolean; acknowledged_at: Date | null; file_version_id: number | null; version_no: number | null }>(
    db,
    `SELECT p.user_id, u.active, a.acknowledged_at, a.file_version_id, v.version_no
       FROM document_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN acknowledgements a ON a.document_id = p.document_id AND a.user_id = p.user_id
       LEFT JOIN file_versions v ON v.id = a.file_version_id
      WHERE p.document_id = $1 AND p.role = 'acquaintance'
      ORDER BY u.full_name`,
    [docId],
  );
  const users = await loadUserRefs(db, list.map((r) => r.user_id));
  // Заблокированные сотрудники, не успевшие ознакомиться, исключаются из числа ожидаемых.
  const expected = list.filter((r) => r.active || r.acknowledged_at);
  const acknowledged = expected.filter((r) => r.acknowledged_at).length;
  return {
    total: expected.length,
    acknowledged,
    pending: expected.length - acknowledged,
    items: list.map((r) => ({
      user: refOf(users, r.user_id),
      acknowledgedAt: iso(r.acknowledged_at),
      fileVersionId: r.file_version_id,
      fileVersionNo: r.version_no,
    })),
  };
}

export async function getDocumentDetail(db: Db, actor: Actor, id: number): Promise<DocumentDetail> {
  const doc = await requireDocument(db, actor, id);
  return buildDetail(db, actor, doc);
}

export async function buildDetail(db: Db, actor: Actor, doc: DocRow): Promise<DocumentDetail> {
  const type = (await one<DocTypeRow>(db, 'SELECT * FROM doc_types WHERE id = $1', [doc.doc_type_id]))!;
  const dept = doc.department_id
    ? await one<{ name: string }>(db, 'SELECT name FROM departments WHERE id = $1', [doc.department_id])
    : null;
  const participants = await rows<{ user_id: number; role: string; position: number }>(
    db,
    'SELECT user_id, role, position FROM document_participants WHERE document_id = $1 ORDER BY position, user_id',
    [doc.id],
  );
  const roundRows = await rows<RoundRow>(db, 'SELECT * FROM approval_rounds WHERE document_id = $1 ORDER BY round_no DESC', [doc.id]);
  const stepRows = roundRows.length
    ? await rows<StepRow>(db, 'SELECT * FROM approval_steps WHERE round_id = ANY($1::int[]) ORDER BY position, id', [
        roundRows.map((r) => r.id),
      ])
    : [];
  const rf = await roundFilesMap(db, roundRows.map((r) => r.id));
  const accessRows = await rows<{ user_id: number | null; department_id: number | null; department_name: string | null }>(
    db,
    `SELECT a.user_id, a.department_id, d.name AS department_name
       FROM document_access a LEFT JOIN departments d ON d.id = a.department_id WHERE a.document_id = $1 ORDER BY a.id`,
    [doc.id],
  );
  const myAck = await one<{ acknowledged_at: Date }>(
    db,
    'SELECT acknowledged_at FROM acknowledgements WHERE document_id = $1 AND user_id = $2',
    [doc.id, actor.id],
  );
  const tp = new Params();
  const tDoc = tp.add(doc.id);
  const taskRows = await rows<TaskRow>(
    db,
    `SELECT t.* FROM tasks t WHERE t.document_id = ${tDoc} AND ${taskVisibleSql(actor, 't', tp)} ORDER BY t.id`,
    tp.values,
  );
  const link = doc.deal_id ? await getLink(db, doc.id) : null;

  const users = await loadUserRefs(db, [
    doc.initiator_id,
    doc.signer_id,
    ...participants.map((p) => p.user_id),
    ...roundRows.map((r) => r.started_by),
    ...stepRows.map((s) => s.user_id),
    ...accessRows.map((a) => a.user_id),
    ...taskRows.map((t) => t.assignee_id),
  ]);

  const rounds: ApprovalRound[] = roundRows.map((r) => ({
    id: r.id,
    roundNo: r.round_no,
    mode: r.mode,
    modeLabel: ROUTE_MODE_LABELS[r.mode],
    startedAt: iso(r.started_at)!,
    startedBy: refOf(users, r.started_by),
    finishedAt: iso(r.finished_at),
    outcome: r.outcome,
    outcomeLabel: r.outcome ? ROUND_OUTCOME_LABELS[r.outcome] : null,
    steps: stepRows.filter((s) => s.round_id === r.id).map((s) => toStep(s, users)),
    files: rf.get(r.id) ?? [],
  }));

  const openRound = roundRows.find((r) => !r.finished_at);
  const myStepRow = openRound
    ? stepRows.find((s) => s.round_id === openRound.id && s.user_id === actor.id && s.state !== 'replaced') ?? null
    : null;
  const inAcq = participants.some((p) => p.role === 'acquaintance' && p.user_id === actor.id);
  const isInit = doc.initiator_id === actor.id;
  const admin = isAdmin(actor);
  const auditor = isAuditor(actor);
  const isSigner = doc.signer_id === actor.id;
  const editable = doc.status === 'draft' || doc.status === 'rework';
  const active = ['draft', 'in_review', 'rework', 'on_signing'].includes(doc.status);

  let myAction: MyDocumentAction = null;
  if (doc.status === 'in_review' && myStepRow?.state === 'pending') myAction = 'approve';
  else if (doc.status === 'on_signing' && isSigner) myAction = 'sign';
  else if (doc.status === 'rework' && isInit) myAction = 'rework';
  else if (doc.kind === 'order' && doc.status === 'approved' && inAcq && !myAck) myAction = 'acknowledge';

  const canViewAck = doc.kind === 'order' && (isInit || isSigner || auditor);
  const reminded = doc.last_reminded_at && Date.now() - doc.last_reminded_at.getTime() < 24 * 3600 * 1000;

  const permissions: DocumentPermissions = {
    canEdit: isInit && editable,
    canDelete: isInit && doc.status === 'draft' && doc.launch_count === 0,
    canLaunch: isInit && editable,
    canManageFiles: isInit && editable,
    canDecide: myAction === 'approve',
    canSign: myAction === 'sign',
    canCancel: (isInit || admin) && active,
    canArchive: doc.kind === 'order' && doc.status === 'approved' && (isInit || admin),
    canAcknowledge: myAction === 'acknowledge',
    canChangeRoute: (isInit || admin) && doc.status === 'in_review',
    canManageAccess: isInit,
    canManageAcquaintance: isInit && doc.kind === 'order' && !['rejected', 'cancelled', 'archived'].includes(doc.status),
    canViewAcknowledgements: canViewAck,
    canRemind: isInit && (doc.status === 'in_review' || doc.status === 'on_signing') && !reminded,
    canCopy: isInit,
    canRetryBitrix: (isInit || admin) && !!link,
    canComment: true,
    canCreateTask: true,
  };

  const tasks: DocumentTaskRef[] = taskRows.map((t) => ({
    id: t.id,
    number: t.number,
    title: t.title,
    status: t.status,
    statusLabel: TASK_STATUS_LABELS[t.status],
    assignee: refOf(users, t.assignee_id),
    dueAt: iso(t.due_at),
    overdue: isTaskOverdue(t),
  }));

  return {
    id: doc.id,
    number: doc.number,
    kind: doc.kind,
    kindLabel: DOC_KIND_LABELS[doc.kind],
    type: toDocType(type),
    title: doc.title,
    description: doc.description,
    status: doc.status,
    statusLabel: docStatusLabel(doc.status, doc.kind),
    routeMode: doc.route_mode,
    routeModeLabel: ROUTE_MODE_LABELS[doc.route_mode],
    dueAt: iso(doc.due_at),
    overdue: isDocOverdue(doc),
    initiator: refOf(users, doc.initiator_id),
    department: deptRef(doc.department_id, dept?.name ?? null),
    deal: dealRef(doc),
    dealLocked: doc.launch_count > 0,
    signer: doc.signer_id ? refOf(users, doc.signer_id) : null,
    orderDate: doc.order_date,
    signedAt: iso(doc.signed_at),
    createdAt: iso(doc.created_at)!,
    updatedAt: iso(doc.updated_at)!,
    launchedAt: iso(doc.launched_at),
    completedAt: iso(doc.completed_at),
    launchCount: doc.launch_count,
    approvers: participants.filter((p) => p.role === 'approver').map((p) => refOf(users, p.user_id)),
    observers: participants.filter((p) => p.role === 'observer').map((p) => refOf(users, p.user_id)),
    acquaintance: participants.filter((p) => p.role === 'acquaintance').map((p) => refOf(users, p.user_id)),
    rounds,
    files: await listFiles(db, 'document', doc.id),
    myStep: myStepRow ? toStep(myStepRow, users) : null,
    myAction,
    myActionLabel: myAction ? MY_ACTION_LABELS[myAction] : null,
    myAcknowledgement: { required: inAcq, acknowledgedAt: iso(myAck?.acknowledged_at) },
    acknowledgements: canViewAck ? await acknowledgementSummary(db, doc.id) : null,
    access:
      isInit || auditor
        ? {
            users: accessRows.filter((a) => a.user_id).map((a) => refOf(users, a.user_id!)),
            departments: accessRows.filter((a) => a.department_id).map((a) => ({ id: a.department_id!, name: a.department_name ?? '' })),
          }
        : null,
    tasks,
    bitrix: link ? toLinkInfo(link, doc.kind) : null,
    comments: await loadComments(db, 'document', doc.id),
    permissions,
  };
}

// ───────────── Создание и изменение ─────────────

async function setParticipants(db: Db, docId: number, role: 'approver' | 'observer' | 'acquaintance', ids: number[]): Promise<void> {
  await db.query('DELETE FROM document_participants WHERE document_id = $1 AND role = $2', [docId, role]);
  let pos = 1;
  for (const userId of ids) {
    await db.query('INSERT INTO document_participants (document_id, user_id, role, position) VALUES ($1, $2, $3, $4)', [
      docId,
      userId,
      role,
      pos++,
    ]);
  }
}

async function currentParticipants(db: Db, docId: number, role: string): Promise<number[]> {
  return (
    await rows<{ user_id: number }>(
      db,
      'SELECT user_id FROM document_participants WHERE document_id = $1 AND role = $2 ORDER BY position, user_id',
      [docId, role],
    )
  ).map((r) => r.user_id);
}

const sameList = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function validateApprovers(db: Db, ids: number[], initiatorId: number): Promise<void> {
  if (uniq(ids).length !== ids.length) {
    throw unprocessable('Один сотрудник не может быть согласующим дважды', [
      { field: 'approverIds', message: 'Один сотрудник не может быть согласующим дважды' },
    ]);
  }
  if (ids.includes(initiatorId)) {
    throw unprocessable('Инициатор не может быть согласующим собственного документа', [
      { field: 'approverIds', message: 'Инициатор не может быть согласующим собственного документа' },
    ]);
  }
  await requireActiveUsers(db, ids, 'approverIds');
}

async function validateSigner(db: Db, signerId: number): Promise<void> {
  const u = await one<{ active: boolean; roles: string[]; full_name: string }>(
    db,
    'SELECT active, roles, full_name FROM users WHERE id = $1',
    [signerId],
  );
  const fail = (m: string) => unprocessable(m, [{ field: 'signerId', message: m }]);
  if (!u) throw fail('Утверждающий не найден');
  if (!u.active) throw fail(`Учётная запись сотрудника ${u.full_name} заблокирована`);
  if (!u.roles.includes('signer')) throw fail(`Сотрудник ${u.full_name} не имеет полномочия «Утверждающий»`);
}

/** Получает сведения о сделке у Битрикс24 (вне транзакции). */
async function resolveDeal(dealId: string): Promise<{ id: string; title: string; url: string }> {
  let deal;
  try {
    deal = await getBitrixAdapter().getDeal(dealId);
  } catch (err) {
    throw new AppError(502, 'bitrix_unavailable', `Не удалось получить сведения о сделке: ${(err as Error).message}`);
  }
  if (!deal) throw unprocessable('Сделка не найдена в Битрикс24', [{ field: 'dealId', message: 'Сделка не найдена в Битрикс24' }]);
  return { id: deal.id, title: deal.title, url: deal.url };
}

export async function createDocument(actor: Actor, input: CreateDocumentRequest): Promise<DocumentDetail> {
  const deal = input.dealId ? await resolveDeal(String(input.dealId)) : null;
  return tx(async (db) => {
    const type = await one<DocTypeRow>(db, 'SELECT * FROM doc_types WHERE id = $1', [input.typeId]);
    if (!type || !type.active) {
      throw unprocessable('Тип документа не найден или отключён', [{ field: 'typeId', message: 'Тип документа не найден или отключён' }]);
    }
    const isOrder = type.kind === 'order';
    if (deal && isOrder) {
      throw unprocessable('Связь со сделкой для приказов не используется', [
        { field: 'dealId', message: 'Связь со сделкой для приказов не используется' },
      ]);
    }
    if (!isOrder && (input.signerId || input.acquaintanceIds?.length || input.orderDate)) {
      throw unprocessable('Утверждающий, дата приказа и список ознакомления указываются только для приказа');
    }
    const approvers = input.approverIds ?? [];
    const observers = uniq(input.observerIds ?? []);
    const acquaintance = uniq(input.acquaintanceIds ?? []);
    await validateApprovers(db, approvers, actor.id);
    await requireActiveUsers(db, observers, 'observerIds');
    await requireActiveUsers(db, acquaintance, 'acquaintanceIds');
    if (input.signerId) await validateSigner(db, input.signerId);

    const number = await nextNumber(db, type.number_prefix);
    const doc = (await one<DocRow>(
      db,
      `INSERT INTO documents (number, doc_type_id, kind, title, description, initiator_id, department_id, route_mode,
                              due_at, deal_id, deal_title, deal_url, signer_id, order_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        number,
        type.id,
        type.kind,
        clean(input.title),
        clean(input.description),
        actor.id,
        actor.departmentId,
        input.routeMode ?? 'sequential',
        parseDueAt(input.dueAt),
        deal?.id ?? null,
        deal?.title ?? null,
        deal?.url ?? null,
        input.signerId ?? null,
        input.orderDate ?? null,
      ],
    ))!;
    await setParticipants(db, doc.id, 'approver', approvers);
    await setParticipants(db, doc.id, 'observer', observers);
    if (isOrder) await setParticipants(db, doc.id, 'acquaintance', acquaintance);
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: doc.id,
      action: 'document.created',
      summary: `Создана карточка ${number} (${type.name})`,
      details: { number, typeCode: type.code },
    });
    if (deal) {
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: doc.id,
        action: 'document.deal_linked',
        summary: `Карточка связана со сделкой Битрикс24 № ${deal.id}`,
        details: { dealId: deal.id, dealTitle: deal.title },
      });
    }
    return buildDetail(db, actor, doc);
  });
}

const FIELD_LABELS: Record<string, string> = {
  title: 'название',
  description: 'описание',
  dueAt: 'срок',
  routeMode: 'режим маршрута',
  approverIds: 'согласующие',
  observerIds: 'наблюдатели',
  signerId: 'утверждающий',
  acquaintanceIds: 'список ознакомления',
  orderDate: 'дата приказа',
};

export async function updateDocument(actor: Actor, id: number, input: UpdateDocumentRequest): Promise<DocumentDetail> {
  // Сведения о сделке запрашиваются до транзакции; право на изменение проверяется внутри неё.
  let deal: { id: string; title: string; url: string } | null = null;
  if (input.dealId) {
    const pre = await tx((db) => requireDocument(db, actor, id));
    requireInitiator(pre, actor);
    if (pre.deal_id !== String(input.dealId)) deal = await resolveDeal(String(input.dealId));
  }
  return tx(async (db) => {
    const doc = await requireDocument(db, actor, id, { lock: true });
    requireInitiator(doc, actor, 'Изменять карточку может только инициатор');
    if (doc.status !== 'draft' && doc.status !== 'rework') {
      throw conflict('Карточку можно изменять только в статусах «Черновик» и «На доработке»');
    }
    const isOrder = doc.kind === 'order';
    const changed: string[] = [];
    const changes: Record<string, unknown> = {};
    const sets: string[] = [];
    const p = new Params();
    const setField = (key: string, column: string, value: unknown, old: unknown) => {
      sets.push(`${column} = ${p.add(value)}`);
      changed.push(FIELD_LABELS[key]);
      changes[key] = { from: old, to: value };
    };

    if (input.title !== undefined && clean(input.title) !== doc.title) setField('title', 'title', clean(input.title), undefined);
    if (input.description !== undefined && clean(input.description) !== doc.description) {
      setField('description', 'description', clean(input.description), undefined);
    }
    if (input.dueAt !== undefined) {
      const due = parseDueAt(input.dueAt);
      if ((due?.getTime() ?? null) !== (doc.due_at?.getTime() ?? null)) setField('dueAt', 'due_at', due, iso(doc.due_at));
    }
    if (input.routeMode !== undefined && input.routeMode !== doc.route_mode) {
      setField('routeMode', 'route_mode', input.routeMode, doc.route_mode);
    }
    if (input.orderDate !== undefined) {
      if (!isOrder && input.orderDate) throw unprocessable('Дата приказа указывается только для приказа');
      if (isOrder && input.orderDate !== doc.order_date) setField('orderDate', 'order_date', input.orderDate, doc.order_date);
    }
    if (input.signerId !== undefined) {
      if (!isOrder && input.signerId) throw unprocessable('Утверждающий указывается только для приказа');
      if (isOrder && input.signerId !== doc.signer_id) {
        if (input.signerId) await validateSigner(db, input.signerId);
        setField('signerId', 'signer_id', input.signerId, doc.signer_id);
      }
    }

    // Связь со сделкой
    let dealAudit: { action: string; summary: string; details: Record<string, unknown> } | null = null;
    if (input.dealId !== undefined) {
      const newId = input.dealId ? String(input.dealId) : null;
      if (newId !== doc.deal_id) {
        if (isOrder) {
          throw unprocessable('Связь со сделкой для приказов не используется', [
            { field: 'dealId', message: 'Связь со сделкой для приказов не используется' },
          ]);
        }
        if (doc.launch_count > 0) throw conflict('Сделку можно изменить только до первого запуска согласования');
        sets.push(`deal_id = ${p.add(deal?.id ?? null)}`, `deal_title = ${p.add(deal?.title ?? null)}`, `deal_url = ${p.add(deal?.url ?? null)}`);
        dealAudit = !newId
          ? { action: 'document.deal_unlinked', summary: `Связь со сделкой Битрикс24 № ${doc.deal_id} удалена`, details: { from: doc.deal_id } }
          : doc.deal_id
            ? {
                action: 'document.deal_changed',
                summary: `Связь со сделкой изменена: № ${doc.deal_id} → № ${newId}`,
                details: { from: doc.deal_id, to: newId, dealTitle: deal?.title },
              }
            : {
                action: 'document.deal_linked',
                summary: `Карточка связана со сделкой Битрикс24 № ${newId}`,
                details: { dealId: newId, dealTitle: deal?.title },
              };
      }
    }

    // Участники
    if (input.approverIds !== undefined) {
      const old = await currentParticipants(db, doc.id, 'approver');
      if (!sameList(old, input.approverIds)) {
        await validateApprovers(db, input.approverIds, doc.initiator_id);
        await setParticipants(db, doc.id, 'approver', input.approverIds);
        changed.push(FIELD_LABELS.approverIds);
        changes.approverIds = { from: old, to: input.approverIds };
      }
    }
    if (input.observerIds !== undefined) {
      const old = await currentParticipants(db, doc.id, 'observer');
      const next = uniq(input.observerIds);
      if (!sameList(old, next)) {
        await requireActiveUsers(db, next.filter((x) => !old.includes(x)), 'observerIds');
        await setParticipants(db, doc.id, 'observer', next);
        changed.push(FIELD_LABELS.observerIds);
        changes.observerIds = { from: old, to: next };
      }
    }
    if (input.acquaintanceIds !== undefined) {
      if (!isOrder && input.acquaintanceIds.length) throw unprocessable('Список ознакомления указывается только для приказа');
      if (isOrder) {
        const old = await currentParticipants(db, doc.id, 'acquaintance');
        const next = uniq(input.acquaintanceIds);
        if (!sameList(old, next)) {
          await requireActiveUsers(db, next.filter((x) => !old.includes(x)), 'acquaintanceIds');
          await setParticipants(db, doc.id, 'acquaintance', next);
          changed.push(FIELD_LABELS.acquaintanceIds);
          changes.acquaintanceIds = { from: old, to: next };
        }
      }
    }

    if (!changed.length && !dealAudit) return buildDetail(db, actor, doc);
    sets.push('updated_at = now()');
    const updated = (await one<DocRow>(db, `UPDATE documents SET ${sets.join(', ')} WHERE id = ${p.add(doc.id)} RETURNING *`, p.values))!;
    if (changed.length) {
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: doc.id,
        action: 'document.updated',
        summary: `Карточка изменена: ${changed.join(', ')}`,
        details: { changes },
      });
    }
    if (dealAudit) await audit(db, { actorId: actor.id, entityType: 'document', entityId: doc.id, ...dealAudit });
    return buildDetail(db, actor, updated);
  });
}

export async function deleteDocument(actor: Actor, id: number): Promise<void> {
  const keys = await tx(async (db) => {
    const doc = await requireDocument(db, actor, id, { lock: true });
    requireInitiator(doc, actor, 'Удалить черновик может только инициатор');
    if (doc.status !== 'draft' || doc.launch_count > 0) throw conflict('Удалить можно только черновик, который ещё не запускался');
    const ks = await rows<{ storage_key: string }>(
      db,
      `SELECT v.storage_key FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.owner_type = 'document' AND f.owner_id = $1`,
      [id],
    );
    await db.query(`DELETE FROM files WHERE owner_type = 'document' AND owner_id = $1`, [id]);
    await db.query(`DELETE FROM comments WHERE entity_type = 'document' AND entity_id = $1`, [id]);
    await db.query('DELETE FROM documents WHERE id = $1', [id]);
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'document.deleted',
      summary: `Черновик ${doc.number} удалён`,
      details: { number: doc.number },
    });
    return ks.map((k) => k.storage_key);
  });
  for (const k of keys) await removeStored(k);
}

/** Копия карточки в новый черновик — без файлов, решений и связей с раундами. */
export async function copyDocument(actor: Actor, id: number): Promise<DocumentDetail> {
  return tx(async (db) => {
    const src = await requireDocument(db, actor, id);
    requireInitiator(src, actor, 'Скопировать карточку может только её инициатор');
    const type = (await one<DocTypeRow>(db, 'SELECT * FROM doc_types WHERE id = $1', [src.doc_type_id]))!;
    if (!type.active) throw conflict('Тип документа отключён — копирование невозможно');
    const number = await nextNumber(db, type.number_prefix);
    const doc = (await one<DocRow>(
      db,
      `INSERT INTO documents (number, doc_type_id, kind, title, description, initiator_id, department_id, route_mode,
                              deal_id, deal_title, deal_url, signer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [number, type.id, type.kind, src.title, src.description, actor.id, actor.departmentId, src.route_mode, src.deal_id, src.deal_title, src.deal_url, src.signer_id],
    ))!;
    // Заблокированные сотрудники в копию не переносятся.
    await db.query(
      `INSERT INTO document_participants (document_id, user_id, role, position)
       SELECT $2, p.user_id, p.role, p.position FROM document_participants p JOIN users u ON u.id = p.user_id AND u.active
        WHERE p.document_id = $1`,
      [src.id, doc.id],
    );
    if (doc.signer_id) {
      const s = await one<{ ok: boolean }>(db, `SELECT (active AND 'signer' = ANY(roles)) AS ok FROM users WHERE id = $1`, [doc.signer_id]);
      if (!s?.ok) await db.query('UPDATE documents SET signer_id = NULL WHERE id = $1', [doc.id]);
    }
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: doc.id,
      action: 'document.created',
      summary: `Создана карточка ${number} — копия карточки ${src.number}`,
      details: { number, copiedFrom: src.id, copiedFromNumber: src.number },
    });
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: src.id,
      action: 'document.copied',
      summary: `Карточка скопирована в новый черновик ${number}`,
      details: { copyId: doc.id, copyNumber: number },
    });
    return buildDetail(db, actor, (await one<DocRow>(db, 'SELECT * FROM documents WHERE id = $1', [doc.id]))!);
  });
}

/** Индивидуальный доступ на просмотр: полный новый перечень сотрудников и подразделений. */
export async function setAccess(actor: Actor, id: number, userIdsRaw: number[], departmentIdsRaw: number[]): Promise<DocumentDetail> {
  return tx(async (db) => {
    const doc = await requireDocument(db, actor, id, { lock: true });
    requireInitiator(doc, actor, 'Управлять доступом может только инициатор документа');
    const userIds = uniq(userIdsRaw);
    const departmentIds = uniq(departmentIdsRaw);
    const old = await rows<{ user_id: number | null; department_id: number | null }>(
      db,
      'SELECT user_id, department_id FROM document_access WHERE document_id = $1',
      [id],
    );
    const oldUsers = old.filter((o) => o.user_id).map((o) => o.user_id!);
    const oldDepts = old.filter((o) => o.department_id).map((o) => o.department_id!);
    const addedUsers = userIds.filter((u) => !oldUsers.includes(u));
    await requireActiveUsers(db, addedUsers, 'userIds');
    if (departmentIds.length) {
      const found = await rows<{ id: number }>(db, 'SELECT id FROM departments WHERE id = ANY($1::int[])', [departmentIds]);
      if (found.length !== departmentIds.length) {
        throw unprocessable('Подразделение не найдено', [{ field: 'departmentIds', message: 'Подразделение не найдено' }]);
      }
    }
    await db.query('DELETE FROM document_access WHERE document_id = $1', [id]);
    for (const u of userIds) {
      await db.query('INSERT INTO document_access (document_id, user_id, granted_by) VALUES ($1, $2, $3)', [id, u, actor.id]);
    }
    for (const d of departmentIds) {
      await db.query('INSERT INTO document_access (document_id, department_id, granted_by) VALUES ($1, $2, $3)', [id, d, actor.id]);
    }
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'document.access_changed',
      summary: `Изменён индивидуальный доступ: сотрудников — ${userIds.length}, подразделений — ${departmentIds.length}`,
      details: { users: { from: oldUsers, to: userIds }, departments: { from: oldDepts, to: departmentIds } },
    });
    return buildDetail(db, actor, doc);
  });
}

export async function addDocumentComment(actor: Actor, id: number, bodyRaw: string): Promise<Comment> {
  return tx(async (db) => {
    const doc = await requireDocument(db, actor, id);
    const body = clean(bodyRaw);
    if (!body) throw unprocessable('Комментарий не может быть пустым', [{ field: 'body', message: 'Комментарий не может быть пустым' }]);
    const c = (await one<{ id: number; created_at: Date }>(
      db,
      `INSERT INTO comments (entity_type, entity_id, author_id, body) VALUES ('document', $1, $2, $3) RETURNING id, created_at`,
      [id, actor.id, body],
    ))!;
    await audit(db, {
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'comment.added',
      summary: 'Добавлен комментарий',
      details: { commentId: c.id },
    });
    // Инициатор и участники, от которых ожидается решение, узнают о комментарии.
    const pending = await rows<{ user_id: number }>(
      db,
      `SELECT s.user_id FROM approval_steps s JOIN approval_rounds r ON r.id = s.round_id
        WHERE r.document_id = $1 AND r.finished_at IS NULL AND s.state = 'pending'`,
      [id],
    );
    const recipients = [doc.initiator_id, ...pending.map((s) => s.user_id)].filter((u) => u !== actor.id);
    await notifyMany(db, recipients, {
      type: 'comment_added',
      title: `Новый комментарий к документу ${doc.number}`,
      body: `В карточке ${doc.number} новый комментарий. Автор — ${actor.fullName}.`,
      entityType: 'document',
      entityId: id,
    });
    const users = await loadUserRefs(db, [actor.id]);
    return { id: c.id, author: refOf(users, actor.id), body, createdAt: iso(c.created_at)! };
  });
}

export function parseStatuses(value: string | undefined): DocStatus[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean) as DocStatus[];
}

export { notFound };
