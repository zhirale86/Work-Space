import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../api/client';
import { useApi, useDelayed, useDocumentTitle } from '../../api/hooks';
import type { AdminAuditEntry, AdminBitrixRetryResponse, AdminBitrixState, DealsResponse, Page, UserRef } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Pagination } from '../../components/Pagination';
import { useToast } from '../../components/Toast';
import { UserPicker } from '../../components/UserPicker';
import { Alert, Button, Card, Empty, LoadError, Loading, cx } from '../../components/ui';
import { dateTime, dateTimeFull } from '../../lib/format';

export function BitrixAdminPage() {
  useDocumentTitle('Интеграция с Битрикс24');
  const toast = useToast();
  const st = useApi<AdminBitrixState>('/admin/bitrix');
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [retrying, setRetrying] = useState<number | 'all' | null>(null);
  const [toggling, setToggling] = useState(false);
  const [mockOn, setMockOn] = useState<boolean | null>(null);
  const s = st.data;

  const runCheck = async () => {
    setChecking(true);
    try {
      await api.get<DealsResponse>('/bitrix/deals', { q: '' });
      setCheck({ ok: true, text: 'Связь с Битрикс24 есть' });
      toast.success('Связь с Битрикс24 есть');
    } catch (e) {
      const text = `Битрикс24 не отвечает: ${e instanceof ApiError ? e.message : 'нет ответа'}`;
      setCheck({ ok: false, text });
      toast.error('Нет связи', text);
    } finally {
      setChecking(false);
    }
  };

  const retry = async (documentId?: number) => {
    setRetrying(documentId ?? 'all');
    try {
      const r = await api.post<AdminBitrixRetryResponse>('/admin/bitrix/retry', documentId ? { documentId } : {});
      if (r.failed === 0) toast.success(r.processed > 1 ? `Статусы переданы: ${r.synced}` : 'Статус передан');
      else toast.error('Не удалось передать', `Передано: ${r.synced}, с ошибкой: ${r.failed}. Проверьте связь с Битрикс24.`);
      st.reload(true);
    } catch (e) {
      toast.fail('Не удалось передать', e);
    } finally {
      setRetrying(null);
    }
  };

  const toggleMock = async (unavailable: boolean) => {
    setToggling(true);
    setMockOn(unavailable);
    try {
      const r = await api.put<AdminBitrixState>('/admin/bitrix/mock', { unavailable });
      st.setData(r);
      setMockOn(null);
      setCheck(null);
      toast.info(unavailable ? 'Эмулятор Битрикс24 недоступен — передача будет завершаться ошибкой.' : 'Эмулятор Битрикс24 снова доступен.');
    } catch (e) {
      setMockOn(null);
      toast.fail('Не удалось переключить', e);
    } finally {
      setToggling(false);
    }
  };

  if (st.error) return <div className="card"><LoadError title="Не удалось загрузить состояние интеграции" onRetry={() => st.reload()} /></div>;
  if (!s) return <Loading><div className="stats">{[0, 1, 2].map((i) => <span key={i} className="skeleton skeleton--tile" />)}</div></Loading>;

  const linked = check ? check.ok : s.mode === 'mock' ? !s.mockUnavailable : s.webhookConfigured;

  return (
    <div className="stack stack--lg">
      <div className="grid-2">
        <Card title="Состояние интеграции">
          <div className="stack">
            <dl className="dl">
              <dt className="dl__term">Связь</dt>
              <dd className="dl__value">{linked ? <span className="badge badge--sync-ok">Связь есть</span> : <span className="badge badge--sync-error">Нет связи</span>}</dd>
              <dt className="dl__term">Режим</dt>
              <dd className="dl__value">{s.mode === 'mock' ? 'Эмулятор' : 'Битрикс24'}</dd>
              <dt className="dl__term">Адрес</dt>
              <dd className="dl__value">{s.mode === 'mock' ? 'встроенный эмулятор' : s.webhookConfigured ? 'входящий вебхук настроен (адрес скрыт)' : 'вебхук не настроен'}</dd>
              <dt className="dl__term">Передано</dt>
              <dd className="dl__value num">{s.counts.synced}</dd>
            </dl>
            {check && <Alert tone={check.ok ? 'success' : 'danger'}>{check.text}</Alert>}
            <div>
              <Button icon="refresh" busy={checking} busyText="Проверяем…" onClick={runCheck}>
                Проверить связь
              </Button>
            </div>
          </div>
        </Card>
        {s.mode === 'mock' && (
          <Card title="Проверка отказа">
            <div className="stack">
              <label className="switch">
                <input type="checkbox" checked={mockOn ?? s.mockUnavailable} aria-busy={toggling} onChange={(e) => void toggleMock(e.target.checked)} />
                <span>Эмулятор недоступен</span>
              </label>
              <p className="text-sm text-muted">Включите, чтобы проверить сценарий № 11: передача не удаётся, ошибка попадает в очередь.</p>
              <Link className="link text-sm" to="/b24">
                Открыть эмулятор Битрикс24
              </Link>
            </div>
          </Card>
        )}
      </div>
      <div className="stats stats--3">
        <div className={cx('stat', s.counts.pending === 0 && 'stat--zero')}>
          <span className="stat__value">{s.counts.pending}</span>
          <span className="stat__label">В очереди</span>
          <span className="stat__hint">ожидают отправки</span>
        </div>
        <div className={cx('stat', s.counts.error > 0 ? 'stat--accent' : 'stat--zero')}>
          <span className="stat__value">{s.counts.error}</span>
          <span className="stat__label">Ошибки</span>
          <span className="stat__hint">{s.counts.error ? 'повторите передачу' : 'ошибок нет'}</span>
        </div>
        <div className={cx('stat', s.counts.synced === 0 && 'stat--zero')}>
          <span className="stat__value">{s.counts.synced}</span>
          <span className="stat__label">Передано</span>
          <span className="stat__hint">записей в сделках актуальны</span>
        </div>
      </div>
      <section className="card">
        <header className="card__header">
          <h2 className="card__title">
            Очередь ошибок <span className="card__count">{s.queue.length}</span>
          </h2>
          <Button variant="primary" icon="refresh" size="sm" disabled={!s.queue.length} busy={retrying === 'all'} busyText="Повторяем…" onClick={() => void retry()}>
            Повторить все
          </Button>
        </header>
        {!s.queue.length ? (
          <Empty icon="check" title="Ошибок нет" text="Все статусы переданы в Битрикс24." />
        ) : (
          <div className="table-wrap table-wrap--flat">
            <table className="table table--dense">
              <thead>
                <tr>
                  <th scope="col">Согласование</th>
                  <th scope="col">Сделка</th>
                  <th scope="col">Статус к передаче</th>
                  <th scope="col" className="td-num">
                    Попыток
                  </th>
                  <th scope="col">Последняя попытка</th>
                  <th scope="col">Ошибка</th>
                  <th scope="col" className="td-actions">
                    <span className="visually-hidden">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.queue.map((q) => (
                  <tr key={q.documentId}>
                    <td className="td-nowrap">
                      <Link className="link" to={`/documents/${q.documentId}`}>
                        {q.documentNumber}
                      </Link>
                    </td>
                    <td className="td-nowrap">{q.dealId ? `№ ${q.dealId}` : '—'}</td>
                    <td className="td-nowrap">{q.documentStatusLabel}</td>
                    <td className="td-num">{q.link.attempts}</td>
                    <td className="td-nowrap">{q.link.lastAttemptAt ? dateTime(q.link.lastAttemptAt) : '—'}</td>
                    <td className="td-main">
                      <span className="text-truncate cell-clip" title={q.link.lastError ?? undefined}>
                        {q.link.state === 'pending' ? 'Ожидает отправки' : q.link.lastError ?? '—'}
                      </span>
                    </td>
                    <td className="td-actions">
                      <Button size="sm" busy={retrying === q.documentId} busyText="Передаём…" onClick={() => void retry(q.documentId)}>
                        Повторить
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <footer className="card__footer">
          <span className="text-sm text-muted">Повторная отправка обновляет существующую запись в сделке и не создаёт дубликатов.</span>
        </footer>
      </section>
    </div>
  );
}

const ACTION_GROUPS: { prefix: string; label: string }[] = [
  { prefix: 'auth.', label: 'Вход и выход' },
  { prefix: 'document.', label: 'Документы' },
  { prefix: 'approval.', label: 'Согласование' },
  { prefix: 'route.', label: 'Маршрут' },
  { prefix: 'order.', label: 'Приказы' },
  { prefix: 'file.', label: 'Файлы' },
  { prefix: 'comment.', label: 'Комментарии' },
  { prefix: 'task.', label: 'Поручения' },
  { prefix: 'bitrix.', label: 'Интеграция' },
  { prefix: 'user.', label: 'Пользователи' },
  { prefix: 'department.', label: 'Подразделения' },
  { prefix: 'doc_type.', label: 'Типы документов' },
];

const ENTITY_LABEL: Record<string, string> = { document: 'Документ', task: 'Поручение', user: 'Пользователь', department: 'Подразделение', doc_type: 'Тип документа', bitrix: 'Интеграция' };

export function AuditPage() {
  useDocumentTitle('Журнал действий');
  const [params, setParams] = useSearchParams();
  const [qText, setQText] = useState(params.get('q') ?? '');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const query = { actorId: params.get('actorId') ?? undefined, action: params.get('action') ?? undefined, from: params.get('from') ?? undefined, to: params.get('to') ?? undefined, q: params.get('q') ?? undefined, page, pageSize: 50 };
  const list = useApi<Page<AdminAuditEntry>>('/admin/audit', query);
  const skeleton = useDelayed(list.loading);
  const set = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? sp.set(k, v) : sp.delete(k));
    if (!('page' in patch)) sp.delete('page');
    setParams(sp);
  };
  useEffect(() => {
    const t = window.setTimeout(() => (params.get('q') ?? '') !== qText.trim() && set({ q: qText.trim() || null }), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qText]);
  const actor: UserRef[] = params.get('actorId') ? [{ id: Number(params.get('actorId')), fullName: params.get('actorName') ?? '…', position: '', department: null, active: true }] : [];

  return (
    <div className="stack">
      <div className="filters">
        <div className="filters__row filters__row--audit">
          <label className="field">
            <span className="field__label">Поиск</span>
            <span className="search">
              <Icon name="search" />
              <input className="input" type="search" placeholder="Номер объекта или текст записи" value={qText} onChange={(e) => setQText(e.target.value)} />
            </span>
          </label>
          <div className="field">
            <span className="field__label">Сотрудник</span>
            <UserPicker single value={actor} placeholder="Любой" ariaLabel="Сотрудник" onChange={(u) => set({ actorId: u[0] ? String(u[0].id) : null, actorName: u[0]?.fullName ?? null })} />
          </div>
          <label className="field">
            <span className="field__label">Действие</span>
            <select className="select" value={params.get('action') ?? ''} onChange={(e) => set({ action: e.target.value || null })}>
              <option value="">Все действия</option>
              {ACTION_GROUPS.map((g) => (
                <option key={g.prefix} value={g.prefix}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">С</span>
            <input className="input input--date" type="date" value={params.get('from') ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
          </label>
          <label className="field">
            <span className="field__label">По</span>
            <input className="input input--date" type="date" value={params.get('to') ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
          </label>
        </div>
      </div>
      <div className="table-wrap">
        {list.error ? (
          <LoadError onRetry={() => list.reload()} />
        ) : (
          <>
            <table className="table table--dense table--sticky" style={{ ['--table-sticky-top' as string]: 'var(--topbar-h)' }}>
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Кто</th>
                  <th scope="col">Действие</th>
                  <th scope="col">Объект</th>
                </tr>
              </thead>
              <tbody>
                {list.loading && !list.data ? (
                  Array.from({ length: 10 }, (_, i) => (
                    <tr key={i} className="table__empty">
                      <td colSpan={4} className="skeleton-cell">
                        {skeleton && <span className="skeleton skeleton--row" />}
                      </td>
                    </tr>
                  ))
                ) : !list.data?.items.length ? (
                  <tr className="table__empty">
                    <td colSpan={4}>
                      <Empty icon="search" title="Записей за выбранный период нет" />
                    </td>
                  </tr>
                ) : (
                  list.data.items.map((e) => (
                    <tr key={e.id} className={cx(!e.actor && 'is-system')}>
                      <td className="td-nowrap td-muted" title={dateTimeFull(e.at)}>
                        {dateTime(e.at)}
                      </td>
                      <td className="td-nowrap">{e.actor ? e.actorName : <span className="text-muted">Система</span>}</td>
                      <td className="td-main">{e.summary}</td>
                      <td className="td-nowrap td-muted">{e.entityId ? `${ENTITY_LABEL[e.entityType] ?? e.entityType} · ${e.entityId}` : ENTITY_LABEL[e.entityType] ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {list.data && list.data.total > 0 && <Pagination page={page} pageSize={50} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
          </>
        )}
      </div>
    </div>
  );
}

