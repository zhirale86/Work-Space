/**
 * Документы, согласование и приказы (server/src/documents, approvals, orders):
 * карточка, права, маршрут, раунды, утверждение, ознакомление.
 */
import type {
  AcknowledgementSummary,
  ApprovalRound,
  ApprovalStep,
  Comment,
  CreateDocumentRequest,
  DealRef,
  Decision,
  DocType,
  DocumentDetail,
  DocumentListItem,
  DocumentPermissions,
  DocumentScope,
  DocumentTaskRef,
  ErrorDetail,
  MyDocumentAction,
  Page,
  RouteChangeRequest,
  RouteMode,
  StepState,
  UpdateDocumentRequest,
} from '../api/types';
import {
  DOC_KIND_LABELS,
  MY_ACTION_LABELS,
  ROUND_OUTCOME_LABELS,
  ROUTE_MODE_LABELS,
  STEP_STATE_LABELS,
  TASK_STATUS_LABELS,
  docStatusLabel,
} from '../../../server/src/labels';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../../server/src/errors';
import { BitrixError, enqueueBitrixSync, getDeal, getLink, mockDealUrl, toLinkInfo } from './bitrix';
import {
  type Actor,
  type Paging,
  audit,
  byName,
  clean,
  deptRef,
  docVisible,
  fail422,
  findDocument,
  ilike,
  iso,
  isoReq,
  isAdmin,
  isAuditor,
  isDocOverdue,
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
  requireDocumentForManage,
  requireInitiator,
  requireInitiatorOrAdmin,
  taskVisible,
  uniq,
  userById,
} from './core';
import { type DocRow, type DocTypeRow, type ParticipantRow, type StepRow, db, nextId, now } from './db';
import { latestVersions, listFiles, roundFiles } from './files';

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

const typeOf = (d: DocRow): DocTypeRow => db.docTypes.find((t) => t.id === d.doc_type_id)!;
const participantsOf = (docId: number, role: ParticipantRow['role']): number[] =>
  db.participants
    .filter((p) => p.document_id === docId && p.role === role)
    .sort((a, b) => a.position - b.position || a.user_id - b.user_id)
    .map((p) => p.user_id);
const openRoundOf = (docId: number) => db.rounds.find((r) => r.document_id === docId && r.finished_at === null);
const lastRoundOf = (docId: number) => db.rounds.filter((r) => r.document_id === docId).sort((a, b) => b.round_no - a.round_no)[0];

function hasPendingStep(docId: number, userId: number): boolean {
  const r = openRoundOf(docId);
  return !!r && db.steps.some((s) => s.round_id === r.id && s.user_id === userId && s.state === 'pending');
}
const hasAck = (docId: number, userId: number): boolean => db.acks.some((a) => a.document_id === docId && a.user_id === userId);
const inAcquaintance = (docId: number, userId: number): boolean =>
  db.participants.some((p) => p.document_id === docId && p.user_id === userId && p.role === 'acquaintance');
const needAck = (d: DocRow, userId: number): boolean => d.kind === 'order' && d.status === 'approved' && inAcquaintance(d.id, userId) && !hasAck(d.id, userId);

function myActionOf(d: DocRow, userId: number): MyDocumentAction {
  if (d.status === 'in_review' && hasPendingStep(d.id, userId)) return 'approve';
  if (d.status === 'on_signing' && d.signer_id === userId) return 'sign';
  if (d.status === 'rework' && d.initiator_id === userId) return 'rework';
  if (needAck(d, userId)) return 'acknowledge';
  return null;
}

/** Есть активные сотрудники из списка ознакомления, не подтвердившие ознакомление. */
function pendingAck(d: DocRow): boolean {
  return db.participants.some(
    (p) => p.document_id === d.id && p.role === 'acquaintance' && userById(p.user_id)?.active && !hasAck(d.id, p.user_id),
  );
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
  overdueMine?: boolean;
  pendingAcknowledgement?: boolean;
}

const dayStart = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

export function filterDocuments(actor: Actor, f: DocumentFilters): DocRow[] {
  const me = actor.id;
  return db.documents
    .filter((d) => {
      if (!docVisible(actor, d)) return false;
      if (f.q?.trim()) {
        const s = f.q.trim();
        if (!ilike(d.number, s) && !ilike(d.title, s) && !ilike(d.deal_title, s)) return false;
      }
      switch (f.scope) {
        case 'mine':
          if (d.initiator_id !== me) return false;
          break;
        case 'to_approve':
          if (!(d.status === 'in_review' && hasPendingStep(d.id, me))) return false;
          break;
        case 'to_sign':
          if (!(d.status === 'on_signing' && d.signer_id === me)) return false;
          break;
        case 'to_acknowledge':
          if (!needAck(d, me)) return false;
          break;
        default:
          break;
      }
      if (f.kind && d.kind !== f.kind) return false;
      if (f.typeId && d.doc_type_id !== f.typeId) return false;
      if (f.statuses?.length && !f.statuses.includes(d.status)) return false;
      if (f.initiatorId && d.initiator_id !== f.initiatorId) return false;
      if (f.departmentId && d.department_id !== f.departmentId) return false;
      if (f.createdFrom && d.created_at < dayStart(f.createdFrom)) return false;
      if (f.createdTo && d.created_at >= dayStart(f.createdTo) + 86400_000) return false;
      if (f.deal?.trim()) {
        const v = f.deal.trim();
        if (d.deal_id !== v && !ilike(d.deal_title, v)) return false;
      }
      if (f.overdue && !isDocOverdue(d)) return false;
      if (f.overdueMine) {
        if (!isDocOverdue(d)) return false;
        const mine =
          (d.status === 'in_review' && hasPendingStep(d.id, me)) || (d.status === 'on_signing' && d.signer_id === me) || (d.status === 'rework' && d.initiator_id === me);
        if (!mine) return false;
      }
      if (f.pendingAcknowledgement) {
        if (!(d.kind === 'order' && d.status === 'approved' && pendingAck(d))) return false;
        if (!isAuditor(actor) && d.initiator_id !== me && d.signer_id !== me) return false;
      }
      return true;
    })
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
}

function dealRef(d: DocRow): DealRef | null {
  return d.deal_id ? { id: d.deal_id, title: d.deal_title, url: d.deal_url ?? mockDealUrl(d.deal_id) } : null;
}

