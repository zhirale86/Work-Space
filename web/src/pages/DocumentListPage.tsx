import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import { useApi, useDelayed, useDocumentTitle } from '../api/hooks';
import type { Department, DocKind, DocType, DocumentListItem, Page, UserRef } from '../api/types';
import { Icon } from '../components/Icon';
import { Dropdown } from '../components/Menu';
import { Pagination } from '../components/Pagination';
import { UserPicker } from '../components/UserPicker';
import { Button, DocStatusBadge, Due, Empty, LoadError, PageHeader, cx } from '../components/ui';
import { dateShort, dayText, isoDay, NBSP } from '../lib/format';
import { APPROVAL_STATUSES, FINISHED_DOC, ORDER_STATUSES, docPath, statusLabel } from '../lib/status';

type Mode = 'approvals' | 'orders' | 'all';

interface Tab {
  key: string;
  label: string;
  scopes: string[];
}

const CONFIG: Record<Mode, { title: string; lead: string; kind?: DocKind; tabs: Tab[]; entity: string }> = {
  approvals: {
    title: 'Согласования',
    lead: 'Все согласования, к которым у вас есть доступ.',
    kind: 'approval',
    entity: 'согласований',
    tabs: [
      { key: 'all', label: 'Все доступные', scopes: ['all'] },
      { key: 'to_approve', label: 'Ждут моего решения', scopes: ['to_approve'] },
      { key: 'mine', label: 'Созданные мной', scopes: ['mine'] },
    ],
  },
  orders: {
    title: 'Приказы',
    lead: 'Приказы, в которых вы участвуете или с которыми должны ознакомиться.',
    kind: 'order',
    entity: 'приказов',
    tabs: [
      { key: 'all', label: 'Все доступные', scopes: ['all'] },
      { key: 'decide', label: 'На согласование и утверждение', scopes: ['to_approve', 'to_sign'] },
      { key: 'to_acknowledge', label: 'На ознакомление', scopes: ['to_acknowledge'] },
      { key: 'mine', label: 'Созданные мной', scopes: ['mine'] },
    ],
  },
  all: {
    title: 'Все документы',
    lead: 'Согласования и приказы в пределах ваших прав доступа.',
    entity: 'документов',
    tabs: [
      { key: 'all', label: 'Все доступные', scopes: ['all'] },
      { key: 'to_approve', label: 'Ждут моего решения', scopes: ['to_approve'] },
      { key: 'mine', label: 'Созданные мной', scopes: ['mine'] },
    ],
  },
};

const FILTER_KEYS = ['q', 'typeId', 'status', 'departmentId', 'initiatorId', 'from', 'to', 'overdue'];

function usePeriodPresets() {
  const today = new Date();
  const ago = (n: number) => isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  return [
    { label: 'Сегодня', from: ago(0), to: ago(0) },
    { label: '7 дней', from: ago(6), to: ago(0) },
    { label: '30 дней', from: ago(29), to: ago(0) },
    { label: 'Этот месяц', from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: ago(0) },
  ];
}

