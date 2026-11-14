import type { Deal } from '../api-types';
import { formatDateTimeRu } from '../common';
import { config } from '../config';
import { MockBitrixAdapter } from './mock';
import { RestBitrixAdapter } from './rest';

export interface ApprovalTaskInput {
  /** null — запись ещё не создана. */
  externalTaskId: string | null;
  /** "DOCFLOW-<id документа>" — ключ идемпотентности. */
  marker: string;
  dealId: string;
  title: string;
  number: string;
  statusCode: string;
  statusLabel: string;
  cardUrl: string;
  createdAt: string;
  initiator: string;
  currentApprovers: string[];
}

export interface ApprovalTaskResult {
  externalTaskId: string;
  /**
   * created — запись создана впервые; updated — обновлена; recreated — была удалена в Битрикс24
   * и создана заново; reopened — была закрыта при активном согласовании и возобновлена.
   */
  event: 'created' | 'updated' | 'recreated' | 'reopened';
}

export interface BitrixAdapter {
  /** Поиск по названию и номеру. */
  searchDeals(query: string): Promise<Deal[]>;
  getDeal(id: string): Promise<Deal | null>;
  upsertApprovalTask(input: ApprovalTaskInput): Promise<ApprovalTaskResult>;
  dealUrl(id: string): string;
}

/** Ошибка связи с Битрикс24 или отказ с его стороны. Текст — русский, без секретов вебхука. */
export class BitrixError extends Error {}

/** Статусы, при которых запись в Битрикс24 завершается. */
export const FINAL_STATUSES = ['approved', 'rejected', 'cancelled', 'archived'];

export function taskTitle(input: ApprovalTaskInput): string {
  return `[${input.statusLabel}] ${input.title || input.number}`;
}

export function taskDescription(input: ApprovalTaskInput): string {
  const lines = [
    `Согласование ${input.number}`,
    `Статус: ${input.statusLabel}`,
    `Карточка: ${input.cardUrl}`,
    `Инициатор: ${input.initiator}`,
  ];
  if (input.currentApprovers.length) lines.push(`Текущие согласующие: ${input.currentApprovers.join(', ')}`);
  lines.push(`Дата создания: ${formatDateTimeRu(new Date(input.createdAt))}`);
  lines.push('Запись ведётся системой документооборота; решение принимается в карточке согласования.');
  return lines.join('\n');
}

let adapter: BitrixAdapter | null = null;

export function getBitrixAdapter(): BitrixAdapter {
  if (!adapter) {
    adapter =
      config.bitrixMode === 'rest'
        ? new RestBitrixAdapter({
            webhookUrl: config.bitrixWebhookUrl,
            portalUrl: config.bitrixPortalUrl,
            responsibleId: config.bitrixResponsibleId,
            timeoutMs: config.bitrixTimeoutMs,
          })
        : new MockBitrixAdapter();
  }
  return adapter;
}

/** Подмена адаптера (тесты). */
export function setBitrixAdapter(a: BitrixAdapter | null): void {
  adapter = a;
}