export function toListItem(d: DocRow, actor: Actor): DocumentListItem {
  const t = typeOf(d);
  const my = myActionOf(d, actor.id);
  return {
    id: d.id,
    number: d.number,
    kind: d.kind,
    kindLabel: DOC_KIND_LABELS[d.kind],
    type: { id: t.id, code: t.code, name: t.name },
    title: d.title,
    status: d.status,
    statusLabel: docStatusLabel(d.status, d.kind),
    initiator: refOf(d.initiator_id),
    department: deptRef(d.department_id),
    createdAt: isoReq(d.created_at),
    dueAt: iso(d.due_at),
    overdue: isDocOverdue(d),
    deal: dealRef(d),
    myAction: my,
    myActionLabel: my ? MY_ACTION_LABELS[my] : null,
  };
}

export function queryDocuments(actor: Actor, f: DocumentFilters, p: Paging): Page<DocumentListItem> {
  const page = pageOf(filterDocuments(actor, f), p);
  return { ...page, items: page.items.map((d) => toListItem(d, actor)) };
}

// ───────────── Карточка ─────────────

export function toStep(s: StepRow): ApprovalStep {
  return {
    id: s.id,
    user: refOf(s.user_id),
    position: s.position,
    state: s.state,
    stateLabel: STEP_STATE_LABELS[s.state],
    comment: s.comment,
    activatedAt: iso(s.activated_at),
    decidedAt: iso(s.decided_at),
  };
}

export function loadComments(entityType: 'document' | 'task', entityId: number): Comment[] {
  return db.comments
    .filter((c) => c.entity_type === entityType && c.entity_id === entityId)
    .sort((a, b) => a.id - b.id)
    .map((c) => ({ id: c.id, author: refOf(c.author_id), body: c.body, createdAt: isoReq(c.created_at) }));
}

export function acknowledgementSummary(docId: number): AcknowledgementSummary {
  const list = participantsOf(docId, 'acquaintance').sort(byName);
  const rows = list.map((userId) => {
    const a = db.acks.find((x) => x.document_id === docId && x.user_id === userId);
    const v = a?.file_version_id ? db.versions.find((x) => x.id === a.file_version_id) : undefined;
    return { userId, active: !!userById(userId)?.active, ack: a, versionNo: v?.version_no ?? null };
  });
  const expected = rows.filter((r) => r.active || r.ack);
  const acknowledged = expected.filter((r) => r.ack).length;
  return {
    total: expected.length,
    acknowledged,
    pending: expected.length - acknowledged,
    items: rows.map((r) => ({
      user: refOf(r.userId),
      acknowledgedAt: iso(r.ack?.acknowledged_at),
      fileVersionId: r.ack?.file_version_id ?? null,
      fileVersionNo: r.versionNo,
    })),
  };
}

export function getDocumentDetail(actor: Actor, id: number): DocumentDetail {
  return buildDetail(actor, requireDocument(actor, id));
}

export function buildDetail(actor: Actor, doc: DocRow): DocumentDetail {
  const type = typeOf(doc);
  const roundRows = db.rounds.filter((r) => r.document_id === doc.id).sort((a, b) => b.round_no - a.round_no);
  const stepsOf = (roundId: number) => db.steps.filter((s) => s.round_id === roundId).sort((a, b) => a.position - b.position || a.id - b.id);
  const accessRows = db.access.filter((a) => a.document_id === doc.id).sort((a, b) => a.id - b.id);
  const myAck = db.acks.find((a) => a.document_id === doc.id && a.user_id === actor.id);
  const taskRows = db.tasks.filter((t) => t.document_id === doc.id && taskVisible(actor, t)).sort((a, b) => a.id - b.id);
  const link = doc.deal_id ? getLink(doc.id) : undefined;

  const rounds: ApprovalRound[] = roundRows.map((r) => ({
    id: r.id,
    roundNo: r.round_no,
    mode: r.mode,
    modeLabel: ROUTE_MODE_LABELS[r.mode],
    startedAt: isoReq(r.started_at),
    startedBy: refOf(r.started_by),
    finishedAt: iso(r.finished_at),
    outcome: r.outcome,
    outcomeLabel: r.outcome ? ROUND_OUTCOME_LABELS[r.outcome] : null,
    steps: stepsOf(r.id).map(toStep),
    files: roundFiles(r.id),
  }));

  const openRound = roundRows.find((r) => r.finished_at === null);
  const myStepRow = openRound ? stepsOf(openRound.id).find((s) => s.user_id === actor.id && s.state !== 'replaced') ?? null : null;
  const inAcq = inAcquaintance(doc.id, actor.id);
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
  const reminded = !!doc.last_reminded_at && now() - doc.last_reminded_at < 24 * 3600 * 1000;

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
    assignee: refOf(t.assignee_id),
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
    initiator: refOf(doc.initiator_id),
    department: deptRef(doc.department_id),
    deal: dealRef(doc),
    dealLocked: doc.launch_count > 0,
    signer: doc.signer_id ? refOf(doc.signer_id) : null,
    orderDate: doc.order_date,
    signedAt: iso(doc.signed_at),
    createdAt: isoReq(doc.created_at),
    updatedAt: isoReq(doc.updated_at),
    launchedAt: iso(doc.launched_at),
    completedAt: iso(doc.completed_at),
    launchCount: doc.launch_count,
    approvers: participantsOf(doc.id, 'approver').map(refOf),
    observers: participantsOf(doc.id, 'observer').map(refOf),
    acquaintance: participantsOf(doc.id, 'acquaintance').map(refOf),
    rounds,
    files: listFiles('document', doc.id),
    myStep: myStepRow ? toStep(myStepRow) : null,
    myAction,
    myActionLabel: myAction ? MY_ACTION_LABELS[myAction] : null,
    myAcknowledgement: { required: inAcq, acknowledgedAt: iso(myAck?.acknowledged_at) },
    acknowledgements: canViewAck ? acknowledgementSummary(doc.id) : null,
    access:
      isInit || auditor
        ? {
            users: accessRows.filter((a) => a.user_id).map((a) => refOf(a.user_id!)),
            departments: accessRows.filter((a) => a.department_id).map((a) => deptRef(a.department_id)!),
          }
        : null,
    tasks,
    bitrix: link ? toLinkInfo(link, doc.kind) : null,
    comments: loadComments('document', doc.id),
    permissions,
  };
}

// ───────────── Создание и изменение ─────────────

function setParticipants(docId: number, role: ParticipantRow['role'], ids: number[]): void {
  db.participants = db.participants.filter((p) => !(p.document_id === docId && p.role === role));
  ids.forEach((user_id, i) => db.participants.push({ document_id: docId, user_id, role, position: i + 1 }));
}

const sameList = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function validateApprovers(ids: number[], initiatorId: number): void {
  if (uniq(ids).length !== ids.length) throw fail422('Один сотрудник не может быть согласующим дважды', 'approverIds');
  if (ids.includes(initiatorId)) throw fail422('Инициатор не может быть согласующим собственного документа', 'approverIds');
  requireActiveUsers(ids, 'approverIds');
}

