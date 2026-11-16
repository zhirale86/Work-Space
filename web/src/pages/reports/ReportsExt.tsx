/** Расширение отчётов: «Мои согласования», «Все согласования», список под цифрой. */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, useDelayed } from '../../api/hooks';
import {
  ALL_LABELS,
  APPROVER_LABELS,
  INITIATOR_LABELS,
  type AllApprovalsReport,
  type AllState,
  type ApproverState,
  type DrillAs,
  type DrillReport,
  type InitiatorState,
  type MyApprovalsReport,
} from '../../api/reportsExt';
import type { DocumentListItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Pagination } from '../../components/Pagination';
import { DocStatusBadge, Due, Empty, LoadError, cx } from '../../components/ui';
import { docPath } from '../../lib/status';

const PAGE_SIZE = 25;

/** Адрес списка под цифрой. */
export function drillPath(as: DrillAs, id: number, state: string): string {
  return `/reports/drill?${new URLSearchParams({ as, id: String(id), state })}`;
}

/** Цифра-ссылка: ноль не кликабелен. */
export function DrillNum({ n, to, danger }: { n: number; to: string; danger?: boolean }) {
  if (!n) return <span className="td-muted">0</span>;
  return (
    <Link className={cx('link num-link', danger && 'text-danger')} to={to} onClick={(e) => e.stopPropagation()} title="Открыть список">
      {n}
    </Link>
  );
}

