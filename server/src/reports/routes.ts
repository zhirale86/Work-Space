import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DashboardResponse, ReportResponse, ReportSummaryResponse } from '../api-types';
import { paging, parse, zId, zPage } from '../common';
import { getPool } from '../db';
import { actorOf } from '../http';
import { dashboard, report, reportSummary } from './service';

const reportQuery = z.object({ userId: zId.optional(), departmentId: zId.optional(), ...zPage });
const reportParams = z.object({ reportCode: z.string().max(60) });

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', async (req): Promise<DashboardResponse> => dashboard(getPool(), actorOf(req)));

  app.get('/reports/summary', async (req): Promise<ReportSummaryResponse> => reportSummary(getPool(), actorOf(req)));

  app.get('/reports/:reportCode', async (req): Promise<ReportResponse> => {
    const { reportCode } = parse(reportParams, req.params);
    const query = parse(reportQuery, req.query);
    return report(getPool(), actorOf(req), reportCode, { userId: query.userId, departmentId: query.departmentId }, paging(query));
  });
}