function validateSigner(signerId: number): void {
  const u = userById(signerId);
  if (!u) throw fail422('Утверждающий не найден', 'signerId');
  if (!u.active) throw fail422(`Учётная запись сотрудника ${u.full_name} заблокирована`, 'signerId');
  if (!u.roles.includes('signer')) throw fail422(`Сотрудник ${u.full_name} не имеет полномочия «Утверждающий»`, 'signerId');
}

function resolveDeal(dealId: string): { id: string; title: string; url: string } {
  let deal;
  try {
    deal = getDeal(dealId);
  } catch (err) {
    if (err instanceof BitrixError) throw new AppError(502, 'bitrix_unavailable', `Не удалось получить сведения о сделке: ${err.message}`);
    throw err;
  }
  if (!deal) throw fail422('Сделка не найдена в Битрикс24', 'dealId');
  return { id: deal.id, title: deal.title, url: deal.url };
}

export function createDocument(actor: Actor, input: CreateDocumentRequest): DocumentDetail {
  const deal = input.dealId ? resolveDeal(String(input.dealId)) : null;
  const type = db.docTypes.find((t) => t.id === input.typeId);
  if (!type || !type.active) throw fail422('Тип документа не найден или отключён', 'typeId');
  const isOrder = type.kind === 'order';
  if (deal && isOrder) throw fail422('Связь со сделкой для приказов не используется', 'dealId');
  if (!isOrder && (input.signerId || input.acquaintanceIds?.length || input.orderDate)) {
    throw unprocessable('Утверждающий, дата приказа и список ознакомления указываются только для приказа');
  }
  const approvers = input.approverIds ?? [];
  const observers = uniq(input.observerIds ?? []);
  const acquaintance = uniq(input.acquaintanceIds ?? []);
  validateApprovers(approvers, actor.id);
  requireActiveUsers(observers, 'observerIds');
  requireActiveUsers(acquaintance, 'acquaintanceIds');
  if (input.signerId) validateSigner(input.signerId);
  const dueAt = parseDueAt(input.dueAt);

  const number = nextNumber(type.number_prefix);
  const t = now();
  const doc: DocRow = {
    id: nextId('documents'),
    number,
    doc_type_id: type.id,
    kind: type.kind,
    title: clean(input.title),
    description: clean(input.description),
    initiator_id: actor.id,
    department_id: actor.departmentId,
    status: 'draft',
    route_mode: input.routeMode ?? 'sequential',
    due_at: dueAt,
    deal_id: deal?.id ?? null,
    deal_title: deal?.title ?? null,
    deal_url: deal?.url ?? null,
    signer_id: input.signerId ?? null,
    order_date: input.orderDate ?? null,
    signed_at: null,
    signed_by: null,
    launch_count: 0,
    last_reminded_at: null,
    created_at: t,
    updated_at: t,
    launched_at: null,
    completed_at: null,
  };
  db.documents.push(doc);
  setParticipants(doc.id, 'approver', approvers);
  setParticipants(doc.id, 'observer', observers);
  if (isOrder) setParticipants(doc.id, 'acquaintance', acquaintance);
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: doc.id,
    action: 'document.created',
    summary: `Создана карточка ${number} (${type.name})`,
    details: { number, typeCode: type.code },
  });
  if (deal) {
    audit({
      actorId: actor.id,
      entityType: 'document',
      entityId: doc.id,
      action: 'document.deal_linked',
      summary: `Карточка связана со сделкой Битрикс24 № ${deal.id}`,
      details: { dealId: deal.id, dealTitle: deal.title },
    });
  }
  return buildDetail(actor, doc);
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

export function updateDocument(actor: Actor, id: number, input: UpdateDocumentRequest): DocumentDetail {
  let deal: { id: string; title: string; url: string } | null = null;
  if (input.dealId) {
    const pre = requireDocument(actor, id);
    requireInitiator(pre, actor);
    if (pre.deal_id !== String(input.dealId)) deal = resolveDeal(String(input.dealId));
  }
  const doc = requireDocument(actor, id);
  requireInitiator(doc, actor, 'Изменять карточку может только инициатор');
  if (doc.status !== 'draft' && doc.status !== 'rework') throw conflict('Карточку можно изменять только в статусах «Черновик» и «На доработке»');
  const isOrder = doc.kind === 'order';
  const changed: string[] = [];
  const changes: Record<string, unknown> = {};
  const patch: Partial<DocRow> = {};
  const setField = <K extends keyof DocRow>(key: string, column: K, value: DocRow[K], old: unknown) => {
    patch[column] = value;
    changed.push(FIELD_LABELS[key]);
    changes[key] = { from: old, to: value };
  };

  if (input.title !== undefined && clean(input.title) !== doc.title) setField('title', 'title', clean(input.title), undefined);
  if (input.description !== undefined && clean(input.description) !== doc.description) setField('description', 'description', clean(input.description), undefined);
  if (input.dueAt !== undefined) {
    const due = parseDueAt(input.dueAt);
    if (due !== doc.due_at) setField('dueAt', 'due_at', due, iso(doc.due_at));
  }
  if (input.routeMode !== undefined && input.routeMode !== doc.route_mode) setField('routeMode', 'route_mode', input.routeMode, doc.route_mode);
  if (input.orderDate !== undefined) {
    if (!isOrder && input.orderDate) throw unprocessable('Дата приказа указывается только для приказа');
    if (isOrder && input.orderDate !== doc.order_date) setField('orderDate', 'order_date', input.orderDate ?? null, doc.order_date);
  }
  if (input.signerId !== undefined) {
    if (!isOrder && input.signerId) throw unprocessable('Утверждающий указывается только для приказа');
    if (isOrder && input.signerId !== doc.signer_id) {
      if (input.signerId) validateSigner(input.signerId);
      setField('signerId', 'signer_id', input.signerId ?? null, doc.signer_id);
    }
  }

  let dealAudit: { action: string; summary: string; details: Record<string, unknown> } | null = null;
  if (input.dealId !== undefined) {
    const newId = input.dealId ? String(input.dealId) : null;
    if (newId !== doc.deal_id) {
      if (isOrder) throw fail422('Связь со сделкой для приказов не используется', 'dealId');
      if (doc.launch_count > 0) throw conflict('Сделку можно изменить только до первого запуска согласования');
      patch.deal_id = deal?.id ?? null;
      patch.deal_title = deal?.title ?? null;
      patch.deal_url = deal?.url ?? null;
      dealAudit = !newId
        ? { action: 'document.deal_unlinked', summary: `Связь со сделкой Битрикс24 № ${doc.deal_id} удалена`, details: { from: doc.deal_id } }
        : doc.deal_id
          ? { action: 'document.deal_changed', summary: `Связь со сделкой изменена: № ${doc.deal_id} → № ${newId}`, details: { from: doc.deal_id, to: newId, dealTitle: deal?.title } }
          : { action: 'document.deal_linked', summary: `Карточка связана со сделкой Битрикс24 № ${newId}`, details: { dealId: newId, dealTitle: deal?.title } };
    }
  }

  if (input.approverIds !== undefined) {
    const old = participantsOf(doc.id, 'approver');
    if (!sameList(old, input.approverIds)) {
      validateApprovers(input.approverIds, doc.initiator_id);
      setParticipants(doc.id, 'approver', input.approverIds);
      changed.push(FIELD_LABELS.approverIds);
      changes.approverIds = { from: old, to: input.approverIds };
    }
  }
  if (input.observerIds !== undefined) {
    const old = participantsOf(doc.id, 'observer');
    const next = uniq(input.observerIds);
    if (!sameList(old, next)) {
      requireActiveUsers(next.filter((x) => !old.includes(x)), 'observerIds');
      setParticipants(doc.id, 'observer', next);
      changed.push(FIELD_LABELS.observerIds);
      changes.observerIds = { from: old, to: next };
    }
  }
  if (input.acquaintanceIds !== undefined) {
    if (!isOrder && input.acquaintanceIds.length) throw unprocessable('Список ознакомления указывается только для приказа');
    if (isOrder) {
      const old = participantsOf(doc.id, 'acquaintance');
      const next = uniq(input.acquaintanceIds);
      if (!sameList(old, next)) {
        requireActiveUsers(next.filter((x) => !old.includes(x)), 'acquaintanceIds');
        setParticipants(doc.id, 'acquaintance', next);
        changed.push(FIELD_LABELS.acquaintanceIds);
        changes.acquaintanceIds = { from: old, to: next };
      }
    }
  }

  if (!changed.length && !dealAudit) return buildDetail(actor, doc);
  Object.assign(doc, patch, { updated_at: now() });
  if (changed.length) {
    audit({ actorId: actor.id, entityType: 'document', entityId: doc.id, action: 'document.updated', summary: `Карточка изменена: ${changed.join(', ')}`, details: { changes } });
  }
  if (dealAudit) audit({ actorId: actor.id, entityType: 'document', entityId: doc.id, ...dealAudit });
  return buildDetail(actor, doc);
}

