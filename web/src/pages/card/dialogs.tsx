import { useEffect, useState } from 'react';
import { api, errorText } from '../../api/client';
import type { Department, DocumentDetail, UserRef } from '../../api/types';
import { Modal } from '../../components/Modal';
import { UserPicker } from '../../components/UserPicker';
import { Alert, Button, Field, cx } from '../../components/ui';

/** «Согласовать?» — без подтверждения опасности, но с необязательным комментарием. */
export function ApproveModal({ title = 'Согласовать?', confirm = 'Согласовать', text, onConfirm, onClose }: { title?: string; confirm?: string; text?: string; onConfirm: (comment: string) => Promise<void>; onClose: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(comment.trim());
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      initialFocus="textarea"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" icon="check" busy={busy} busyText="Отправляем…" onClick={submit}>
            {confirm}
          </Button>
        </>
      }
    >
      {text && <p>{text}</p>}
      <Field label="Комментарий" optional htmlFor="approve-comment">
        <textarea id="approve-comment" className="textarea" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
    </Modal>
  );
}

/** Изменение маршрута: замена или добавление согласующего с причиной (раздел 4.5). */
export function RouteModal({ doc, initialFrom, onDone, onClose }: { doc: DocumentDetail; initialFrom?: number; onDone: (d: DocumentDetail | null, text: string) => void; onClose: () => void }) {
  const round = doc.rounds[0] && !doc.rounds[0].finishedAt ? doc.rounds[0] : null;
  const replaceable = (round?.steps ?? []).filter((s) => s.state === 'pending' || s.state === 'waiting');
  const [tab, setTab] = useState<'replace' | 'add'>(replaceable.length ? 'replace' : 'add');
  const [from, setFrom] = useState<number>(initialFrom ?? replaceable[0]?.user.id ?? 0);
  const [to, setTo] = useState<UserRef[]>([]);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exclude = [doc.initiator.id, ...(round?.steps ?? []).filter((s) => s.state !== 'replaced').map((s) => s.user.id)];

  const submit = async () => {
    const e: Record<string, string> = {};
    if (tab === 'replace' && !from) e.from = 'Выберите, кого заменить';
    if (!to.length) e.to = tab === 'replace' ? 'Выберите, на кого заменить' : 'Выберите, кого добавить';
    if (reason.trim().length < 5) e.reason = 'Напишите причину — без неё изменить маршрут нельзя.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setFailure(null);
    try {
      const body = tab === 'replace' ? { action: 'replace', fromUserId: from, toUserId: to[0].id, reason: reason.trim() } : { action: 'add', toUserId: to[0].id, reason: reason.trim() };
      const r = await api.put<DocumentDetail | { ok: true }>(`/documents/${doc.id}/route`, body);
      onDone('id' in r ? r : null, tab === 'replace' ? 'Согласующий заменён' : 'Согласующий добавлен');
    } catch (err) {
      setFailure(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Изменить маршрут"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText={tab === 'replace' ? 'Заменяем…' : 'Добавляем…'} onClick={submit}>
            {tab === 'replace' ? 'Заменить' : 'Добавить'}
          </Button>
        </>
      }
    >
      <div className="tabs tabs--modal" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'replace'} className={cx('tab', tab === 'replace' && 'is-active')} disabled={!replaceable.length} onClick={() => setTab('replace')}>
          Заменить согласующего
        </button>
        <button type="button" role="tab" aria-selected={tab === 'add'} className={cx('tab', tab === 'add' && 'is-active')} onClick={() => setTab('add')}>
          Добавить согласующего
        </button>
      </div>
      {tab === 'replace' && (
        <Field label="Кого заменить" htmlFor="rt-from" error={errors.from} hint="Только те, кто ещё не принял решение.">
          <select id="rt-from" className="select" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {replaceable.map((s) => (
              <option key={s.user.id} value={s.user.id}>
                {s.user.fullName}
                {s.user.department ? ` — ${s.user.department.name}` : ''}
                {!s.user.active ? ' (заблокирован)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={tab === 'replace' ? 'На кого' : 'Кого добавить'} htmlFor="rt-to" error={errors.to} hint={tab === 'add' ? (doc.routeMode === 'parallel' ? 'Новый согласующий получит документ сразу.' : 'Новый согласующий встанет в конец очереди.') : undefined}>
        <UserPicker inputId="rt-to" single value={to} excludeIds={exclude} excludeHint="Уже участвует или инициатор" onChange={setTo} ariaLabel="Выбрать сотрудника" />
      </Field>
      <Field label={tab === 'replace' ? 'Причина замены' : 'Причина'} required htmlFor="rt-reason" error={errors.reason} hint="Причина попадёт в историю согласования.">
        <input id="rt-reason" className="input" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {failure && <Alert tone="danger">{failure}</Alert>}
    </Modal>
  );
}

/** Индивидуальный доступ к карточке: сотрудники и подразделения. */
export function AccessModal({ doc, onDone, onClose }: { doc: DocumentDetail; onDone: (d: DocumentDetail) => void; onClose: () => void }) {
  const [users, setUsers] = useState<UserRef[]>(doc.access?.users ?? []);
  const [deptIds, setDeptIds] = useState<number[]>(doc.access?.departments.map((d) => d.id) ?? []);
  const [depts, setDepts] = useState<Department[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ items: Department[] }>('/departments')
      .then((r) => setDepts(r.items))
      .catch(() => setFailure('Не удалось загрузить подразделения.'));
  }, []);
  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const d = await api.put<DocumentDetail>(`/documents/${doc.id}/access`, { userIds: users.map((u) => u.id), departmentIds: deptIds });
      onDone(d);
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Настроить доступ"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Сохраняем…" onClick={submit}>
            Сохранить доступ
          </Button>
        </>
      }
    >
      <p className="text-muted">Участники видят карточку и так. Здесь — кому ещё открыть просмотр.</p>
      <Field label="Сотрудники" htmlFor="acc-users">
        <UserPicker inputId="acc-users" value={users} onChange={setUsers} ariaLabel="Добавить сотрудника" />
      </Field>
      <fieldset className="fieldset">
        <legend className="field__label">Подразделения целиком</legend>
        <div className="check-grid">
          {depts.map((d) => (
            <label key={d.id} className="checkbox">
              <input type="checkbox" checked={deptIds.includes(d.id)} onChange={(e) => setDeptIds((l) => (e.target.checked ? [...l, d.id] : l.filter((x) => x !== d.id)))} />
              <span>{d.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {failure && <Alert tone="danger">{failure}</Alert>}
    </Modal>
  );
}

/** Дополнение списка ознакомления (после утверждения — только добавление). */
export function AcquaintanceModal({ doc, onDone, onClose }: { doc: DocumentDetail; onDone: (d: DocumentDetail) => void; onClose: () => void }) {
  const [add, setAdd] = useState<UserRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submit = async () => {
    if (!add.length) return onClose();
    setBusy(true);
    try {
      const d = await api.put<DocumentDetail>(`/documents/${doc.id}/acquaintance`, { userIds: [...doc.acquaintance.map((u) => u.id), ...add.map((u) => u.id)] });
      onDone(d);
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Добавить сотрудников"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Добавляем…" onClick={submit}>
            Добавить
          </Button>
        </>
      }
    >
      <Field label="Кого добавить в список ознакомления" htmlFor="acq-add" hint="Добавленные сотрудники получат уведомление.">
        <UserPicker inputId="acq-add" value={add} excludeIds={doc.acquaintance.map((u) => u.id)} excludeHint="Уже в списке" onChange={setAdd} ariaLabel="Добавить сотрудника" />
      </Field>
      {failure && <Alert tone="danger">{failure}</Alert>}
    </Modal>
  );
}
