/** Эмулятор Битрикс24: поток «Запрос на создание заказа». */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, useDelayed, useDocumentTitle } from '../../api/hooks';
import { ORDER_FLOW_NAME, type OrderRequestInfo } from '../../api/orderRequest';
import type { FileVersion } from '../../api/types';
import { downloadVersion } from '../../components/Files';
import { useToast } from '../../components/Toast';
import { Button, Empty, LoadError, Loading, PageHeader } from '../../components/ui';
import { NBSP, dateTime, fileSize } from '../../lib/format';

function DownloadButton({ r }: { r: OrderRequestInfo }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await downloadVersion({ downloadUrl: r.file.downloadUrl, originalName: r.file.name } as FileVersion);
    } catch (e) {
      toast.fail('Файл не скачан', e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" icon="download" busy={busy} busyText="Скачиваем…" onClick={go}>
      Скачать
    </Button>
  );
}

/** Раздел на странице сделки. */
export function DealOrderRequests({ dealId }: { dealId: number }) {
  const { data } = useApi<{ items: OrderRequestInfo[] }>('/bitrix-mock/order-requests', { dealId });
  if (!data) return null;
  return (
    <section className="card" aria-labelledby="b24-orders">
      <header className="card__header">
        <h2 className="card__title" id="b24-orders">
          {ORDER_FLOW_NAME} <span className="card__count">{data.items.length}</span>
        </h2>
      </header>
      {!data.items.length ? (
        <Empty icon="inbox" title="Запросов пока нет" text="Запрос создаётся из Документооборота после согласования GPM-калькулятора." />
      ) : (
        <div className="table-wrap table-wrap--flat">
          <table className="table table--dense">
            <thead>
              <tr>
                <th scope="col">Запрос</th>
                <th scope="col">Отметка</th>
                <th scope="col">Вложение</th>
                <th scope="col">Создан</th>
                <th scope="col" className="td-actions">
                  <span className="visually-hidden">Переход</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td className="td-main">
                    <span className="table__title">№{NBSP}{r.number}</span>
                    <span className="table__sub">
                      {r.documentNumber} · от {r.author.fullName}
                    </span>
                  </td>
                  <td>
                    <span className="badge badge--approved">GPM согласован</span>
                    <span className="table__sub">{r.approvers.map((a) => a.user.fullName.split(' ')[0]).join(', ')}</span>
                  </td>
                  <td className="td-nowrap">
                    {r.file.name}
                    <span className="table__sub">версия {r.file.versionNo}</span>
                  </td>
                  <td className="td-nowrap">{dateTime(r.createdAt)}</td>
                  <td className="td-actions">
                    <Link className="btn btn--secondary btn--sm" to={`/b24/order-requests/${r.id}`}>
                      Открыть
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Карточка элемента потока. */
export function OrderRequestPage() {
  const { id } = useParams();
  const { data: r, error, loading, reload } = useApi<OrderRequestInfo>(`/bitrix-mock/order-requests/${Number(id) || 0}`);
  useDocumentTitle(r ? `${ORDER_FLOW_NAME} № ${r.number}` : ORDER_FLOW_NAME);
  const skeleton = useDelayed(loading);
  if (error) {
    if (error.status === 404 || error.status === 400) return <div className="page-center"><Empty icon="search" title="Запрос не найден" actions={<Link className="btn btn--secondary" to="/b24">К списку сделок</Link>} /></div>;
    return <LoadError onRetry={() => reload()} />;
  }
  if (!r) return <Loading>{skeleton && <span className="skeleton skeleton--tile" />}</Loading>;
  return (
    <>
      <PageHeader
        crumbs={[{ to: '/b24', label: 'Сделки' }, { to: `/b24/deals/${r.dealId}`, label: `№${NBSP}${r.dealId}` }, { label: ORDER_FLOW_NAME }]}
        title={`${ORDER_FLOW_NAME} №${NBSP}${r.number}`}
        badges={<span className="badge badge--neutral">{r.statusLabel}</span>}
        lead="Элемент существующего потока Битрикс24, созданный из Документооборота."
      />
      <div className="layout-split">
        <div className="stack">
          <section className="card" aria-labelledby="or-approval">
            <header className="card__header">
              <h2 className="card__title" id="or-approval">
                Согласование GPM-калькулятора
              </h2>
              <span className="badge badge--approved">Согласован</span>
            </header>
            <div className="card__body stack">
              <p>
                GPM-калькулятор согласован {dateTime(r.approvedAt)} в Документообороте (запуск {r.roundNo}). Все согласующие приняли положительное решение.
              </p>
              <div className="table-wrap table-wrap--flat">
                <table className="table table--dense">
                  <thead>
                    <tr>
                      <th scope="col">Согласовал</th>
                      <th scope="col">Должность</th>
                      <th scope="col">Дата решения</th>
                      <th scope="col">Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.approvers.map((a) => (
                      <tr key={a.user.id}>
                        <td className="td-main">{a.user.fullName}</td>
                        <td>
                          {a.user.position || '—'}
                          {a.user.department ? <span className="table__sub">{a.user.department.name}</span> : null}
                        </td>
                        <td className="td-nowrap">{dateTime(a.decidedAt)}</td>
                        <td className="td-muted">{a.comment || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
          <section className="card" aria-labelledby="or-file">
            <header className="card__header">
              <h2 className="card__title" id="or-file">
                Вложение
              </h2>
            </header>
            <div className="card__body">
              <div className="file">
                <div className="file__row">
                  <span className="file__icon">XLSX</span>
                  <div className="file__main">
                    <div className="file__name">{r.file.name}</div>
                    <div className="file__meta">
                      GPM-калькулятор · версия {r.file.versionNo} (последняя на момент согласования) · {fileSize(r.file.size)}
                    </div>
                  </div>
                  <div className="file__actions">
                    <DownloadButton r={r} />
                  </div>
                </div>
              </div>
            </div>
          </section>
          {r.comment && (
            <section className="card" aria-labelledby="or-comment">
              <header className="card__header">
                <h2 className="card__title" id="or-comment">
                  Комментарий инициатора
                </h2>
              </header>
              <div className="card__body">
                <p>{r.comment}</p>
              </div>
            </section>
          )}
        </div>
        <aside className="layout-split__aside">
          <section className="card card--compact" aria-label="Сведения">
            <div className="card__body">
              <dl className="dl">
                <dt className="dl__term">Сделка</dt>
                <dd className="dl__value">
                  <Link to={`/b24/deals/${r.dealId}`}>{r.dealTitle ?? `№${NBSP}${r.dealId}`}</Link>
                </dd>
                <dt className="dl__term">Основание</dt>
                <dd className="dl__value">
                  <Link to={`/documents/${r.documentId}`}>{r.documentNumber}</Link>
                  <div className="text-sm text-muted">{r.documentTitle}</div>
                </dd>
                <dt className="dl__term">Инициатор</dt>
                <dd className="dl__value">{r.author.fullName}</dd>
                <dt className="dl__term">Создан</dt>
                <dd className="dl__value">{dateTime(r.createdAt)}</dd>
                <dt className="dl__term">Стадия</dt>
                <dd className="dl__value">{r.statusLabel}</dd>
              </dl>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}
