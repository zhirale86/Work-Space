import { purgeExpiredSessions } from '../auth/service';
import { processBitrixQueue } from '../bitrix/sync';
import { checkDeadlines } from './deadlines';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

const JOBS: Job[] = [
  { name: 'Синхронизация с Битрикс24', everyMs: 15_000, run: () => processBitrixQueue() },
  { name: 'Проверка сроков', everyMs: 5 * 60_000, run: () => checkDeadlines() },
  { name: 'Очистка просроченных сессий', everyMs: 60 * 60_000, run: () => purgeExpiredSessions() },
];

/** Запускает фоновые задания внутри процесса сервера. Возвращает функцию остановки. */
export function startJobs(log: { error: (obj: unknown, msg?: string) => void }): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const job of JOBS) {
    let busy = false;
    const tick = async () => {
      if (busy) return; // предыдущий запуск ещё не завершился
      busy = true;
      try {
        await job.run();
      } catch (err) {
        log.error({ err, job: job.name }, 'Ошибка фонового задания');
      } finally {
        busy = false;
      }
    };
    const t = setInterval(tick, job.everyMs);
    t.unref();
    timers.push(t);
    setTimeout(tick, 2_000).unref();
  }
  return () => timers.forEach((t) => clearInterval(t));
}
