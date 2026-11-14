import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, errorText, upload } from '../../api/client';
import { useDocumentTitle } from '../../api/hooks';
import type { FileItem, HistoryEntry, Page, TaskDetail, UserRef } from '../../api/types';
import { DEFAULT_EXTS, Dropzone, FileList, checkFile } from '../../components/Files';
import { MoreMenu } from '../../components/Menu';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { UserPicker } from '../../components/UserPicker';
import { Alert, Avatar, Button, Card, Field, LoadError, Loading, OverdueBadge, PageHeader, PersonChips, TaskStatusBadge, cx } from '../../components/ui';
import { date, dateTimeFull, due, isoDay } from '../../lib/format';
import { docPath } from '../../lib/status';
import { useCounters } from '../../layout/AppLayout';
import { useMe } from '../../layout/Auth';
import { NoAccess } from '../Misc';
import { HistoryCard } from '../card/parts';

type Dialog = null | 'submit' | 'return' | 'cancel' | 'due' | 'assignee';

function SubmitModal({ task, onDone, onClose }: { task: TaskDetail; onDone: (t: TaskDetail) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<{ title: string; hint: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) {
      setError('Опишите результат — без него передать на проверку нельзя.');
      document.getElementById('res-text')?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      for (const f of files) await upload<FileItem>(`/tasks/${task.id}/files?role=result`, f).promise;
      const t = await api.post<TaskDetail>(`/tasks/${task.id}/submit`, { resultText: text.trim() });
      onDone(t);
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Передать результат"
      onClose={onClose}
      initialFocus="textarea"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Передаём…" onClick={submit}>
            Передать на проверку
          </Button>
        </>
      }
    >
      <Field label="Результат" required htmlFor="res-text" error={error}>
        <textarea
          id="res-text"
          className="textarea"
          rows={4}
          placeholder="Опишите, что сделано"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
      </Field>
      <div className="field">
        <span className="field__label">
          Файлы <span className="field__optional">— необязательно</span>
        </span>
        <Dropzone
          compact
          multiple
          title={files.length ? `Выбрано файлов: ${files.length}` : 'Приложить файлы результата'}
          hint={files.length ? files.map((f) => f.name).join(', ') : 'XLSX, XLS, DOCX, DOC, PDF, JPG, PNG — до 50 МБ каждый'}
          accept={DEFAULT_EXTS}
          error={fileError}
          onFiles={(list) => {
            const bad = list.map((f) => checkFile(f, DEFAULT_EXTS)).find(Boolean) ?? null;
            setFileError(bad);
            if (!bad) setFiles((l) => [...l, ...list]);
          }}
        />
      </div>
      {failure && <Alert tone="danger">{failure}</Alert>}
    </Modal>
  );
}

