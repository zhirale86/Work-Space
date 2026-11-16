/** Расширение отчётов: «Мои согласования», провал в цифру, «Все согласования» (контракт — src/api/reportsExt.ts). */
import type { AllApprovalsReport, AllState, ApproverState, DrillAs, DrillReport, InitiatorState, MyApprovalsReport } from '../api/reportsExt';
import { ALL_LABELS, APPROVER_LABELS, INITIATOR_LABELS } from '../api/reportsExt';
import { AppError } from '../../../server/src/errors';
import { type Actor, type Paging, deptRef, docVisible, ilike, isAdmin, isAuditor, isDocOverdue, pageOf, refOf } from './core';
import { db, type DocRow } from './db';
import { toListItem } from './documents';

const sortDocs = (list: DocRow[]) => list.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
const visible = (actor: Actor) => db.documents.filter((d) => docVisible(actor, d));

/** Шаги сотрудника, где от него требовалось или было принято решение (без очереди, замен и «не потребовалось»). */
export function stepsOf(userId: number, docId: number) {
  const rounds = new Set(db.rounds.filter((r) => r.document_id === docId).map((r) => r.id));
  return db.steps.filter((s) => rounds.has(s.round_id) && s.user_id === userId && ['pending', 'approved', 'rework', 'rejected'].includes(s.state));
}

export function approverMatch(d: DocRow, userId: number, state: ApproverState): boolean {
  const steps = stepsOf(userId, d.id);
  if (!steps.length) return false;
  const pending = d.status === 'in_review' && steps.some((s) => s.state === 'pending');
  switch (state) {
    case 'pending':
      return pending;
    case 'overdue':
      return pending && isDocOverdue(d);
    case 'all':
      return true;
    default:
      return steps.some((s) => s.state === state);
  }
}

function statusMatch(d: DocRow, state: InitiatorState): boolean {
  switch (state) {
    case 'in_progress':
      return d.status === 'in_review' || d.status === 'on_signing';
    case 'approved':
      return d.status === 'approved' || d.status === 'archived';
    case 'all':
      return d.status !== 'draft';
    default:
      return d.status === state;
  }
}

const APPROVER_STATES = Object.keys(APPROVER_LABELS) as ApproverState[];
const INITIATOR_STATES = Object.keys(INITIATOR_LABELS) as InitiatorState[];
const ALL_STATES = Object.keys(ALL_LABELS) as AllState[];

export function myApprovals(actor: Actor): MyApprovalsReport {
  const docs = visible(actor);
  const approver = Object.fromEntries(APPROVER_STATES.map((s) => [s, docs.filter((d) => approverMatch(d, actor.id, s)).length])) as Record<ApproverState, number>;
  const mine = docs.filter((d) => d.initiator_id === actor.id);
  const initiator = Object.fromEntries(INITIATOR_STATES.map((s) => [s, mine.filter((d) => statusMatch(d, s)).length])) as Record<InitiatorState, number>;
  return { approver, initiator };
}

const bad = (field: string) => new AppError(400, 'validation', 'Некорректные данные запроса', [{ field, message: 'Недопустимое значение' }]);

function shortName(userId: number): string {
  const u = refOf(userId);
  const [last, first, middle] = u.fullName.split(' ');
  return [last, first && `${first[0]}.`, middle && `${middle[0]}.`].filter(Boolean).join(' ');
}

export function drill(actor: Actor, q: Record<string, string>, pg: Paging): DrillReport {
  const as = q.as as DrillAs;
  if (!['approver', 'initiator', 'department'].includes(as)) throw bad('as');
  const id = Number(q.id ?? (as === 'department' ? 0 : actor.id));
  if (!Number.isInteger(id) || id < 0) throw bad('id');
  const docs = visible(actor);
  let list: DocRow[];
  let title: string;
  if (as === 'approver') {
    const state = q.state as ApproverState;
    if (!APPROVER_STATES.includes(state)) throw bad('state');
    list = docs.filter((d) => approverMatch(d, id, state));
    const who = id === actor.id ? 'Я — согласующий' : `${shortName(id)} — согласующий`;
    title = `${who}: ${APPROVER_LABELS[state].toLowerCase()}`;
  } else {
    const state = q.state as InitiatorState;
    if (!INITIATOR_STATES.includes(state)) throw bad('state');
    if (as === 'initiator') {
      list = docs.filter((d) => d.initiator_id === id && statusMatch(d, state));
      title = `${id === actor.id ? 'Я — инициатор' : `${shortName(id)} — инициатор`}: ${INITIATOR_LABELS[state].toLowerCase()}`;
    } else {
      list = docs.filter((d) => (d.department_id ?? 0) === id && statusMatch(d, state));
      title = `${deptRef(id || null)?.name ?? 'Без подразделения'}: ${INITIATOR_LABELS[state].toLowerCase()}`;
    }
  }
  const page = pageOf(sortDocs(list), pg);
  return { ...page, title, items: page.items.map((d) => toListItem(d, actor)) };
}

function allMatch(d: DocRow, state: AllState): boolean {
  switch (state) {
    case 'all':
      return d.status !== 'draft';
    case 'active':
      return d.status === 'in_review' || d.status === 'on_signing';
    case 'approved':
      return d.status === 'approved' || d.status === 'archived';
    default:
      return d.status === state;
  }
}

export function allApprovals(actor: Actor, q: Record<string, string>, pg: Paging): AllApprovalsReport {
  if (!isAdmin(actor) && !isAuditor(actor)) throw new AppError(403, 'forbidden', 'Раздел доступен администратору и контролю документов');
  const state = (q.state || 'all') as AllState;
  if (!ALL_STATES.includes(state)) throw bad('state');
  if (q.kind && !['approval', 'order'].includes(q.kind)) throw bad('kind');
  const base = db.documents.filter((d) => (!q.kind || d.kind === q.kind) && (!q.q?.trim() || ilike(d.number, q.q.trim()) || ilike(d.title, q.q.trim()) || ilike(d.deal_title, q.q.trim())));
  const counts = Object.fromEntries(ALL_STATES.map((s) => [s, base.filter((d) => allMatch(d, s)).length])) as Record<AllState, number>;
  const page = pageOf(sortDocs(base.filter((d) => allMatch(d, state))), pg);
  return { ...page, counts, items: page.items.map((d) => toListItem(d, actor)) };
}
