/** Запрос на создание заказа в Битрикс24 по согласованному GPM (контракт — src/api/orderRequest.ts). */
import type { OrderRequestApprover, OrderRequestInfo, OrderRequestState } from '../api/orderRequest';
import { AppError, conflict, notFound } from '../../../server/src/errors';
import { type Actor, audit, formatDateTimeRu, isAdmin, isoReq, refOf, requireDocument } from './core';
import { appHref } from './bitrix';
import { type DocRow, db, getBlob, nextId, now } from './db';

interface OrderRequestRow {
  id: number;
  document_id: number;
  deal_id: string;
  number: string;
  round_no: number;
  approved_at: number;
  approvers: Array<{ user_id: number; decided_at: number; comment: string | null }>;
  version_id: number;
  comment: string | null;
  author_id: number;
  created_at: number;
}

/** Таблица в сохранённом состоянии демо (у ранних сохранений её нет). */
function rows(): OrderRequestRow[] {
  const s = db as unknown as { orderRequests?: OrderRequestRow[] };
  return (s.orderRequests ??= []);
}

const isGpm = (d: DocRow) => d.kind === 'approval' && db.docTypes.find((t) => t.id === d.doc_type_id)?.code === 'GPM';

/** Последний завершённый с согласованием запуск и его решения. */
function approvalOf(d: DocRow) {
  const round = db.rounds.filter((r) => r.document_id === d.id && r.outcome === 'approved').sort((a, b) => b.round_no - a.round_no)[0];
  if (!round) return null;
  const approvers = db.steps
    .filter((s) => s.round_id === round.id && s.state === 'approved' && s.decided_at !== null)
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ user_id: s.user_id, decided_at: s.decided_at!, comment: s.comment }));
  return { round, approvers, approvedAt: round.finished_at ?? Math.max(...approvers.map((a) => a.decided_at)) };
}

/** Последняя версия основного Excel-файла. */
function latestGpmVersion(d: DocRow) {
  const file = db.files.find((f) => f.owner_type === 'document' && f.owner_id === d.id && f.role === 'main' && f.deleted_at === null);
  if (!file) return null;
  return db.versions.filter((v) => v.file_id === file.id).sort((a, b) => b.version_no - a.version_no)[0] ?? null;
}

const mapApprovers = (list: OrderRequestRow['approvers']): OrderRequestApprover[] =>
  list.map((a) => ({ user: refOf(a.user_id), decidedAt: isoReq(a.decided_at), comment: a.comment }));

function toInfo(r: OrderRequestRow): OrderRequestInfo {
  const d = db.documents.find((x) => x.id === r.document_id)!;
  const v = db.versions.find((x) => x.id === r.version_id)!;
  return {
    id: r.id,
    number: r.number,
    documentId: d.id,
    documentNumber: d.number,
    documentTitle: d.title,
    dealId: r.deal_id,
    dealTitle: d.deal_title,
    gpmApproved: true,
    approvedAt: isoReq(r.approved_at),
    roundNo: r.round_no,
    approvers: mapApprovers(r.approvers),
    file: { name: v.original_name, versionNo: v.version_no, size: v.size, downloadUrl: `/api/bitrix-mock/order-requests/${r.id}/file` },
    comment: r.comment,
    author: refOf(r.author_id),
    createdAt: isoReq(r.created_at),
    status: 'new',
    statusLabel: 'Новый',
    url: appHref(`/b24/order-requests/${r.id}`),
  };
}

/** Причина, по которой запрос отправить нельзя, или null. */
function blocker(d: DocRow, actor: Actor): string | null {
  if (!isGpm(d)) return 'Запрос на создание заказа отправляется только по согласованию GPM-калькулятора';
  if (d.initiator_id !== actor.id && !isAdmin(actor)) return 'Отправить запрос может инициатор согласования или администратор';
  if (d.status !== 'approved') return 'Запрос можно отправить после того, как все согласующие примут положительное решение';
  if (!d.deal_id) return 'Согласование не связано со сделкой Битрикс24';
  if (!latestGpmVersion(d)) return 'В карточке нет Excel-файла GPM-калькулятора';
  return null;
}