export function deleteDocument(actor: Actor, id: number): void {
  const doc = requireDocument(actor, id);
  requireInitiator(doc, actor, 'Удалить черновик может только инициатор');
  if (doc.status !== 'draft' || doc.launch_count > 0) throw conflict('Удалить можно только черновик, который ещё не запускался');
  const fileIds = new Set(db.files.filter((f) => f.owner_type === 'document' && f.owner_id === id).map((f) => f.id));
  db.versions = db.versions.filter((v) => !fileIds.has(v.file_id));
  db.files = db.files.filter((f) => !fileIds.has(f.id));
  db.comments = db.comments.filter((c) => !(c.entity_type === 'document' && c.entity_id === id));
  db.participants = db.participants.filter((p) => p.document_id !== id);
  db.access = db.access.filter((a) => a.document_id !== id);
  db.documents = db.documents.filter((d) => d.id !== id);
  audit({ actorId: actor.id, entityType: 'document', entityId: id, action: 'document.deleted', summary: `Черновик ${doc.number} удалён`, details: { number: doc.number } });
}

/** Копия карточки в новый черновик — без файлов, решений и связей с раундами. */
export function copyDocument(actor: Actor, id: number): DocumentDetail {
  const src = requireDocument(actor, id);
  requireInitiator(src, actor, 'Скопировать карточку может только её инициатор');
  const type = typeOf(src);
  if (!type.active) throw conflict('Тип документа отключён — копирование невозможно');
  const number = nextNumber(type.number_prefix);
  const t = now();
  const signer = src.signer_id ? userById(src.signer_id) : undefined;
  const doc: DocRow = {
    ...src,
    id: nextId('documents'),
    number,
    initiator_id: actor.id,
    department_id: actor.departmentId,
    status: 'draft',
    due_at: null,
    signer_id: signer && signer.active && signer.roles.includes('signer') ? signer.id : null,
    order_date: null,
    signed_at: null,
    signed_by: null,
    launch_count: 0,
    last_reminded_at: null,
    created_at: t,
    updated_at: t,
    launched_at: null,
    completed_at: null,
  };
  db.documents.push(doc);
  for (const p of db.participants.filter((x) => x.document_id === src.id && userById(x.user_id)?.active)) db.participants.push({ ...p, document_id: doc.id });
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: doc.id,
    action: 'document.created',
    summary: `Создана карточка ${number} — копия карточки ${src.number}`,
    details: { number, copiedFrom: src.id, copiedFromNumber: src.number },
  });
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: src.id,
    action: 'document.copied',
    summary: `Карточка скопирована в новый черновик ${number}`,
    details: { copyId: doc.id, copyNumber: number },
  });
  return buildDetail(actor, doc);
}

export function setAccess(actor: Actor, id: number, userIdsRaw: number[], departmentIdsRaw: number[]): DocumentDetail {
  const doc = requireDocument(actor, id);
  requireInitiator(doc, actor, 'Управлять доступом может только инициатор документа');
  const userIds = uniq(userIdsRaw);
  const departmentIds = uniq(departmentIdsRaw);
  const old = db.access.filter((a) => a.document_id === id);
  const oldUsers = old.filter((o) => o.user_id).map((o) => o.user_id!);
  const oldDepts = old.filter((o) => o.department_id).map((o) => o.department_id!);
  requireActiveUsers(userIds.filter((u) => !oldUsers.includes(u)), 'userIds');
  if (departmentIds.some((d) => !db.departments.some((x) => x.id === d))) throw fail422('Подразделение не найдено', 'departmentIds');
  db.access = db.access.filter((a) => a.document_id !== id);
  for (const u of userIds) db.access.push({ id: nextId('access'), document_id: id, user_id: u, department_id: null, granted_by: actor.id });
  for (const d of departmentIds) db.access.push({ id: nextId('access'), document_id: id, user_id: null, department_id: d, granted_by: actor.id });
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: id,
    action: 'document.access_changed',
    summary: `Изменён индивидуальный доступ: сотрудников — ${userIds.length}, подразделений — ${departmentIds.length}`,
    details: { users: { from: oldUsers, to: userIds }, departments: { from: oldDepts, to: departmentIds } },
  });
  return buildDetail(actor, doc);
}

