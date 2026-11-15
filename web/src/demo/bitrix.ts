/**
 * Эмулятор Битрикс24 и очередь передачи (server/src/bitrix): одна задача в сделке на каждое
 * согласование с актуальным статусом, режим «недоступен», повторы с паузами.
 */
import type { BitrixLinkInfo, Deal, MockDeal, MockDealDetail, MockTask, MockTaskStatus } from '../api/types';
import { BITRIX_STATE_LABELS, MOCK_TASK_STATUS_LABELS, docStatusLabel } from '../../../server/src/labels';
import { notFound } from '../../../server/src/errors';
import { audit, formatDateTimeRu, ilike, iso, isoReq, q, userById } from './core';
import { type DocRow, type LinkRow, type MockDealRow, type MockTaskRow, db, nextId, now } from './db';

/** Адрес внутри демо (hash-маршрутизация), пригодный для открытия в новой вкладке. */
export function appHref(path: string): string {
  const base = typeof window === 'undefined' ? '' : window.location.href.split('#')[0];
  return `${base}#${path}`;
}

export const mockDealUrl = (id: string | number): string => appHref(`/b24/deals/${id}`);

class BitrixError extends Error {}

const FINAL_STATUSES = ['approved', 'rejected', 'cancelled', 'archived'];
/** Паузы между автоматическими повторами, минут. */
const BACKOFF_MIN = [1, 5, 15, 60];

function ensureAvailable(): void {
  if (db.settings.mockUnavailable) throw new BitrixError('Битрикс24 недоступен: нет связи с порталом (эмулятор в режиме «недоступен»)');
}

const toDeal = (r: MockDealRow): Deal => ({ id: String(r.id), title: r.title, url: mockDealUrl(r.id), stage: r.stage, company: r.company, amount: r.amount });

export function searchDeals(query: string): Deal[] {
  ensureAvailable();
  const s = query.trim();
  return db.mockDeals
    .filter((d) => !s || ilike(d.title, s) || ilike(d.company, s) || String(d.id) === s)
    .sort((a, b) => Number(String(b.id) === s) - Number(String(a.id) === s) || b.id - a.id)
    .slice(0, 20)
    .map(toDeal);
}

export function getDeal(id: string): Deal | null {
  ensureAvailable();
  if (!/^\d{1,9}$/.test(id)) return null;
  const r = db.mockDeals.find((d) => d.id === Number(id));
  return r ? toDeal(r) : null;
}

/** Исключение адаптера наружу — как ответ 502 сервера. */
export { BitrixError };

interface TaskInput {
  externalTaskId: string | null;
  marker: string;
  dealId: string;
  title: string;
  number: string;
  statusCode: string;
  statusLabel: string;
  cardUrl: string;
  createdAt: number;
  initiator: string;
  currentApprovers: string[];
}

const taskTitle = (i: TaskInput): string => `[${i.statusLabel}] ${i.title || i.number}`;

function taskDescription(i: TaskInput): string {
  const lines = [`Согласование ${i.number}`, `Статус: ${i.statusLabel}`, `Карточка: ${i.cardUrl}`, `Инициатор: ${i.initiator}`];
  if (i.currentApprovers.length) lines.push(`Текущие согласующие: ${i.currentApprovers.join(', ')}`);
  lines.push(`Дата создания: ${formatDateTimeRu(i.createdAt)}`);
  lines.push('Запись ведётся системой документооборота; решение принимается в карточке согласования.');
  return lines.join('\n');
}

