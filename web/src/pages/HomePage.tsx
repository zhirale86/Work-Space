import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, useDelayed, useDocumentTitle } from '../api/hooks';
import type { DashboardResponse, DocumentListItem, Page, TaskListItem } from '../api/types';
import { Icon } from '../components/Icon';
import { Dropdown } from '../components/Menu';
import { DocStatusBadge, Due, Empty, LoadError, Loading, PageHeader, SkeletonRows, SkeletonTiles, TaskStatusBadge, cx } from '../components/ui';
import { count, date, due, NBSP } from '../lib/format';
import { docEditPath, docPath } from '../lib/status';
import { TaskCreateModal } from './tasks/TaskCreateModal';

type Row = { key: string; due: string | null; overdue: boolean; node: ReactNode };

function byDue(a: Row, b: Row): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (!a.due && !b.due) return 0;
  if (!a.due) return 1;
  if (!b.due) return -1;
  return new Date(a.due).getTime() - new Date(b.due).getTime();
}

const ACTIONS = ['Согласование GPM-калькулятора', 'Другое согласование', 'Приказ', 'Поручение'] as const;

export function CreateMenu({ onTask }: { onTask: () => void }) {
  return (
    <Dropdown
      label="Создать"
      items={[
        { label: ACTIONS[0], icon: 'approve', to: '/approvals/new?type=GPM' },
        { label: ACTIONS[1], icon: 'file', to: '/approvals/new?type=APPROVAL' },
        { label: ACTIONS[2], icon: 'order', to: '/orders/new' },
        { label: ACTIONS[3], icon: 'task', onSelect: onTask },
      ]}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className="btn btn--primary" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Icon name="plus" />
          Создать
          <Icon name="chevron-down" />
        </button>
      )}
    />
  );
}

function DocRow({ d, action, actionTo }: { d: DocumentListItem; action: string; actionTo?: string }) {
  const to = docPath(d.kind, d.id);
  return (
    <li className="todo__item">
      <div className="todo__main">
        <Link className="todo__title" to={to}>
          {d.title || d.number}
        </Link>
        <div className="todo__meta">
          <span className="num">{d.number}</span>
          <span>{d.type.name}</span>
          <span>
            {d.initiator.fullName}
            {d.department ? `, ${d.department.name}` : ''}
          </span>
        </div>
      </div>
      <div className="todo__due">
        <Due at={d.dueAt} />
      </div>
      <div className="todo__action">
        <Link className="btn btn--secondary btn--sm" to={actionTo ?? to}>
          {action}
        </Link>
      </div>
    </li>
  );
}

function TaskRow({ t, review }: { t: TaskListItem; review?: boolean }) {
  return (
    <li className="todo__item">
      <div className="todo__main">
        <Link className="todo__title" to={`/tasks/${t.id}`}>
          {t.title}
        </Link>
        <div className="todo__meta">
          <span>
            <TaskStatusBadge status={t.status} />
          </span>
          <span className="num">{t.number}</span>
          <span>{review ? `ждёт вашей проверки — ${t.assignee.fullName}` : t.document ? `по документу ${t.document.number}` : `постановщик — ${t.author.fullName}`}</span>
        </div>
      </div>
      <div className="todo__due">
        <Due at={t.dueAt} />
      </div>
      <div className="todo__action">
        <Link className="btn btn--secondary btn--sm" to={`/tasks/${t.id}`}>
          Открыть
        </Link>
      </div>
    </li>
  );
}

function Block({ id, title, total, link, rows, empty, compact }: { id: string; title: string; total: number; link?: { to: string; label: string }; rows: Row[]; empty: string; compact?: boolean }) {
  return (
    <section className="card" aria-labelledby={`h-${id}`} id={id} tabIndex={-1}>
      <header className="card__header">
        <h2 className="card__title" id={`h-${id}`}>
          {title} {total > 0 && <span className="card__count">{total}</span>}
        </h2>
        {link && total > 0 && (
          <Link className="btn btn--ghost btn--sm" to={link.to}>
            {link.label}
          </Link>
        )}
      </header>
      {rows.length ? (
        <ul className={cx('todo', compact && 'todo--compact')}>{[...rows].sort(byDue).slice(0, 5).map((r) => r.node)}</ul>
      ) : (
        <Empty compact title={empty} />
      )}
    </section>
  );
}

