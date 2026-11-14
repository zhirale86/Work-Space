import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi, useDelayed, useDocumentTitle } from '../api/hooks';
import type { ApprovalsByDepartmentItem, ApprovalsByEmployeeItem, Department, DocumentListItem, OrderAcknowledgementReportItem, ReportCode, ReportResponse, ReportSummaryResponse, TaskListItem, UserRef } from '../api/types';
import { Pagination } from '../components/Pagination';
import { UserPicker } from '../components/UserPicker';
import { DocStatusBadge, Due, Empty, LoadError, Loading, PageHeader, SkeletonTiles, TaskStatusBadge, cx } from '../components/ui';
import { overdueSpan } from '../lib/format';
import { docPath } from '../lib/status';
import { useAuth } from '../layout/Auth';

const TILES: { code: ReportCode; label: string; accent?: boolean; zeroHint: string }[] = [
  { code: 'approvals_in_progress', label: 'Согласования в работе', zeroHint: 'нет в работе' },
  { code: 'approvals_overdue', label: 'Согласования с нарушенным сроком', accent: true, zeroHint: 'всё в срок' },
  { code: 'documents_rework', label: 'Документы на доработке', zeroHint: 'нет на доработке' },
  { code: 'tasks_in_progress', label: 'Поручения в работе', zeroHint: 'нет в работе' },
  { code: 'tasks_overdue', label: 'Просроченные поручения', accent: true, zeroHint: 'всё в срок' },
  { code: 'orders_pending_acknowledgement', label: 'Приказы, ожидающие ознакомления', zeroHint: 'все ознакомлены' },
  { code: 'approvals_by_employee', label: 'Согласования по сотрудникам и подразделениям', zeroHint: 'нет данных' },
];

const CODES = new Set<string>([...TILES.map((t) => t.code), 'approvals_by_department']);