export function addDocumentComment(actor: Actor, id: number, bodyRaw: string): Comment {
  const doc = requireDocument(actor, id);
  const body = clean(bodyRaw);
  if (!body) throw fail422('Комментарий не может быть пустым', 'body');
  const c = { id: nextId('comments'), entity_type: 'document' as const, entity_id: id, author_id: actor.id, body, created_at: now() };
  db.comments.push(c);
  audit({ actorId: actor.id, entityType: 'document', entityId: id, action: 'comment.added', summary: 'Добавлен комментарий', details: { commentId: c.id } });
  const r = openRoundOf(id);
  const pending = r ? db.steps.filter((s) => s.round_id === r.id && s.state === 'pending').map((s) => s.user_id) : [];
  notifyMany([doc.initiator_id, ...pending].filter((u) => u !== actor.id), {
    type: 'comment_added',
    title: `Новый комментарий к документу ${doc.number}`,
    body: `В карточке ${doc.number} новый комментарий. Автор — ${actor.fullName}.`,
    entityType: 'document',
    entityId: id,
  });
  return { id: c.id, author: refOf(actor.id), body, createdAt: isoReq(c.created_at) };
}

// ───────────── Согласование ─────────────

const docRef = (doc: DocRow): string => `${doc.number}${doc.title ? ` ${q(doc.title)}` : ''}`;

function setStatus(doc: DocRow, status: DocRow['status'], extra: Partial<DocRow> = {}): void {
  const completed = ['approved', 'rejected', 'cancelled'].includes(status);
  Object.assign(doc, { status, updated_at: now(), completed_at: completed ? now() : null }, extra);
  enqueueBitrixSync(doc);
}

function launchProblems(doc: DocRow, type: DocTypeRow, approvers: number[]): ErrorDetail[] {
  const problems: ErrorDetail[] = [];
  if (!doc.title.trim()) problems.push({ field: 'title', message: 'Не указано название' });
  if (type.require_description && !doc.description.trim()) problems.push({ field: 'description', message: 'Не заполнено описание' });
  if (doc.kind === 'order') {
    if (!doc.signer_id) problems.push({ field: 'signer', message: 'Не выбран утверждающий' });
    else {
      const s = userById(doc.signer_id);
      if (!s?.active) problems.push({ field: 'signer', message: `Учётная запись утверждающего (${s?.full_name}) заблокирована — выберите другого` });
      else if (!s.roles.includes('signer')) problems.push({ field: 'signer', message: `Сотрудник ${s.full_name} не имеет полномочия «Утверждающий»` });
    }
  } else if (!approvers.length) {
    problems.push({ field: 'approvers', message: 'Не выбран ни один согласующий' });
  }
  if (approvers.length) {
    const blocked = approvers.map((id) => userById(id)).filter((u) => u && !u.active).sort((a, b) => a!.full_name.localeCompare(b!.full_name, 'ru'));
    for (const b of blocked) problems.push({ field: 'approvers', message: `Учётная запись согласующего (${b!.full_name}) заблокирована — замените участника` });
    if (approvers.includes(doc.initiator_id)) problems.push({ field: 'approvers', message: 'Инициатор не может быть согласующим собственного документа' });
  }
  if (type.require_deal && !doc.deal_id) problems.push({ field: 'deal', message: 'Не выбрана сделка Битрикс24' });
  if (type.require_deadline && !doc.due_at) problems.push({ field: 'dueAt', message: 'Не указан срок' });
  if (doc.due_at && doc.due_at <= now()) problems.push({ field: 'dueAt', message: 'Срок уже прошёл — укажите новый срок' });
  const main = latestVersions('document', doc.id).find((x) => x.file.role === 'main');
  if (type.require_excel) {
    if (!main) problems.push({ field: 'mainFile', message: 'Не прикреплён Excel-файл (основной документ)' });
    else if (!['xlsx', 'xls'].includes(main.version.ext)) problems.push({ field: 'mainFile', message: 'Основной документ должен быть Excel-файлом (XLSX или XLS)' });
  } else if (type.require_file && !main) {
    problems.push({ field: 'mainFile', message: 'Не прикреплён основной документ' });
  }
  return problems;
}

function notifySigner(doc: DocRow): void {
  if (!doc.signer_id) return;
  notify({
    userId: doc.signer_id,
    type: 'sign_requested',
    title: `Приказ на утверждение: ${doc.number}`,
    body: `Приказ ${docRef(doc)} ожидает вашего утверждения.`,
    entityType: 'document',
    entityId: doc.id,
  });
}

/** Запуск и повторный запуск: новый раунд создаётся для всех согласующих. */
export function launchDocument(actor: Actor, id: number, routeMode?: RouteMode): DocumentDetail {
  const doc = requireDocument(actor, id);
  requireInitiator(doc, actor, 'Запустить согласование может только инициатор');
  if (doc.status !== 'draft' && doc.status !== 'rework') throw conflict(`Запуск невозможен: документ в статусе ${q(docStatusLabel(doc.status, doc.kind))}`);
  const type = typeOf(doc);
  const approvers = participantsOf(id, 'approver');
  const problems = launchProblems(doc, type, approvers);
  if (problems.length) throw unprocessable('Запуск невозможен: заполните обязательные сведения', problems);

  const mode = routeMode ?? doc.route_mode;
  const relaunch = doc.launch_count > 0;
  const isOrder = doc.kind === 'order';
  Object.assign(doc, {
    status: approvers.length ? 'in_review' : 'on_signing',
    route_mode: mode,
    launch_count: doc.launch_count + 1,
    launched_at: now(),
    completed_at: null,
    updated_at: now(),
    signed_at: null,
    signed_by: null,
  });

  let roundNo: number | null = null;
  if (approvers.length) {
    roundNo = Math.max(0, ...db.rounds.filter((r) => r.document_id === id).map((r) => r.round_no)) + 1;
    const roundId = nextId('rounds');
    db.rounds.push({ id: roundId, document_id: id, round_no: roundNo, mode, started_at: now(), started_by: actor.id, finished_at: null, outcome: null });
    // Снимок версий файлов, рассматриваемых в этом раунде.
    for (const { version } of latestVersions('document', id)) db.roundFiles.push({ round_id: roundId, file_version_id: version.id });
    const first: number[] = [];
    approvers.forEach((userId, i) => {
      const pending = mode === 'parallel' || i === 0;
      db.steps.push({
        id: nextId('steps'),
        round_id: roundId,
        user_id: userId,
        position: i + 1,
        state: pending ? 'pending' : 'waiting',
        comment: null,
        activated_at: pending ? now() : null,
        decided_at: null,
      });
      if (pending) first.push(userId);
    });
    notifyMany(first, {
      type: 'approval_requested',
      title: `Документ на согласование: ${doc.number}`,
      body: `Вам на согласование поступил документ ${docRef(doc)}. Инициатор — ${actor.fullName}.`,
      entityType: 'document',
      entityId: id,
    });
  } else {
    notifySigner(doc);
  }
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: id,
    action: relaunch ? 'approval.relaunched' : 'approval.launched',
    summary: approvers.length
      ? `${relaunch ? 'Согласование запущено повторно' : 'Согласование запущено'}: раунд ${roundNo}, ${ROUTE_MODE_LABELS[mode].toLowerCase()}, согласующих — ${approvers.length}`
      : `${isOrder ? 'Приказ' : 'Документ'} направлен на утверждение${relaunch ? ' повторно' : ''}`,
    details: { roundNo, mode, approvers },
  });
  enqueueBitrixSync(doc);
  return buildDetail(actor, doc);
}

