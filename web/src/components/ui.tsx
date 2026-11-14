import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DocKind, DocStatus, TaskStatus, UserRef } from '../api/types';
import { due as dueInfo, initials } from '../lib/format';
import { DOC_BADGE, TASK_BADGE, statusLabel, TASK_STATUS_LABELS } from '../lib/status';
import { Icon, type IconName } from './Icon';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'lg';
  block?: boolean;
  icon?: IconName;
  iconAfter?: IconName;
  /** Кнопка в работе: текст меняется на `busyText`, повторное нажатие невозможно. */
  busy?: boolean;
  busyText?: string;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size, block, icon, iconAfter, busy, busyText, iconOnly, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', `btn--${variant}`, size && `btn--${size}`, block && 'btn--block', iconOnly && 'btn--icon', busy && 'is-busy', className)}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon && <Icon name={icon} />}
      {busy && busyText ? busyText : children}
      {iconAfter && <Icon name={iconAfter} />}
    </button>
  );
});

export function DocStatusBadge({ kind, status, label }: { kind: DocKind; status: DocStatus; label?: string }) {
  return <span className={cx('badge', DOC_BADGE[status])}>{label ?? statusLabel(kind, status)}</span>;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <span className={cx('badge', TASK_BADGE[status])}>{TASK_STATUS_LABELS[status]}</span>;
}

/** Срок: относительный текст, точная дата — в подсказке. */
export function Due({ at, completedAt, completedVerb, plain }: { at: string | null | undefined; completedAt?: string | null; completedVerb?: string; plain?: boolean }) {
  const d = dueInfo(at, completedAt, completedVerb);
  const cls = cx('due', d.tone === 'soon' && 'due--soon', d.tone === 'overdue' && 'due--overdue', d.tone === 'done' && 'due--done');
  return (
    <span className={cls} title={d.title}>
      {!plain && d.tone !== 'none' && d.tone !== 'done' && <Icon name="clock" />}
      {d.text}
    </span>
  );
}

/** Вторая метка «Просрочено на N дней» рядом со статусом. */
export function OverdueBadge({ at }: { at: string | null | undefined }) {
  const d = dueInfo(at);
  if (d.tone !== 'overdue') return null;
  return (
    <span className="badge badge--overdue" title={d.title}>
      {d.text}
    </span>
  );
}

export function Avatar({ name, size }: { name: string; size?: 'sm' | 'lg' }) {
  return (
    <span className={cx('avatar', size && `avatar--${size}`)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function userMeta(u: UserRef): string {
  return [u.position, u.department?.name].filter(Boolean).join(', ');
}

interface EmptyProps {
  icon?: IconName;
  title: string;
  text?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}

export function Empty({ icon = 'inbox', title, text, actions, compact }: EmptyProps) {
  return (
    <div className={cx('empty', compact && 'empty--compact')}>
      {!compact && (
        <span className="empty__icon">
          <Icon name={icon} />
        </span>
      )}
      <div className="empty__title">{title}</div>
      {text && <p className="empty__text">{text}</p>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  );
}

export function LoadError({ title = 'Не удалось загрузить список', onRetry, compact }: { title?: string; onRetry: () => void; compact?: boolean }) {
  return (
    <Empty
      icon="alert"
      compact={compact}
      title={title}
      text={compact ? undefined : 'Проверьте подключение к сети и попробуйте ещё раз.'}
      actions={
        <Button size="sm" icon="refresh" onClick={onRetry}>
          Повторить
        </Button>
      }
    />
  );
}

export function SkeletonRows({ n = 3 }: { n?: number }) {
  return (
    <div className="stack stack--sm skeleton-pad" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="skeleton skeleton--row" />
      ))}
    </div>
  );
}

export function SkeletonTiles({ n }: { n: number }) {
  return (
    <div className="stats" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="skeleton skeleton--tile" />
      ))}
    </div>
  );
}

export function Loading({ children }: { children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">Загрузка…</span>
      {children}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, actions, icon }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; actions?: ReactNode; icon?: IconName }) {
  const ic: IconName = icon ?? (tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert');
  return (
    <div className={cx('alert', `alert--${tone}`)} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={ic} />
      <div className="alert__body">
        {title && <div className="alert__title">{title}</div>}
        {children}
      </div>
      {actions && <div className="alert__actions">{actions}</div>}
    </div>
  );
}

interface PageHeaderProps {
  title: ReactNode;
  badges?: ReactNode;
  lead?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  crumbs?: { to?: string; label: string }[];
}

export function PageHeader({ title, badges, lead, meta, actions, crumbs }: PageHeaderProps) {
  return (
    <>
      {crumbs && (
        <nav className="breadcrumbs" aria-label="Путь">
          {crumbs.map((c, i) => (
            <span key={i} className="row row--sm row--nowrap">
              {i > 0 && <span className="breadcrumbs__sep">/</span>}
              {c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="page__header">
        <div className="page__heading">
          <div className="page__title-row">
            <h1 className="page__title">{title}</h1>
            {badges}
          </div>
          {lead && <p className="page__lead">{lead}</p>}
          {meta && <div className="page__meta">{meta}</div>}
        </div>
        {actions && <div className="page__actions">{actions}</div>}
      </div>
    </>
  );
}

export function Card({ title, count, actions, children, flush, compact, className, id }: { title?: ReactNode; count?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; compact?: boolean; className?: string; id?: string }) {
  return (
    <section className={cx('card', compact && 'card--compact', className)} id={id}>
      {title && (
        <header className="card__header">
          <h2 className="card__title">
            {title}
            {count !== undefined && count !== null && <span className="card__count">{count}</span>}
          </h2>
          {actions}
        </header>
      )}
      <div className={cx('card__body', flush && 'card__body--flush')}>{children}</div>
    </section>
  );
}

/** Метка-«чип» с сотрудником (только для чтения). */
export function PersonChips({ users }: { users: UserRef[] }) {
  if (!users.length) return <span className="text-muted">—</span>;
  return (
    <span className="row row--sm">
      {users.map((u) => (
        <span key={u.id} className="chip chip--static" title={userMeta(u)}>
          {u.fullName}
        </span>
      ))}
    </span>
  );
}

export function Field({ label, required, optional, hint, error, children, className, htmlFor }: { label: ReactNode; required?: boolean; optional?: boolean | string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cx('field', error && 'field--error', className)}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="field__required" title="Обязательное поле">
            *
          </span>
        )}
        {optional && <span className="field__optional">{typeof optional === 'string' ? optional : '— необязательно'}</span>}
      </label>
      {children}
      {error ? (
        <span className="field__error" role="alert">
          <Icon name="alert" />
          {error}
        </span>
      ) : (
        hint && <span className="field__hint">{hint}</span>
      )}
    </div>
  );
}
