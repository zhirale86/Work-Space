import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AcquaintanceRequest, DocumentDetail, OkResponse, SignRequest } from '../api-types';
import { decisionSchema } from '../approvals/routes';
import { idParams, parse } from '../common';
import { actorOf, detailOrOk } from '../http';
import { acknowledge, archiveOrder, setAcquaintance, signOrder } from './service';

const acquaintanceSchema = z.object({ userIds: z.array(z.number().int().positive()).max(1000) });

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/documents/:id/sign', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    const body: SignRequest = parse(decisionSchema, req.body);
    return signOrder(actorOf(req), id, body.decision, body.comment);
  });

  app.post('/documents/:id/archive', async (req): Promise<DocumentDetail | OkResponse> => {
    const { id } = parse(idParams, req.params);
    return detailOrOk(await archiveOrder(actorOf(req), id));
  });

  app.post('/documents/:id/acknowledge', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    return acknowledge(actorOf(req), id);
  });

  app.put('/documents/:id/acquaintance', async (req): Promise<DocumentDetail> => {
    const { id } = parse(idParams, req.params);
    const body: AcquaintanceRequest = parse(acquaintanceSchema, req.body);
    return setAcquaintance(actorOf(req), id, body.userIds);
  });
}