export function orderRequestState(actor: Actor, docId: number): OrderRequestState {
  const d = requireDocument(actor, docId);
  const existing = rows().find((r) => r.document_id === d.id);
  if (existing) return { request: toInfo(existing), canSend: false, reason: null, preview: null };
  if (!isGpm(d)) return { request: null, canSend: false, reason: null, preview: null };
  const why = blocker(d, actor);
  const ap = approvalOf(d);
  const v = latestGpmVersion(d);
  return {
    request: null,
    canSend: why === null,
    reason: why,
    preview:
      d.status === 'approved' && ap && v
        ? { approvers: mapApprovers(ap.approvers), approvedAt: isoReq(ap.approvedAt), roundNo: ap.round.round_no, file: { name: v.original_name, versionNo: v.version_no, size: v.size } }
        : null,
  };
}

export function sendOrderRequest(actor: Actor, docId: number, body: { comment?: unknown }): OrderRequestInfo {
  const d = requireDocument(actor, docId);
  if (rows().some((r) => r.document_id === d.id)) throw conflict('Запрос на создание заказа по этому согласованию уже отправлен');
  const why = blocker(d, actor);
  if (why) throw conflict(why);
  if (db.settings.mockUnavailable) {
    audit({ actorId: actor.id, entityType: 'bitrix', entityId: d.id, action: 'order_request_failed', summary: `Не удалось отправить запрос на создание заказа по ${d.number}: Битрикс24 недоступен` });
    throw new AppError(502, 'bitrix_unavailable', 'Битрикс24 недоступен: запрос на создание заказа не отправлен. Повторите попытку позже.');
  }
  const ap = approvalOf(d)!;
  const v = latestGpmVersion(d)!;
  const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 2000) : null;
  const id = nextId('orderRequests');
  const row: OrderRequestRow = {
    id,
    document_id: d.id,
    deal_id: d.deal_id!,
    number: `ЗАК-${String(1040 + id).padStart(6, '0')}`,
    round_no: ap.round.round_no,
    approved_at: ap.approvedAt,
    approvers: ap.approvers,
    version_id: v.id,
    comment,
    author_id: actor.id,
    created_at: now(),
  };
  rows().push(row);
  const names = ap.approvers.map((a) => refOf(a.user_id).fullName).join(', ');
  audit({
    actorId: actor.id,
    entityType: 'document',
    entityId: d.id,
    action: 'order_request_sent',
    summary: `Отправлен запрос на создание заказа в Битрикс24 (${row.number}, поток «Запрос на создание заказа»): GPM согласован ${formatDateTimeRu(ap.approvedAt)} — ${names}; приложен «${v.original_name}», версия ${v.version_no}`,
    details: { requestId: id, number: row.number, dealId: row.deal_id, versionId: v.id },
  });
  return toInfo(row);
}

export function listOrderRequests(dealId: string | undefined): { items: OrderRequestInfo[] } {
  return { items: rows().filter((r) => !dealId || r.deal_id === dealId).sort((a, b) => b.id - a.id).map(toInfo) };
}

export function getOrderRequest(id: number): OrderRequestInfo {
  const r = rows().find((x) => x.id === id);
  if (!r) throw notFound('Запрос не найден');
  return toInfo(r);
}

/** Файл хранится в Битрикс24 как копия — доступен на странице элемента потока. */
export function orderRequestFile(id: number): { name: string; mime: string; bytes: Uint8Array } {
  const r = rows().find((x) => x.id === id);
  const v = r && db.versions.find((x) => x.id === r.version_id);
  if (!v) throw notFound('Файл не найден');
  const bytes = getBlob(v.storage_key);
  if (!bytes) throw notFound('Содержимое файла не сохранилось после перезагрузки страницы демо');
  return { name: v.original_name, mime: v.mime, bytes };
}
