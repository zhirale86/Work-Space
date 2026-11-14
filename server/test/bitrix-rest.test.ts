/** Модульный тест REST-адаптера Битрикс24 с подменой fetch (без сети и базы данных). */
import './env';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type ApprovalTaskInput, BitrixError } from '../src/bitrix/adapter';
import { RestBitrixAdapter } from '../src/bitrix/rest';

interface Call {
  url: string;
  method: string;
  body: any;
}

type Handler = (method: string, body: any, signal?: AbortSignal | null) => Promise<Response> | Response;

const WEBHOOK = 'https://portal.example.ru/rest/17/s3cr3t-t0ken/';

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = /\/([a-z.]+)\.json$/.exec(url)![1];
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, method, body });
    return handler(method, body, init?.signal);
  }) as typeof fetch;
  return { calls, impl };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function adapter(impl: typeof fetch, timeoutMs = 2000): RestBitrixAdapter {
  return new RestBitrixAdapter({ webhookUrl: WEBHOOK, portalUrl: 'https://portal.example.ru', responsibleId: 7, timeoutMs, fetchImpl: impl });
}

const input = (over: Partial<ApprovalTaskInput> = {}): ApprovalTaskInput => ({
  externalTaskId: null,
  marker: 'DOCFLOW-42',
  dealId: '1001',
  title: 'GPM: поставка',
  number: 'GPM-2026-000042',
  statusCode: 'in_review',
  statusLabel: 'На согласовании',
  cardUrl: 'https://docflow.local/documents/42',
  createdAt: '2026-11-14T08:00:00.000Z',
  initiator: 'Иванов Алексей',
  currentApprovers: ['Петрова Мария'],
  ...over,
});

