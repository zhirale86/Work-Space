import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ApprovalRound, ApprovalStep, Comment, DocumentDetail, HistoryEntry, UserRef } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Alert, Button, Due, PersonChips, cx, userMeta } from '../../components/ui';
import { count, date, dateTime, dateTimeFull, DAYS, NBSP } from '../../lib/format';
import { STEP_BADGE, STEP_CLASS, SYNC_BADGE, statusLabel } from '../../lib/status';

const mainVersionOf = (r: ApprovalRound) => r.files.find((f) => f.role === 'main')?.version.versionNo ?? null;

function daysSince(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
  return d < 1 ? 'меньше суток' : count(d, DAYS);
}

function stepMeta(s: ApprovalStep, r: ApprovalRound, steps: ApprovalStep[], meId: number): string {
  const who = [s.user.position, s.user.department?.name].filter(Boolean).join(', ');
  const v = mainVersionOf(r);
  const parts = [who];
  if (s.state === 'pending') {
    parts.push(s.activatedAt ? `ожидает решения с ${dateTime(s.activatedAt)} (${daysSince(s.activatedAt)})` : 'ожидает решения');
  } else if (s.state === 'waiting') {
    const prev = steps.filter((x) => x.position < s.position && x.state !== 'replaced').pop();
    parts.push(prev?.user.id === meId && prev.state === 'pending' ? 'получит документ после вашего решения' : 'в очереди');
  } else if (s.state === 'skipped') {
    parts.push('процесс завершился раньше');
  } else if (s.state === 'replaced') {
    parts.push(s.decidedAt ? `заменён ${date(s.decidedAt)}` : 'заменён');
  } else if (s.decidedAt) {
    parts.push(dateTime(s.decidedAt));
    if (v) parts.push(`по версии ${v}`);
  }
  return parts.filter(Boolean).join(' · ');
}

function StepComment({ s }: { s: ApprovalStep }) {
  if (!s.comment) return null;
  return (
    <div className="route__comment">
      <span className="route__comment-label">{s.state === 'rework' || s.state === 'rejected' ? 'Замечание' : 'Комментарий'}</span>
      {s.comment}
    </div>
  );
}

function BlockedNote({ s, onReplace }: { s: ApprovalStep; onReplace?: (u: UserRef) => void }) {
  if (s.user.active || !['pending', 'waiting'].includes(s.state)) return null;
  return (
    <div className="route__alert">
      <Alert
        tone="warning"
        actions={
          onReplace && (
            <Button size="sm" onClick={() => onReplace(s.user)}>
              Заменить
            </Button>
          )
        }
      >
        Учётная запись заблокирована. Замените согласующего.
      </Alert>
    </div>
  );
}

interface RouteProps {
  doc: DocumentDetail;
  meId: number;
  onReplace?: (u: UserRef) => void;
}