function PeriodButton({ from, to, overdue, onApply }: { from: string; to: string; overdue: boolean; onApply: (v: { from: string; to: string; overdue: boolean }) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const [o, setO] = useState(overdue);
  const wrap = useRef<HTMLDivElement>(null);
  const presets = usePeriodPresets();
  useEffect(() => {
    if (open) {
      setF(from);
      setT(to);
      setO(overdue);
    }
  }, [open, from, to, overdue]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const active = !!(from || to || overdue);
  return (
    <div className="menu-wrap" ref={wrap}>
      <Button icon="calendar" className={cx(active && 'is-applied')} aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        Период
      </Button>
      {open && (
        <div className="menu menu--right period-pop" role="dialog" aria-label="Период создания">
          <div className="row row--sm">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                className={cx('filter-chip filter-chip--preset', f === p.from && t === p.to && 'is-active')}
                onClick={() => {
                  setF(p.from);
                  setT(p.to);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="grid-2 period-pop__dates">
            <label className="field">
              <span className="field__label">с</span>
              <input className="input input--date" type="date" value={f} max={t || undefined} onChange={(e) => setF(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">по</span>
              <input className="input input--date" type="date" value={t} min={f || undefined} onChange={(e) => setT(e.target.value)} />
            </label>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={o} onChange={(e) => setO(e.target.checked)} />
            <span>Только просроченные</span>
          </label>
          <div className="row row--between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setF('');
                setT('');
                setO(false);
              }}
            >
              Очистить
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onApply({ from: f, to: t, overdue: o });
                setOpen(false);
              }}
            >
              Применить
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type SortKey = 'created_desc' | 'created_asc' | 'due_asc' | 'due_desc';

function sortItems(items: DocumentListItem[], sort: SortKey): DocumentListItem[] {
  const val = (d: DocumentListItem) => (sort.startsWith('due') ? (d.dueAt ? new Date(d.dueAt).getTime() : null) : new Date(d.createdAt).getTime());
  const dir = sort.endsWith('asc') ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir;
  });
}

export function DocumentListPage({ mode }: { mode: Mode }) {
  const cfg = CONFIG[mode];
  useDocumentTitle(cfg.title);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const tabKey = cfg.tabs.some((t) => t.key === params.get('scope')) ? params.get('scope')! : 'all';
  const tab = cfg.tabs.find((t) => t.key === tabKey)!;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const pageSize = [10, 25, 50].includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 25;
  const sort = (['created_desc', 'created_asc', 'due_asc', 'due_desc'].includes(params.get('sort') ?? '') ? params.get('sort') : 'created_desc') as SortKey;
  const [qText, setQText] = useState(params.get('q') ?? '');

  const types = useApi<{ items: DocType[] }>('/doc-types');
  const depts = useApi<{ items: Department[] }>('/departments');
  const typeList = (types.data?.items ?? []).filter((t) => !cfg.kind || t.kind === cfg.kind);
  const statusList = cfg.kind === 'approval' ? APPROVAL_STATUSES : ORDER_STATUSES;

  const set = (patch: Record<string, string | null | undefined>, keepPage = false) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    }
    if (!keepPage) sp.delete('page');
    setParams(sp, { replace: false });
  };

  // Поиск — через 300 мс после остановки ввода.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((params.get('q') ?? '') !== qText.trim()) set({ q: qText.trim() || null });
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qText]);
  useEffect(() => setQText(params.get('q') ?? ''), [params]);

  const filters = {
    q: params.get('q') ?? undefined,
    kind: cfg.kind,
    typeId: params.get('typeId') ?? undefined,
    status: params.get('status') ?? undefined,
    departmentId: params.get('departmentId') ?? undefined,
    initiatorId: params.get('initiatorId') ?? undefined,
    createdFrom: params.get('from') ?? undefined,
    createdTo: params.get('to') ?? undefined,
    overdue: params.get('overdue') === '1' ? true : undefined,
  };
  const filterKey = JSON.stringify(filters);
  const hasFilters = FILTER_KEYS.some((k) => params.get(k));

  const [data, setData] = useState<Page<DocumentListItem> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const skeleton = useDelayed(loading);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const run = async (): Promise<Page<DocumentListItem>> => {
      if (tab.scopes.length === 1) return api.get<Page<DocumentListItem>>('/documents', { ...filters, scope: tab.scopes[0], page, pageSize });
      // Объединённая вкладка (несколько scope): API принимает один scope — собираем на клиенте.
      const parts = await Promise.all(tab.scopes.map((s) => api.get<Page<DocumentListItem>>('/documents', { ...filters, scope: s, pageSize: 100 })));
      const seen = new Set<number>();
      const all = parts.flatMap((p) => p.items).filter((d) => !seen.has(d.id) && !!seen.add(d.id));
      all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize };
    };
    run()
      .then((p) => !cancelled && setData(p))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e : new ApiError(0, 'internal', '')))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, tabKey, page, pageSize, tick]);

  // Счётчики вкладок — без учёта фильтров.
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      cfg.tabs.map(async (t) => {
        const totals = await Promise.all(t.scopes.map((s) => api.get<Page<unknown>>('/documents', { kind: cfg.kind, scope: s, pageSize: 1 }).then((p) => p.total)));
        return [t.key, totals.reduce((a, b) => a + b, 0)] as const;
      }),
    )
      .then((pairs) => !cancelled && setCounts(Object.fromEntries(pairs)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cfg, tick]);

  const items = useMemo(() => (data ? sortItems(data.items, sort) : []), [data, sort]);

  const chips: { key: string; label: string; value: string; clear: Record<string, null> }[] = [];
  if (params.get('q')) chips.push({ key: 'q', label: 'Поиск:', value: `«${params.get('q')}»`, clear: { q: null } });
  if (params.get('typeId')) chips.push({ key: 'typeId', label: 'Тип:', value: typeList.find((t) => String(t.id) === params.get('typeId'))?.name ?? '…', clear: { typeId: null } });
  if (params.get('status'))
    chips.push({
      key: 'status',
      label: 'Статус:',
      value: params
        .get('status')!
        .split(',')
        .map((s) => statusLabel(cfg.kind ?? 'approval', s as never))
        .join(', '),
      clear: { status: null },
    });
  if (params.get('departmentId')) chips.push({ key: 'departmentId', label: 'Подразделение:', value: depts.data?.items.find((d) => String(d.id) === params.get('departmentId'))?.name ?? '…', clear: { departmentId: null } });
  if (params.get('initiatorId')) chips.push({ key: 'initiatorId', label: 'Инициатор:', value: params.get('initiatorName') ?? '…', clear: { initiatorId: null, initiatorName: null } as Record<string, null> });
  if (params.get('from') || params.get('to')) {
    const f = params.get('from');
    const t = params.get('to');
    chips.push({ key: 'period', label: 'Период:', value: `${f ? dayText(f) : '…'} — ${t ? dayText(t) : '…'}`, clear: { from: null, to: null } });
  }
  if (params.get('overdue') === '1') chips.push({ key: 'overdue', label: 'Только просроченные', value: '', clear: { overdue: null } });

  const resetAll = () => {
    setQText('');
    const sp = new URLSearchParams();
    if (tabKey !== 'all') sp.set('scope', tabKey);
    setParams(sp);
  };

  const initiator: UserRef[] = params.get('initiatorId')
    ? [{ id: Number(params.get('initiatorId')), fullName: params.get('initiatorName') ?? '…', position: '', department: null, active: true }]
    : [];

  const createButton =
    mode === 'approvals' ? (
      <Dropdown
        label="Создать согласование"
        items={[
          { label: 'Согласование GPM-калькулятора', icon: 'approve', to: '/approvals/new?type=GPM' },
          { label: 'Другое согласование', icon: 'file', to: '/approvals/new?type=APPROVAL' },
        ]}
        trigger={({ open, toggle, ref }) => (
          <button ref={ref} type="button" className="btn btn--primary" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
            <Icon name="plus" />
            Создать согласование
            <Icon name="chevron-down" />
          </button>
        )}
      />
    ) : mode === 'orders' ? (
      <Link className="btn btn--primary" to="/orders/new">
        <Icon name="plus" />
        Создать приказ
      </Link>
    ) : null;

  const sortBtn = (key: 'created' | 'due', label: string) => {
    const activeKey = sort.startsWith(key);
    const asc = sort.endsWith('asc');
    const next = activeKey ? `${key}_${asc ? 'desc' : 'asc'}` : `${key}_${key === 'due' ? 'asc' : 'desc'}`;
    return (
      <button
        className={cx('th-sort', activeKey && 'is-active')}
        type="button"
        aria-label={`${label}, сортировка: ${activeKey ? (asc ? (key === 'due' ? 'сначала ближайшие' : 'сначала старые') : key === 'due' ? 'сначала дальние' : 'сначала новые') : 'не выбрана'}`}
        onClick={() => set({ sort: next === 'created_desc' ? null : next }, true)}
      >
        {label}
        <Icon name={activeKey ? 'chevron-down' : 'sort'} className={activeKey && asc ? 'icon--flip' : undefined} />
      </button>
    );
  };

  const emptyState = () => {
    if (hasFilters)
      return (
        <Empty
          icon="search"
          title="По вашему запросу ничего не найдено"
          text="Проверьте номер или название либо сбросьте фильтры."
          actions={
            <Button size="sm" onClick={resetAll}>
              Сбросить фильтры
            </Button>
          }
        />
      );
    if (tabKey === 'to_approve' || tabKey === 'decide')
      return <Empty icon="check" title={mode === 'orders' ? 'Нет приказов, ожидающих вашего решения' : 'Нет согласований, ожидающих вашего решения'} text="Когда вас выберут согласующим, документ появится здесь и в уведомлениях." />;
    if (tabKey === 'to_acknowledge') return <Empty icon="check" title="Все приказы прочитаны" text="Новые приказы на ознакомление появятся здесь и в уведомлениях." />;
    if (mode === 'orders')
      return (
        <Empty
          title="Здесь пока нет приказов"
          text="Создайте первый приказ — он появится в этом списке."
          actions={
            <Link className="btn btn--secondary btn--sm" to="/orders/new">
              Создать приказ
            </Link>
          }
        />
      );
    if (mode === 'approvals')
      return (
        <Empty
          title="Здесь пока нет согласований"
          text="Создайте первое согласование — оно появится в этом списке."
          actions={
            <Link className="btn btn--secondary btn--sm" to="/approvals/new?type=GPM">
              Создать согласование
            </Link>
          }
        />
      );
    return <Empty title="Здесь пока нет документов" text="Согласования и приказы, к которым у вас есть доступ, появятся в этом списке." />;
  };

  return (
    <>
      <PageHeader title={cfg.title} lead={cfg.lead} actions={createButton} />
      <div className="tabs tabs--page" role="tablist">
        {cfg.tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === tabKey} className={cx('tab', t.key === tabKey && 'is-active')} onClick={() => set({ scope: t.key === 'all' ? null : t.key })}>
            {t.label}
            {counts[t.key] !== undefined && <span className="tab__count">{counts[t.key]}</span>}
          </button>
        ))}
      </div>

      <form className="filters" aria-label="Фильтры" onSubmit={(e) => e.preventDefault()}>
        <div className="filters__row">
          <label className="field">
            <span className="field__label">Поиск</span>
            <span className="search">
              <Icon name="search" />
              <input className="input" type="search" placeholder={mode === 'orders' ? 'Номер или название' : 'Номер, название или сделка'} value={qText} onChange={(e) => setQText(e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span className="field__label">Тип</span>
            <select className="select" value={params.get('typeId') ?? ''} onChange={(e) => set({ typeId: e.target.value })}>
              <option value="">Все типы</option>
              {typeList.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Статус</span>
            <select className="select" value={params.get('status') ?? ''} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Все статусы</option>
              {statusList.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(cfg.kind ?? 'approval', s)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Подразделение</span>
            <select className="select" value={params.get('departmentId') ?? ''} onChange={(e) => set({ departmentId: e.target.value })}>
              <option value="">Любое</option>
              {(depts.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="field__label">Инициатор</span>
            <UserPicker single value={initiator} placeholder="Любой" ariaLabel="Инициатор" onChange={(u) => set({ initiatorId: u[0] ? String(u[0].id) : null, initiatorName: u[0]?.fullName ?? null })} />
          </div>
          <PeriodButton from={params.get('from') ?? ''} to={params.get('to') ?? ''} overdue={params.get('overdue') === '1'} onApply={(v) => set({ from: v.from || null, to: v.to || null, overdue: v.overdue ? '1' : null })} />
        </div>
        {chips.length > 0 && (
          <div className="filters__active">
            <span>Применено:</span>
            {chips.map((c) => (
              <span key={c.key} className="filter-chip">
                <span className="filter-chip__key">{c.label}</span>
                {c.value && ` ${c.value}`}
                <button className="chip__remove" type="button" aria-label={`Убрать фильтр ${c.label.replace(':', '')}`} onClick={() => set(c.clear)}>
                  <Icon name="x" />
                </button>
              </span>
            ))}
            <Button variant="ghost" size="sm" onClick={resetAll}>
              Сбросить всё
            </Button>
          </div>
        )}
      </form>

      <div className="table-wrap">
        {error ? (
          <LoadError onRetry={() => setTick((t) => t + 1)} />
        ) : (
          <>
            <table className="table table--sticky table--clickable" style={{ ['--table-sticky-top' as string]: 'var(--topbar-h)' }}>
              <thead>
                <tr>
                  <th scope="col">Номер</th>
                  <th scope="col">Название, тип и сделка</th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="hide-sm">
                    Инициатор
                  </th>
                  <th scope="col">{sortBtn('due', 'Срок')}</th>
                  <th scope="col" className="hide-md">
                    {sortBtn('created', 'Создано')}
                  </th>
                </tr>
              </thead>
              <tbody aria-busy={loading}>
                {loading && !data ? (
                  Array.from({ length: 8 }, (_, i) => (
                    <tr key={i} className="table__empty">
                      <td colSpan={6} className="skeleton-cell">
                        {skeleton && <span className="skeleton skeleton--row" />}
                      </td>
                    </tr>
                  ))
                ) : !items.length ? (
                  <tr className="table__empty">
                    <td colSpan={6}>{emptyState()}</td>
                  </tr>
                ) : (
                  items.map((d) => {
                    const to = docPath(d.kind, d.id);
                    const finished = FINISHED_DOC.includes(d.status);
                    return (
                      <tr key={d.id} className={cx(d.overdue && 'is-overdue', loading && 'is-stale')} onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(to)}>
                        <td className="td-nowrap td-muted num">{d.number}</td>
                        <td className="td-main">
                          <Link className="table__title" to={to}>
                            {d.title || 'Без названия'}
                          </Link>
                          <span className="table__sub">
                            {d.type.name} · {d.deal ? `сделка №${NBSP}${d.deal.id}${d.deal.title ? ` · ${d.deal.title}` : ''}` : d.kind === 'order' ? 'приказ' : 'без сделки'}
                          </span>
                        </td>
                        <td className="td-nowrap">
                          <DocStatusBadge kind={d.kind} status={d.status} label={d.statusLabel} />
                        </td>
                        <td className="td-nowrap hide-sm">
                          {d.initiator.fullName}
                          <span className="table__sub">{d.department?.name ?? '—'}</span>
                        </td>
                        <td className="td-nowrap">{finished ? <span className="due due--done">{d.statusLabel}</span> : <Due at={d.dueAt} />}</td>
                        <td className="td-nowrap td-muted hide-md">{dateShort(d.createdAt)}</td>
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
    </>
  );
}
