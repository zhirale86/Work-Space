import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorText } from '../../api/client';
import { useApi, useDelayed, useDocumentTitle } from '../../api/hooks';
import type { AdminResetPasswordResponse, AdminUser, Department, Page, SystemRole } from '../../api/types';
import { Icon } from '../../components/Icon';
import { MoreMenu } from '../../components/Menu';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { Pagination } from '../../components/Pagination';
import { useToast } from '../../components/Toast';
import { Alert, Button, Empty, Field, LoadError } from '../../components/ui';
import { ROLE_HINTS } from '../../lib/status';
import { useMe } from '../../layout/Auth';

const ROLES: { code: SystemRole; label: string }[] = [
  { code: 'employee', label: 'Сотрудник' },
  { code: 'signer', label: 'Утверждающий' },
  { code: 'admin', label: 'Администратор' },
  { code: 'auditor', label: 'Контроль документов' },
];

/** Временный пароль: 12 символов без похожих букв, с цифрой и знаком. */
function tempPassword(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
  const d = '23456789';
  const s = '!#%+=?';
  const pick = (set: string) => set[crypto.getRandomValues(new Uint32Array(1))[0] % set.length];
  const chars = [...Array.from({ length: 9 }, () => pick(a)), pick(d), pick(d), pick(s)];
  return chars.sort(() => (crypto.getRandomValues(new Uint8Array(1))[0] > 127 ? 1 : -1)).join('');
}

function PasswordModal({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal
      title="Временный пароль"
      size="sm"
      onClose={onClose}
      initialFocus=".btn--primary"
      footer={
        <Button variant="primary" onClick={onClose}>
          Готово
        </Button>
      }
    >
      <p>Пароль для {name}:</p>
      <div className="temp-password">
        <code className="temp-password__value">{password}</code>
        <Button size="sm" icon="link" onClick={() => navigator.clipboard?.writeText(password).then(() => toast.info('Пароль скопирован.'), () => toast.error('Не удалось скопировать'))}>
          Скопировать
        </Button>
      </div>
      <p className="text-muted">Передайте пароль сотруднику. Пароль показывается один раз; при первом входе сотрудник задаст новый.</p>
    </Modal>
  );
}

