import { formatDateTimeRu, uniq } from '../common';
import { type Db, getPool, rows } from '../db';
import { notify } from '../notifications/service';

const SOON_HOURS = 24;

/**
 * Проверка сроков. «Срок приближается» — за 24 часа, «Срок нарушен» — при наступлении.
 * Каждое уведомление формируется один раз на участника (ключ dedupe_key включает срок,
 * поэтому после переноса срока уведомления формируются заново). Задание безопасно для повторного запуска.
 */
export async function checkDeadlines(db: Db = getPool(), now: Date = new Date()): Promise<void> {
  const docs = await rows<{
    id: number;
    number: string;
    kind: string;
    due_at: Date;
    status: string;
    initiator_id: number;
    signer_id: number | null;
    pending: number[];
  }>(
    db,
    `SELECT d.id, d.number, d.kind, d.due_at, d.status, d.initiator_id, d.signer_id,
            ARRAY(SELECT s.user_id FROM approval_steps s JOIN approval_rounds r ON r.id = s.round_id
                   WHERE r.document_id = d.id AND r.finished_at IS NULL AND s.state = 'pending') AS pending
       FROM documents d
      WHERE d.due_at IS NOT NULL AND d.due_at <= $1::timestamptz + make_interval(hours => $2)
        AND d.status IN ('in_review','on_signing','rework')`,
    [now, SOON_HOURS],
  );
  for (const d of docs) {
    const overdue = d.due_at.getTime() <= now.getTime();
    // Участники, от которых ожидается действие.
    let recipients = d.status === 'in_review' ? d.pending : d.status === 'on_signing' ? (d.signer_id ? [d.signer_id] : []) : [d.initiator_id];
    if (overdue) recipients = uniq([...recipients, d.initiator_id]);
    const what = d.kind === 'order' ? 'приказу' : 'документу';
    for (const userId of recipients) {
      await notify(db, {
        userId,
        type: overdue ? 'deadline_overdue' : 'deadline_soon',
        title: overdue ? `Срок нарушен: ${d.number}` : `Срок приближается: ${d.number}`,
        body: overdue
          ? `Срок по ${what} ${d.number} истёк ${formatDateTimeRu(d.due_at)}.`
          : `Срок по ${what} ${d.number} — ${formatDateTimeRu(d.due_at)}.`,
        entityType: 'document',
        entityId: d.id,
        dedupeKey: `deadline:${overdue ? 'overdue' : 'soon'}:document:${d.id}:${userId}:${d.due_at.getTime()}`,
      });
    }
  }

  const tasks = await rows<{ id: number; number: string; due_at: Date; status: string; author_id: number; assignee_id: number }>(
    db,
    `SELECT id, number, due_at, status, author_id, assignee_id FROM tasks
      WHERE due_at IS NOT NULL AND due_at <= $1::timestamptz + make_interval(hours => $2)
        AND status NOT IN ('done','cancelled')`,
    [now, SOON_HOURS],
  );
  for (const t of tasks) {
    const overdue = t.due_at.getTime() <= now.getTime();
    let recipients = t.status === 'review' ? [t.author_id] : [t.assignee_id];
    if (overdue) recipients = uniq([...recipients, t.author_id]);
    for (const userId of recipients) {
      await notify(db, {
        userId,
        type: overdue ? 'deadline_overdue' : 'deadline_soon',
        title: overdue ? `Срок нарушен: поручение ${t.number}` : `Срок приближается: поручение ${t.number}`,
        body: overdue
          ? `Срок исполнения поручения ${t.number} истёк ${formatDateTimeRu(t.due_at)}.`
          : `Срок исполнения поручения ${t.number} — ${formatDateTimeRu(t.due_at)}.`,
        entityType: 'task',
        entityId: t.id,
        dedupeKey: `deadline:${overdue ? 'overdue' : 'soon'}:task:${t.id}:${userId}:${t.due_at.getTime()}`,
      });
    }
  }
}
