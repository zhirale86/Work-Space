import { useState } from 'react';
import type { DocumentDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Button, Empty, cx } from '../../components/ui';
import { DAYS, count, dateTimeFull, due } from '../../lib/format';

type Filter = 'all' | 'done' | 'pending';

/** Вкладка «Ознакомление»: плитки, фильтр, поиск и плотная таблица (раздел 4.6). */
export function AcknowledgementTab({ doc, onAdd }: { doc: DocumentDetail; onAdd?: () => void }) {
  const ack = doc.acknowledgements!;
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const late = !!doc.dueAt && new Date(doc.dueAt).getTime() < Date.now();
  const pendingItems = ack.items.filter((i) => !i.acknowledgedAt);
  const lateCount = late ? pendingItems.length : 0;
  const rows = ack.items
    .filter((i) => (filter === 'done' ? !!i.acknowledgedAt : filter === 'pending' ? !i.acknowledgedAt : true))
    .filter((i) => !q.trim() || i.user.fullName.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(!!a.acknowledgedAt) - Number(!!b.acknowledgedAt) || a.user.fullName.localeCompare(b.user.fullName, 'ru'));

  if (!ack.items.length) {
    return (
      <div className="card">
        <Empty
          icon="order"
          title="Список ознакомления не задан"
          text="Добавьте сотрудников, которые должны ознакомиться с приказом."
          actions={
            onAdd && (
              <Button size="sm" onClick={onAdd}>
                Добавить сотрудников
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="stats stats--3">
        <div className={cx('stat', ack.acknowledged === 0 && 'stat--zero')}>
          <span className="stat__value">{ack.acknowledged}</span>
          <span className="stat__label">Ознакомились</span>
          <span className="stat__hint">из {ack.total}</span>
        </div>
        <div className={cx('stat', ack.pending === 0 && 'stat--zero')}>
          <span className="stat__value">{ack.pending}</span>
          <span className="stat__label">Не ознакомились</span>
          <span className="stat__hint">{doc.dueAt ? `срок — ${due(doc.dueAt).text.toLowerCase()}` : 'срок не задан'}</span>
        </div>
        <div className={cx('stat', lateCount > 0 ? 'stat--accent' : 'stat--zero')}>
          <span className="stat__value">{lateCount}</span>
          <span className="stat__label">С нарушением срока</span>
          <span className="stat__hint">{lateCount ? 'нужно напомнить' : 'нарушений нет'}</span>
        </div>
      </div>
      <section className="card">
        <header className="card__header">
          <div className="segmented" role="radiogroup" aria-label="Кого показать">
            {(
              [
                ['all', 'Все'],
                ['done', 'Ознакомились'],
                ['pending', 'Не ознакомились'],
              ] as [Filter, string][]
            ).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={filter === k} className={cx('segmented__item', filter === k && 'is-active')} onClick={() => setFilter(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="row row--sm">
            <label className="search search--sm">
              <span className="visually-hidden">Поиск по сотруднику</span>
              <Icon name="search" />
              <input className="input input--sm" type="search" placeholder="Поиск по сотруднику" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            {onAdd && (
              <Button size="sm" icon="plus" onClick={onAdd}>
                Добавить
              </Button>
            )}
          </div>
        </header>
        <div className="table-wrap table-wrap--flat table-wrap--scroll">
          <table className="table table--dense table--sticky">
            <thead>
              <tr>
                <th scope="col">Сотрудник</th>
                <th scope="col">Подразделение</th>
                <th scope="col">Состояние</th>
                <th scope="col">Когда</th>
                <th scope="col" className="td-num">
                  Версия
                </th>
              </tr>
            </thead>
            <tbody>
              {!rows.length ? (
                <tr className="table__empty">
                  <td colSpan={5}>
                    <Empty compact title="Никого не найдено" />
                  </td>
                </tr>
              ) : (
                rows.map((i) => {
                  const overdue = !i.acknowledgedAt && late;
                  const d = doc.dueAt ? due(doc.dueAt) : null;
                  return (
                    <tr key={i.user.id} className={cx(overdue && 'is-overdue')}>
                      <td>
                        {i.user.fullName}
                        {!i.user.active && <span className="table__sub">учётная запись заблокирована</span>}
                      </td>
                      <td>{i.user.department?.name ?? '—'}</td>
                      <td>{i.acknowledgedAt ? <span className="badge badge--done">Ознакомлен(а)</span> : <span className={cx('badge', overdue ? 'badge--overdue' : 'badge--neutral')}>Не ознакомлен(а)</span>}</td>
                      <td className={cx('td-nowrap', !i.acknowledgedAt && 'td-muted')}>
                        {i.acknowledgedAt
                          ? dateTimeFull(i.acknowledgedAt)
                          : d
                            ? overdue
                              ? `срок прошёл ${count(Math.max(1, d.overdueDays), DAYS)} назад`
                              : d.text.toLowerCase()
                            : 'без срока'}
                      </td>
                      <td className={cx('td-num', !i.fileVersionNo && 'td-muted')}>{i.fileVersionNo ?? '—'}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
