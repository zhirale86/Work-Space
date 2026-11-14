import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useApi, useDelayed, useDocumentTitle } from '../../api/hooks';
import type { Page, TaskListItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Pagination } from '../../components/Pagination';
import { Button, Due, Empty, LoadError, PageHeader, TaskStatusBadge, cx } from '../../components/ui';
import { NBSP } from '../../lib/format';
import { TASK_STATUSES, TASK_STATUS_LABELS } from '../../lib/status';
import { TaskCreateModal } from './TaskCreateModal';

const TABS = [
  { key: 'assigned', label: 'Мне' },
  { key: 'authored', label: 'От меня' },
  { key: 'all', label: 'Все доступные' },
] as const;

export function TasksListPage() {
  useDocumentTitle('Поручения');
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const scope = TABS.some((t) => t.key === params.get('scope')) ? params.get('scope')! : 'assigned';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = [10, 25, 50].includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 25;
  const [qText, setQText] = useState(params.get('q') ?? '');
  const [create, setCreate] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});

  const set = (patch: Record<string, string | null>, keepPage = false) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? sp.delete(k) : sp.set(k, v));
    if (!keepPage) sp.delete('page');
    setParams(sp);
  };

  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((params.get('q') ?? '') !== qText.trim()) set({ q: qText.trim() || null });
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qText]);

  const query = { scope, q: params.get('q') ?? undefined, status: params.get('status') ?? undefined, overdue: params.get('overdue') === '1' ? true : undefined, page, pageSize };
  const { data, error, loading, reload } = useApi<Page<TaskListItem>>('/tasks', query);
  const skeleton = useDelayed(loading);
  const hasFilters = !!(params.get('q') || params.get('status') || params.get('overdue'));

  useEffect(() => {
    let c = false;
    Promise.all(TABS.map((t) => api.get<Page<unknown>>('/tasks', { scope: t.key, pageSize: 1 }).then((p) => [t.key, p.total] as const)))
      .then((pairs) => !c && setCounts(Object.fromEntries(pairs)))
      .catch(() => undefined);
    return () => {
      c = true;
    };
  }, [data]);

  const reset = () => {
    setQText('');
    setParams(scope === 'assigned' ? {} : { scope });
  };

  const empty = () => {
    if (hasFilters)
      return (
        <Empty
          icon="search"
          title="По вашему запросу ничего не найдено"
          text="Проверьте номер или название либо сбросьте фильтры."
          actions={
            <Button size="sm" onClick={reset}>
              Сбросить фильтры
            </Button>
          }
        />
      );
    if (scope === 'assigned') return <Empty icon="task" title="Вам пока не давали поручений" text="Новые поручения появятся здесь и в уведомлениях." />;
    if (scope === 'authored')
      return (
        <Empty
          icon="task"
          title="Вы ещё не давали поручений"
          actions={
            <Button size="sm" onClick={() => setCreate(true)}>
              Создать поручение
            </Button>
          }
        />
      );
    return <Empty icon="task" title="Поручений пока нет" text="Поручения, которые выдали вам или выдали вы, появятся здесь." />;
  };

  return (
    <>
      <PageHeader
        title="Поручения"
        lead="Поручения, которые выдали вам или выдали вы."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreate(true)}>
            Создать поручение
          </Button>
        }
      />
      <div className="tabs tabs--page" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={scope === t.key} className={cx('tab', scope === t.key && 'is-active')} onClick={() => set({ scope: t.key === 'assigned' ? null : t.key })}>
            {t.label}
            {counts[t.key] !== undefined && <span className="tab__count">{counts[t.key]}</span>}
          </button>
        ))}
      </div>
      <form className="filters" aria-label="Фильтры" onSubmit={(e) => e.preventDefault()}>
        <div className="filters__row filters__row--tasks">
          <label className="field">
            <span className="field__label">Поиск</span>
            <span className="search">
              <Icon name="search" />
              <input className="input" type="search" placeholder="Номер или название" value={qText} onChange={(e) => setQText(e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span className="field__label">Статус</span>
            <select className="select" value={params.get('status') ?? ''} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Все статусы</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox filters__check">
            <input type="checkbox" checked={params.get('overdue') === '1'} onChange={(e) => set({ overdue: e.target.checked ? '1' : null })} />
            <span>Только просроченные</span>
          </label>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={reset}>
              Сбросить всё
            </Button>
          )}
        </div>
      </form>
      <div className="table-wrap">
        {error ? (
          <LoadError onRetry={() => reload()} />
        ) : (
          <>
            <table className="table table--sticky table--clickable" style={{ ['--table-sticky-top' as string]: 'var(--topbar-h)' }}>
              <thead>
                <tr>
                  <th scope="col">Номер</th>
                  <th scope="col">Поручение</th>
                  <th scope="col">Статус</th>
                  <th scope="col">{scope === 'assigned' ? 'Постановщик' : 'Исполнитель'}</th>
                  <th scope="col">Срок</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data ? (
                  Array.from({ length: 8 }, (_, i) => (
                    <tr key={i} className="table__empty">
                      <td colSpan={5} className="skeleton-cell">
                        {skeleton && <span className="skeleton skeleton--row" />}
                      </td>
                    </tr>
                  ))
                ) : !data?.items.length ? (
                  <tr className="table__empty">
                    <td colSpan={5}>{empty()}</td>
                  </tr>
                ) : (
                  data.items.map((t) => {
                    const person = scope === 'assigned' ? t.author : t.assignee;
                    return (
                      <tr key={t.id} className={cx(t.overdue && 'is-overdue')} onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(`/tasks/${t.id}`)}>
                        <td className="td-nowrap td-muted num">{t.number}</td>
                        <td className="td-main">
                          <Link className="table__title" to={`/tasks/${t.id}`}>
                            {t.title}
                          </Link>
                          <span className="table__sub">{t.document ? `по документу ${t.document.number}${NBSP}· ${t.document.title}` : 'без документа-основания'}</span>
                        </td>
                        <td className="td-nowrap">
                          <TaskStatusBadge status={t.status} />
                        </td>
                        <td className="td-nowrap">
                          {person.fullName}
                          <span className="table__sub">{person.department?.name ?? '—'}</span>
                        </td>
                        <td className="td-nowrap">{t.status === 'done' || t.status === 'cancelled' ? <span className="due due--done">{t.statusLabel}</span> : <Due at={t.dueAt} />}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {data && data.total > 0 && <Pagination page={page} pageSize={pageSize} total={data.total} onPage={(p) => set({ page: String(p) }, true)} onPageSize={(s) => set({ pageSize: s === 25 ? null : String(s) })} />}
          </>
        )}
      </div>
      {create && <TaskCreateModal onClose={() => setCreate(false)} onCreated={(t) => navigate(`/tasks/${t.id}`)} />}
    </>
  );
}