function EditModal({ task, field, onDone, onClose }: { task: TaskDetail; field: 'due' | 'assignee'; onDone: (t: TaskDetail) => void; onClose: () => void }) {
  const [dueV, setDueV] = useState(task.dueAt ? isoDay(new Date(task.dueAt)) : '');
  const [who, setWho] = useState<UserRef[]>([task.assignee]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (field === 'due' && !dueV) return setFailure('Укажите срок.');
    if (field === 'assignee' && !who.length) return setFailure('Выберите исполнителя.');
    setBusy(true);
    try {
      const t = await api.patch<TaskDetail>(`/tasks/${task.id}`, field === 'due' ? { dueAt: dueV } : { assigneeId: who[0].id });
      onDone(t);
    } catch (e) {
      setFailure(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={field === 'due' ? 'Изменить срок' : 'Сменить исполнителя'}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Сохраняем…" onClick={submit}>
            Сохранить
          </Button>
        </>
      }
    >
      {field === 'due' ? (
        <Field label="Новый срок" required htmlFor="ed-due" hint="Изменение попадёт в историю поручения.">
          <input id="ed-due" className="input input--date" type="date" min={isoDay(new Date())} value={dueV} onChange={(e) => setDueV(e.target.value)} />
        </Field>
      ) : (
        <Field label="Новый исполнитель" required htmlFor="ed-who" hint="Прежний и новый исполнитель получат уведомления.">
          <UserPicker inputId="ed-who" single value={who} onChange={setWho} ariaLabel="Выбрать исполнителя" />
        </Field>
      )}
      {failure && <Alert tone="danger">{failure}</Alert>}
    </Modal>
  );
}

export function TaskCardPage() {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const me = useMe();
  const toast = useToast();
  const { refresh } = useCounters();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState<{ title: string; hint: string } | null>(null);
  useDocumentTitle(task?.title ?? 'Поручение');

  const loadHistory = useCallback(() => {
    api
      .get<Page<HistoryEntry>>(`/tasks/${id}/history`, { pageSize: 100 })
      .then((p) => setHistory(p.items))
      .catch(() => undefined);
  }, [id]);

  const load = useCallback(() => {
    setError(null);
    return api
      .get<TaskDetail>(`/tasks/${id}`)
      .then((t) => {
        setTask(t);
        loadHistory();
      })
      .catch((e) => setError(e instanceof ApiError ? e : new ApiError(0, 'internal', '')));
  }, [id, loadHistory]);

  useEffect(() => {
    setTask(null);
    void load();
  }, [load]);

  const apply = (t: TaskDetail, msg?: string) => {
    setTask(t);
    setDialog(null);
    loadHistory();
    refresh();
    if (msg) toast.success(msg);
  };

  if (error) return error.status === 404 || error.status === 400 ? <NoAccess /> : <LoadError title="Не удалось загрузить поручение" onRetry={() => void load()} />;
  if (!task) {
    return (
      <Loading>
        <div className="stack">
          <span className="skeleton skeleton--title" />
          <span className="skeleton skeleton--tile" />
          <span className="skeleton skeleton--row" />
        </div>
      </Loading>
    );
  }

  const p = task.permissions;
  const isAssignee = task.assignee.id === me.id;
  const isAuthor = task.author.id === me.id;
  const returned = history.find((h) => h.action === 'task.returned');
  const submitted = history.find((h) => h.action === 'task.submitted');
  const resultFiles = task.files.filter((f) => f.role === 'result');
  const otherFiles = task.files.filter((f) => f.role !== 'result');

  const act = async (path: 'start' | 'accept', msg: string, setBusy: (b: boolean) => void) => {
    setBusy(true);
    try {
      apply(await api.post<TaskDetail>(`/tasks/${id}/${path}`), msg);
    } catch (e) {
      toast.fail('Действие не выполнено', e);
    } finally {
      setBusy(false);
    }
  };

  const panel = ((): { title: string; text?: string; actions?: React.ReactNode; calm: boolean } => {
    const dueText = task.dueAt ? `Срок — до ${date(task.dueAt)}.` : 'Срок не задан.';
    if (task.status === 'done') return { title: `Поручение выполнено ${task.completedAt ? date(task.completedAt) : ''}`.trim(), calm: true };
    if (task.status === 'cancelled') return { title: 'Поручение отменено', text: history.find((h) => h.action === 'task.cancelled')?.details?.reason ? `Причина: «${String(history.find((h) => h.action === 'task.cancelled')!.details.reason)}»` : undefined, calm: true };
    if (isAssignee && task.status === 'new')
      return {
        title: 'Вам назначено поручение',
        text: dueText,
        calm: false,
        actions: (
          <>
            {p.canStart && (
              <Button variant="primary" busy={starting} busyText="Берём…" onClick={() => void act('start', 'Поручение в работе', setStarting)}>
                Взять в работу
              </Button>
            )}
            {p.canSubmit && <Button onClick={() => setDialog('submit')}>Передать результат</Button>}
          </>
        ),
      };
    if (isAssignee && task.status === 'in_progress')
      return {
        title: 'Поручение у вас в работе',
        text: returned ? `${returned.actorName} вернул(а) в работу: «${String(returned.details?.comment ?? '')}»` : dueText,
        calm: false,
        actions: p.canSubmit && (
          <Button variant="primary" onClick={() => setDialog('submit')}>
            Передать результат
          </Button>
        ),
      };
    if (isAssignee && task.status === 'review') return { title: `Результат на проверке у ${task.author.fullName}`, calm: true };
    if (isAuthor && task.status === 'review')
      return {
        title: 'Проверьте результат',
        text: `${task.assignee.fullName} передал(а) результат${submitted ? ` ${date(submitted.at)}` : ''}.`,
        calm: false,
        actions: (
          <>
            {p.canAccept && (
              <Button variant="primary" icon="check" busy={accepting} busyText="Принимаем…" onClick={() => void act('accept', 'Поручение выполнено', setAccepting)}>
                Принять результат
              </Button>
            )}
            {p.canReturn && <Button onClick={() => setDialog('return')}>Вернуть в работу</Button>}
          </>
        ),
      };
    if (isAuthor) {
      const d = due(task.dueAt);
      return { title: `Поручение выполняет ${task.assignee.fullName}`, text: task.dueAt ? `${d.text}.` : 'Срок не задан.', calm: true };
    }
    return { title: 'От вас ничего не требуется', text: `Исполнитель — ${task.assignee.fullName}.`, calm: true };
  })();

  const sendComment = async () => {
    if (!comment.trim()) return;
    setSending(true);
    try {
      await api.post(`/tasks/${id}/comments`, { body: comment.trim() });
      setComment('');
      toast.success('Комментарий отправлен');
      await load();
    } catch (e) {
      toast.fail('Комментарий не отправлен', e, sendComment);
    } finally {
      setSending(false);
    }
  };

  const addFiles = async (list: File[]) => {
    const bad = list.map((f) => checkFile(f, DEFAULT_EXTS)).find(Boolean) ?? null;
    setFileError(bad);
    if (bad) return;
    setUploading(true);
    try {
      for (const f of list) await upload(`/tasks/${id}/files?role=attachment`, f).promise;
      toast.success(list.length > 1 ? 'Файлы загружены' : 'Файл загружен');
      await load();
    } catch (e) {
      toast.fail('Не удалось загрузить', e);
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <PageHeader
        crumbs={[{ to: '/tasks', label: 'Поручения' }, { label: task.number }]}
        title={task.title}
        badges={
          <>
            <TaskStatusBadge status={task.status} />
            {task.overdue && <OverdueBadge at={task.dueAt} />}
          </>
        }
        meta={
          <>
            <span className="num">{task.number}</span>
            <span>Постановщик: {task.author.fullName}</span>
            <span>Исполнитель: {task.assignee.fullName}</span>
            <span title={task.dueAt ? dateTimeFull(task.dueAt) : undefined}>{task.dueAt ? `Срок ${date(task.dueAt)}` : 'Без срока'}</span>
          </>
        }
        actions={
          <MoreMenu
            items={[
              { label: 'Изменить срок', icon: 'calendar', hidden: !p.canEdit, onSelect: () => setDialog('due') },
              { label: 'Сменить исполнителя', icon: 'admin', hidden: !p.canEdit, onSelect: () => setDialog('assignee') },
              {
                label: 'Скопировать ссылку',
                icon: 'link',
                onSelect: () => navigator.clipboard?.writeText(window.location.href).then(() => toast.info('Ссылка скопирована.'), () => toast.error('Не удалось скопировать ссылку')),
              },
              { label: 'Отменить поручение', danger: true, divider: true, hidden: !p.canCancel, onSelect: () => setDialog('cancel') },
            ]}
          />
        }
      />
      <div className="layout-split">
        <div className="stack stack--lg">
          <section className={cx('action-panel', panel.calm && 'action-panel--calm')} aria-label="Ожидаемое действие">
            <div className="action-panel__main">
              <h2 className="action-panel__title">{panel.title}</h2>
              {panel.text && <p className="action-panel__text">{panel.text}</p>}
            </div>
            {panel.actions && <div className="action-panel__actions">{panel.actions}</div>}
          </section>
          <Card title="Содержание">{task.body.trim() ? <p className="text-lg pre-wrap">{task.body}</p> : <p className="text-muted">Подробности не указаны.</p>}</Card>
          {(task.resultText || resultFiles.length > 0) && (
            <Card title="Результат">
              <div className="stack">
                {task.resultText && <p className="text-lg pre-wrap">{task.resultText}</p>}
                {resultFiles.length > 0 && <FileList files={resultFiles} />}
              </div>
            </Card>
          )}
          <Card title="Файлы" count={otherFiles.length || undefined}>
            <div className="stack">
              <FileList files={otherFiles} />
              {p.canUploadFiles && <Dropzone compact multiple title="Добавить файлы" hint="XLSX, XLS, DOCX, DOC, PDF, JPG, PNG — до 50 МБ каждый" accept={DEFAULT_EXTS} error={fileError} disabled={uploading} onFiles={(l) => void addFiles(l)} />}
            </div>
          </Card>
          <HistoryCard
            entries={history}
            comments={task.comments}
            rounds={[]}
            byRound={false}
            title="Комментарии и история"
            footer={
              p.canComment && (
                <form
                  className="comment-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void sendComment();
                  }}
                >
                  <Avatar name={me.fullName} />
                  <label className="spacer">
                    <span className="visually-hidden">Комментарий</span>
                    <textarea className="textarea" rows={1} placeholder="Написать комментарий" value={comment} onChange={(e) => setComment(e.target.value)} />
                  </label>
                  <Button type="submit" busy={sending} busyText="Отправляем…" disabled={!comment.trim()}>
                    Отправить
                  </Button>
                </form>
              )
            }
          />
        </div>
        <aside className="layout-split__aside">
          <Card title="Сведения" compact>
            <dl className="dl">
              <dt className="dl__term">Постановщик</dt>
              <dd className="dl__value">{task.author.fullName}</dd>
              <dt className="dl__term">Исполнитель</dt>
              <dd className="dl__value">{task.assignee.fullName}</dd>
              <dt className="dl__term">Срок</dt>
              <dd className="dl__value">{task.dueAt ? <span className={cx('due', task.overdue && 'due--overdue')}>{dateTimeFull(task.dueAt)}</span> : 'Без срока'}</dd>
              <dt className="dl__term">Создано</dt>
              <dd className="dl__value num">{dateTimeFull(task.createdAt)}</dd>
              {task.completedAt && (
                <>
                  <dt className="dl__term">Выполнено</dt>
                  <dd className="dl__value num">{dateTimeFull(task.completedAt)}</dd>
                </>
              )}
              <dt className="dl__term">Наблюдатели</dt>
              <dd className="dl__value">
                <PersonChips users={task.observers} />
              </dd>
            </dl>
          </Card>
          <Card title="Основание" compact>
            {!task.document ? (
              <p className="text-muted">Самостоятельное поручение, без документа-основания.</p>
            ) : task.document.accessible ? (
              <Link className="link" to={docPath('order', task.document.id).replace('/orders/', '/documents/')}>
                {task.document.number} · {task.document.title}
              </Link>
            ) : (
              <p>
                {task.document.number} · {task.document.title}
              </p>
            )}
          </Card>
        </aside>
      </div>

      {dialog === 'submit' && <SubmitModal task={task} onClose={() => setDialog(null)} onDone={(t) => apply(t, 'Результат передан на проверку')} />}
      {dialog === 'return' && (
        <ConfirmDialog
          title="Вернуть поручение в работу?"
          text={`Исполнитель ${task.assignee.fullName} получит ваш комментарий и продолжит работу.`}
          commentLabel="Что нужно доделать"
          commentRequired
          requiredAction="вернуть в работу"
          confirmText="Вернуть в работу"
          busyText="Возвращаем…"
          onClose={() => setDialog(null)}
          onConfirm={async (c) => apply(await api.post<TaskDetail>(`/tasks/${id}/return`, { comment: c }), 'Поручение возвращено в работу')}
        />
      )}
      {dialog === 'cancel' && (
        <ConfirmDialog
          title="Отменить поручение?"
          text="Исполнитель получит уведомление. Отменённое поручение нельзя возобновить."
          commentLabel="Причина отмены"
          commentRequired
          requiredAction="отменить поручение"
          confirmText="Отменить поручение"
          busyText="Отменяем…"
          cancelText="Не отменять"
          onClose={() => setDialog(null)}
          onConfirm={async (c) => apply(await api.post<TaskDetail>(`/tasks/${id}/cancel`, { reason: c }), 'Поручение отменено')}
        />
      )}
      {(dialog === 'due' || dialog === 'assignee') && <EditModal task={task} field={dialog} onClose={() => setDialog(null)} onDone={(t) => apply(t, dialog === 'due' ? 'Срок изменён' : 'Исполнитель изменён')} />}
    </>
  );
}