describe('REST-адаптер Битрикс24', () => {
  test('создание: сначала поиск по маркеру, затем tasks.task.add с привязкой к сделке', async () => {
    const f = fakeFetch((method) => {
      if (method === 'tasks.task.list') return json({ result: { tasks: [] } });
      if (method === 'tasks.task.add') return json({ result: { task: { id: '555' } } });
      throw new Error(`неожиданный метод ${method}`);
    });
    const res = await adapter(f.impl).upsertApprovalTask(input());
    assert.deepEqual(res, { externalTaskId: '555', event: 'created' });
    assert.deepEqual(f.calls.map((c) => c.method), ['tasks.task.list', 'tasks.task.add']);
    assert.equal(f.calls[0].url, 'https://portal.example.ru/rest/17/s3cr3t-t0ken/tasks.task.list.json');
    assert.deepEqual(f.calls[0].body.filter, { XML_ID: 'DOCFLOW-42' });
    const fields = f.calls[1].body.fields;
    assert.equal(fields.TITLE, '[На согласовании] GPM: поставка');
    assert.deepEqual(fields.UF_CRM_TASK, ['D_1001']);
    assert.equal(fields.XML_ID, 'DOCFLOW-42');
    assert.equal(fields.RESPONSIBLE_ID, 7);
    assert.match(fields.DESCRIPTION, /Карточка: https:\/\/docflow\.local\/documents\/42/);
    assert.match(fields.DESCRIPTION, /Текущие согласующие: Петрова Мария/);
  });

  test('повтор без идентификатора: запись найдена по маркеру — обновление вместо дубля', async () => {
    const f = fakeFetch((method) => {
      if (method === 'tasks.task.list') return json({ result: { tasks: [{ id: '900', status: '2' }] } });
      if (method === 'tasks.task.update') return json({ result: { task: { id: '900' } } });
      throw new Error(`неожиданный метод ${method}`);
    });
    const res = await adapter(f.impl).upsertApprovalTask(input({ statusCode: 'approved', statusLabel: 'Согласовано' }));
    assert.deepEqual(res, { externalTaskId: '900', event: 'updated' });
    assert.deepEqual(f.calls.map((c) => c.method), ['tasks.task.list', 'tasks.task.update']);
    assert.equal(f.calls[1].body.taskId, 900);
    assert.equal(f.calls[1].body.fields.STATUS, 5, 'завершённое согласование закрывает задачу');
    assert.equal(f.calls[1].body.fields.TITLE, '[Согласовано] GPM: поставка');
  });

  test('обновление по известному идентификатору; закрытая при активном согласовании — возобновляется', async () => {
    const f = fakeFetch((method, body) => {
      if (method === 'tasks.task.list') {
        assert.deepEqual(body.filter, { ID: '900' });
        return json({ result: { tasks: [{ id: '900', status: '5' }] } });
      }
      if (method === 'tasks.task.update') return json({ result: { task: {} } });
      throw new Error(`неожиданный метод ${method}`);
    });
    const res = await adapter(f.impl).upsertApprovalTask(input({ externalTaskId: '900', statusCode: 'rework', statusLabel: 'На доработке' }));
    assert.deepEqual(res, { externalTaskId: '900', event: 'reopened' });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].body.fields.STATUS, 2);
  });

  test('задача удалена в Битрикс24 — создаётся заново', async () => {
    const f = fakeFetch((method) => {
      if (method === 'tasks.task.list') return json({ result: { tasks: [] } });
      if (method === 'tasks.task.add') return json({ result: { task: { id: 777 } } });
      throw new Error(`неожиданный метод ${method}`);
    });
    const res = await adapter(f.impl).upsertApprovalTask(input({ externalTaskId: '900' }));
    assert.deepEqual(res, { externalTaskId: '777', event: 'recreated' });
    assert.deepEqual(f.calls.map((c) => [c.method, c.body.filter ?? null]), [
      ['tasks.task.list', { ID: '900' }],
      ['tasks.task.list', { XML_ID: 'DOCFLOW-42' }],
      ['tasks.task.add', null],
    ]);
  });

  test('поиск сделок: по номеру — crm.deal.get, по названию — crm.deal.list', async () => {
    const f = fakeFetch((method, body) => {
      if (method === 'crm.deal.get') return json({ result: { ID: '1001', TITLE: 'Сделка 1001', OPPORTUNITY: '150000.00', STAGE_ID: 'NEW' } });
      if (method === 'crm.deal.list') {
        return json({ result: [{ ID: '1001', TITLE: 'Сделка 1001' }, { ID: '1002', TITLE: 'Поставка 1001 шт.' }], total: 2 });
      }
      throw new Error(`неожиданный метод ${method} ${JSON.stringify(body)}`);
    });
    const a = adapter(f.impl);
    const deals = await a.searchDeals('1001');
    assert.deepEqual(deals.map((d) => d.id), ['1001', '1002']);
    assert.equal(deals[0].amount, 150000);
    assert.equal(deals[0].url, 'https://portal.example.ru/crm/deal/details/1001/');
    assert.deepEqual(f.calls.find((c) => c.method === 'crm.deal.list')!.body.filter, { '%TITLE': '1001' });
  });

  test('сделка не найдена — null, а не ошибка', async () => {
    const f = fakeFetch(() => json({ error: 'NOT_FOUND', error_description: 'Not found' }, 400));
    assert.equal(await adapter(f.impl).getDeal('5'), null);
    assert.equal(await adapter(f.impl).getDeal('abc'), null);
  });

  test('таймаут — понятная ошибка BitrixError', async () => {
    // Таймер AbortSignal.timeout не удерживает цикл событий; в сервере его удерживает сокет.
    const keep = setInterval(() => {}, 1000);
    try {
    const f = fakeFetch(
      (_m, _b, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const started = Date.now();
    await assert.rejects(adapter(f.impl, 150).upsertApprovalTask(input()), (err: Error) => {
      assert.ok(err instanceof BitrixError);
      assert.match(err.message, /не ответил за/);
      assert.ok(!err.message.includes('s3cr3t'), 'адрес вебхука не раскрывается');
      return true;
    });
    assert.ok(Date.now() - started < 2000);
    } finally {
      clearInterval(keep);
    }
  });

  test('ошибка API и сетевая ошибка — BitrixError без секрета вебхука', async () => {
    const apiErr = fakeFetch(() => json({ error: 'ACCESS_DENIED', error_description: 'Access denied for task module' }, 403));
    await assert.rejects(adapter(apiErr.impl).upsertApprovalTask(input()), (err: Error) => {
      assert.ok(err instanceof BitrixError);
      assert.match(err.message, /Битрикс24 отклонил запрос tasks\.task\.list: Access denied/);
      return true;
    });
    const net = fakeFetch(() => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${WEBHOOK}`);
    });
    await assert.rejects(adapter(net.impl).upsertApprovalTask(input()), (err: Error) => {
      assert.ok(err instanceof BitrixError);
      assert.match(err.message, /Нет связи с Битрикс24/);
      assert.ok(!err.message.includes('s3cr3t'));
      return true;
    });
    const html = fakeFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    await assert.rejects(adapter(html.impl).searchDeals('x'), /HTTP 502/);
    // Без адреса вебхука вызовов нет.
    const none = new RestBitrixAdapter({ webhookUrl: '', portalUrl: '', responsibleId: 1, timeoutMs: 100, fetchImpl: html.impl });
    await assert.rejects(none.searchDeals('x'), /BITRIX_WEBHOOK_URL/);
    assert.equal(html.calls.length, 1);
  });
});
