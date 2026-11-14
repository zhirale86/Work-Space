import { buildApp } from './app';
import { config } from './config';
import { closePool } from './db';
import { startJobs } from './jobs/scheduler';

async function main(): Promise<void> {
  const app = await buildApp();
  let stopJobs: (() => void) | null = null;
  const shutdown = async (signal: string) => {
    app.log.info(`Получен сигнал ${signal}, сервер останавливается`);
    stopJobs?.();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await app.listen({ port: config.port, host: config.host });
  if (config.jobsEnabled) stopJobs = startJobs(app.log);
}

main().catch((err) => {
  console.error('Сервер не запущен:', err);
  process.exit(1);
});