function upsertApprovalTask(input: TaskInput): { externalTaskId: string; event: 'created' | 'updated' | 'recreated' | 'reopened' } {
  ensureAvailable();
  if (!/^\d{1,9}$/.test(input.dealId) || !db.mockDeals.some((d) => d.id === Number(input.dealId))) {
    throw new BitrixError(`Битрикс24 отклонил запрос: сделка ${input.dealId} не найдена`);
  }
  const final = FINAL_STATUSES.includes(input.statusCode);
  const status: MockTaskStatus = final ? 'completed' : 'in_progress';
  let existing: MockTaskRow | undefined;
  let lost = false;
  if (input.externalTaskId) {
    existing = db.mockTasks.find((t) => t.id === Number(input.externalTaskId));
    lost = !existing;
  }
  existing ??= db.mockTasks.find((t) => t.marker === input.marker);
  if (!existing) {
    const id = nextId('mockTasks');
    db.mockTasks.push({
      id,
      deal_id: Number(input.dealId),
      marker: input.marker,
      title: taskTitle(input),
      description: taskDescription(input),
      status,
      created_at: now(),
      updated_at: now(),
    });
    return { externalTaskId: String(id), event: lost ? 'recreated' : 'created' };
  }
  const reopened = existing.status === 'completed' && !final;
  Object.assign(existing, { deal_id: Number(input.dealId), title: taskTitle(input), description: taskDescription(input), status, updated_at: now() });
  return { externalTaskId: String(existing.id), event: reopened ? 'reopened' : 'updated' };
}

// ───────────── Очередь передачи ─────────────

export function toLinkInfo(l: LinkRow, kind = 'approval'): BitrixLinkInfo {
  return {
    state: l.state,
    stateLabel: BITRIX_STATE_LABELS[l.state],
    externalTaskId: l.external_task_id,
    syncedStatus: l.synced_status,
    syncedStatusLabel: l.synced_status ? docStatusLabel(l.synced_status, kind) : null,
    attempts: l.attempts,
    lastError: l.last_error,
    lastAttemptAt: iso(l.last_attempt_at),
    nextAttemptAt: l.state === 'synced' ? null : iso(l.next_attempt_at),
  };
}

export const getLink = (documentId: number): LinkRow | undefined => db.bitrixLinks.find((l) => l.document_id === documentId);

/** Ставит документ в очередь передачи (запись появляется при первом запуске согласования со сделкой). */
export function enqueueBitrixSync(doc: Pick<DocRow, 'id' | 'deal_id' | 'kind' | 'launch_count'>): void {
  if (!doc.deal_id || doc.kind !== 'approval' || doc.launch_count < 1) return;
  const l = getLink(doc.id);
  if (l) {
    l.state = 'pending';
    l.next_attempt_at = now();
  } else {
    db.bitrixLinks.push({
      document_id: doc.id,
      external_task_id: null,
      state: 'pending',
      synced_status: null,
      attempts: 0,
      last_error: null,
      last_attempt_at: null,
      next_attempt_at: now(),
    });
  }
}

export interface SyncStats {
  processed: number;
  synced: number;
  failed: number;
}

/** Обработка очереди: записи pending/error с наступившим временем попытки (`force` — без ожидания). */
export function processBitrixQueue(opts: { documentId?: number; force?: boolean } = {}): SyncStats {
  const stats: SyncStats = { processed: 0, synced: 0, failed: 0 };
  const due = db.bitrixLinks
    .filter((l) => (l.state === 'pending' || l.state === 'error') && (opts.force || (l.next_attempt_at ?? 0) <= now()))
    .filter((l) => opts.documentId === undefined || l.document_id === opts.documentId)
    .sort((a, b) => (a.next_attempt_at ?? 0) - (b.next_attempt_at ?? 0) || a.document_id - b.document_id);
  for (const link of due) {
    stats.processed++;
    if (syncOne(link)) stats.synced++;
    else stats.failed++;
  }
  return stats;
}