const DECISION_STATE: Record<Decision, StepState> = { approve: 'approved', rework: 'rework', reject: 'rejected' };

export function decide(actor: Actor, id: number, decision: Decision, commentRaw?: string): DocumentDetail {
  const doc = requireDocument(actor, id);
  const comment = clean(commentRaw);
  if (decision !== 'approve' && !comment) {
    throw unprocessable('Укажите комментарий: он обязателен при возврате на доработку и отклонении', [{ field: 'comment', message: 'Комментарий обязателен' }]);
  }
  const round = lastRoundOf(id);
  if (!round) throw conflict('Согласование по документу не запущено');
  const step = db.steps.find((s) => s.round_id === round.id && s.user_id === actor.id && s.state !== 'replaced');
  if (!step) throw forbidden('Вы не являетесь согласующим в текущем раунде');
  const target = DECISION_STATE[decision];
  if (step.state === target) return buildDetail(actor, doc);
  if (round.finished_at) throw conflict('Раунд согласования уже завершён — решение не принято');
  if (step.state !== 'pending') {
    throw conflict(step.state === 'waiting' ? 'Очередь согласования до вас ещё не дошла' : 'Решение по этому шагу уже принято и не может быть изменено');
  }
  Object.assign(step, { state: target, comment: comment || null, decided_at: now() });
  const snapshot = db.roundFiles.filter((r) => r.round_id === round.id).map((r) => r.file_version_id);
  const base = { roundNo: round.round_no, stepId: step.id, fileVersionIds: snapshot };
  const steps = db.steps.filter((s) => s.round_id === round.id);

  if (decision === 'approve') {
    audit({ actorId: actor.id, entityType: 'document', entityId: id, action: 'approval.approved', summary: `Согласовано (раунд ${round.round_no})`, details: { ...base, comment: comment || null } });
    const next = steps.filter((s) => s.state === 'waiting').sort((a, b) => a.position - b.position || a.id - b.id)[0];
    const stillPending = steps.some((s) => s.state === 'pending');
    if (next && !stillPending) {
      next.state = 'pending';
      next.activated_at = now();
      notify({
        userId: next.user_id,
        type: 'approval_requested',
        title: `Документ на согласование: ${doc.number}`,
        body: `Документ ${docRef(doc)} ожидает вашего решения.`,
        entityType: 'document',
        entityId: id,
      });
      doc.updated_at = now();
      enqueueBitrixSync(doc);
    } else if (!next && !stillPending) {
      round.finished_at = now();
      round.outcome = 'approved';
      if (doc.kind === 'order') {
        setStatus(doc, 'on_signing');
        audit({ actorId: null, entityType: 'document', entityId: id, action: 'approval.completed', summary: 'Согласование завершено — приказ направлен на утверждение', details: { roundNo: round.round_no } });
        notifySigner(doc);
        notify({
          userId: doc.initiator_id,
          type: 'approval_completed',
          title: `Приказ ${doc.number} согласован`,
          body: `Приказ ${docRef(doc)} согласован всеми участниками и направлен на утверждение.`,
          entityType: 'document',
          entityId: id,
        });
      } else {
        setStatus(doc, 'approved');
        audit({
          actorId: null,
          entityType: 'document',
          entityId: id,
          action: 'approval.completed',
          summary: 'Согласование завершено: получены все согласования, статус «Согласовано»',
          details: { roundNo: round.round_no },
        });
        notify({
          userId: doc.initiator_id,
          type: 'approval_completed',
          title: `Документ ${doc.number} согласован`,
          body: `Документ ${docRef(doc)} согласован всеми участниками.`,
          entityType: 'document',
          entityId: id,
        });
      }
    }
  } else {
    // Отрицательное решение завершает раунд сразу; остальные шаги — «Не потребовалось».
    for (const s of steps) if (s.state === 'pending' || s.state === 'waiting') s.state = 'skipped';
    round.finished_at = now();
    round.outcome = target as 'rework' | 'rejected';
    setStatus(doc, decision === 'rework' ? 'rework' : 'rejected');
    audit({
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: decision === 'rework' ? 'approval.returned' : 'approval.rejected',
      summary: decision === 'rework' ? `Возвращено на доработку (раунд ${round.round_no})` : `Отклонено (раунд ${round.round_no})`,
      details: { ...base, comment },
    });
    notify({
      userId: doc.initiator_id,
      type: decision === 'rework' ? 'approval_rework' : 'approval_rejected',
      title: decision === 'rework' ? `Документ ${doc.number} возвращён на доработку` : `Документ ${doc.number} отклонён`,
      body: `${actor.fullName}: ${comment}`,
      entityType: 'document',
      entityId: id,
    });
  }
  return buildDetail(actor, doc);
}

/** Карточка после управляющего действия; администратору без права просмотра содержимого — null. */
function manageResult(actor: Actor, id: number): DocumentDetail | null {
  const doc = findDocument(actor, id);
  return doc ? buildDetail(actor, doc) : null;
}

