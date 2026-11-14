import { useEffect, useState } from 'react';
import { api, errorText } from '../../api/client';
import { useApi, useDelayed, useDocumentTitle } from '../../api/hooks';
import type { Department, DocKind, DocType, Page } from '../../api/types';
import { MoreMenu } from '../../components/Menu';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Alert, Button, Empty, Field, LoadError } from '../../components/ui';

// ───────────────────── Подразделения ─────────────────────

function DeptModal({ dept, onDone, onClose }: { dept: Department | null; onDone: (d: Department) => void; onClose: () => void }) {
  const [name, setName] = useState(dept?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim()) return setError('Укажите название');
    setBusy(true);
    try {
      const d = dept ? await api.patch<Department>(`/admin/departments/${dept.id}`, { name: name.trim() }) : await api.post<Department>('/admin/departments', { name: name.trim() });
      onDone(d);
    } catch (e) {
      const m = errorText(e);
      setError(/уже существует/.test(m) ? 'Подразделение с таким названием уже есть' : m);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={dept ? 'Переименовать подразделение' : 'Новое подразделение'}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Сохраняем…" onClick={submit}>
            {dept ? 'Сохранить' : 'Добавить'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Название" required htmlFor="d-name" error={error}>
          <input
            id="d-name"
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
        </Field>
      </form>
    </Modal>
  );
}

export function DepartmentsPage() {
  useDocumentTitle('Подразделения');
  const toast = useToast();
  const list = useApi<{ items: Department[] }>('/admin/departments');
  const skeleton = useDelayed(list.loading);
  const [edit, setEdit] = useState<Department | null | 'new'>(null);
  const [hide, setHide] = useState<Department | null>(null);
  const [counts, setCounts] = useState<Record<number, number>>({});

  // Число сотрудников — отдельным запросом на подразделение (в ответе списка его нет).
  useEffect(() => {
    const items = list.data?.items ?? [];
    let c = false;
    Promise.all(items.map((d) => api.get<Page<unknown>>('/admin/users', { departmentId: d.id, active: true, pageSize: 1 }).then((p) => [d.id, p.total] as const)))
      .then((pairs) => !c && setCounts(Object.fromEntries(pairs)))
      .catch(() => undefined);
    return () => {
      c = true;
    };
  }, [list.data]);

  const toggle = async (d: Department, active: boolean) => {
    try {
      await api.patch(`/admin/departments/${d.id}`, { active });
      toast.success(active ? 'Подразделение возвращено' : 'Подразделение скрыто', d.name);
      setHide(null);
      list.reload(true);
    } catch (e) {
      toast.fail('Не удалось изменить подразделение', e);
    }
  };

  return (
    <div className="stack">
      <div className="row row--between">
        <p className="text-muted">Скрытые подразделения не предлагаются при выборе, но остаются в документах.</p>
        <Button variant="primary" icon="plus" onClick={() => setEdit('new')}>
          Добавить подразделение
        </Button>
      </div>
      <div className="table-wrap">
        {list.error ? (
          <LoadError onRetry={() => list.reload()} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Название</th>
                <th scope="col" className="td-num">
                  Сотрудников
                </th>
                <th scope="col">Состояние</th>
                <th scope="col" className="td-actions">
                  <span className="visually-hidden">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!list.data ? (
                <tr className="table__empty">
                  <td colSpan={4} className="skeleton-cell">
                    {skeleton && <span className="skeleton skeleton--row" />}
                  </td>
                </tr>
              ) : !list.data.items.length ? (
                <tr className="table__empty">
                  <td colSpan={4}>
                    <Empty title="Подразделений пока нет" />
                  </td>
                </tr>
              ) : (
                list.data.items.map((d) => (
                  <tr key={d.id}>
                    <td className="td-main text-strong">{d.name}</td>
                    <td className="td-num">{counts[d.id] ?? '—'}</td>
                    <td>{d.active ? <span className="badge badge--success">Используется</span> : <span className="badge badge--muted">Скрыто</span>}</td>
                    <td className="td-actions">
                      <MoreMenu
                        small
                        label={`Действия: ${d.name}`}
                        items={[
                          { label: 'Переименовать', onSelect: () => setEdit(d) },
                          { label: 'Скрыть', divider: true, hidden: !d.active, onSelect: () => setHide(d) },
                          { label: 'Вернуть', divider: true, hidden: d.active, onSelect: () => void toggle(d, true) },
                        ]}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <DeptModal
          dept={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onDone={(d) => {
            setEdit(null);
            toast.success(edit === 'new' ? 'Подразделение добавлено' : 'Подразделение переименовано', d.name);
            list.reload(true);
          }}
        />
      )}
      {hide && <ConfirmDialog title="Скрыть подразделение?" text="Подразделение исчезнет из списков выбора. В существующих документах оно останется." confirmText="Скрыть" busyText="Скрываем…" onClose={() => setHide(null)} onConfirm={() => toggle(hide, false)} />}
    </div>
  );
}

// ───────────────────── Типы документов ─────────────────────

const REQS: { key: keyof Pick<DocType, 'requireDeal' | 'requireFile' | 'requireExcel' | 'requireDeadline' | 'requireDescription'>; label: string }[] = [
  { key: 'requireDeal', label: 'Сделка Битрикс24' },
  { key: 'requireFile', label: 'Файл' },
  { key: 'requireExcel', label: 'Файл Excel (XLSX, XLS)' },
  { key: 'requireDeadline', label: 'Срок' },
  { key: 'requireDescription', label: 'Описание' },
];

function requiredWords(t: DocType): string {
  const words = ['название', t.kind === 'order' ? 'утверждающий' : 'согласующие', ...REQS.filter((r) => t[r.key]).map((r) => r.label.replace(' (XLSX, XLS)', '').toLowerCase())];
  const s = words.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function TypeModal({ type, onDone, onClose }: { type: DocType | null; onDone: (t: DocType) => void; onClose: () => void }) {
  const [name, setName] = useState(type?.name ?? '');
  const [code, setCode] = useState(type?.code ?? '');
  const [kind, setKind] = useState<DocKind>(type?.kind ?? 'approval');
  const [prefix, setPrefix] = useState(type?.numberPrefix ?? '');
  const [active, setActive] = useState(type?.active ?? true);
  const [req, setReq] = useState<Record<string, boolean>>(() => Object.fromEntries(REQS.map((r) => [r.key, type ? type[r.key] : false])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Укажите название';
    if (!type && !/^[A-Za-z0-9_]{2,30}$/.test(code)) e.code = 'Код: 2–30 символов — латинские буквы, цифры, подчёркивание';
    if (!/^[A-Za-zА-Яа-яЁё0-9]{1,10}$/.test(prefix)) e.prefix = 'Префикс: 1–10 букв или цифр';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setFailure(null);
    const flags = { ...req, requireDeal: kind === 'order' ? false : req.requireDeal, requireFile: req.requireFile || req.requireExcel };
    try {
      const t = type
        ? await api.patch<DocType>(`/admin/doc-types/${type.id}`, { name: name.trim(), numberPrefix: prefix, active, ...flags })
        : await api.post<DocType>('/admin/doc-types', { code, name: name.trim(), kind, numberPrefix: prefix, ...flags });
      onDone(t);
    } catch (err) {
      setFailure(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={type ? 'Тип документа' : 'Новый тип документа'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText="Сохраняем…" onClick={submit}>
            {type ? 'Сохранить' : 'Добавить'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Название" required htmlFor="t-name" error={errors.name} className="form-grid__full">
          <input id="t-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Вид" htmlFor="t-kind">
          <select id="t-kind" className="select" value={kind} disabled={!!type} onChange={(e) => setKind(e.target.value as DocKind)}>
            <option value="approval">Согласование</option>
            <option value="order">Приказ</option>
          </select>
        </Field>
        <Field label="Код" required={!type} htmlFor="t-code" error={errors.code} hint="Служебный, латиницей.">
          <input id="t-code" className="input" value={code} disabled={!!type} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="Префикс номера" required htmlFor="t-prefix" error={errors.prefix} hint="Не меняйте после создания первого документа.">
          <input id="t-prefix" className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
      </div>
      <fieldset className="fieldset">
        <legend className="field__label">Обязательно для запуска</legend>
        <div className="check-grid">
          {REQS.filter((r) => !(kind === 'order' && r.key === 'requireDeal')).map((r) => (
            <label key={r.key} className="checkbox">
              <input type="checkbox" checked={!!req[r.key]} onChange={(e) => setReq((x) => ({ ...x, [r.key]: e.target.checked }))} />
              <span>{r.label}</span>
            </label>
          ))}
        </div>
        <p className="field__hint">{kind === 'order' ? 'Название и утверждающий обязательны всегда.' : 'Название и хотя бы один согласующий обязательны всегда.'}</p>
      </fieldset>
      {type && (
        <label className="switch">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Тип доступен при создании</span>
        </label>
      )}
      {failure && <Alert tone="danger">{failure}</Alert>}
    </Modal>
  );
}

export function DocTypesPage() {
  useDocumentTitle('Типы документов');
  const toast = useToast();
  const list = useApi<{ items: DocType[] }>('/admin/doc-types');
  const skeleton = useDelayed(list.loading);
  const [edit, setEdit] = useState<DocType | null | 'new'>(null);
  return (
    <div className="stack">
      <div className="row row--between">
        <p className="text-muted">Обязательные поля проверяются при запуске согласования.</p>
        <Button variant="primary" icon="plus" onClick={() => setEdit('new')}>
          Добавить тип
        </Button>
      </div>
      <div className="table-wrap">
        {list.error ? (
          <LoadError onRetry={() => list.reload()} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Название</th>
                <th scope="col">Вид</th>
                <th scope="col">Префикс номера</th>
                <th scope="col">Обязательные поля</th>
                <th scope="col">Состояние</th>
                <th scope="col" className="td-actions">
                  <span className="visually-hidden">Действия</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!list.data ? (
                <tr className="table__empty">
                  <td colSpan={6} className="skeleton-cell">
                    {skeleton && <span className="skeleton skeleton--row" />}
                  </td>
                </tr>
              ) : (
                list.data.items.map((t) => (
                  <tr key={t.id}>
                    <td className="td-main">
                      <span className="text-strong">{t.name}</span>
                      <span className="table__sub">{t.code}</span>
                    </td>
                    <td className="td-nowrap">{t.kindLabel}</td>
                    <td className="td-nowrap num">{t.numberPrefix}</td>
                    <td>{requiredWords(t)}</td>
                    <td className="td-nowrap">{t.active ? <span className="badge badge--success">Доступен</span> : <span className="badge badge--muted">Отключён</span>}</td>
                    <td className="td-actions">
                      <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>
                        Изменить
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <TypeModal
          type={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onDone={(t) => {
            setEdit(null);
            toast.success('Тип документа сохранён', t.name);
            list.reload(true);
          }}
        />
      )}
    </div>
  );
}