function nearestHint(items: { dueAt: string | null; overdue: boolean }[], fallback: string): string {
  const overdue = items.filter((i) => i.overdue).length;
  if (overdue) return `${overdue}${NBSP}просрочено`;
  const next = items.map((i) => i.dueAt).filter((x): x is string => !!x).sort()[0];
  if (!next) return fallback;
  const d = due(next);
  return `ближайший срок — ${d.tone === 'soon' ? d.text.toLowerCase() : date(next)}`;
}

function scrollTo(id: string) {
  const el = document.getElementById(id);
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el?.focus({ preventScroll: true });
}

export function HomePage() {
  useDocumentTitle('Мои действия');
  const dash = useApi<DashboardResponse>('/dashboard');
  const mine = useApi<Page<DocumentListItem>>('/documents', { scope: 'mine', status: 'draft,in_review,rework,on_signing', pageSize: 5 });
  const skeleton = useDelayed(dash.loading && !dash.data);
  const [taskOpen, setTaskOpen] = useState(false);
  const navigate = useNavigate();
  const d = dash.data;

  const header = (lead?: string) => <PageHeader title="Мои действия" lead={lead} actions={<CreateMenu onTask={() => setTaskOpen(true)} />} />;
  // Ключ сохраняет открытое окно (и введённые данные), когда главная дозагружается и меняет разметку.
  const modal = taskOpen && <TaskCreateModal key="task-create" onClose={() => setTaskOpen(false)} onCreated={(t) => navigate(`/tasks/${t.id}`)} />;

  if (dash.error) {
    return (
      <>
        {header()}
        <div className="card">
          <LoadError title="Не удалось загрузить" onRetry={() => dash.reload()} />
        </div>
        {modal}
      </>
    );
  }
  if (!d) {
    return (
      <>
        {header()}
        <Loading>
          {skeleton && (
            <>
              <SkeletonTiles n={5} />
              <div className="layout-home section">
                <div className="stack stack--lg">
                  <div className="card">
                    <SkeletonRows />
                  </div>
                  <div className="card">
                    <SkeletonRows />
                  </div>
                </div>
                <div className="stack stack--lg">
                  <div className="card">
                    <SkeletonRows />
                  </div>
                  <div className="card">
                    <SkeletonRows />
                  </div>
                </div>
              </div>
            </>
          )}
        </Loading>
        {modal}
      </>
    );
  }

  const decide = d.toApprove.count + d.toSign.count;
  const tasks = d.myTasks.count + d.tasksToReview.count;
  const total = decide + d.rework.count + tasks + d.toAcknowledge.count;
  const lead = total
    ? `Сегодня от вас ждут ${count(total, ['действие', 'действия', 'действий'])}${d.overdue.count ? `, ${d.overdue.count} из них ${d.overdue.count === 1 ? 'просрочено' : 'просрочены'}` : ''}.`
    : 'От вас сейчас ничего не ждут.';
  const myDocs = mine.data?.items ?? [];

  if (!total && mine.data && !myDocs.length) {
    return (
      <>
        {header(lead)}
        <div className="card">
          <Empty
            icon="check"
            title="От вас ничего не ждут"
            text="Новые согласования, поручения и приказы появятся здесь и в уведомлениях."
            actions={
              <Link className="btn btn--secondary" to="/approvals/new?type=GPM">
                Создать согласование
              </Link>
            }
          />
        </div>
        {modal}
      </>
    );
  }

  const decideItems = [...d.toApprove.items, ...d.toSign.items];
  const decideRows: Row[] = [
    ...d.toApprove.items.map((x) => ({ key: `a${x.id}`, due: x.dueAt, overdue: x.overdue, node: <DocRow key={`a${x.id}`} d={x} action="Рассмотреть" /> })),
    ...d.toSign.items.map((x) => ({ key: `s${x.id}`, due: x.dueAt, overdue: x.overdue, node: <DocRow key={`s${x.id}`} d={x} action="Утвердить" /> })),
  ];
  const taskRows: Row[] = [
    ...d.myTasks.items.map((t) => ({ key: `t${t.id}`, due: t.dueAt, overdue: t.overdue, node: <TaskRow key={`t${t.id}`} t={t} /> })),
    ...d.tasksToReview.items.map((t) => ({ key: `r${t.id}`, due: t.dueAt, overdue: t.overdue, node: <TaskRow key={`r${t.id}`} t={t} review /> })),
  ];
  const reworkRows: Row[] = d.rework.items.map((x) => ({ key: `w${x.id}`, due: x.dueAt, overdue: x.overdue, node: <DocRow key={`w${x.id}`} d={x} action="Доработать" actionTo={docEditPath(x.kind, x.id)} /> }));
  const ackRows: Row[] = d.toAcknowledge.items.map((x) => ({ key: `k${x.id}`, due: x.dueAt, overdue: x.overdue, node: <DocRow key={`k${x.id}`} d={x} action="Ознакомиться" /> }));
  const mineRows: Row[] = myDocs.map((x) => ({
    key: `m${x.id}`,
    due: x.dueAt,
    overdue: x.overdue,
    node: (
      <li key={`m${x.id}`} className="todo__item">
        <div className="todo__main">
          <Link className="todo__title" to={docPath(x.kind, x.id)}>
            {x.title || x.number}
          </Link>
          <div className="todo__meta">
            <span className="num">{x.number}</span>
            <span>{x.status === 'draft' ? 'не запущено' : x.type.name}</span>
          </div>
        </div>
        <div className="todo__action">
          <DocStatusBadge kind={x.kind} status={x.status} label={x.statusLabel} />
        </div>
      </li>
    ),
  }));

  const tile = (value: number, label: string, hint: string, onClick: () => void, accent = false) => (
    <button type="button" className={cx('stat', value === 0 ? 'stat--zero' : accent && 'stat--accent')} onClick={onClick}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
      <span className="stat__hint">{hint}</span>
    </button>
  );

  return (
    <>
      {header(lead)}
      <div className="stats">
        {tile(decide, 'Ждут моего решения', nearestHint(decideItems, decide ? 'без срока' : 'нет ожидающих'), () => scrollTo('b-decide'))}
        {tile(d.rework.count, 'На доработке у меня', d.rework.count ? 'запустите повторно после правок' : 'нет возвращённых', () => scrollTo('b-rework'))}
        {tile(tasks, 'Поручения мне', nearestHint([...d.myTasks.items, ...d.tasksToReview.items], tasks ? 'без срока' : 'нет поручений'), () => scrollTo('b-tasks'))}
        {tile(d.toAcknowledge.count, 'Приказы на ознакомление', nearestHint(d.toAcknowledge.items, d.toAcknowledge.count ? 'без срока' : 'все прочитаны'), () => scrollTo('b-ack'))}
        {tile(d.overdue.count, 'Просрочено', d.overdue.count ? 'требуют действия сегодня' : 'всё в срок', () => navigate('/documents?overdue=1'), true)}
      </div>
      <div className="layout-home section">
        <div className="stack stack--lg">
          <Block id="b-decide" title="Ждут моего решения" total={decide} link={{ to: '/approvals?scope=to_approve', label: 'Все согласования' }} rows={decideRows} empty="Нет согласований, ожидающих вашего решения" />
          <Block id="b-tasks" title="Поручения мне" total={tasks} link={{ to: '/tasks?scope=assigned', label: 'Все поручения' }} rows={taskRows} empty="Нет поручений в работе" />
        </div>
        <div className="stack stack--lg">
          <Block id="b-rework" title="На доработке у меня" total={d.rework.count} rows={reworkRows} empty="Нет документов на доработке" compact />
          <Block id="b-ack" title="Приказы на ознакомление" total={d.toAcknowledge.count} link={{ to: '/orders?scope=to_acknowledge', label: 'Все приказы' }} rows={ackRows} empty="Все приказы прочитаны" compact />
          {mine.error ? (
            <section className="card">
              <header className="card__header">
                <h2 className="card__title">Мои документы в работе</h2>
              </header>
              <LoadError compact title="Не удалось загрузить" onRetry={() => mine.reload()} />
            </section>
          ) : (
            <Block id="b-mine" title="Мои документы в работе" total={mine.data?.total ?? 0} link={{ to: '/documents?scope=mine', label: 'Все мои' }} rows={mineRows} empty="У вас нет документов в работе" compact />
          )}
        </div>
      </div>
      {modal}
    </>
  );
}