export function changeRoute(actor: Actor, id: number, input: RouteChangeRequest): DocumentDetail | null {
  const doc = requireDocumentForManage(actor, id);
  requireInitiatorOrAdmin(doc, actor);
  const reason = clean(input.reason);
  if (!reason) throw unprocessable('Укажите причину изменения маршрута', [{ field: 'reason', message: 'Причина обязательна' }]);
  if (['approved', 'rejected', 'cancelled', 'archived'].includes(doc.status)) throw conflict('Маршрут завершённого документа изменить нельзя');
  if (doc.status !== 'in_review') {
    throw conflict('Маршрут изменяется во время согласования; в черновике и на доработке измените состав согласующих в карточке');
  }
  const round = openRoundOf(id)!;
  const to = userById(input.toUserId);
  const failTo = (m: string) => fail422(m, 'toUserId');
  if (!to) throw failTo('Сотрудник не найден');
  if (!to.active) throw failTo(`Учётная запись сотрудника ${to.full_name} заблокирована`);
  if (to.id === doc.initiator_id) throw failTo('Инициатор не может быть согласующим собственного документа');
  if (db.steps.some((s) => s.round_id === round.id && s.user_id === to.id && s.state !== 'replaced')) throw failTo(`${to.full_name} уже участвует в этом раунде согласования`);

  if (input.action === 'replace') {
    const step = db.steps.find((s) => s.round_id === round.id && s.user_id === input.fromUserId && s.state !== 'replaced');
    if (!step) throw unprocessable('Заменяемый сотрудник не участвует в текущем раунде', [{ field: 'fromUserId', message: 'Сотрудник не участвует в текущем раунде' }]);
    if (step.state !== 'pending' && step.state !== 'waiting') throw conflict('Нельзя заменить участника, уже принявшего решение');
    const fromName = userById(step.user_id)?.full_name ?? '';
    const prevState = step.state;
    Object.assign(step, { state: 'replaced', decided_at: now(), comment: `Заменён: ${reason}` });
    db.steps.push({
      id: nextId('steps'),
      round_id: round.id,
      user_id: to.id,
      position: step.position,
      state: prevState,
      comment: null,
      activated_at: prevState === 'pending' ? now() : null,
      decided_at: null,
    });
    db.participants = db.participants.filter((p) => !(p.document_id === id && p.role === 'approver' && p.user_id === to.id));
    for (const p of db.participants) if (p.document_id === id && p.role === 'approver' && p.user_id === step.user_id) p.user_id = to.id;
    audit({
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'route.replaced',
      summary: `Маршрут изменён: замена согласующего — ${fromName} → ${to.full_name}. Причина: ${reason}`,
      details: { roundNo: round.round_no, fromUserId: step.user_id, toUserId: to.id, reason, position: step.position },
    });
    notify({
      userId: step.user_id,
      type: 'route_changed',
      title: `Вы исключены из маршрута согласования ${doc.number}`,
      body: `Ваше участие в согласовании документа ${doc.number} больше не требуется.`,
    });
    if (prevState === 'pending') {
      notify({ userId: to.id, type: 'approval_requested', title: `Документ на согласование: ${doc.number}`, body: `Документ ${docRef(doc)} ожидает вашего решения.`, entityType: 'document', entityId: id });
    }
  } else {
    const position = Math.max(0, ...db.steps.filter((s) => s.round_id === round.id).map((s) => s.position)) + 1;
    const pending = round.mode === 'parallel';
    db.steps.push({
      id: nextId('steps'),
      round_id: round.id,
      user_id: to.id,
      position,
      state: pending ? 'pending' : 'waiting',
      comment: null,
      activated_at: pending ? now() : null,
      decided_at: null,
    });
    if (!db.participants.some((p) => p.document_id === id && p.role === 'approver' && p.user_id === to.id)) {
      const pos = Math.max(0, ...db.participants.filter((p) => p.document_id === id && p.role === 'approver').map((p) => p.position)) + 1;
      db.participants.push({ document_id: id, user_id: to.id, role: 'approver', position: pos });
    }
    audit({
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: 'route.added',
      summary: `Маршрут изменён: добавлен согласующий ${to.full_name}. Причина: ${reason}`,
      details: { roundNo: round.round_no, toUserId: to.id, reason, position },
    });
    if (pending) {
      notify({ userId: to.id, type: 'approval_requested', title: `Документ на согласование: ${doc.number}`, body: `Документ ${docRef(doc)} ожидает вашего решения.`, entityType: 'document', entityId: id });
    }
  }
  doc.updated_at = now();
  enqueueBitrixSync(doc);
  return manageResult(actor, id);
}

export function cancelDocument(actor: Actor, id: number, reasonRaw: string): DocumentDetail | null {
  const doc = requireDocumentForManage(actor, id);
  requireInitiatorOrAdmin(doc, actor);
  const reason = clean(reasonRaw);
  if (!reason) throw unprocessable('Укажите причину отмены', [{ field: 'reason', message: 'Причина обязательна' }]);
  if (doc.status === 'cancelled') return manageResult(actor, id);
  if (!['draft', 'in_review', 'rework', 'on_signing'].includes(doc.status)) throw conflict(`Отмена невозможна: документ в статусе ${q(docStatusLabel(doc.status, doc.kind))}`);
  const prev = doc.status;
  const round = openRoundOf(id);
  const waiting: number[] = [];
  if (round) {
    for (const s of db.steps.filter((x) => x.round_id === round.id)) {
      if (s.state === 'pending') waiting.push(s.user_id);
      if (s.state === 'pending' || s.state === 'waiting') s.state = 'skipped';
    }
    round.finished_at = now();
    round.outcome = 'cancelled';
  }
  if (prev === 'on_signing' && doc.signer_id) waiting.push(doc.signer_id);
  setStatus(doc, 'cancelled');
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: id,
    action: 'document.cancelled',
    summary: `Процесс отменён${isAdmin(actor) && doc.initiator_id !== actor.id ? ' администратором' : ''}. Причина: ${reason}`,
    details: { reason, previousStatus: prev },
  });
  notifyMany([...waiting, doc.initiator_id].filter((u) => u !== actor.id), {
    type: 'approval_cancelled',
    title: `Процесс по документу ${doc.number} отменён`,
    body: `Причина: ${reason}`,
    entityType: 'document',
    entityId: id,
  });
  return manageResult(actor, id);
}

export function remind(actor: Actor, id: number): DocumentDetail {
  const doc = requireDocument(actor, id);
  requireInitiator(doc, actor, 'Отправить напоминание может только инициатор');
  let recipients: number[] = [];
  if (doc.status === 'in_review') {
    const r = openRoundOf(id);
    recipients = r ? db.steps.filter((s) => s.round_id === r.id && s.state === 'pending').map((s) => s.user_id) : [];
  } else if (doc.status === 'on_signing' && doc.signer_id) {
    recipients = [doc.signer_id];
  } else {
    throw conflict('Напоминание отправляется, только когда от участников ожидается решение');
  }
  if (doc.last_reminded_at && now() - doc.last_reminded_at < 24 * 3600 * 1000) {
    throw conflict('Напоминание уже отправлялось — повторить можно не чаще одного раза в сутки');
  }
  doc.last_reminded_at = now();
  notifyMany(recipients, {
    type: 'reminder',
    title: `Напоминание: ожидается ваше решение по документу ${doc.number}`,
    body: `Инициатор ${actor.fullName} напоминает о документе ${docRef(doc)}.`,
    entityType: 'document',
    entityId: id,
  });
  audit({ actorId: actor.id, entityType: 'document', entityId: id, action: 'document.reminded', summary: `Отправлено напоминание участникам (${recipients.length})`, details: { recipients } });
  return buildDetail(actor, doc);
}

