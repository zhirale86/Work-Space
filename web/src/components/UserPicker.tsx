import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api/client';
import { useDebounced } from '../api/hooks';
import type { Page, SystemRole, UserRef } from '../api/types';
import { Icon } from './Icon';
import { Avatar, cx } from './ui';

interface PickerProps {
  value: UserRef[];
  onChange: (users: UserRef[]) => void;
  /** Один сотрудник (исполнитель, утверждающий). */
  single?: boolean;
  /** Нумеровать метки и разрешить перестановку (порядок «по очереди»). */
  ordered?: boolean;
  excludeIds?: number[];
  excludeHint?: string;
  role?: SystemRole;
  placeholder?: string;
  inputId?: string;
  invalid?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

const PAGE = 8;

/** Выбор сотрудников: поиск по имени, должности и подразделению, метки выбранных. */
export function UserPicker({ value, onChange, single, ordered, excludeIds = [], excludeHint = 'Нельзя выбрать', role, placeholder = 'Начните вводить фамилию', inputId, invalid, disabled, ariaLabel }: PickerProps) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<UserRef[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const q = useDebounced(text, 250);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    api
      .get<Page<UserRef>>('/users', { q: q.trim() || undefined, role, pageSize: PAGE })
      .then((p) => {
        if (cancelled) return;
        setItems(p.items);
        setTotal(p.total);
        setActive(0);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q, open, role]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selectedIds = new Set(value.map((u) => u.id));
  const excluded = new Set(excludeIds);
  const selectable = (u: UserRef) => !selectedIds.has(u.id) && !excluded.has(u.id);

  const pick = (u: UserRef) => {
    if (!selectable(u)) return;
    onChange(single ? [u] : [...value, u]);
    setText('');
    if (single) setOpen(false);
    input.current?.focus();
  };

  const remove = (id: number) => onChange(value.filter((u) => u.id !== id));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return;
    const next = [...value];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChange(next);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && items[active]) {
        e.preventDefault();
        pick(items[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
    } else if (e.key === 'Backspace' && !text && value.length) {
      remove(value[value.length - 1].id);
    }
  };

  const showInput = !(single && value.length > 0);

  return (
    <div className="picker" ref={wrap}>
      <div className={cx('picker__control', invalid && 'is-invalid', disabled && 'is-disabled')} onClick={() => !disabled && input.current?.focus()}>
        {value.map((u, i) => (
          <span
            key={u.id}
            className={cx('chip', ordered && 'chip--draggable', dragIndex === i && 'is-dragging')}
            title={[u.position, u.department?.name].filter(Boolean).join(', ')}
            draggable={ordered && !disabled}
            onDragStart={() => setDragIndex(i)}
            onDragEnd={() => setDragIndex(null)}
            onDragOver={(e) => ordered && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) move(dragIndex, i);
              setDragIndex(null);
            }}
          >
            {ordered && <span className="chip__order">{i + 1}</span>}
            {u.fullName}
            {!u.active && <span className="chip__note">заблокирован</span>}
            {ordered && !disabled && value.length > 1 && (
              <span className="chip__moves">
                <button type="button" className="chip__remove" aria-label={`Раньше в очереди: ${u.fullName}`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <Icon name="chevron-left" />
                </button>
                <button type="button" className="chip__remove" aria-label={`Позже в очереди: ${u.fullName}`} disabled={i === value.length - 1} onClick={() => move(i, i + 1)}>
                  <Icon name="chevron-right" />
                </button>
              </span>
            )}
            {!disabled && (
              <button type="button" className="chip__remove" aria-label={`Убрать: ${u.fullName}`} onClick={() => remove(u.id)}>
                <Icon name="x" />
              </button>
            )}
          </span>
        ))}
        {showInput && !disabled && (
          <input
            ref={input}
            id={inputId}
            className="picker__input"
            type="text"
            value={text}
            placeholder={value.length ? 'Добавить ещё' : placeholder}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
          />
        )}
      </div>
      {open && showInput && !disabled && (
        <div className="picker__menu" role="listbox" id={listId}>
          {failed ? (
            <div className="picker__empty">Не удалось загрузить список сотрудников. Попробуйте ещё раз.</div>
          ) : loading && !items.length ? (
            <div className="picker__empty">Ищем…</div>
          ) : !items.length ? (
            <div className="picker__empty">Никого не найдено. Проверьте написание фамилии.</div>
          ) : (
            <>
              {items.map((u, i) => {
                const already = selectedIds.has(u.id);
                const blocked = excluded.has(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={already || blocked}
                    className={cx('picker__option', i === active && 'is-active', (already || blocked) && 'is-selected')}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(u)}
                  >
                    <Avatar name={u.fullName} />
                    <span className="picker__option-main">
                      <span className="picker__option-name">{u.fullName}</span>
                      <span className="picker__option-meta">{already ? 'Уже добавлен' : blocked ? excludeHint : [u.position, u.department?.name].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                );
              })}
              {total > items.length && (
                <div className="picker__empty">
                  Показаны {items.length} из {total}. Уточните запрос, если нужного сотрудника нет.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