function UserModal({ user, departments, onDone, onClose }: { user: AdminUser | null; departments: Department[]; onDone: (u: AdminUser, password?: string) => void; onClose: () => void }) {
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [login, setLogin] = useState(user?.login ?? '');
  const [position, setPosition] = useState(user?.position ?? '');
  const [dept, setDept] = useState<string>(user?.department ? String(user.department.id) : '');
  const [roles, setRoles] = useState<SystemRole[]>(user?.roles ?? ['employee']);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!fullName.trim()) e.fullName = 'Укажите фамилию и имя';
    if (!user && !/^[A-Za-z0-9._-]{3,64}$/.test(login.trim())) e.login = 'Логин: 3–64 символа — латинские буквы, цифры, точка, дефис, подчёркивание';
    if (!dept) e.dept = 'Выберите подразделение';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setFailure(null);
    const finalRoles = Array.from(new Set<SystemRole>(['employee', ...roles]));
    try {
      if (user) {
        const u = await api.patch<AdminUser>(`/admin/users/${user.id}`, { fullName: fullName.trim(), position: position.trim(), departmentId: Number(dept), roles: finalRoles });
        onDone(u);
      } else {
        const password = tempPassword();
        const u = await api.post<AdminUser>('/admin/users', { login: login.trim(), fullName: fullName.trim(), position: position.trim() || undefined, departmentId: Number(dept), roles: finalRoles, password, mustChangePassword: true });
        onDone(u, password);
      }
    } catch (err) {
      const msg = errorText(err);
      if (/логином/.test(msg)) setErrors({ login: 'Логин уже занят' });
      else setFailure(/роль администратора/.test(msg) ? 'Нельзя снять роль администратора у единственного администратора' : msg);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={user ? 'Изменить пользователя' : 'Новый пользователь'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" busy={busy} busyText={user ? 'Сохраняем…' : 'Создаём…'} onClick={submit}>
            {user ? 'Сохранить' : 'Создать'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Фамилия и имя" required htmlFor="u-name" error={errors.fullName} className="form-grid__full">
          <input id="u-name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Логин" required={!user} htmlFor="u-login" error={errors.login} hint={user ? 'Логин не меняется.' : 'Латинские буквы, цифры, точка, дефис.'}>
          <input id="u-login" className="input" value={login} disabled={!!user} autoCapitalize="off" spellCheck={false} onChange={(e) => setLogin(e.target.value)} />
        </Field>
        <Field label="Должность" htmlFor="u-pos">
          <input id="u-pos" className="input" value={position} onChange={(e) => setPosition(e.target.value)} />
        </Field>
        <Field label="Подразделение" required htmlFor="u-dept" error={errors.dept} className="form-grid__full">
          <select id="u-dept" className="select" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">Выберите подразделение</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {!d.active ? ' (скрыто)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset className="fieldset">
        <legend className="field__label">Роли</legend>
        <div className="stack stack--sm">
          {ROLES.map((r) => (
            <label key={r.code} className="checkbox">
              <input type="checkbox" checked={r.code === 'employee' || roles.includes(r.code)} disabled={r.code === 'employee'} onChange={(e) => setRoles((l) => (e.target.checked ? [...l, r.code] : l.filter((x) => x !== r.code)))} />
              <span>
                {r.label}
                <span className="checkbox__hint">{ROLE_HINTS[r.code]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {failure && <Alert tone="danger">{failure}</Alert>}
    </Modal>
  );
}

export function UsersPage() {
  useDocumentTitle('Пользователи');
  const me = useMe();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [qText, setQText] = useState(params.get('q') ?? '');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const query = { q: params.get('q') ?? undefined, departmentId: params.get('departmentId') ?? undefined, role: params.get('role') ?? undefined, active: params.get('active') ?? undefined, page, pageSize: 25 };
  const list = useApi<Page<AdminUser>>('/admin/users', query);
  const depts = useApi<{ items: Department[] }>('/admin/departments');
  const skeleton = useDelayed(list.loading);
  const [edit, setEdit] = useState<AdminUser | null | 'new'>(null);
  const [block, setBlock] = useState<AdminUser | null>(null);
  const [reset, setReset] = useState<AdminUser | null>(null);
  const [pw, setPw] = useState<{ name: string; password: string } | null>(null);

  const set = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? sp.set(k, v) : sp.delete(k));
    if (!('page' in patch)) sp.delete('page');
    setParams(sp);
  };
  useEffect(() => {
    const t = window.setTimeout(() => (params.get('q') ?? '') !== qText.trim() && set({ q: qText.trim() || null }), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qText]);

  const unblock = async (u: AdminUser) => {
    try {
      await api.post(`/admin/users/${u.id}/unblock`);
      toast.success('Учётная запись разблокирована', u.fullName);
      list.reload(true);
    } catch (e) {
      toast.fail('Не удалось разблокировать', e);
    }
  };

  return (
    <div className="stack">
      <div className="row row--between">
        <p className="text-muted">Учётные записи не удаляются — только блокируются.</p>
        <Button variant="primary" icon="plus" onClick={() => setEdit('new')}>
          Добавить пользователя
        </Button>
      </div>
      <div className="filters">
        <div className="filters__row filters__row--admin">
          <label className="field">
            <span className="field__label">Поиск</span>
            <span className="search">
              <Icon name="search" />
              <input className="input" type="search" placeholder="Имя или логин" value={qText} onChange={(e) => setQText(e.target.value)} />
            </span>
          </label>
          <label className="field">
            <span className="field__label">Подразделение</span>
            <select className="select" value={params.get('departmentId') ?? ''} onChange={(e) => set({ departmentId: e.target.value || null })}>
              <option value="">Любое</option>
              {(depts.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Роль</span>
            <select className="select" value={params.get('role') ?? ''} onChange={(e) => set({ role: e.target.value || null })}>
              <option value="">Любая</option>
              {ROLES.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Состояние</span>
            <select className="select" value={params.get('active') ?? ''} onChange={(e) => set({ active: e.target.value || null })}>
              <option value="">Любое</option>
              <option value="true">Активна</option>
              <option value="false">Заблокирована</option>
            </select>
          </label>
        </div>
      </div>
      <div className="table-wrap">
        {list.error ? (
          <LoadError onRetry={() => list.reload()} />
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Сотрудник</th>
                  <th scope="col" className="hide-md">
                    Должность
                  </th>
                  <th scope="col">Подразделение</th>
                  <th scope="col">Роли</th>
                  <th scope="col">Состояние</th>
                  <th scope="col" className="td-actions">
                    <span className="visually-hidden">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.loading && !list.data ? (
                  Array.from({ length: 6 }, (_, i) => (
                    <tr key={i} className="table__empty">
                      <td colSpan={6} className="skeleton-cell">
                        {skeleton && <span className="skeleton skeleton--row" />}
                      </td>
                    </tr>
                  ))
                ) : !list.data?.items.length ? (
                  <tr className="table__empty">
                    <td colSpan={6}>
                      <Empty icon="search" title="Никого не найдено" text="Проверьте написание или сбросьте фильтры." />
                    </td>
                  </tr>
                ) : (
                  list.data.items.map((u) => (
                    <tr key={u.id}>
                      <td className="td-main">
                        <span className="text-strong">{u.fullName}</span>
                        <span className="table__sub">{u.login}</span>
                      </td>
                      <td className="hide-md">{u.position || '—'}</td>
                      <td className="td-nowrap">{u.department?.name ?? '—'}</td>
                      <td>
                        <span className="row row--sm">
                          {u.roleLabels.map((r) => (
                            <span key={r} className="chip chip--static">
                              {r}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="td-nowrap">{u.active ? <span className="badge badge--success">Активна</span> : <span className="badge badge--muted">Заблокирована</span>}</td>
                      <td className="td-actions">
                        <MoreMenu
                          small
                          label={`Действия: ${u.fullName}`}
                          items={[
                            { label: 'Изменить', onSelect: () => setEdit(u) },
                            { label: 'Сбросить пароль', onSelect: () => setReset(u) },
                            { label: 'Заблокировать', danger: true, divider: true, hidden: !u.active || u.id === me.id, onSelect: () => setBlock(u) },
                            { label: 'Разблокировать', divider: true, hidden: u.active, onSelect: () => void unblock(u) },
                          ]}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            {list.data && list.data.total > 0 && <Pagination page={page} pageSize={25} total={list.data.total} onPage={(p) => set({ page: String(p) })} />}
          </>
        )}
      </div>
      {edit && (
        <UserModal
          user={edit === 'new' ? null : edit}
          departments={depts.data?.items ?? []}
          onClose={() => setEdit(null)}
          onDone={(u, password) => {
            setEdit(null);
            list.reload(true);
            toast.success(password ? 'Пользователь создан' : 'Изменения сохранены', u.fullName);
            if (password) setPw({ name: u.fullName, password });
          }}
        />
      )}
      {block && (
        <ConfirmDialog
          title={`Заблокировать ${block.fullName}?`}
          text="Сотрудник не сможет войти. Его документы и история сохранятся. Незавершённые шаги согласований останутся за ним — инициаторы смогут заменить участника."
          confirmText="Заблокировать"
          busyText="Блокируем…"
          onClose={() => setBlock(null)}
          onConfirm={async () => {
            await api.post(`/admin/users/${block.id}/block`);
            toast.success('Учётная запись заблокирована', block.fullName);
            setBlock(null);
            list.reload(true);
          }}
        />
      )}
      {reset && (
        <ConfirmDialog
          title={`Сбросить пароль ${reset.fullName}?`}
          text="Система создаст временный пароль. При первом входе сотрудник задаст новый."
          confirmText="Сбросить пароль"
          busyText="Сбрасываем…"
          onClose={() => setReset(null)}
          onConfirm={async () => {
            const r = await api.post<AdminResetPasswordResponse>(`/admin/users/${reset.id}/reset-password`);
            setPw({ name: reset.fullName, password: r.temporaryPassword });
            setReset(null);
          }}
        />
      )}
      {pw && <PasswordModal name={pw.name} password={pw.password} onClose={() => setPw(null)} />}
    </div>
  );
}
