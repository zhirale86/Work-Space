import type { Deal, MockDeal, MockDealDetail, MockTask, MockTaskStatus } from '../api-types';
import { iso, like } from '../common';
import { config } from '../config';
import { type Db, getPool, one, rows } from '../db';
import { notFound } from '../errors';
import { MOCK_TASK_STATUS_LABELS } from '../labels';
import {
  type ApprovalTaskInput,
  type ApprovalTaskResult,
  type BitrixAdapter,
  BitrixError,
  FINAL_STATUSES,
  taskDescription,
  taskTitle,
} from './adapter';

export const SETTING_UNAVAILABLE = 'bitrix_mock_unavailable';
/** Одноразовый сбой: задача создаётся, но ответ «теряется» — для проверки отсутствия дублей. */
export const SETTING_FAIL_AFTER_CREATE = 'bitrix_mock_fail_after_create';

export async function getSetting<T>(db: Db, key: string, def: T): Promise<T> {
  const r = await one<{ value: T }>(db, 'SELECT value FROM settings WHERE key = $1', [key]);
  return r ? r.value : def;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

interface DealRow {
  id: number;
  title: string;
  stage: string;
  company: string;
  amount: number;
}
interface TaskRow {
  id: number;
  deal_id: number;
  marker: string;
  title: string;
  description: string;
  status: MockTaskStatus;
  created_at: Date;
  updated_at: Date;
}

export const mockDealUrl = (id: string | number): string => `${config.publicUrl}/bitrix-mock/deals/${id}`;

const isDealId = (id: string): boolean => /^\d{1,9}$/.test(id);

/** Эмулятор Битрикс24 на таблицах mock_deals и mock_tasks. */
export class MockBitrixAdapter implements BitrixAdapter {
  private async ensureAvailable(): Promise<void> {
    if (await getSetting<boolean>(getPool(), SETTING_UNAVAILABLE, false)) {
      throw new BitrixError('Битрикс24 недоступен: нет связи с порталом (эмулятор в режиме «недоступен»)');
    }
  }

  private toDeal(r: DealRow): Deal {
    return { id: String(r.id), title: r.title, url: this.dealUrl(String(r.id)), stage: r.stage, company: r.company, amount: r.amount };
  }

  async searchDeals(query: string): Promise<Deal[]> {
    await this.ensureAvailable();
    const q = query.trim();
    const list = await rows<DealRow>(
      getPool(),
      `SELECT * FROM mock_deals
        WHERE $1 = '' OR title ILIKE $2 OR company ILIKE $2 OR id::text = $1
        ORDER BY (id::text = $1) DESC, id DESC LIMIT 20`,
      [q, like(q)],
    );
    return list.map((r) => this.toDeal(r));
  }

  async getDeal(id: string): Promise<Deal | null> {
    await this.ensureAvailable();
    if (!isDealId(id)) return null;
    const r = await one<DealRow>(getPool(), 'SELECT * FROM mock_deals WHERE id = $1', [Number(id)]);
    return r ? this.toDeal(r) : null;
  }

  async upsertApprovalTask(input: ApprovalTaskInput): Promise<ApprovalTaskResult> {
    await this.ensureAvailable();
    const db = getPool();
    if (!isDealId(input.dealId) || !(await one(db, 'SELECT 1 FROM mock_deals WHERE id = $1', [Number(input.dealId)]))) {
      throw new BitrixError(`Битрикс24 отклонил запрос: сделка ${input.dealId} не найдена`);
    }
    const final = FINAL_STATUSES.includes(input.statusCode);
    const status: MockTaskStatus = final ? 'completed' : 'in_progress';
    const title = taskTitle(input);
    const description = taskDescription(input);

    let existing: TaskRow | null = null;
    let lost = false;
    if (input.externalTaskId && /^\d{1,9}$/.test(input.externalTaskId)) {
      existing = await one<TaskRow>(db, 'SELECT * FROM mock_tasks WHERE id = $1', [Number(input.externalTaskId)]);
      lost = !existing;
    }
    // Идемпотентность: перед созданием — поиск по маркеру.
    existing ??= await one<TaskRow>(db, 'SELECT * FROM mock_tasks WHERE marker = $1', [input.marker]);

    if (!existing) {
      const created = await one<{ id: number }>(
        db,
        `INSERT INTO mock_tasks (deal_id, marker, title, description, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (marker) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
                                            status = EXCLUDED.status, updated_at = now()
         RETURNING id`,
        [Number(input.dealId), input.marker, title, description, status],
      );
      if (await getSetting<boolean>(db, SETTING_FAIL_AFTER_CREATE, false)) {
        await setSetting(db, SETTING_FAIL_AFTER_CREATE, false);
        throw new BitrixError('Битрикс24 не ответил вовремя: соединение прервано после отправки запроса');
      }
      return { externalTaskId: String(created!.id), event: lost ? 'recreated' : 'created' };
    }
    const reopened = existing.status === 'completed' && !final;
    await db.query(
      `UPDATE mock_tasks SET deal_id = $2, title = $3, description = $4, status = $5, updated_at = now() WHERE id = $1`,
      [existing.id, Number(input.dealId), title, description, status],
    );
    return { externalTaskId: String(existing.id), event: reopened ? 'reopened' : 'updated' };
  }

  dealUrl(id: string): string {
    return mockDealUrl(id);
  }
}

// ───────────── Страницы эмулятора ─────────────

function toMockTask(t: TaskRow): MockTask {
  const url = /Карточка: (\S+)/.exec(t.description)?.[1] ?? null;
  const docId = /^DOCFLOW-(\d+)$/.exec(t.marker)?.[1];
  return {
    id: t.id,
    dealId: t.deal_id,
    marker: t.marker,
    title: t.title,
    description: t.description,
    status: t.status,
    statusLabel: MOCK_TASK_STATUS_LABELS[t.status],
    createdAt: iso(t.created_at)!,
    updatedAt: iso(t.updated_at)!,
    cardUrl: url,
    documentId: docId ? Number(docId) : null,
  };
}

export async function listMockDeals(db: Db, q: string): Promise<MockDeal[]> {
  const list = await rows<DealRow & { tasks_count: number }>(
    db,
    `SELECT d.*, (SELECT count(*)::int FROM mock_tasks t WHERE t.deal_id = d.id) AS tasks_count
       FROM mock_deals d
      WHERE $1 = '' OR d.title ILIKE $2 OR d.company ILIKE $2 OR d.id::text = $1
      ORDER BY d.id`,
    [q.trim(), like(q.trim())],
  );
  return list.map((d) => ({
    id: d.id,
    title: d.title,
    stage: d.stage,
    company: d.company,
    amount: d.amount,
    url: mockDealUrl(d.id),
    tasksCount: d.tasks_count,
  }));
}

export async function getMockDeal(db: Db, id: number): Promise<MockDealDetail> {
  const d = await one<DealRow>(db, 'SELECT * FROM mock_deals WHERE id = $1', [id]);
  if (!d) throw notFound('Сделка не найдена');
  const tasks = await rows<TaskRow>(db, 'SELECT * FROM mock_tasks WHERE deal_id = $1 ORDER BY id', [id]);
  return {
    id: d.id,
    title: d.title,
    stage: d.stage,
    company: d.company,
    amount: d.amount,
    url: mockDealUrl(d.id),
    tasksCount: tasks.length,
    tasks: tasks.map(toMockTask),
  };
}

export async function deleteMockTask(db: Db, id: number): Promise<void> {
  const r = await db.query('DELETE FROM mock_tasks WHERE id = $1', [id]);
  if (!r.rowCount) throw notFound('Задача не найдена');
}

export async function setMockTaskStatus(db: Db, id: number, status: MockTaskStatus): Promise<void> {
  const r = await db.query('UPDATE mock_tasks SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  if (!r.rowCount) throw notFound('Задача не найдена');
}
