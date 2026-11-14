import { useEffect, useState } from 'react';
import { ApiError, api, errorText, upload } from '../../api/client';
import { useDebounced } from '../../api/hooks';
import type { DocumentListItem, Page, TaskDetail, TaskDocumentRef, UserRef } from '../../api/types';
import { DEFAULT_EXTS, Dropzone, checkFile } from '../../components/Files';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { UserPicker } from '../../components/UserPicker';
import { Alert, Button, Field, cx } from '../../components/ui';
import { isoDay } from '../../lib/format';

interface Props {
  /** Документ-основание: при создании из приказа заполнен и не редактируется. */
  document?: TaskDocumentRef;
  onClose: () => void;
  onCreated: (t: TaskDetail) => void;
}

function DocSearch({ value, onChange }: { value: TaskDocumentRef | null; onChange: (d: TaskDocumentRef | null) => void }) {
  const [text, setText] = useState('');
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [open, setOpen] = useState(false);
  const q = useDebounced(text, 300);
  useEffect(() => {
    if (!open || !q.trim()) {
      setItems([]);
      return;
    }
    let c = false;
    api
      .get<Page<DocumentListItem>>('/documents', { q: q.trim(), pageSize: 6 })
      .then((p) => !c && setItems(p.items))
      .catch(() => !c && setItems([]));
    return () => {
      c = true;
    };
  }, [q, open]);
  if (value)
    return (
      <span className="chip chip--static chip--wide">
        {value.number} · {value.title}
        <button type="button" className="chip__remove" aria-label="Убрать документ-основание" onClick={() => onChange(null)}>
          <Icon name="x" />
        </button>
      </span>
    );
  return (
    <div className="picker">
      <input id="tk-doc" className="input" type="search" placeholder="Номер или название документа" value={text} autoComplete="off" onChange={(e) => setText(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 150)} />
      {open && q.trim() && (
        <div className="picker__menu" role="listbox">
          {!items.length ? (
            <div className="picker__empty">Документы не найдены.</div>
          ) : (
            items.map((d) => (
              <button key={d.id} type="button" role="option" aria-selected={false} className="picker__option" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange({ id: d.id, number: d.number, title: d.title, accessible: true })}>
                <span className="picker__option-main">
                  <span className="picker__option-name">{d.title || d.number}</span>
                  <span className="picker__option-meta">
                    {d.number} · {d.type.name}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Окно «Новое поручение» (раздел 4.7). */
export function TaskCreateModal({ document: fixedDoc, onClose, onCreated }: Props) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState<UserRef[]>([]);
  const [due, setDue] = useState('');
  const [doc, setDoc] = useState<TaskDocumentRef | null>(fixedDoc ?? null);
  const [observers, setObservers] = useState<UserRef[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<{ title: string; hint: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = isoDay(new Date());

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = 'Напишите, что нужно сделать';
    if (!assignee.length) e.assignee = 'Выберите исполнителя';
    if (!due) e.due = 'Укажите срок';
    else if (due < today) e.due = 'Дата в прошлом недопустима';
    setErrors(e);
    setFailure(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const t = await api.post<TaskDetail>('/tasks', {
        title: title.trim(),
        body: body.trim() || undefined,
        assigneeId: assignee[0].id,
        dueAt: due,
        documentId: doc?.id ?? null,
        observerIds: observers.map((u) => u.id),
      });
      let failed = 0;
      for (const f of files) {
        try {
          await upload(`/tasks/${t.id}/files?role=attachment`, f).promise;
        } catch {
          failed += 1;
        }
      }
      toast.success('Поручение создано', `${assignee[0].fullName} получит уведомление.`);
      if (failed) toast.error('Не все файлы загружены', `Не удалось загрузить: ${failed}. Добавьте их в карточке поручения.`);
      onCreated(t);
      onClose();
    } catch (err) {
      setFailure(errorText(err));
      if (err instanceof ApiError) {
        const map: Record<string, string> = {};
        for (const d of err.details) map[d.field === 'assigneeId' ? 'assignee' : d.field === 'dueAt' ? 'due' : d.field] = d.message;
        if (Object.keys(map).length) setErrors(map);
      }
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Новое поручение"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Создаём…" onClick={submit}>
            Создать поручение
          </Button>
        </>
      }
    >
      <Field label="Что нужно сделать" required htmlFor="tk-title" error={errors.title}>
        <input id="tk-title" className="input" type="text" maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Подробности" optional htmlFor="tk-body">
        <textarea id="tk-body" className="textarea" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="form-grid">
        <Field label="Исполнитель" required htmlFor="tk-assignee" error={errors.assignee}>
          <UserPicker inputId="tk-assignee" single value={assignee} invalid={!!errors.assignee} onChange={setAssignee} ariaLabel="Выбрать исполнителя" />
        </Field>
        <Field label="Срок" required htmlFor="tk-due" error={errors.due}>
          <input id="tk-due" className={cx('input input--date', errors.due && 'is-invalid')} type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
      <Field label="Документ-основание" optional htmlFor="tk-doc" hint={fixedDoc ? 'Поручение создаётся по этому документу.' : 'Без документа поручение будет самостоятельным.'}>
        {fixedDoc ? (
          <span className="chip chip--static chip--wide">
            {fixedDoc.number} · {fixedDoc.title}
          </span>
        ) : (
          <DocSearch value={doc} onChange={setDoc} />
        )}
      </Field>
      <Field label="Наблюдатели" optional htmlFor="tk-obs">
        <UserPicker inputId="tk-obs" value={observers} onChange={setObservers} ariaLabel="Добавить наблюдателя" />
      </Field>
      <div className="field">
        <span className="field__label">
          Файлы <span className="field__optional">— необязательно</span>
        </span>
        <Dropzone
          compact
          multiple
          title={files.length ? `Выбрано файлов: ${files.length}` : 'Добавить файлы'}
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
