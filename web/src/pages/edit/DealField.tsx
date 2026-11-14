import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { useDebounced } from '../../api/hooks';
import type { Deal, DealsResponse } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Alert, Button, cx } from '../../components/ui';
import { money, NBSP } from '../../lib/format';

interface Props {
  value: Deal | null;
  onChange: (d: Deal | null) => void;
  locked?: boolean;
  required?: boolean;
  invalid?: boolean;
  inputId: string;
}

/** Номер сделки из ссылки Битрикс24 или из чисел: «…/crm/deal/details/48215/» → 48215. */
function dealIdFrom(text: string): string | null {
  const t = text.trim();
  if (/^\d{1,12}$/.test(t)) return t;
  const m = /deals?\/(?:details\/)?(\d{1,12})/i.exec(t) ?? (/^https?:\/\//i.test(t) ? /(\d{1,12})\/?(?:[?#].*)?$/.exec(t) : null);
  return m ? m[1] : null;
}

/** Поиск и выбор сделки Битрикс24 (раздел 4.4, п. 1). */
export function DealField({ value, onChange, locked, invalid, inputId }: Props) {
  const [editing, setEditing] = useState(!value);
  const [text, setText] = useState('');
  const [items, setItems] = useState<Deal[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [down, setDown] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0);
  const q = useDebounced(text, 300);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => setEditing(!value), [value]);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    const id = dealIdFrom(q);
    setLoading(true);
    setNotFound(false);
    setDown(false);
    const req = id && /\D/.test(q.trim())
      ? api.get<Deal>(`/bitrix/deals/${id}`).then((d) => [d])
      : api.get<DealsResponse>('/bitrix/deals', { q: q.trim() || undefined }).then((r) => r.items);
    req
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setActive(0);
        if (!list.length && q.trim()) setNotFound(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setItems([]);
        if (e instanceof ApiError && e.code === 'bitrix_unavailable') setDown(true);
        else if (e instanceof ApiError && (e.status === 404 || e.status === 400)) setNotFound(true);
        else setDown(true);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q, editing, tick]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (d: Deal) => {
    onChange(d);
    setText('');
    setOpen(false);
  };

  if (value && !editing) {
    return (
      <div className="deal-plate">
        <div className="deal-plate__main">
          <div className="deal__title">{value.title}</div>
          <div className="deal__id">
            Сделка №{NBSP}{value.id}
            {value.company ? ` · ${value.company}` : ''}
          </div>
          <a className="link text-sm" href={value.url} target="_blank" rel="noreferrer">
            Открыть в Битрикс24
          </a>
        </div>
        {!locked && (
          <Button size="sm" onClick={() => setEditing(true)}>
            Изменить
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="stack stack--sm">
      <div className="picker" ref={wrap}>
        <span className="input-group">
          <Icon name="link" />
          <input
            id={inputId}
            className={cx('input', invalid && 'is-invalid')}
            type="text"
            autoComplete="off"
            placeholder="Название или номер сделки, ссылка на сделку"
            value={text}
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || notFound}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              const list = items ?? [];
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, list.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && list[active]) {
                e.preventDefault();
                pick(list[active]);
              } else if (e.key === 'Escape' && open) {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          />
        </span>
        {open && !down && !notFound && (
          <div className="picker__menu" role="listbox">
            {loading && !items?.length ? (
              <div className="picker__empty">Ищем сделки…</div>
            ) : !items?.length ? (
              <div className="picker__empty">Начните вводить название или номер сделки.</div>
            ) : (
              items.map((d, i) => (
                <button key={d.id} type="button" role="option" aria-selected={i === active} className={cx('picker__option', i === active && 'is-active', value?.id === d.id && 'is-selected')} onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(d)}>
                  <span className="picker__option-main">
                    <span className="picker__option-name">{d.title}</span>
                    <span className="picker__option-meta">
                      Сделка №{NBSP}{d.id}
                      {d.company ? ` · ${d.company}` : ''}
                      {d.stage ? ` · ${d.stage}` : ''}
                      {d.amount ? ` · ${money(d.amount)}` : ''}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {notFound && (
        <span className="field__error" role="alert">
          <Icon name="alert" />
          Сделка не найдена. Проверьте ссылку или найдите сделку по названию.
        </span>
      )}
      {down && (
        <Alert
          tone="warning"
          actions={
            <Button size="sm" icon="refresh" onClick={() => setTick((t) => t + 1)}>
              Повторить
            </Button>
          }
        >
          Битрикс24 не отвечает — список сделок недоступен. Сохраните черновик и повторите позже.
        </Alert>
      )}
      {value && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Оставить «{value.title}»
          </Button>
        </div>
      )}
    </div>
  );
}