export function DocTable({ items }: { items: DocumentListItem[] }) {
  const navigate = useNavigate();
  return (
    <table className="table table--dense table--sticky table--clickable">
      <thead>
        <tr>
          <th scope="col">Номер</th>
          <th scope="col">Название</th>
          <th scope="col">Статус</th>
          <th scope="col">Инициатор</th>
          <th scope="col">Создано</th>
          <th scope="col">Срок</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id} className={cx(d.overdue && 'is-overdue')} onClick={() => navigate(docPath(d.kind, d.id))}>
            <td className="td-nowrap td-muted">{d.number}</td>
            <td className="td-main">
              <Link className="table__title" to={docPath(d.kind, d.id)}>
                {d.title || d.number}
              </Link>
              <span className="table__sub">
                {d.type.name}
                {d.deal ? ` · ${d.deal.title}` : ''}
              </span>
            </td>
            <td className="td-nowrap">
              <DocStatusBadge kind={d.kind} status={d.status} label={d.statusLabel} />
            </td>
            <td className="td-nowrap">
              {d.initiator.fullName}
              <span className="table__sub">{d.department?.name ?? '—'}</span>
            </td>
            <td className="td-nowrap td-muted">{new Date(d.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</td>
            <td className="td-nowrap">{d.dueAt ? <Due at={d.dueAt} /> : <span className="td-muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Rows({ loading, error, onRetry, children }: { loading: boolean; error: unknown; onRetry: () => void; children: React.ReactNode }) {
  const skeleton = useDelayed(loading);
  if (error) return <LoadError title="Не удалось загрузить отчёт" onRetry={onRetry} />;
  if (loading) return <div className="stack stack--sm skeleton-pad">{skeleton && Array.from({ length: 6 }, (_, i) => <span key={i} className="skeleton skeleton--row" />)}</div>;
  return <>{children}</>;
}

const APPROVER_ORDER: ApproverState[] = ['pending', 'overdue', 'approved', 'rework', 'rejected', 'all'];
const INITIATOR_ORDER: InitiatorState[] = ['in_progress', 'rework', 'approved', 'rejected', 'cancelled', 'all'];

function StatGroup<S extends string>({ title, hint, order, labels, counts, to, danger }: {
  title: string;
  hint: string;
  order: S[];
  labels: Record<S, string>;
  counts: Record<S, number>;
  to: (s: S) => string;
  danger?: S[];
}) {
  const navigate = useNavigate();
  return (
    <div className="card">
      <div className="card__header">
        <h2 className="card__title">{title}</h2>
        <span className="text-muted text-sm">{hint}</span>
      </div>
      <div className="card__body">
        <div className="stats stats--drill">
          {order.map((s) => {
            const n = counts[s];
            return (
              <button key={s} type="button" disabled={!n} className={cx('stat', !n ? 'stat--zero' : danger?.includes(s) && 'stat--accent')} onClick={() => navigate(to(s))}>
                <span className="stat__value">{n}</span>
                <span className="stat__label">{labels[s]}</span>
                <span className="stat__hint">{n ? 'открыть список' : 'нет'}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function MyApprovalsView({ userId }: { userId: number }) {
  const my = useApi<MyApprovalsReport>('/report-ext/my');
  return (
    <Rows loading={my.loading && !my.data} error={my.error} onRetry={() => my.reload()}>
      {my.data && (
        <div className="stack">
          <StatGroup
            title="Я — согласующий"
            hint="Документы, где от вас требовалось или требуется решение"
            order={APPROVER_ORDER}
            labels={APPROVER_LABELS}
            counts={my.data.approver}
            to={(s) => drillPath('approver', userId, s)}
            danger={['overdue']}
          />
          <StatGroup
            title="Я — инициатор"
            hint="Согласования и приказы, которые запускали вы"
            order={INITIATOR_ORDER}
            labels={INITIATOR_LABELS}
            counts={my.data.initiator}
            to={(s) => drillPath('initiator', userId, s)}
            danger={['rework']}
          />
        </div>
      )}
    </Rows>
  );
}

export function DrillView() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const r = useApi<DrillReport>('/report-ext/drill', { as: params.get('as') ?? '', id: params.get('id') ?? '', state: params.get('state') ?? '', page, pageSize: PAGE_SIZE });
  return (
    <div className="stack">
      <div className="row row--between">
        <h2 className="h3">{r.data?.title ?? 'Список документов'}</h2>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => navigate(-1)}>
          <Icon name="chevron-left" /> Назад к отчёту
        </button>
      </div>
      <div className="table-wrap table-wrap--scroll">
        <Rows loading={r.loading && !r.data} error={r.error} onRetry={() => r.reload()}>
          {r.data && (r.data.items.length ? <DocTable items={r.data.items} /> : <Empty icon="check" title="Документов нет" />)}
        </Rows>
      </div>
      {r.data && r.data.total > PAGE_SIZE && (
        <div className="table-wrap table-wrap--pager">
          <Pagination page={page} pageSize={PAGE_SIZE} total={r.data.total} onPage={(p) => setParams((sp) => (sp.set('page', String(p)), sp))} />
        </div>
      )}
      {r.data && <p className="text-muted text-sm">Нажмите на строку, чтобы открыть карточку: маршрут, решения и комментарии, файлы с версиями, история.</p>}
    </div>
  );
}

const ALL_ORDER: AllState[] = ['all', 'active', 'rework', 'approved', 'rejected', 'cancelled'];

export function AllApprovalsView() {
  const [params, setParams] = useSearchParams();
  const state = (ALL_ORDER.includes(params.get('state') as AllState) ? params.get('state') : 'all') as AllState;
  const kind = params.get('kind') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [q, setQ] = useState(params.get('q') ?? '');
  const r = useApi<AllApprovalsReport>('/report-ext/all', { state, kind, q: params.get('q') ?? '', page, pageSize: PAGE_SIZE });
  const set = (patch: Record<string, string | null>) =>
    setParams((sp) => {
      for (const [k, v] of Object.entries(patch)) (v ? sp.set(k, v) : sp.delete(k));
      sp.delete('page');
      return sp;
    });
  return (
    <div className="stack">
      <div className="tabs tabs--page" role="tablist" aria-label="Статус">
        {ALL_ORDER.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={s === state} className={cx('tab', s === state && 'is-active')} onClick={() => set({ state: s === 'all' ? null : s })}>
            {ALL_LABELS[s]}
            {r.data && <span className="tab__count">{r.data.counts[s]}</span>}
          </button>
        ))}
      </div>
      <form
        className="filters"
        aria-label="Фильтры"
        onSubmit={(e) => {
          e.preventDefault();
          set({ q: q.trim() || null });
        }}
      >
        <div className="filters__row filters__row--report">
          <label className="field">
            <span className="field__label">Поиск</span>
            <span className="search">
              <Icon name="search" />
              <input className="input" value={q} placeholder="Номер, название или сделка" onChange={(e) => setQ(e.target.value)} onBlur={() => set({ q: q.trim() || null })} />
            </span>
          </label>
          <label className="field">
            <span className="field__label">Вид</span>
            <select className="select" value={kind} onChange={(e) => set({ kind: e.target.value || null })}>
              <option value="">Согласования и приказы</option>
              <option value="approval">Только согласования</option>
              <option value="order">Только приказы</option>
            </select>
          </label>
        </div>
      </form>
      <div className="table-wrap table-wrap--scroll">
        <Rows loading={r.loading && !r.data} error={r.error} onRetry={() => r.reload()}>
          {r.data && (r.data.items.length ? <DocTable items={r.data.items} /> : <Empty icon="check" title="Документов нет" text="Измените статус или условия поиска." />)}
        </Rows>
      </div>
      {r.data && r.data.total > PAGE_SIZE && (
        <div className="table-wrap table-wrap--pager">
          <Pagination page={page} pageSize={PAGE_SIZE} total={r.data.total} onPage={(p) => setParams((sp) => (sp.set('page', String(p)), sp))} />
        </div>
      )}
    </div>
  );
}
