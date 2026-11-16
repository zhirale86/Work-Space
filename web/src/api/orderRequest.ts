/**
 * Запрос на создание заказа (счёта) в Битрикс24 по согласованному GPM-калькулятору.
 * Утверждается на демо, затем реализуется на сервере.
 *
 * GET  /documents/:id/order-request          → OrderRequestState
 * POST /documents/:id/order-request          { comment?: string } → OrderRequestInfo
 *      409 — запрос уже отправлен или документ не согласован; 502 bitrix_unavailable — нет связи с Битрикс24.
 * GET  /bitrix-mock/order-requests?dealId=   → { items: OrderRequestInfo[] }   (эмулятор)
 * GET  /bitrix-mock/order-requests/:id       → OrderRequestInfo                (эмулятор)
 * GET  /bitrix-mock/order-requests/:id/file  → файл, переданный в Битрикс24    (эмулятор)
 */
import type { IsoDateTime, UserRef } from './types';

export interface OrderRequestApprover {
  user: UserRef;
  decidedAt: IsoDateTime;
  comment: string | null;
}

export interface OrderRequestInfo {
  id: number;
  /** Номер элемента потока в Битрикс24. */
  number: string;
  documentId: number;
  documentNumber: string;
  documentTitle: string;
  dealId: string;
  dealTitle: string | null;
  /** Отметка для потока: GPM-калькулятор согласован. */
  gpmApproved: true;
  approvedAt: IsoDateTime;
  /** Номер запуска, в котором получены все согласования. */
  roundNo: number;
  approvers: OrderRequestApprover[];
  file: { name: string; versionNo: number; size: number; downloadUrl: string };
  comment: string | null;
  author: UserRef;
  createdAt: IsoDateTime;
  status: 'new';
  statusLabel: string;
  /** Ссылка на элемент потока в Битрикс24 (в демо — страница эмулятора). */
  url: string;
}

export interface OrderRequestState {
  request: OrderRequestInfo | null;
  /** Можно ли отправить запрос сейчас (кнопка видна только инициатору и администратору). */
  canSend: boolean;
  /** Почему кнопка недоступна — для подсказки; null, если доступна или запрос уже отправлен. */
  reason: string | null;
  /** Что будет передано: согласующие и последняя версия файла (для окна подтверждения). */
  preview: { approvers: OrderRequestApprover[]; approvedAt: IsoDateTime; roundNo: number; file: { name: string; versionNo: number; size: number } } | null;
}

/** Название существующего потока в Битрикс24. */
export const ORDER_FLOW_NAME = 'Запрос на создание заказа';

/** Пока сервер не реализует запрос на создание заказа, функция включена только в демо-сборке. */
export const ORDER_REQUEST_ENABLED = import.meta.env.VITE_DEMO === '1';
