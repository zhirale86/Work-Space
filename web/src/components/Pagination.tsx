import { Icon } from './Icon';
import { cx } from './ui';

interface Props {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize?: (s: number) => void;
  sizes?: number[];
}

function pages(current: number, last: number): (number | 'gap')[] {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const set = new Set([1, 2, last - 1, last, current - 1, current, current + 1].filter((p) => p >= 1 && p <= last));
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
}

export function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [10, 25, 50] }: Props) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pagination">
      <span className="pagination__info">
        {from}–{to} из {total}
      </span>
      {last > 1 && (
        <div className="pagination__pages">
          <button className="page-btn" type="button" disabled={page <= 1} aria-label="Предыдущая страница" onClick={() => onPage(page - 1)}>
            <Icon name="chevron-left" />
          </button>
          {pages(page, last).map((p, i) =>
            p === 'gap' ? (
              <span key={`g${i}`} className="pagination__gap">
                …
              </span>
            ) : (
              <button key={p} className={cx('page-btn', p === page && 'is-current')} type="button" aria-current={p === page ? 'page' : undefined} onClick={() => onPage(p)}>
                {p}
              </button>
            ),
          )}
          <button className="page-btn" type="button" disabled={page >= last} aria-label="Следующая страница" onClick={() => onPage(page + 1)}>
            <Icon name="chevron-right" />
          </button>
        </div>
      )}
      {onPageSize && (
        <label className="pagination__size">
          На странице
          <select className="select select--sm pagination__select" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
