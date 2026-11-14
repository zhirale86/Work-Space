import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationItem, OkResponse, Page, UnreadCountResponse } from '../api-types';
import { idParams, paging, parse, zBoolQuery, zPage } from '../common';
import { getPool } from '../db';
import { actorOf } from '../http';
import { listNotifications, markAllRead, markRead, unreadCount } from './service';

const listQuery = z.object({ unread: zBoolQuery, ...zPage });

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', async (req): Promise<Page<NotificationItem>> => {
    const query = parse(listQuery, req.query);
    return listNotifications(getPool(), actorOf(req).id, !!query.unread, paging(query));
  });

  app.get('/notifications/unread-count', async (req): Promise<UnreadCountResponse> => {
    return { count: await unreadCount(getPool(), actorOf(req).id) };
  });

  app.post('/notifications/:id/read', async (req): Promise<OkResponse> => {
    const { id } = parse(idParams, req.params);
    await markRead(getPool(), actorOf(req).id, id);
    return { ok: true };
  });

  app.post('/notifications/read-all', async (req): Promise<OkResponse> => {
    await markAllRead(getPool(), actorOf(req).id);
    return { ok: true };
  });
}