export function ReportsPage() {
  useDocumentTitle('Отчёты');
  const { code: codeParam } = useParams();
  const code = (CODES.has(codeParam ?? '') ? codeParam : 'approvals_in_progress') as ReportCode;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = 25;
  const departmentId = params.get('departmentId') ?? undefined;
  const userId = params.get('userId') ?? undefined;
  const summary = useApi<ReportSummaryResponse>('/reports/summary');
  const report = useApi<ReportResponse>(`/reports/${code}`, { departmentId, userId, page, pageSize });
  const depts = useApi<{ items: Department[] }>('/departments');
  const tilesSkeleton = useDelayed(summary.loading && !summary.data);
  const tableSkeleton = useDelayed(report.loading);
  const byGroup = code === 'approvals_by_employee' || code === 'approvals_by_department';
  const activeTile = byGroup ? 'approvals_by_employee' : code;

  const set = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? sp.set(k, v) : sp.delete(k));
    sp.delete('page');
    setParams(sp);
  };
  const go = (c: ReportCode) => navigate({ pathname: `/reports/${c}`, search: new URLSearchParams([...params.entries()].filter(([k]) => k !== 'page')).toString() });
  const countOf = (c: ReportCode) => summary.data?.items.find((i) => i.code === c)?.count ?? 0;
  const user: UserRef[] = userId ? [{ id: Number(userId), fullName: params.get('userName') ?? '…', position: '', department: null, active: true }] : [];

  const r = report.data;
  const emptyTitle = code === 'approvals_overdue' ? 'Просроченных согласований нет — всё в срок.' : code === 'tasks_overdue' ? 'Просроченных поручений нет — всё в срок.' : 'Таких документов сейчас нет';

  const table = () => {
    if (!r) return null;
    if (!r.items.length) return <Empty icon="check" title={emptyTitle} />;
    switch (r.code) {
      case 'approvals_in_progress':
      case 'approvals_overdue':
      case 'documents_rework':
        return (
          <table className="table table--dense table--sticky table--clickable">
            <thead>
              <tr>
                <th scope="col">Номер</th>
                <th scope="col">Название</th>
                <th scope="col">Статус</th>
                <th scope="col">Инициатор</th>
                <th scope="col">{r.code === 'approvals_overdue' ? 'Просрочка' : 'Срок'}</th>
              </tr>
            </thead>
            <tbody>
              {(r.items as DocumentListItem[]).map((d) => (
                <tr key={d.id} className={cx(d.overdue && 'is-overdue')} onClick={() => navigate(docPath(d.kind, d.id))}>
                  <td className="td-nowrap td-muted">{d.number}</td>
                  <td className="td-main">
                    <Link className="table__title" to={docPath(d.kind, d.id)}>
                      {d.title || d.number}
                    </Link>
                    <span className="table__sub">{d.type.name}</span>
                  </td>
                  <td className="td-nowrap">
                    <DocStatusBadge kind={d.kind} status={d.status} label={d.statusLabel} />
                  </td>
                  <td className="td-nowrap">
                    {d.initiator.fullName}
                    <span className="table__sub">{d.department?.name ?? '—'}</span>
                  </td>
                  <td className="td-nowrap">{r.code === 'approvals_overdue' && d.dueAt ? <span className="due due--overdue">{overdueSpan(d.dueAt)}</span> : <Due at={d.dueAt} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'tasks_in_progress':
      case 'tasks_overdue':
        return (
          <table className="table table--dense table--sticky table--clickable">
            <thead>
              <tr>
                <th scope="col">Номер</th>
                <th scope="col">Поручение</th>
                <th scope="col">Статус</th>
                <th scope="col">Исполнитель</th>
                {r.code === 'tasks_in_progress' && <th scope="col">Постановщик</th>}
                <th scope="col">{r.code === 'tasks_overdue' ? 'Просрочка' : 'Срок'}</th>
              </tr>
            </thead>
            <tbody>
              {(r.items as TaskListItem[]).map((t) => (
                <tr key={t.id} className={cx(t.overdue && 'is-overdue')} onClick={() => navigate(`/tasks/${t.id}`)}>
                  <td className="td-nowrap td-muted">{t.number}</td>
                  <td className="td-main">
                    <Link className="table__title" to={`/tasks/${t.id}`}>
                      {t.title}
                    </Link>
                  </td>
                  <td className="td-nowrap">
                    <TaskStatusBadge status={t.status} />
                  </td>
                  <td className="td-nowrap">{t.assignee.fullName}</td>
                  {r.code === 'tasks_in_progress' && <td className="td-nowrap">{t.author.fullName}</td>}
                  <td className="td-nowrap">{r.code === 'tasks_overdue' && t.dueAt ? <span className="due due--overdue">{overdueSpan(t.dueAt)}</span> : <Due at={t.dueAt} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'orders_pending_acknowledgement':
        return (
          <table className="table table--dense table--sticky table--clickable">
            <thead>
              <tr>
                <th scope="col">Приказ</th>
                <th scope="col" className="td-num">
                  Ознакомились
                </th>
                <th scope="col" className="td-num">
                  Не ознакомились
                </th>
                <th scope="col">Срок</th>
              </tr>
            </thead>
            <tbody>
              {(r.items as OrderAcknowledgementReportItem[]).map((d) => (
                <tr key={d.id} className={cx(d.overdue && 'is-overdue')} onClick={() => navigate(`${docPath('order', d.id)}?tab=ack`)}>
                  <td className="td-main">
                    <Link className="table__title" to={`${docPath('order', d.id)}?tab=ack`}>
                      {d.title}
                    </Link>
                    <span className="table__sub">{d.number}</span>
                  </td>
                  <td className="td-num">
                    {d.ackDone} из {d.ackTotal}
                  </td>
                  <td className="td-num">{d.ackPending}</td>
                  <td className="td-nowrap">
                    <Due at={d.dueAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'approvals_by_employee':
        return (
          <table className="table table--dense table--sticky">
            <thead>
              <tr>
                <th scope="col">Сотрудник</th>
                <th scope="col" className="td-num">
                  В работе
                </th>
                <th scope="col" className="td-num">
                  Просрочено
                </th>
                <th scope="col" className="td-num">
                  Согласовано
                </th>
                <th scope="col" className="td-num">
                  Возвращено
                </th>
                <th scope="col" className="td-num">
                  Отклонено
                </th>
                <th scope="col" className="td-num">
                  Всего решений
                </th>
              </tr>
            </thead>
            <tbody>
              {(r.items as ApprovalsByEmployeeItem[]).map((x) => (
                <tr key={x.user.id}>
                  <td className="td-main">
                    {x.user.fullName}
                    <span className="table__sub">{x.user.department?.name ?? '—'}</span>
                  </td>
                  <td className="td-num">{x.pending}</td>
                  <td className={cx('td-num', x.overdue > 0 && 'text-danger')}>{x.overdue}</td>
                  <td className="td-num">{x.approved}</td>
                  <td className="td-num">{x.returned}</td>
                  <td className="td-num">{x.rejected}</td>
                  <td className="td-num">{x.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'approvals_by_department':
        return (
          <table className="table table--dense table--sticky">
            <thead>
              <tr>
                <th scope="col">Подразделение</th>
                <th scope="col" className="td-num">
                  В работе
                </th>
                <th scope="col" className="td-num">
                  На доработке
                </th>
                <th scope="col" className="td-num">
                  Согласовано
                </th>
                <th scope="col" className="td-num">
                  Отклонено
                </th>
                <th scope="col" className="td-num">
                  Отменено
                </th>
                <th scope="col" className="td-num">
                  Всего
                </th>
              </tr>
            </thead>
            <tbody>
              {(r.items as ApprovalsByDepartmentItem[]).map((x, i) => (
                <tr key={x.department?.id ?? `n${i}`}>
                  <td className="td-main">{x.department?.name ?? 'Без подразделения'}</td>
                  <td className="td-num">{x.inProgress}</td>
                  <td className="td-num">{x.rework}</td>
                  <td className="td-num">{x.approved}</td>
                  <td className="td-num">{x.rejected}</td>
                  <td className="td-num">{x.cancelled}</td>
                  <td className="td-num">{x.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
    }
  };

  return (
    <>
      <PageHeader title="Отчёты" lead="Показатели на сейчас. Нажмите на показатель, чтобы открыть список." meta={!hasRole('auditor') ? <span>Показаны документы, к которым у вас есть доступ.</span> : <span>Показатели по всей компании.</span>} />
      <div className="filters filters--inline" role="group" aria-label="Фильтры отчёта">
        <div className="filters__row filters__row--report">
          <label className="field">
            <span className="field__label">Подразделение</span>
            <select className="select" value={departmentId ?? ''} onChange={(e) => set({ departmentId: e.target.value || null })}>
              <option value="">Все подразделения</option>
              {(depts.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="field__label">Сотрудник</span>
            <UserPicker single value={user} placeholder="Любой" ariaLabel="Сотрудник" onChange={(u) => set({ userId: u[0] ? String(u[0].id) : null, userName: u[0]?.fullName ?? null })} />
          </div>
        </div>
      </div>
      <div className="section section--tight">
        {summary.error ? (
          <div className="card">
            <LoadError title="Не удалось загрузить отчёт" onRetry={() => summary.reload()} />
          </div>
        ) : !summary.data ? (
          tilesSkeleton ? <SkeletonTiles n={7} /> : <Loading />
        ) : (
          <div className="stats stats--report">
            {TILES.map((t) => {
              const n = t.code === 'approvals_by_employee' ? Math.max(countOf('approvals_by_employee'), countOf('approvals_by_department')) : countOf(t.code);
              return (
                <button key={t.code} type="button" className={cx('stat', activeTile === t.code && 'is-active', n === 0 ? 'stat--zero' : t.accent && 'stat--accent')} aria-pressed={activeTile === t.code} onClick={() => go(t.code)}>
                  <span className="stat__value">{n}</span>
                  <span className="stat__label">{t.label}</span>
                  <span className="stat__hint">{activeTile === t.code ? 'выбрано' : n === 0 ? t.zeroHint : 'открыть список'}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="section section--tight">
        {byGroup && (
          <div className="segmented report-switch" role="radiogroup" aria-label="Разрез">
            <button type="button" role="radio" aria-checked={code === 'approvals_by_employee'} className={cx('segmented__item', code === 'approvals_by_employee' && 'is-active')} onClick={() => go('approvals_by_employee')}>
              По сотрудникам
            </button>
            <button type="button" role="radio" aria-checked={code === 'approvals_by_department'} className={cx('segmented__item', code === 'approvals_by_department' && 'is-active')} onClick={() => go('approvals_by_department')}>
              По подразделениям
            </button>
          </div>
        )}
        <div className="table-wrap table-wrap--scroll">
          {report.error ? (
            <LoadError title="Не удалось загрузить отчёт" onRetry={() => report.reload()} />
          ) : report.loading && !r ? (
            <div className="stack stack--sm skeleton-pad">{tableSkeleton && Array.from({ length: 6 }, (_, i) => <span key={i} className="skeleton skeleton--row" />)}</div>
          ) : (
            table()
          )}
        </div>
        {r && r.total > pageSize && (
          <div className="table-wrap table-wrap--pager">
            <Pagination page={page} pageSize={pageSize} total={r.total} onPage={(p) => setParams((sp) => (sp.set('page', String(p)), sp))} />
          </div>
        )}
      </div>
    </>
  );
}
