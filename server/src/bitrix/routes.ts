import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BitrixRetryResponse, Deal, DealsResponse, MockDeal, MockDealDetail, OkResponse } from '../api-types';
import { audit } from '../audit/service';
import { idParams, parse } from '../common';
import { getPool, tx } from '../db';
import { requireDocumentForManage, requireInitiatorOrAdmin } from '../documents/access';
import { AppError, conflict, notFound } from '../errors';
import { actorOf, requireRole } from '../http';
import { BitrixError, getBitrixAdapter } from './adapter';
import { deleteMockTask, getMockDeal, listMockDeals, setMockTaskStatus } from './mock';
import { getLink, processBitrixQueue, toLinkInfo } from './sync';

const dealsQuery = z.object({ q: z.string().max(200).optional() });
const dealParams = z.object({ id: z.string().regex(/^\d{1,12}$/, 'Некорректный идентификатор сделки') });

function wrap(err: unknown): never {
  if (err instanceof BitrixError) throw new AppError(502, 'bitrix_unavailable', err.message);
  throw err;
}

export async function bitrixRoutes(app: FastifyInstance): Promise<void> {
  /** Поиск сделок для выбора в карточке согласования. */
  app.get('/bitrix/deals', async (req): Promise<DealsResponse> => {
    actorOf(req);
    const { q } = parse(dealsQuery, req.query);
    try {
      return { items: await getBitrixAdapter().searchDeals(q ?? '') };
    } catch (err) {
      return wrap(err);
    }
  });

  app.get('/bitrix/deals/:id', async (req): Promise<Deal> => {
    actorOf(req);
    const { id } = parse(dealParams, req.params);
    let deal: Deal | null = null;
    try {
      deal = await getBitrixAdapter().getDeal(id);
    } catch (err) {
      wrap(err);
    }
    if (!deal) throw notFound('Сделка не найдена');
    // В карточке используются только идентификатор, название и ссылка.
    return { id: deal.id, title: deal.title, url: deal.url };
  });

  /** Ручной повтор передачи в Битрикс24 — инициатор или администратор. */
  app.post('/documents/:id/bitrix/retry', async (req): Promise<BitrixRetryResponse> => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    await tx(async (db) => {
      const doc = await requireDocumentForManage(db, actor, id);
      requireInitiatorOrAdmin(doc, actor);
      const link = await getLink(db, id);
      if (!link) throw conflict('По документу нет записи для передачи в Битрикс24');
      await db.query(`UPDATE bitrix_links SET state = 'pending', next_attempt_at = now() WHERE document_id = $1`, [id]);
      await audit(db, {
        actorId: actor.id,
        entityType: 'document',
        entityId: id,
        action: 'bitrix.retry_requested',
        summary: 'Запрошена повторная передача в Битрикс24',
      });
    });
    await processBitrixQueue({ documentId: id, force: true });
    return { bitrix: toLinkInfo((await getLink(getPool(), id))!) };
  });

  // ───────────── Эмулятор Битрикс24 (стенд для сценариев 8–11) ─────────────

  app.get('/bitrix-mock/deals', async (req): Promise<{ items: MockDeal[] }> => {
    actorOf(req);
    const { q } = parse(dealsQuery, req.query);
    return { items: await listMockDeals(getPool(), q ?? '') };
  });

  app.get('/bitrix-mock/deals/:id', async (req): Promise<MockDealDetail> => {
    actorOf(req);
    const { id } = parse(idParams, req.params);
    return getMockDeal(getPool(), id);
  });

  /** Имитация ручного удаления задачи в Битрикс24 (только администратор). */
  app.delete('/bitrix-mock/tasks/:id', async (req): Promise<OkResponse> => {
    requireRole(req, 'admin');
    const { id } = parse(idParams, req.params);
    await deleteMockTask(getPool(), id);
    return { ok: true };
  });

  /** Имитация ручного закрытия задачи в Битрикс24 (только администратор). */
  app.post('/bitrix-mock/tasks/:id/complete', async (req): Promise<OkResponse> => {
    requireRole(req, 'admin');
    const { id } = parse(idParams, req.params);
    await setMockTaskStatus(getPool(), id, 'completed');
    return { ok: true };
  });
}