// ───────────── Приказы ─────────────

function requireOrder(doc: DocRow): void {
  if (doc.kind !== 'order') throw conflict('Действие применяется только к приказам');
}

function notifyAcquaintance(doc: DocRow, userIds: number[]): void {
  notifyMany(userIds, {
    type: 'acknowledge_requested',
    title: `Ознакомьтесь с приказом ${doc.number}`,
    body: `Приказ ${docRef(doc)} утверждён. Подтвердите ознакомление в карточке приказа.`,
    entityType: 'document',
    entityId: doc.id,
  });
}

const SIGN_RESULT: Record<Decision, DocRow['status']> = { approve: 'approved', rework: 'rework', reject: 'rejected' };

const localDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function signOrder(actor: Actor, id: number, decision: Decision, commentRaw?: string): DocumentDetail {
  const doc = requireDocument(actor, id);
  requireOrder(doc);
  if (doc.signer_id !== actor.id) throw forbidden('Утвердить приказ может только указанный в нём утверждающий');
  const comment = clean(commentRaw);
  if (decision !== 'approve' && !comment) {
    throw unprocessable('Укажите комментарий: он обязателен при возврате на доработку и отклонении', [{ field: 'comment', message: 'Комментарий обязателен' }]);
  }
  if (doc.status === SIGN_RESULT[decision] && doc.signed_by === actor.id) return buildDetail(actor, doc);
  if (doc.status !== 'on_signing') throw conflict('Приказ не находится на утверждении');

  if (decision === 'approve') {
    setStatus(doc, 'approved', { signed_at: now(), signed_by: actor.id, order_date: doc.order_date ?? localDate(now()) });
    audit({ actorId: actor.id, entityType: 'document', entityId: id, action: 'order.signed', summary: 'Приказ утверждён', details: { comment: comment || null, orderDate: doc.order_date } });
    notify({
      userId: doc.initiator_id,
      type: 'order_signed',
      title: `Приказ ${doc.number} утверждён`,
      body: `Приказ ${docRef(doc)} утверждён. Сотрудникам из списка ознакомления направлены уведомления.`,
      entityType: 'document',
      entityId: id,
    });
    const list = db.participants.filter((p) => p.document_id === id && p.role === 'acquaintance').map((p) => p.user_id);
    if (list.length) {
      notifyAcquaintance(doc, list);
      audit({ actorId: null, entityType: 'document', entityId: id, action: 'order.acquaintance_started', summary: `Приказ направлен на ознакомление: сотрудников — ${list.length}`, details: { userIds: list } });
    }
  } else {
    setStatus(doc, SIGN_RESULT[decision], { signed_by: actor.id });
    audit({
      actorId: actor.id,
      entityType: 'document',
      entityId: id,
      action: decision === 'rework' ? 'order.returned' : 'order.rejected',
      summary: decision === 'rework' ? 'Приказ возвращён утверждающим на доработку' : 'Приказ отклонён утверждающим',
      details: { comment },
    });
    notify({
      userId: doc.initiator_id,
      type: decision === 'rework' ? 'approval_rework' : 'approval_rejected',
      title: decision === 'rework' ? `Приказ ${doc.number} возвращён на доработку` : `Приказ ${doc.number} отклонён`,
      body: `${actor.fullName}: ${comment}`,
      entityType: 'document',
      entityId: id,
    });
  }
  return buildDetail(actor, doc);
}

export function archiveOrder(actor: Actor, id: number): DocumentDetail | null {
  const doc = requireDocumentForManage(actor, id);
  requireOrder(doc);
  requireInitiatorOrAdmin(doc, actor);
  if (doc.status === 'archived') return manageResult(actor, id);
  if (doc.status !== 'approved') throw conflict('В архив можно перевести только утверждённый приказ');
  doc.status = 'archived';
  doc.updated_at = now();
  audit({ actorId: actor.id, entityType: 'document', entityId: id, action: 'order.archived', summary: 'Приказ переведён в архив' });
  return manageResult(actor, id);
}

export function acknowledge(actor: Actor, id: number): DocumentDetail {
  const doc = requireDocument(actor, id);
  requireOrder(doc);
  if (!inAcquaintance(id, actor.id)) throw forbidden('Вы не входите в список ознакомления с этим приказом');
  if (hasAck(id, actor.id)) return buildDetail(actor, doc);
  if (doc.status !== 'approved') throw conflict(doc.status === 'archived' ? 'Приказ находится в архиве' : 'Ознакомиться можно только с утверждённым приказом');
  const version = latestVersions('document', id).find((x) => x.file.role === 'main')?.version;
  db.acks.push({ document_id: id, user_id: actor.id, file_version_id: version?.id ?? null, acknowledged_at: now() });
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: id,
    action: 'order.acknowledged',
    summary: `Ознакомление с приказом подтверждено${version ? ` (версия файла ${version.version_no})` : ''}`,
    details: { fileVersionId: version?.id ?? null, fileVersionNo: version?.version_no ?? null },
  });
  return buildDetail(actor, doc);
}

export function setAcquaintance(actor: Actor, id: number, userIdsRaw: number[]): DocumentDetail {
  const doc = requireDocument(actor, id);
  requireOrder(doc);
  requireInitiator(doc, actor, 'Изменять список ознакомления может только инициатор приказа');
  if (['rejected', 'cancelled', 'archived'].includes(doc.status)) throw conflict('Список ознакомления завершённого приказа изменить нельзя');
  const next = uniq(userIdsRaw);
  const old = participantsOf(id, 'acquaintance');
  const added = next.filter((u) => !old.includes(u));
  const removed = old.filter((u) => !next.includes(u));
  if (doc.status === 'approved' && removed.length) throw conflict('После утверждения приказа список ознакомления можно дополнять, но не сокращать');
  requireActiveUsers(added, 'userIds');
  if (!added.length && !removed.length) return buildDetail(actor, doc);
  db.participants = db.participants.filter((p) => !(p.document_id === id && p.role === 'acquaintance' && removed.includes(p.user_id)));
  let pos = old.length;
  for (const u of added) db.participants.push({ document_id: id, user_id: u, role: 'acquaintance', position: ++pos });
  doc.updated_at = now();
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: id,
    action: 'order.acquaintance_changed',
    summary: `Список ознакомления изменён: добавлено — ${added.length}, исключено — ${removed.length}`,
    details: { added, removed },
  });
  if (doc.status === 'approved') notifyAcquaintance(doc, added);
  return buildDetail(actor, doc);
}

export { notFound };