function syncOne(link: LinkRow): boolean {
  const doc = db.documents.find((d) => d.id === link.document_id);
  if (!doc || !doc.deal_id) {
    link.state = 'synced';
    link.last_error = null;
    return true;
  }
  const open = db.rounds.find((r) => r.document_id === doc.id && r.finished_at === null);
  const approvers = open
    ? db.steps
        .filter((s) => s.round_id === open.id && s.state === 'pending')
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((s) => userById(s.user_id)?.full_name ?? '')
    : [];
  const statusLabel = docStatusLabel(doc.status, doc.kind);
  try {
    const res = upsertApprovalTask({
      externalTaskId: link.external_task_id,
      marker: `DOCFLOW-${doc.id}`,
      dealId: doc.deal_id,
      title: doc.title,
      number: doc.number,
      statusCode: doc.status,
      statusLabel,
      cardUrl: appHref(`/documents/${doc.id}`),
      createdAt: doc.created_at,
      initiator: userById(doc.initiator_id)?.full_name ?? '',
      currentApprovers: approvers,
    });
    const retried = link.state === 'error' || link.attempts > 0;
    const prevStatus = link.synced_status;
    Object.assign(link, {
      state: 'synced',
      external_task_id: res.externalTaskId,
      synced_status: doc.status,
      attempts: 0,
      last_error: null,
      last_attempt_at: now(),
    });
    if (res.event !== 'updated' || prevStatus !== doc.status || retried) {
      const summary =
        res.event === 'created'
          ? `В Битрикс24 создана запись о согласовании (задача № ${res.externalTaskId}), статус ${q(statusLabel)}`
          : res.event === 'recreated'
            ? `Запись в Битрикс24 была удалена и создана заново (задача № ${res.externalTaskId}), статус ${q(statusLabel)}`
            : res.event === 'reopened'
              ? `Запись в Битрикс24 была закрыта при активном согласовании и возобновлена, статус ${q(statusLabel)}`
              : `Статус ${q(statusLabel)} передан в Битрикс24${retried ? ' после повторной попытки' : ''}`;
      audit({
        actorId: null,
        entityType: 'document',
        entityId: doc.id,
        action: `bitrix.${res.event === 'updated' ? 'synced' : res.event}`,
        summary,
        details: { externalTaskId: res.externalTaskId, status: doc.status, dealId: doc.deal_id },
      });
    }
    return true;
  } catch (err) {
    const message = ((err as Error)?.message || 'Неизвестная ошибка').slice(0, 500);
    const attempts = link.attempts + 1;
    const pause = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
    Object.assign(link, { state: 'error', attempts, last_error: message, last_attempt_at: now(), next_attempt_at: now() + pause * 60_000 });
    audit({
      actorId: null,
      entityType: 'document',
      entityId: doc.id,
      action: 'bitrix.error',
      summary: `Ошибка передачи в Битрикс24 (попытка ${attempts}): ${message}`,
      details: { attempts, error: message, status: doc.status, nextAttemptInMinutes: pause },
    });
    return false;
  }
}

// ───────────── Страницы эмулятора ─────────────

function toMockTask(t: MockTaskRow): MockTask {
  const docId = /^DOCFLOW-(\d+)$/.exec(t.marker)?.[1];
  return {
    id: t.id,
    dealId: t.deal_id,
    marker: t.marker,
    title: t.title,
    description: t.description,
    status: t.status,
    statusLabel: MOCK_TASK_STATUS_LABELS[t.status],
    createdAt: isoReq(t.created_at),
    updatedAt: isoReq(t.updated_at),
    cardUrl: /Карточка: (\S+)/.exec(t.description)?.[1] ?? null,
    documentId: docId ? Number(docId) : null,
  };
}

const toMockDeal = (d: MockDealRow): MockDeal => ({
  id: d.id,
  title: d.title,
  stage: d.stage,
  company: d.company,
  amount: d.amount,
  url: mockDealUrl(d.id),
  tasksCount: db.mockTasks.filter((t) => t.deal_id === d.id).length,
});

export function listMockDeals(s: string): MockDeal[] {
  const v = s.trim();
  return db.mockDeals
    .filter((d) => !v || ilike(d.title, v) || ilike(d.company, v) || String(d.id) === v)
    .sort((a, b) => a.id - b.id)
    .map(toMockDeal);
}

export function getMockDeal(id: number): MockDealDetail {
  const d = db.mockDeals.find((x) => x.id === id);
  if (!d) throw notFound('Сделка не найдена');
  return { ...toMockDeal(d), tasks: db.mockTasks.filter((t) => t.deal_id === id).sort((a, b) => a.id - b.id).map(toMockTask) };
}

export function deleteMockTask(id: number): void {
  const i = db.mockTasks.findIndex((t) => t.id === id);
  if (i < 0) throw notFound('Задача не найдена');
  db.mockTasks.splice(i, 1);
}

export function completeMockTask(id: number): void {
  const t = db.mockTasks.find((x) => x.id === id);
  if (!t) throw notFound('Задача не найдена');
  t.status = 'completed';
  t.updated_at = now();
}
