import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CancelRequest, DecisionRequest, DocumentDetail, LaunchRequest, OkResponse, RouteChangeRequest } from '../api-types';
import { idParams, parse, zId } from '../common';
import { actorOf, detailOrOk } from '../http';
import { cancelDocument, changeRoute, decide, launchDocument, remind } from './service';

const launchSchema = z.object({ routeMode: z.enum(['sequential', 'parallel']).optional() });
export const decisionSchema = z.object({
  decision: z.enum(['approve', 'rework', 'reject']),
  comment: z.string().max(5000).optional(),
});
const cancelSchema = z.object({ reason: z.string().max(2000).optional() });
const routeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), fromUserId: zId, toUserId: zId, reason: z.string().max(2000).optional() }),
  z.object({ action: z.literal('add'), toUserId: zId, reason: z.string().max(2000).optional() }),
]);

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/documents/:id/launch', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    const body: LaunchRequest = parse(launchSchema, req.body);
    return launchDocument(actorOf(req), id, body.routeMode);
  });

  app.post('/documents/:id/decision', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    const body: DecisionRequest = parse(decisionSchema, req.body);
    return decide(actorOf(req), id, body.decision, body.comment);
  });

  app.put('/documents/:id/route', async (req): Promise<DocumentDetail | OkResponse> => {
    const { id } = parse(idParams, req.params);
    const body = parse(routeSchema, req.body);
    return detailOrOk(await changeRoute(actorOf(req), id, { ...body, reason: body.reason ?? '' } as RouteChangeRequest));
  });

  app.post('/documents/:id/cancel', async (req): Promise<DocumentDetail | OkResponse> => {
    const { id } = parse(idParams, req.params);
    const body: Partial<CancelRequest> = parse(cancelSchema, req.body);
    return detailOrOk(await cancelDocument(actorOf(req), id, body.reason ?? ''));
  });

  app.post('/documents/:id/remind', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    return remind(actorOf(req), id);
  });
}
