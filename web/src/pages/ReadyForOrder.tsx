/** Главная: согласованные GPM, по которым можно запросить создание заказа в Битрикс24. */
import { Link } from 'react-router-dom';
import { useApi } from '../api/hooks';
import { ORDER_REQUEST_ENABLED } from '../api/orderRequest';
import type { DocumentListItem } from '../api/types';
import { Icon } from '../components/Icon';
import { docPath } from '../lib/status';

export function ReadyForOrder() {
  const r = useApi<{ items: DocumentListItem[] }>(ORDER_REQUEST_ENABLED ? '/order-requests/ready' : null);
  const items = r.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="section">
    <section className="card ready-order" aria-labelledby="h-ready-order">
      <header className="card__header">
        <h2 className="card__title" id="h-ready-order">
          Готово к заказу в Битрикс24 <span className="card__count">{items.length}</span>
        </h2>
        <span className="text-sm text-muted">GPM согласован — отправьте запрос на создание заказа</span>
      </header>
      <ul className="todo">
        {items.map((d) => (
          <li key={d.id} className="todo__item">
            <div className="todo__main">
              <Link className="todo__title" to={docPath(d.kind, d.id)}>
                {d.title}
              </Link>
              <div className="todo__meta">
                <span className="num">{d.number}</span>
                {d.deal && <span>Сделка № {d.deal.id}</span>}
              </div>
            </div>
            <div className="todo__action">
              <Link className="btn btn--primary btn--sm" to={`${docPath(d.kind, d.id)}?order=1`}>
                <Icon name="external" />
                Запросить создание заказа
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
    </div>
  );
}