/** Маршрут: шаги текущего или выбранного запуска (раздел 4.5, п. 3). */
export function RouteCard({ doc, meId, onReplace }: RouteProps) {
  const [roundId, setRoundId] = useState<number | null>(null);
  const rounds = doc.rounds;
  const round = rounds.find((r) => r.id === roundId) ?? rounds[0] ?? null;

  if (!round) {
    if (!doc.approvers.length) return null;
    return (
      <section className="card">
        <header className="card__header">
          <h2 className="card__title">
            Маршрут <span className="card__count">{doc.routeMode === 'parallel' ? 'одновременно' : 'по очереди'} · не запущен</span>
          </h2>
        </header>
        <div className="card__body">
          <ol className="route">
            {doc.approvers.map((u, i) => (
              <li key={u.id} className="route__step route__step--waiting">
                <span className="route__marker">{i + 1}</span>
                <div className="route__body">
                  <div className="route__head">
                    <span className="route__name">
                      {u.fullName}
                      {u.id === meId ? ' — это вы' : ''}
                    </span>
                  </div>
                  <div className="route__meta">{userMeta(u)} · получит документ после запуска</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    );
  }

  const steps = [...round.steps].sort((a, b) => a.position - b.position || a.id - b.id);
  const live = steps.filter((s) => s.state !== 'replaced');
  const done = live.filter((s) => s.state === 'approved').length;
  const modeText = round.mode === 'parallel' ? 'одновременно' : 'по очереди';

  const renderStep = (s: ApprovalStep, i: number, member: boolean) => {
    const badge = STEP_BADGE[s.state];
    const marker = s.state === 'approved' ? <Icon name="check" /> : s.state === 'rework' ? <Icon name="return" /> : s.state === 'rejected' ? <Icon name="x" /> : member ? null : i + 1;
    const name = (
      <span className="route__name">
        {s.user.fullName}
        {s.user.id === meId ? ' — это вы' : ''}
      </span>
    );
    if (member) {
      return (
        <div key={s.id} className={cx('route__member', STEP_CLASS[s.state])}>
          <span className="route__marker">{marker}</span>
          <div className="route__body">
            <div className="route__name">{name}</div>
            <div className="route__meta">{stepMeta(s, round, steps, meId)}</div>
            <StepComment s={s} />
            <BlockedNote s={s} onReplace={onReplace} />
          </div>
          {badge && <span className={cx('badge', badge.cls)}>{badge.text}</span>}
        </div>
      );
    }
    return (
      <li key={s.id} className={cx('route__step', STEP_CLASS[s.state])}>
        <span className="route__marker">{marker}</span>
        <div className="route__body">
          <div className="route__head">
            {name}
            {badge && <span className={cx('badge', badge.cls)}>{badge.text}</span>}
          </div>
          <div className="route__meta">{stepMeta(s, round, steps, meId)}</div>
          <StepComment s={s} />
          <BlockedNote s={s} onReplace={onReplace} />
        </div>
      </li>
    );
  };

  return (
    <section className="card" aria-labelledby="c-route">
      <header className="card__header">
        <h2 className="card__title" id="c-route">
          Маршрут{' '}
          <span className="card__count">
            {modeText} · {done} из {live.length}
          </span>
        </h2>
        {rounds.length > 1 && (
          <div className="segmented" role="tablist" aria-label="Запуск согласования">
            {rounds.map((r, i) => (
              <button key={r.id} type="button" role="tab" aria-selected={r.id === round.id} className={cx('segmented__item', r.id === round.id && 'is-active')} onClick={() => setRoundId(r.id)}>
                Запуск{NBSP}{r.roundNo}
                {i === 0 && !r.finishedAt ? ' · текущий' : ''}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="card__body">
        {round.mode === 'parallel' ? (
          <ol className="route">
            <li className="route__group">
              <span className="route__marker">
                <Icon name="parallel" />
              </span>
              <div className="route__group-box">
                <div className="route__group-title">
                  <span>Согласуют одновременно — нужны решения всех</span>
                  <span className="num">
                    {done} из {live.length}
                  </span>
                </div>
                {steps.map((s, i) => renderStep(s, i, true))}
              </div>
            </li>
          </ol>
        ) : (
          <ol className="route">{steps.map((s, i) => renderStep(s, i, false))}</ol>
        )}
      </div>
    </section>
  );
}

// ───────────────────── История ─────────────────────

type Tone = 'success' | 'attention' | 'danger' | 'system' | '';

function toneOf(e: HistoryEntry): Tone {
  if (!e.actor) return e.action === 'bitrix.error' ? 'system' : 'system';
  if (/approved$|completed$|signed$|accepted$|acknowledged$/.test(e.action)) return 'success';
  if (/returned$/.test(e.action)) return 'attention';
  if (/rejected$|cancelled$/.test(e.action)) return 'danger';
  return '';
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

interface HistoryProps {
  entries: HistoryEntry[];
  comments: Comment[];
  rounds: ApprovalRound[];
  /** Группировать по запускам (согласование, приказ). */
  byRound?: boolean;
  footer?: ReactNode;
  title?: string;
}

export function HistoryCard({ entries, comments, rounds, byRound = true, footer, title = 'История' }: HistoryProps) {
  const [system, setSystem] = useState(true);
  const [limit, setLimit] = useState(8);

  const grouped = useMemo(() => {
    // Номер запуска: из details.roundNo; после возврата на доработку — следующий запуск.
    const asc = [...entries].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime() || a.id - b.id);
    let cur = 1;
    const withRound = asc.map((e) => {
      const rn = typeof e.details?.roundNo === 'number' ? (e.details.roundNo as number) : null;
      if (rn) cur = rn;
      const r = cur;
      if (/returned$/.test(e.action)) cur += 1;
      return { e, round: r };
    });
    return withRound.reverse();
  }, [entries]);

  const visible = grouped.filter((g) => system || g.e.actor);
  const shown = visible.slice(0, limit);
  const showRounds = byRound && rounds.length > 1;
  const commentText = (e: HistoryEntry): string | null => {
    const d = e.details ?? {};
    if (typeof d.commentId === 'number') return comments.find((c) => c.id === d.commentId)?.body ?? null;
    if (typeof d.comment === 'string' && d.comment) return d.comment;
    if (typeof d.reason === 'string' && d.reason) return d.reason;
    if (typeof d.resultText === 'string' && d.resultText) return d.resultText;
    return null;
  };

  const blocks: { round: number; items: typeof shown }[] = [];
  for (const g of shown) {
    const last = blocks[blocks.length - 1];
    if (showRounds && last && last.round === g.round) last.items.push(g);
    else if (!showRounds && last) last.items.push(g);
    else blocks.push({ round: g.round, items: [g] });
  }

  return (
    <section className="card" aria-labelledby="c-hist">
      <header className="card__header">
        <h2 className="card__title" id="c-hist">
          {title} <span className="card__count">{visible.length}</span>
        </h2>
        <label className="checkbox text-sm">
          <input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} />
          <span>Показывать системные записи</span>
        </label>
      </header>
      <div className="card__body">
        {!shown.length ? (
          <p className="text-muted">Записей пока нет.</p>
        ) : (
          blocks.map((b, bi) => {
            const r = rounds.find((x) => x.roundNo === b.round);
            const v = r ? mainVersionOf(r) : null;
            return (
              <div key={bi} className={cx(bi > 0 && 'timeline-block')}>
                {showRounds && (
                  <div className="timeline__divider">
                    Запуск{NBSP}{b.round}
                    {v ? ` · версия${NBSP}${v}` : r ? '' : ' · подготовка'}
                  </div>
                )}
                <ol className="timeline">
                  {b.items.map(({ e }) => {
                    const tone = toneOf(e);
                    const text = commentText(e);
                    return (
                      <li key={e.id} className={cx('timeline__item', tone && `timeline__item--${tone}`)}>
                        <span className="timeline__dot" />
                        <div>
                          <div className="timeline__head">
                            <span className="timeline__text">
                              {e.actor ? (
                                <>
                                  <span className="timeline__actor">{e.actorName}</span> — {lowerFirst(e.summary)}
                                </>
                              ) : (
                                e.summary
                              )}
                            </span>
                            <time className="timeline__time" dateTime={e.at} title={dateTimeFull(e.at)}>
                              {dateTime(e.at)}
                            </time>
                          </div>
                          {text && <div className="timeline__comment">{text}</div>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            );
          })
        )}
        {visible.length > limit && (
          <div className="timeline-more">
            <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + 20)}>
              Показать ещё {count(Math.min(20, visible.length - limit), ['запись', 'записи', 'записей'])}
            </Button>
          </div>
        )}
        {footer && (
          <>
            <hr className="divider timeline-sep" />
            {footer}
          </>
        )}
      </div>
    </section>
  );
}

// ───────────────────── Сделка и синхронизация ─────────────────────

export function DealCard({ doc, onRetry, retrying }: { doc: DocumentDetail; onRetry?: () => void; retrying?: boolean }) {
  const b = doc.bitrix;
  const editable = doc.permissions.canEdit && !doc.dealLocked;
  return (
    <section className="card card--compact" aria-labelledby="c-deal">
      <header className="card__header">
        <h2 className="card__title" id="c-deal">
          Сделка Битрикс24
        </h2>
      </header>
      <div className="card__body stack">
        {!doc.deal ? (
          <>
            <p className="text-muted">Согласование не связано со сделкой.</p>
            {editable && (
              <Link className="btn btn--secondary btn--block" to={`/approvals/${doc.id}/edit`}>
                Привязать сделку
              </Link>
            )}
          </>
        ) : (
          <>
            <div>
              <div className="deal__title">{doc.deal.title ?? 'Сделка'}</div>
              <div className="deal__id">Сделка №{NBSP}{doc.deal.id}</div>
            </div>
            <a className="btn btn--secondary btn--block" href={doc.deal.url} target="_blank" rel="noreferrer">
              Открыть сделку в Битрикс24
              <Icon name="external" />
            </a>
            <hr className="divider" />
            {!b ? (
              <p className="text-sm text-muted">Запись в сделке появится после запуска согласования.</p>
            ) : (
              <>
                <div className="sync">
                  <span className={cx('badge', SYNC_BADGE[b.state].cls)}>{SYNC_BADGE[b.state].text}</span>
                  {b.state === 'synced' && b.lastAttemptAt && <span className="sync__meta">{dateTime(b.lastAttemptAt)}</span>}
                </div>
                {b.state === 'synced' && (
                  <p className="text-sm text-muted">
                    В сделке согласование видно среди задач со статусом «{b.syncedStatusLabel ?? doc.statusLabel}».
                  </p>
                )}
                {b.state === 'pending' && <p className="text-sm text-muted">Передаём статус в Битрикс24…</p>}
                {b.state === 'error' && (
                  <>
                    <p className="text-sm text-muted">
                      {b.lastAttemptAt ? `Последняя попытка: ${dateTime(b.lastAttemptAt)}. ` : ''}
                      {b.syncedStatus && b.syncedStatus !== doc.status
                        ? `Статус в сделке устарел: там «${statusLabel(doc.kind, b.syncedStatus)}», сейчас — «${doc.statusLabel}».`
                        : 'Запись в сделке может быть устаревшей.'}
                    </p>
                    {onRetry && (
                      <Button size="sm" icon="refresh" busy={retrying} busyText="Передаём…" onClick={onRetry}>
                        Повторить передачу
                      </Button>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function InfoCard({ doc }: { doc: DocumentDetail }) {
  const order = doc.kind === 'order';
  return (
    <section className="card card--compact" aria-labelledby="c-info">
      <header className="card__header">
        <h2 className="card__title" id="c-info">
          Сведения
        </h2>
      </header>
      <div className="card__body">
        <dl className="dl">
          <dt className="dl__term">Срок</dt>
          <dd className="dl__value">{doc.dueAt ? <span className={cx('due', doc.overdue && 'due--overdue')} title={dateTimeFull(doc.dueAt)}>{dateTimeFull(doc.dueAt)}</span> : <Due at={null} />}</dd>
          {order && (
            <>
              <dt className="dl__term">Утверждающий</dt>
              <dd className="dl__value">{doc.signer ? doc.signer.fullName : '—'}</dd>
              <dt className="dl__term">Дата приказа</dt>
              <dd className="dl__value">{doc.orderDate ? date(doc.orderDate + 'T00:00:00', true) : 'при утверждении'}</dd>
            </>
          )}
          <dt className="dl__term">Порядок</dt>
          <dd className="dl__value">{doc.approvers.length || doc.rounds.length ? (doc.routeMode === 'parallel' ? 'Одновременно' : 'По очереди') : 'Без согласующих'}</dd>
          <dt className="dl__term">Инициатор</dt>
          <dd className="dl__value">{doc.initiator.fullName}</dd>
          <dt className="dl__term">Подразделение</dt>
          <dd className="dl__value">{doc.department?.name ?? '—'}</dd>
          <dt className="dl__term">Создано</dt>
          <dd className="dl__value num">{dateTimeFull(doc.createdAt)}</dd>
          <dt className="dl__term">Запусков</dt>
          <dd className="dl__value num">{doc.launchCount}</dd>
          <dt className="dl__term">Наблюдатели</dt>
          <dd className="dl__value">
            <PersonChips users={doc.observers} />
          </dd>
          {doc.access && (doc.access.users.length > 0 || doc.access.departments.length > 0) && (
            <>
              <dt className="dl__term">Доступ открыт</dt>
              <dd className="dl__value">{[...doc.access.users.map((u) => u.fullName), ...doc.access.departments.map((d) => d.name)].join(', ')}</dd>
            </>
          )}
        </dl>
      </div>
    </section>
  );
}
