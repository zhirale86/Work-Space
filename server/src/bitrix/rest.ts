import type { Deal } from '../api-types';
import {
  type ApprovalTaskInput,
  type ApprovalTaskResult,
  type BitrixAdapter,
  BitrixError,
  FINAL_STATUSES,
  taskDescription,
  taskTitle,
} from './adapter';

export interface RestOptions {
  /** Входящий вебхук вида https://portal/rest/<user>/<token>/ — секрет, в сообщения об ошибках не попадает. */
  webhookUrl: string;
  /** Адрес портала для ссылок на сделки. */
  portalUrl: string;
  /** Ответственный за создаваемые задачи (обязательное поле задачи Битрикс24). */
  responsibleId: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface RestTask {
  id: string;
  status: string;
}

/** Статусы задач Битрикс24: 2 — ждёт выполнения, 5 — завершена. */
const STATUS_PENDING = 2;
const STATUS_COMPLETED = 5;

/**
 * Реализация адаптера через REST API Битрикс24 (входящий вебхук).
 * Используемые методы: crm.deal.list, crm.deal.get, tasks.task.list, tasks.task.add, tasks.task.update.
 * Маркер идемпотентности хранится в поле задачи XML_ID (внешний идентификатор).
 */
export class RestBitrixAdapter implements BitrixAdapter {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RestOptions) {
    this.base = opts.webhookUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.base) throw new BitrixError('Не задан адрес вебхука Битрикс24 (BITRIX_WEBHOOK_URL)');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new BitrixError(`Битрикс24 не ответил за ${Math.round(this.opts.timeoutMs / 1000)} с (метод ${method})`);
      }
      // Текст исходной ошибки не включается: он может содержать адрес вебхука.
      throw new BitrixError(`Нет связи с Битрикс24 (метод ${method})`);
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || !body || body.error) {
      const reason = body?.error_description || body?.error || `HTTP ${res.status}`;
      const e = new BitrixError(`Битрикс24 отклонил запрос ${method}: ${String(reason).slice(0, 300)}`);
      (e as BitrixError & { notFound?: boolean }).notFound =
        res.status === 404 || /not found|не найден/i.test(String(reason));
      throw e;
    }
    return body.result as T;
  }

  private toDeal(r: Record<string, unknown>): Deal {
    const id = String(r.ID);
    const amount = Number(r.OPPORTUNITY);
    return {
      id,
      title: String(r.TITLE ?? ''),
      url: this.dealUrl(id),
      stage: r.STAGE_ID ? String(r.STAGE_ID) : undefined,
      amount: Number.isFinite(amount) ? amount : undefined,
    };
  }

  async searchDeals(query: string): Promise<Deal[]> {
    const q = query.trim();
    const select = ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY'];
    const result: Deal[] = [];
    if (/^\d{1,12}$/.test(q)) {
      const byId = await this.getDeal(q);
      if (byId) result.push(byId);
    }
    const list = await this.call<Array<Record<string, unknown>>>('crm.deal.list', {
      filter: q ? { '%TITLE': q } : {},
      select,
      order: { ID: 'DESC' },
    });
    for (const r of Array.isArray(list) ? list : []) {
      const deal = this.toDeal(r);
      if (!result.some((d) => d.id === deal.id)) result.push(deal);
    }
    return result.slice(0, 20);
  }

  async getDeal(id: string): Promise<Deal | null> {
    if (!/^\d{1,12}$/.test(id)) return null;
    try {
      const r = await this.call<Record<string, unknown> | null>('crm.deal.get', { id: Number(id) });
      return r && r.ID ? this.toDeal(r) : null;
    } catch (err) {
      if ((err as { notFound?: boolean }).notFound) return null;
      throw err;
    }
  }

  private async findTask(filter: Record<string, unknown>): Promise<RestTask | null> {
    const r = await this.call<{ tasks?: Array<Record<string, unknown>> }>('tasks.task.list', {
      filter,
      select: ['ID', 'TITLE', 'STATUS', 'XML_ID'],
      order: { ID: 'ASC' },
    });
    const t = r?.tasks?.[0];
    if (!t) return null;
    return { id: String(t.id ?? t.ID), status: String(t.status ?? t.STATUS ?? '') };
  }

  async upsertApprovalTask(input: ApprovalTaskInput): Promise<ApprovalTaskResult> {
    const final = FINAL_STATUSES.includes(input.statusCode);
    const fields: Record<string, unknown> = {
      TITLE: taskTitle(input),
      DESCRIPTION: taskDescription(input),
      UF_CRM_TASK: [`D_${input.dealId}`],
    };

    let existing: RestTask | null = null;
    let lost = false;
    if (input.externalTaskId) {
      existing = await this.findTask({ ID: input.externalTaskId });
      lost = !existing;
    }
    // Идемпотентность: перед созданием — поиск по маркеру (XML_ID).
    existing ??= await this.findTask({ XML_ID: input.marker });

    if (!existing) {
      const r = await this.call<{ task?: { id?: string | number } }>('tasks.task.add', {
        fields: { ...fields, XML_ID: input.marker, RESPONSIBLE_ID: this.opts.responsibleId },
      });
      const id = r?.task?.id;
      if (id === undefined || id === null) throw new BitrixError('Битрикс24 не вернул идентификатор созданной задачи');
      if (final) {
        await this.call('tasks.task.update', { taskId: Number(id), fields: { STATUS: STATUS_COMPLETED } });
      }
      return { externalTaskId: String(id), event: lost ? 'recreated' : 'created' };
    }

    const wasCompleted = Number(existing.status) === STATUS_COMPLETED;
    if (final && !wasCompleted) fields.STATUS = STATUS_COMPLETED;
    if (!final && wasCompleted) fields.STATUS = STATUS_PENDING;
    await this.call('tasks.task.update', { taskId: Number(existing.id), fields });
    return { externalTaskId: existing.id, event: !final && wasCompleted ? 'reopened' : 'updated' };
  }

  dealUrl(id: string): string {
    return `${this.opts.portalUrl}/crm/deal/details/${encodeURIComponent(id)}/`;
  }
}
