import type { BitrixLinkInfo, BitrixLinkState, DocStatus } from '../api-types';
import { audit } from '../audit/service';
import { iso } from '../common';
import { config } from '../config';
import { type Db, one, onCommit, rows, tx } from '../db';
import type { DocRow } from '../documents/access';
import { BITRIX_STATE_LABELS, docStatusLabel, q } from '../labels';
import { getBitrixAdapter } from './adapter';

export interface LinkRow {
  document_id: number;
  external_task_id: string | null;
  state: BitrixLinkState;
  synced_status: DocStatus | null;
  attempts: number;
  last_error: string | null;
  last_attempt_at: Date | null;
  next_attempt_at: Date | null;
}

/** Паузы между автоматическими повторами, минут. */
const BACKOFF_MIN = [1, 5, 15, 60];

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

export async function getLink(db: Db, documentId: number): Promise<LinkRow | null> {
  return one<LinkRow>(db, 'SELECT * FROM bitrix_links WHERE document_id = $1', [documentId]);
}

/**
 * Ставит документ в очередь передачи в Битрикс24 — в той же транзакции, что и смена статуса.
 * Черновики не передаются: запись появляется при первом запуске согласования со сделкой.
 */
export async function enqueueBitrixSync(db: Db, doc: Pick<DocRow, 'id' | 'deal_id' | 'kind' | 'launch_count'>): Promise<void> {
  if (!doc.deal_id || doc.kind !== 'approval' || doc.launch_count < 1) return;
  await db.query(
    `INSERT INTO bitrix_links (document_id, state, next_attempt_at) VALUES ($1, 'pending', now())
     ON CONFLICT (document_id) DO UPDATE SET state = 'pending', next_attempt_at = now()`,
    [doc.id],
  );
  onCommit(db, kickBitrixSync);
}

let running: Promise<unknown> | null = null;
let again = false;

/** Немедленная попытка передачи после изменения (не дожидаясь фонового задания). */
export function kickBitrixSync(): void {
  if (!config.jobsEnabled) return;
  if (running) {
    again = true;
    return;
  }
  running = processBitrixQueue()
    .catch(() => {})
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        kickBitrixSync();
      }
    });
}

export interface SyncStats {
  processed: number;
  synced: number;
  failed: number;
}

/**
 * Обрабатывает очередь: берёт записи pending/error с наступившим временем попытки,
 * блокирует их (FOR UPDATE SKIP LOCKED) и передаёт АКТУАЛЬНОЕ состояние документа.
 * `force` — не ждать времени следующей попытки (ручной повтор).
 */
export async function processBitrixQueue(opts: { documentId?: number; force?: boolean; limit?: number } = {}): Promise<SyncStats> {
  const stats: SyncStats = { processed: 0, synced: 0, failed: 0 };
  const seen: number[] = [];
  const limit = opts.limit ?? 200;
  while (stats.processed < limit) {
    const result = await tx(async (db) => {
      const link = await one<LinkRow>(
        db,
        `SELECT * FROM bitrix_links
          WHERE state IN ('pending','error')
            AND ($1::boolean OR next_attempt_at <= now())
            AND ($2::int IS NULL OR document_id = $2)
            AND NOT (document_id = ANY($3::int[]))
          ORDER BY next_attempt_at, document_id
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [!!opts.force, opts.documentId ?? null, seen],
      );
      if (!link) return null;
      seen.push(link.document_id);
      return syncOne(db, link);
    });
    if (result === null) break;
    stats.processed++;
    if (result) stats.synced++;
    else stats.failed++;
  }
  return stats;
}

async function syncOne(db: Db, link: LinkRow): Promise<boolean> {
  const doc = await one<DocRow & { initiator_name: string }>(
    db,
    `SELECT d.*, u.full_name AS initiator_name FROM documents d JOIN users u ON u.id = d.initiator_id WHERE d.id = $1`,
    [link.document_id],
  );
  if (!doc || !doc.deal_id) {
    await db.query(`UPDATE bitrix_links SET state = 'synced', last_error = NULL WHERE document_id = $1`, [link.document_id]);
    return true;
  }
  const approvers = await rows<{ full_name: string }>(
    db,
    `SELECT u.full_name FROM approval_steps s
       JOIN approval_rounds r ON r.id = s.round_id
       JOIN users u ON u.id = s.user_id
      WHERE r.document_id = $1 AND r.finished_at IS NULL AND s.state = 'pending'
      ORDER BY s.position, s.id`,
    [doc.id],
  );
  const statusLabel = docStatusLabel(doc.status, doc.kind);
  try {
    const res = await getBitrixAdapter().upsertApprovalTask({
      externalTaskId: link.external_task_id,
      marker: `DOCFLOW-${doc.id}`,
      dealId: doc.deal_id,
      title: doc.title,
      number: doc.number,
      statusCode: doc.status,
      statusLabel,
      cardUrl: `${config.publicUrl}/documents/${doc.id}`,
      createdAt: doc.created_at.toISOString(),
      initiator: doc.initiator_name,
      currentApprovers: approvers.map((a) => a.full_name),
    });
    await db.query(
      `UPDATE bitrix_links
          SET state = 'synced', external_task_id = $2, synced_status = $3, attempts = 0,
              last_error = NULL, last_attempt_at = now()
        WHERE document_id = $1`,
      [doc.id, res.externalTaskId, doc.status],
    );
    const retried = link.state === 'error' || link.attempts > 0;
    if (res.event !== 'updated' || link.synced_status !== doc.status || retried) {
      const summary =
        res.event === 'created'
          ? `В Битрикс24 создана запись о согласовании (задача № ${res.externalTaskId}), статус ${q(statusLabel)}`
          : res.event === 'recreated'
            ? `Запись в Битрикс24 была удалена и создана заново (задача № ${res.externalTaskId}), статус ${q(statusLabel)}`
            : res.event === 'reopened'
              ? `Запись в Битрикс24 была закрыта при активном согласовании и возобновлена, статус ${q(statusLabel)}`
              : `Статус ${q(statusLabel)} передан в Битрикс24${retried ? ' после повторной попытки' : ''}`;
      await audit(db, {
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
    await db.query(
      `UPDATE bitrix_links
          SET state = 'error', attempts = $2, last_error = $3, last_attempt_at = now(),
              next_attempt_at = now() + make_interval(mins => $4)
        WHERE document_id = $1`,
      [doc.id, attempts, message, pause],
    );
    await audit(db, {
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
