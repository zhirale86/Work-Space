import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { cx } from './ui';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  to?: string;
  danger?: boolean;
  /** Черта перед пунктом. */
  divider?: boolean;
  hidden?: boolean;
}

interface DropdownProps {
  /** Содержимое кнопки-триггера. */
  trigger: (props: { open: boolean; toggle: () => void; ref: React.RefObject<HTMLButtonElement> }) => ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  label?: string;
}

/** Выпадающее меню: Esc и щелчок вне закрывают, стрелки двигают фокус. */
export function Dropdown({ trigger, items, align = 'right', label }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const visible = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = Array.from(wrap.current?.querySelectorAll<HTMLButtonElement>('.menu__item') ?? []);
        const i = els.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
        els[next]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    wrap.current?.querySelector<HTMLButtonElement>('.menu__item')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!visible.length) return null;

  return (
    <div className="menu-wrap" ref={wrap}>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref: btn })}
      {open && (
        <div className={cx('menu', align === 'right' ? 'menu--right' : 'menu--left')} role="menu" aria-label={label}>
          {visible.map((it, i) => (
            <div key={i} role="none">
              {it.divider && i > 0 && <div className="menu__divider" role="separator" />}
              <button
                type="button"
                role="menuitem"
                className={cx('menu__item', it.danger && 'menu__item--danger')}
                onClick={() => {
                  setOpen(false);
                  if (it.to) navigate(it.to);
                  it.onSelect?.();
                }}
              >
                {it.icon && <Icon name={it.icon} />}
                {it.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Кнопка «…» с меню действий. */
export function MoreMenu({ items, label = 'Другие действия', small }: { items: MenuItem[]; label?: string; small?: boolean }) {
  return (
    <Dropdown
      items={items}
      label={label}
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className={cx('btn btn--secondary btn--icon', small && 'btn--sm')} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Icon name="more" />
        </button>
      )}
    />
  );
}
