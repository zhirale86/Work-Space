import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApi, useDelayed, useDocumentTitle } from '../../api/hooks';
import type { AdminBitrixState, DocStatus, MockDeal, MockDealDetail, MockTask } from '../../api/types';
import { Alert, Button, Card, Empty, LoadError, Loading, PageHeader, cx } from '../../components/ui';
import { dateTime, money, NBSP } from '../../lib/format';
import { APPROVAL_STATUS_LABELS, DOC_BADGE } from '../../lib/status';
import { useAuth } from '../../layout/Auth';

/** Предупреждение режима «Эмулятор недоступен» — видно только администратору (флаг читается из /admin/bitrix). */
function UnavailableNote() {
  const { hasRole } = useAuth();
  const st = useApi<AdminBitrixState>(hasRole('admin') ? '/admin/bitrix' : null);
  if (!st.data?.mockUnavailable) return null;
  return <Alert tone="warning">Эмулятор недоступен — включена проверка отказа. Статусы здесь могут быть устаревшими.</Alert>;
}

export function DealsListPage() {
  useDocumentTitle('Эмулятор Битрикс24');
  const { data, error, loading, reload } = useApi<{ items: MockDeal[] }>('/bitrix-mock/deals');
  const skeleton = useDelayed(loading);
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title="Сделки" lead="Сделки тестового портала Битрикс24. Откройте сделку, чтобы увидеть согласования среди её задач." />
      <div className="stack">
        <UnavailableNote />
        <div className="table-wrap">
          {error ? (
            <LoadError onRetry={() => reload()} />
          ) : (
            <table className="table table--clickable">
              <thead>
                <tr>
                  <th scope="col">Сделка</th>
                  <th scope="col">Клиент</th>
                  <th scope="col" className="hide-md">
                    Стадия
                  </th>
                  <th scope="col" className="td-num">
                    Сумма
                  </th>
                  <th scope="col" className="td-num">
                    Задач
                  </th>
                </tr>
              </thead>
              <tbody>
                {!data ? (
                  <tr className="table__empty">
                    <td colSpan={5} className="skeleton-cell">
                      {skeleton && <span className="skeleton skeleton--row" />}
                    </td>
                  </tr>
                ) : !data.items.length ? (
                  <tr className="table__empty">
                    <td colSpan={5}>
                      <Empty title="Сделок нет" />
                    </td>
                  </tr>
                ) : (
                  data.items.map((d) => (
                    <tr key={d.id} onClick={() => navigate(`/b24/deals/${d.id}`)}>
                      <td className="td-main">
                        <Link className="table__title" to={`/b24/deals/${d.id}`}>
                          {d.title}
                        </Link>
                        <span className="table__sub">Сделка №{NBSP}{d.id}</span>
                      </td>
                      <td>{d.company}</td>
                      <td className="hide-md">{d.stage}</td>
                      <td className="td-num">{money(d.amount)}</td>
                      <td className="td-num">{d.tasksCount}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

const LABEL_TO_STATUS: Record<string, DocStatus> = Object.fromEntries(
  (Object.entries(APPROVAL_STATUS_LABELS) as [DocStatus, string][]).flatMap(([k, v]) => [[v, k]]).concat([
    ['Утверждён', 'approved'],
    ['Отклонён', 'rejected'],
    ['Отменён', 'cancelled'],
  ]),
);

/** Разбор задачи эмулятора: статус из «[На согласовании] …», строки описания «Инициатор: …», «Текущие согласующие: …». */
function parseTask(t: MockTask) {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(t.title);
  const label = m?.[1] ?? '';
  const line = (k: string) => new RegExp(`^${k}: (.+)$`, 'm').exec(t.description)?.[1] ?? null;
  return {
    label,
    name: m?.[2] ?? t.title,
    status: LABEL_TO_STATUS[label] ?? null,
    initiator: line('Инициатор'),
    current: line('Текущие согласующие'),
    number: /^Согласование (\S+)/m.exec(t.description)?.[1] ?? null,
  };
}

export function DealPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<MockDealDetail>(`/bitrix-mock/deals/${Number(id) || 0}`);
  useDocumentTitle(data ? `Сделка № ${data.id}` : 'Сделка');
  const skeleton = useDelayed(loading);

  if (error) {
    if (error.status === 404 || error.status === 400)
      return (
        <div className="page-center">
          <Empty
            icon="search"
            title="Сделка не найдена"
            actions={
              <Link className="btn btn--secondary" to="/b24">
                К списку сделок
              </Link>
            }
          />
        </div>
      );
    return <LoadError title="Не удалось загрузить сделку" onRetry={() => reload()} />;
  }
  if (!data) return <Loading>{skeleton && <span className="skeleton skeleton--tile" />}</Loading>;

  const lastUpdate = data.tasks.map((t) => t.updatedAt).sort().pop();

  return (
    <>
      <PageHeader crumbs={[{ to: '/b24', label: 'Сделки' }, { label: `№${NBSP}${data.id}` }]} title={`Сделка №${NBSP}${data.id} · ${data.title}`} />
      <div className="stack stack--lg">
        <UnavailableNote />
        <div className="layout-split">
          <section className="card" aria-labelledby="b24-tasks">
            <header className="card__header">
              <h2 className="card__title" id="b24-tasks">
                Задачи <span className="card__count">{data.tasks.length}</span>
              </h2>
              <div className="row row--sm">
                {lastUpdate && <span className="text-sm text-muted">Обновлено из Документооборота: {dateTime(lastUpdate)}</span>}
                <Button size="sm" icon="refresh" onClick={() => reload(true)}>
                  Обновить
                </Button>
              </div>
            </header>
            {!data.tasks.length ? (
              <Empty icon="inbox" title="В этой сделке пока нет согласований" text="Они появятся после запуска согласования, связанного со сделкой." />
            ) : (
              <div className="table-wrap table-wrap--flat">
                <table className="table table--dense">
                  <thead>
                    <tr>
                      <th scope="col">Задача</th>
                      <th scope="col">Статус</th>
                      <th scope="col" className="hide-md">
                        Создана
                      </th>
                      <th scope="col">Инициатор</th>
                      <th scope="col">Сейчас у</th>
                      <th scope="col" className="hide-md">
                        Обновлено
                      </th>
                      <th scope="col" className="td-actions">
                        <span className="visually-hidden">Переход</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tasks.map((t) => {
                      const x = parseTask(t);
                      const closed = t.status === 'completed';
                      return (
                        <tr key={t.id} className={cx(closed && 'is-closed')}>
                          <td className="td-main">
                            <span className="table__title">{t.title}</span>
                            <span className="table__sub">
                              {x.number ?? t.marker} · {closed ? 'задача закрыта' : 'задача открыта'}
                            </span>
                          </td>
                          <td className="td-nowrap">{x.status ? <span className={cx('badge', DOC_BADGE[x.status])}>{x.label}</span> : <span className="badge badge--neutral">{x.label || t.statusLabel}</span>}</td>
                          <td className="td-nowrap hide-md">{dateTime(t.createdAt)}</td>
                          <td>{x.initiator ?? '—'}</td>
                          <td>{x.current ?? (closed ? '—' : '—')}</td>
                          <td className="td-nowrap hide-md">{dateTime(t.updatedAt)}</td>
                          <td className="td-actions">
                            {t.documentId ? (
                              <Link className="btn btn--secondary btn--sm" to={`/documents/${t.documentId}`}>
                                Открыть согласование
                              </Link>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <aside className="layout-split__aside">
            <Card title="О сделке" compact>
              <dl className="dl">
                <dt className="dl__term">Клиент</dt>
                <dd className="dl__value">{data.company}</dd>
                <dt className="dl__term">Сумма</dt>
                <dd className="dl__value num">{money(data.amount)}</dd>
                <dt className="dl__term">Стадия</dt>
                <dd className="dl__value">{data.stage}</dd>
                <dt className="dl__term">Ответственный</dt>
                <dd className="dl__value">{data.tasks.map((t) => parseTask(t).initiator).find(Boolean) ?? 'не назначен'}</dd>
              </dl>
            </Card>
            <p className="text-sm text-muted">Изменить или закрыть запись здесь нельзя: источник статуса — Документооборот.</p>
          </aside>
        </div>
      </div>
    </>
  );
}
