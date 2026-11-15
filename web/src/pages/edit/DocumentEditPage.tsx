import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, errorText, upload } from '../../api/client';
import { useApi, useDocumentTitle } from '../../api/hooks';
import type { Deal, DocKind, DocType, DocumentDetail, FileItem, RouteMode, UpdateDocumentRequest, UserRef } from '../../api/types';
import { DEFAULT_EXTS, Dropzone, EXCEL_EXTS, FileList, FilePickButton, UploadRow, checkFile, type FileProblem } from '../../components/Files';
import { Icon } from '../../components/Icon';
import { MoreMenu } from '../../components/Menu';
import { ConfirmDialog, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { UserPicker } from '../../components/UserPicker';
import { Alert, Button, DocStatusBadge, Field, LoadError, Loading, PageHeader, cx } from '../../components/ui';
import { count, dateTimeFull, dueFromDay, ext, isoDay, joinRu, NBSP, time } from '../../lib/format';
import { docEditPath, docPath } from '../../lib/status';
import { useMe } from '../../layout/Auth';
import { NoAccess } from '../Misc';
import { DealField } from './DealField';

interface FormState {
  title: string;
  titleAuto: boolean;
  description: string;
  deal: Deal | null;
  due: string;
  routeMode: RouteMode;
  approvers: UserRef[];
  observers: UserRef[];
  signer: UserRef[];
  acquaintance: UserRef[];
  orderDate: string;
}

const EMPTY: FormState = { title: '', titleAuto: false, description: '', deal: null, due: '', routeMode: 'sequential', approvers: [], observers: [], signer: [], acquaintance: [], orderDate: '' };

interface Upload {
  key: number;
  file: File;
  role: 'main' | 'attachment';
  versionOf?: number;
  percent: number;
  error: string | null;
  abort?: () => void;
}

interface Check {
  key: string;
  label: string;
  done: boolean;
  optional?: boolean;
  doneNote?: string;
  missingNote: string;
  /** Что осталось сделать — для строки под кнопкой. */
  remain: string;
  target: string;
}

function formFromDoc(d: DocumentDetail): FormState {
  return {
    title: d.title,
    titleAuto: false,
    description: d.description,
    deal: d.deal ? { id: d.deal.id, title: d.deal.title ?? `Сделка № ${d.deal.id}`, url: d.deal.url } : null,
    due: d.dueAt ? isoDay(new Date(d.dueAt)) : '',
    routeMode: d.routeMode,
    approvers: d.approvers,
    observers: d.observers,
    signer: d.signer ? [d.signer] : [],
    acquaintance: d.acquaintance,
    orderDate: d.orderDate ?? '',
  };
}

function payloadOf(f: FormState, kind: DocKind): UpdateDocumentRequest {
  const p: UpdateDocumentRequest = {
    title: f.title.trim(),
    description: f.description,
    dueAt: f.due ? dueFromDay(f.due) : null,
    routeMode: f.routeMode,
    approverIds: f.approvers.map((u) => u.id),
    observerIds: f.observers.map((u) => u.id),
  };
  if (kind === 'approval') p.dealId = f.deal?.id ?? null;
  else {
    p.signerId = f.signer[0]?.id ?? null;
    p.acquaintanceIds = f.acquaintance.map((u) => u.id);
    p.orderDate = f.orderDate || null;
  }
  return p;
}

/** Только изменившиеся поля — чтобы в истории не появлялись пустые правки. */
function diff(next: UpdateDocumentRequest, prev: UpdateDocumentRequest | null): UpdateDocumentRequest {
  if (!prev) return next;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) if (JSON.stringify(v) !== JSON.stringify((prev as Record<string, unknown>)[k])) out[k] = v;
  return out as UpdateDocumentRequest;
}

function resolveType(types: DocType[], kind: DocKind, param: string | null): DocType | null {
  const list = types.filter((t) => t.kind === kind && t.active);
  if (param) {
    const p = param.toLowerCase();
    const alias = p === 'gpm' ? 'gpm' : p === 'other' ? 'approval' : p;
    const found = list.find((t) => t.code.toLowerCase() === alias || String(t.id) === p);
    if (found) return found;
  }
  return list.find((t) => !t.requireExcel) ?? list[0] ?? null;
}

const isGpm = (t: DocType) => t.requireExcel || t.code.toUpperCase() === 'GPM';

const today = () => isoDay(new Date());

export function DocumentEditPage({ kind }: { kind: DocKind }) {
  const { id: idParam } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const types = useApi<{ items: DocType[] }>('/doc-types');

  const [docId, setDocId] = useState<number | null>(idParam ? Number(idParam) : null);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchProblems, setLaunchProblems] = useState<string[] | null>(null);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [mainError, setMainError] = useState<FileProblem | null>(null);
  const [attError, setAttError] = useState<FileProblem | null>(null);
  const [dueError, setDueError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deptPick, setDeptPick] = useState('');
  const savedPayload = useRef<UpdateDocumentRequest | null>(null);
  const saveChain = useRef<Promise<number | null>>(Promise.resolve(null));
  const formRef = useRef(form);
  formRef.current = form;
  const docIdRef = useRef(docId);
  docIdRef.current = docId;
  const allowNav = useRef(false);
  const seq = useRef(0);

  // Загрузка существующего документа.
  useEffect(() => {
    if (!idParam) return;
    const id = Number(idParam);
    if (doc && doc.id === id) return; // только что созданный черновик — уже в памяти
    setLoadError(null);
    api
      .get<DocumentDetail>(`/documents/${id}`)
      .then((d) => {
        setDoc(d);
        setDocId(d.id);
        const f = formFromDoc(d);
        setForm(f);
        setFiles(d.files);
        savedPayload.current = payloadOf(f, d.kind);
        setDirty(false);
      })
      .catch((e) => setLoadError(e instanceof ApiError ? e : new ApiError(0, 'internal', '')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idParam]);

  const type: DocType | null = doc ? doc.type : types.data ? resolveType(types.data.items, kind, params.get('type')) : null;
  const gpm = !!type && kind === 'approval' && isGpm(type);
  const rework = doc?.status === 'rework';
  const dealLocked = !!doc?.dealLocked;

  const update = (patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
    setLaunchProblems(null);
  };

  /** Сохранение: первое — создание черновика, далее — изменённые поля. Вызовы выстраиваются в очередь. */
  const save = useCallback((): Promise<number | null> => {
    const run = async (): Promise<number | null> => {
      if (!type) return null;
      const f = formRef.current;
      const full = payloadOf(f, kind);
      setSaving(true);
      setSaveError(null);
      try {
        let d: DocumentDetail;
        if (!docIdRef.current) {
          d = await api.post<DocumentDetail>('/documents', { typeId: type.id, ...full, title: full.title || undefined });
          docIdRef.current = d.id;
          setDocId(d.id);
          setDoc(d);
          allowNav.current = true;
          navigate(docEditPath(kind, d.id), { replace: true });
          window.setTimeout(() => (allowNav.current = false), 0);
        } else {
          const body = diff(full, savedPayload.current);
          if (dealLocked) delete body.dealId;
          if (!Object.keys(body).length) {
            if (formRef.current === f) setDirty(false);
            setSavedAt(new Date());
            return docIdRef.current;
          }
          d = await api.patch<DocumentDetail>(`/documents/${docIdRef.current}`, body);
          setDoc(d);
        }
        savedPayload.current = full;
        if (formRef.current === f) setDirty(false);
        setSavedAt(new Date());
        return d.id;
      } catch (e) {
        setSaveError(errorText(e));
        if (e instanceof ApiError && e.details.some((x) => x.field === 'dueAt')) setDueError(e.details.find((x) => x.field === 'dueAt')!.message);
        throw e;
      } finally {
        setSaving(false);
      }
    };
    const p = saveChain.current.catch(() => null).then(run);
    saveChain.current = p.catch(() => null);
    return p;
  }, [type, kind, navigate, dealLocked]);

  // Автосохранение через 2 секунды после изменения.
  useEffect(() => {
    if (!dirty || !type) return;
    if (form.due && form.due < today()) return;
    const t = window.setTimeout(() => void save().catch(() => undefined), 2000);
    return () => window.clearTimeout(t);
  }, [form, dirty, type, save]);

  // Уход со страницы с несохранёнными изменениями.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !allowNav.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ───── Файлы ─────
  const startUpload = async (file: File, role: 'main' | 'attachment', versionOf?: number, key = ++seq.current) => {
    setUploads((l) => [...l.filter((u) => u.key !== key), { key, file, role, versionOf, percent: 0, error: null }]);
    let id: number | null = docIdRef.current;
    try {
      if (!id) id = await save();
    } catch {
      setUploads((l) => l.map((u) => (u.key === key ? { ...u, error: 'Не удалось загрузить: черновик не сохранён' } : u)));
      return;
    }
    if (!id) return;
    const path = versionOf ? `/files/${versionOf}/versions` : `/documents/${id}/files?role=${role}`;
    const h = upload<FileItem>(path, file, (p) => setUploads((l) => l.map((u) => (u.key === key ? { ...u, percent: p } : u))));
    setUploads((l) => l.map((u) => (u.key === key ? { ...u, abort: h.abort } : u)));
    try {
      const item = await h.promise;
      setFiles((fl) => [...fl.filter((x) => x.id !== item.id), item]);
      setUploads((l) => l.filter((u) => u.key !== key));
      setLaunchProblems(null);
      if (versionOf) toast.success(`Загружена версия ${item.currentVersion.versionNo}`, item.currentVersion.originalName);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'aborted') {
        setUploads((l) => l.filter((u) => u.key !== key));
        return;
      }
      const text = e instanceof ApiError && e.code !== 'network' && e.code !== 'internal' ? e.message : 'Не удалось загрузить';
      setUploads((l) => l.map((u) => (u.key === key ? { ...u, error: text, abort: undefined } : u)));
    }
  };

  const mainFile = files.find((f) => f.role === 'main' && !f.deletedAt) ?? null;
  const mainUploading = uploads.some((u) => u.role === 'main' && !u.versionOf && !u.error);

  const onMainFiles = (list: File[]) => {
    const f = list[0];
    const problem = checkFile(f, gpm ? EXCEL_EXTS : DEFAULT_EXTS, gpm);
    setMainError(problem);
    if (!problem) void startUpload(f, 'main');
  };
  const onAttachFiles = (list: File[]) => {
    setAttError(null);
    let hasMain = !!mainFile || mainUploading;
    for (const f of list) {
      const problem = checkFile(f, DEFAULT_EXTS);
      if (problem) {
        setAttError(problem);
        continue;
      }
      // «Другое согласование»: первый загруженный файл становится основным.
      const role = !gpm && kind === 'approval' && !hasMain ? 'main' : 'attachment';
      if (role === 'main') hasMain = true;
      void startUpload(f, role);
    }
  };
  const newVersion = (fi: FileItem, f: File) => {
    const problem = checkFile(f, fi.role === 'main' && gpm ? EXCEL_EXTS : DEFAULT_EXTS, fi.role === 'main' && gpm);
    if (problem) {
      fi.role === 'main' ? setMainError(problem) : setAttError(problem);
      return;
    }
    void startUpload(f, fi.role === 'result' ? 'attachment' : fi.role, fi.id);
  };
  const removeFile = async (fi: FileItem) => {
    try {
      await api.del(`/files/${fi.id}`);
      setFiles((l) => l.filter((x) => x.id !== fi.id));
      toast.success('Файл удалён', fi.currentVersion.originalName);
    } catch (e) {
      toast.fail('Не удалось удалить файл', e);
    }
  };

  // ───── Готовность к запуску ─────
  const checks: Check[] = useMemo(() => {
    if (!type) return [];
    const c: Check[] = [];
    c.push({ key: 'title', label: 'Название', done: !!form.title.trim(), missingNote: 'Введите название', remain: 'ввести название', target: 'f-title' });
    if (kind === 'approval' && type.requireDeal)
      c.push({ key: 'deal', label: 'Сделка Битрикс24', done: !!form.deal, doneNote: form.deal ? `Сделка №${NBSP}${form.deal.id}` : undefined, missingNote: 'Выберите сделку', remain: 'выбрать сделку', target: 'f-deal' });
    if (type.requireExcel) {
      const ok = !!mainFile && EXCEL_EXTS.includes(ext(mainFile.currentVersion.originalName));
      c.push({ key: 'mainFile', label: 'Excel-файл GPM-калькулятора', done: ok, doneNote: ok ? `Версия ${mainFile!.currentVersion.versionNo}` : undefined, missingNote: 'Прикрепите файл XLSX или XLS', remain: 'прикрепить Excel-файл', target: 'f-main' });
    } else if (type.requireFile) {
      c.push({ key: 'mainFile', label: kind === 'order' ? 'Файл приказа' : 'Файл', done: !!mainFile, doneNote: mainFile ? mainFile.currentVersion.originalName : undefined, missingNote: 'Прикрепите файл', remain: 'прикрепить файл', target: 'f-main' });
    }
    if (type.requireDescription) c.push({ key: 'description', label: 'Описание', done: !!form.description.trim(), missingNote: 'Заполните описание', remain: 'заполнить описание', target: 'f-desc' });
    const mode = form.routeMode === 'sequential' ? 'по очереди' : 'одновременно';
    if (kind === 'approval') {
      c.push({ key: 'approvers', label: 'Согласующие', done: form.approvers.length > 0, doneNote: `Выбрано ${form.approvers.length}, ${mode}`, missingNote: 'Выберите хотя бы одного согласующего', remain: 'выбрать согласующих', target: 'f-approvers' });
    } else {
      c.push({ key: 'signer', label: 'Утверждающий', done: form.signer.length > 0, doneNote: form.signer[0]?.fullName, missingNote: 'Выберите утверждающего', remain: 'выбрать утверждающего', target: 'f-signer' });
      c.push({ key: 'approvers', label: 'Согласующие', optional: true, done: form.approvers.length > 0, doneNote: `Выбрано ${form.approvers.length}, ${mode}`, missingNote: 'Необязательно. Без согласующих приказ сразу уйдёт на утверждение', remain: '', target: 'f-approvers' });
      c.push({ key: 'acq', label: 'Список ознакомления', optional: true, done: form.acquaintance.length > 0, doneNote: `Выбрано ${count(form.acquaintance.length, ['сотрудник', 'сотрудника', 'сотрудников'])}`, missingNote: 'Необязательно. Можно дополнить после утверждения', remain: '', target: 'f-acq' });
    }
    c.push({
      key: 'dueAt',
      label: 'Срок',
      optional: !type.requireDeadline,
      done: !!form.due && form.due >= today(),
      doneNote: form.due ? `до ${form.due.split('-').reverse().join('.')}` : undefined,
      missingNote: type.requireDeadline ? 'Укажите срок' : 'Необязательно. Без срока не будет напоминаний',
      remain: 'указать срок',
      target: 'f-due',
    });
    return c;
  }, [type, kind, form, mainFile]);

  const required = checks.filter((c) => !c.optional);
  const doneCount = required.filter((c) => c.done).length;
  const missing = required.filter((c) => !c.done);
  const ready = !missing.length && !uploads.some((u) => !u.error) && !dueError;

  const focusTarget = (id: string) => {
    const el = document.getElementById(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => (el?.matches('input,textarea,select,[tabindex]') ? el : el?.querySelector<HTMLElement>('input,textarea,select,[tabindex="0"]'))?.focus({ preventScroll: true }), 250);
  };

  const launch = async () => {
    setLaunching(true);
    setLaunchProblems(null);
    try {
      const id = (await save()) ?? docIdRef.current;
      if (!id) return;
      const d = await api.post<DocumentDetail>(`/documents/${id}/launch`, { routeMode: kind === 'approval' || form.approvers.length ? form.routeMode : undefined });
      setDirty(false);
      allowNav.current = true;
      const pending = d.rounds[0]?.steps.filter((s) => s.state === 'pending').map((s) => s.user.fullName) ?? [];
      if (kind === 'order') {
        toast.success(d.status === 'on_signing' ? 'Приказ направлен на утверждение' : 'Приказ направлен на согласование', d.status === 'on_signing' && d.signer ? `Документ получил ${d.signer.fullName}.` : pending.length ? `Документ получил ${pending[0]}.` : undefined);
      } else {
        toast.success(rework ? 'Согласование запущено повторно' : 'Согласование запущено', pending.length > 1 ? `Документ получили ${count(pending.length, ['согласующий', 'согласующих', 'согласующих'])}.` : pending[0] ? `Документ получил ${pending[0]}.` : undefined);
      }
      navigate(docPath(kind, d.id));
    } catch (e) {
      if (e instanceof ApiError && e.status === 422 && e.details.length) {
        setLaunchProblems(e.details.map((x) => x.message));
        setHighlight(new Set(e.details.map((x) => (x.field === 'signerId' ? 'signer' : x.field === 'dealId' ? 'deal' : x.field === 'approverIds' ? 'approvers' : x.field))));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else toast.fail(kind === 'order' ? 'Приказ не направлен' : 'Согласование не запущено', e, launch);
    } finally {
      setLaunching(false);
    }
  };

  const saveNow = async () => {
    try {
      await save();
      toast.info('Черновик сохранён.');
    } catch (e) {
      toast.fail('Не удалось сохранить черновик', e, saveNow);
    }
  };

  const addDepartment = async (deptId: string) => {
    setDeptPick('');
    if (!deptId) return;
    try {
      const p = await api.get<{ items: UserRef[] }>('/users', { departmentId: deptId, pageSize: 100 });
      const have = new Set(form.acquaintance.map((u) => u.id));
      const add = p.items.filter((u) => !have.has(u.id));
      update({ acquaintance: [...form.acquaintance, ...add] });
      toast.info(add.length ? `Добавлено ${count(add.length, ['сотрудник', 'сотрудника', 'сотрудников'])}.` : 'Все сотрудники подразделения уже в списке.');
    } catch (e) {
      toast.fail('Не удалось добавить подразделение', e);
    }
  };

  const depts = useApi<{ items: { id: number; name: string }[] }>(kind === 'order' ? '/departments' : null);
  useDocumentTitle(rework ? `Доработка: ${form.title}` : kind === 'order' ? 'Новый приказ' : 'Новое согласование');

  // ───── Отрисовка ─────
  if (loadError) return loadError.status === 404 ? <NoAccess /> : <LoadError title="Не удалось загрузить документ" onRetry={() => window.location.reload()} />;
  if ((idParam && !doc) || (!idParam && !types.data && !types.error)) return <EditSkeleton />;
  if (types.error && !doc) return <LoadError title="Не удалось загрузить типы документов" onRetry={() => types.reload()} />;
  if (!type) return <Alert tone="warning">Тип документа недоступен для создания. Обратитесь к администратору.</Alert>;
  if (doc && !doc.permissions.canEdit) {
    return (
      <div className="stack">
        <Alert tone="info" title="Документ нельзя изменить">
          Изменять можно только черновик или документ на доработке — и только инициатору.
        </Alert>
        <div>
          <Link className="btn btn--secondary" to={docPath(doc.kind, doc.id)}>
            Открыть карточку
          </Link>
        </div>
      </div>
    );
  }

  const reworkRound = doc?.rounds.find((r) => r.outcome === 'rework');
  const reworkStep = reworkRound?.steps.find((s) => s.state === 'rework');
  const lastMainVersion = doc?.rounds[0]?.files.find((f) => f.role === 'main')?.version.versionNo ?? 1;
  const title = rework ? `Доработка: ${form.title || doc?.title}` : kind === 'order' ? 'Новый приказ' : gpm ? 'Новое согласование GPM-калькулятора' : 'Новое согласование';
  const statusBadge = <DocStatusBadge kind={kind} status={rework ? 'rework' : 'draft'} />;
  const launchLabel = rework ? 'Запустить повторно' : kind === 'order' ? (form.approvers.length ? 'Направить на согласование' : 'Направить на утверждение') : 'Запустить согласование';
  const hl = (k: string) => highlight.has(k) && !checks.find((c) => c.key === k)?.done;
  const statusLine = missing.length ? `Осталось ${joinRu(missing.map((m) => m.remain).filter(Boolean))}.` : uploads.some((u) => !u.error) ? 'Дождитесь окончания загрузки файлов.' : 'Всё готово к запуску.';
  const canManageFiles = !doc || doc.permissions.canManageFiles;

  return (
    <>
      <PageHeader
        crumbs={[{ to: kind === 'order' ? '/orders' : '/approvals', label: kind === 'order' ? 'Приказы' : 'Согласования' }, { label: doc?.number ?? 'Новый документ' }]}
        title={title}
        badges={statusBadge}
        meta={
          <>
            <span>{type.name}</span>
            {doc && <span className="num">{doc.number}</span>}
          </>
        }
        actions={
          <>
            <Button onClick={saveNow} busy={saving} busyText="Сохраняем…">
              Сохранить черновик
            </Button>
            {doc && doc.permissions.canDelete && <MoreMenu items={[{ label: 'Удалить черновик', danger: true, onSelect: () => setConfirmDelete(true) }]} />}
          </>
        }
      />

      <div className="layout-split">
        <div className="stack stack--lg">
          {launchProblems && (
            <Alert tone="danger" title={kind === 'order' ? 'Приказ не направлен. Заполните:' : 'Согласование не запущено. Заполните:'}>
              <ul className="bullets">
                {launchProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          )}
          {rework && (
            <>
              <Alert tone="warning">
                {reworkStep
                  ? `${reworkStep.user.fullName}${reworkStep.user.department ? `, ${reworkStep.user.department.name}` : ''}, вернул(а) документ на доработку: «${reworkStep.comment ?? ''}»`
                  : 'Документ возвращён на доработку. Замечания — в истории карточки.'}
              </Alert>
              <Alert tone="info">
                {kind === 'order' ? 'Согласование и утверждение начнутся заново' : 'Согласование начнётся заново для всех согласующих'} — решения по версии {lastMainVersion} останутся в истории.
              </Alert>
            </>
          )}
          {saveError && <Alert tone="danger" title="Черновик не сохранён">{saveError}</Alert>}

          <div className="card">
            {kind === 'approval' && (
              <section className="form-section" aria-labelledby="s-deal">
                <h2 className="form-section__title" id="s-deal">
                  Сделка Битрикс24 {!type.requireDeal && <span className="field__optional">— необязательно</span>}
                </h2>
                <p className="form-section__hint">Согласование появится в сделке среди задач.</p>
                <div id="f-deal-wrap" className={cx(hl('deal') && 'field--error')}>
                  <DealField
                    inputId="f-deal"
                    value={form.deal}
                    locked={dealLocked}
                    invalid={hl('deal')}
                    onChange={(d) => {
                      const auto = !form.title.trim() || form.titleAuto;
                      update({ deal: d, ...(d && auto ? { title: gpm ? `GPM-калькулятор — ${d.title}` : d.title, titleAuto: true } : {}) });
                    }}
                  />
                  {dealLocked && <p className="field__hint">Сделку можно изменить только до первого запуска.</p>}
                </div>
              </section>
            )}

            <section className="form-section" aria-labelledby="s-title">
              <h2 className="form-section__title" id="s-title">
                Название и описание
              </h2>
              <div className="form-grid">
                <Field label="Название" required htmlFor="f-title" className="form-grid__full" error={hl('title') ? 'Введите название' : null} hint={form.titleAuto ? 'Подставлено из названия сделки. Можно изменить до запуска.' : undefined}>
                  <input id="f-title" className="input" type="text" maxLength={300} value={form.title} onChange={(e) => update({ title: e.target.value, titleAuto: false })} />
                </Field>
                {kind === 'order' && (
                  <Field label="Дата приказа" optional htmlFor="f-odate" hint="Если не указать, проставится при утверждении.">
                    <input id="f-odate" className="input input--date" type="date" value={form.orderDate} onChange={(e) => update({ orderDate: e.target.value })} />
                  </Field>
                )}
                <Field label="Описание" optional={!type.requireDescription} required={type.requireDescription} htmlFor="f-desc" className="form-grid__full" error={hl('description') ? 'Заполните описание' : null}>
                  <textarea id="f-desc" className="textarea" rows={3} placeholder="Что важно знать согласующим" value={form.description} onChange={(e) => update({ description: e.target.value })} />
                </Field>
              </div>
            </section>

            <section className="form-section" aria-labelledby="s-files">
              <h2 className="form-section__title" id="s-files">
                Файлы
              </h2>
              {!canManageFiles && <p className="form-section__hint">Файлы сейчас изменить нельзя.</p>}
              <div className="stack" id="f-main">
                {(gpm || kind === 'order') && !mainFile && !mainUploading && (
                  <Dropzone
                    title={gpm ? 'Перетащите Excel-файл GPM-калькулятора или выберите на компьютере' : 'Перетащите файл приказа или выберите на компьютере'}
                    hint={gpm ? 'XLSX или XLS, до 50 МБ' : 'DOCX, DOC, PDF, XLSX, XLS, JPG, PNG — до 50 МБ'}
                    accept={gpm ? EXCEL_EXTS : DEFAULT_EXTS}
                    error={mainError ?? (hl('mainFile') ? { title: gpm ? 'Прикрепите Excel-файл GPM-калькулятора' : 'Прикрепите файл', hint: gpm ? 'XLSX или XLS, до 50 МБ' : 'Без основного файла запуск невозможен.' } : null)}
                    disabled={!canManageFiles}
                    onFiles={onMainFiles}
                  />
                )}
                {(files.length > 0 || uploads.length > 0) && (
                  <div className="stack stack--sm">
                    <FileList
                      files={files}
                      rounds={doc?.rounds}
                      emptyText=""
                      rowActions={(fi) =>
                        canManageFiles && (
                          <>
                            <FilePickButton accept={fi.role === 'main' && gpm ? EXCEL_EXTS : DEFAULT_EXTS} busy={uploads.some((u) => u.versionOf === fi.id && !u.error)} onFile={(f) => newVersion(fi, f)}>
                              Новая версия
                            </FilePickButton>
                            {!rework && (
                              <Button variant="ghost" size="sm" iconOnly icon="x" aria-label={`Удалить файл ${fi.currentVersion.originalName}`} title="Удалить файл" onClick={() => void removeFile(fi)} />
                            )}
                          </>
                        )
                      }
                    />
                    {uploads.length > 0 && (
                      <ul className="files">
                        {uploads.map((u) => (
                          <UploadRow key={u.key} name={u.versionOf ? `${u.file.name} — новая версия` : u.file.name} percent={u.percent} error={u.error} onCancel={u.abort} onRetry={() => void startUpload(u.file, u.role, u.versionOf, u.key)} />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {mainError && (mainFile || mainUploading) && <Alert tone="danger" title={mainError.title}>{mainError.hint}</Alert>}
                {gpm || kind === 'order' ? (
                  <Dropzone compact multiple title="Добавить приложения" hint="XLSX, XLS, DOCX, DOC, PDF, JPG, PNG — до 50 МБ каждый" accept={DEFAULT_EXTS} error={attError} disabled={!canManageFiles} onFiles={onAttachFiles} />
                ) : (
                  <Dropzone
                    multiple
                    compact={!!mainFile}
                    title={mainFile ? 'Добавить файлы' : 'Перетащите файлы или выберите на компьютере'}
                    hint={mainFile ? 'XLSX, XLS, DOCX, DOC, PDF, JPG, PNG — до 50 МБ каждый' : 'Первый загруженный файл станет основным. XLSX, XLS, DOCX, DOC, PDF, JPG, PNG — до 50 МБ'}
                    accept={DEFAULT_EXTS}
                    error={attError ?? (hl('mainFile') ? { title: 'Прикрепите файл', hint: 'Без основного файла запуск невозможен.' } : null)}
                    disabled={!canManageFiles}
                    onFiles={onAttachFiles}
                  />
                )}
              </div>
            </section>

            <section className="form-section" aria-labelledby="s-route">
              <h2 className="form-section__title" id="s-route">
                Согласующие {kind === 'order' && <span className="field__optional">— необязательно</span>}
              </h2>
              <div className="stack">
                <div className="field">
                  <span className="field__label" id="l-mode">
                    Порядок согласования
                  </span>
                  <div className="segmented" role="radiogroup" aria-labelledby="l-mode">
                    {(['sequential', 'parallel'] as RouteMode[]).map((m) => (
                      <button key={m} type="button" role="radio" aria-checked={form.routeMode === m} className={cx('segmented__item', form.routeMode === m && 'is-active')} onClick={() => update({ routeMode: m })}>
                        {m === 'sequential' ? 'По очереди' : 'Одновременно'}
                      </button>
                    ))}
                  </div>
                </div>
                <Field
                  label={kind === 'order' ? 'Согласующие' : 'Согласующие'}
                  required={kind === 'approval'}
                  htmlFor="f-approvers"
                  error={hl('approvers') ? 'Выберите хотя бы одного согласующего' : null}
                  hint={
                    form.approvers.length === 0
                      ? 'Поиск по имени, должности и подразделению.'
                      : form.routeMode === 'sequential'
                        ? `Документ пойдёт по очереди: ${form.approvers.length === 1 ? form.approvers[0].fullName : `сначала ${form.approvers[0].fullName}, затем ${joinRu(form.approvers.slice(1).map((u) => u.fullName))}`}. Порядок меняется перетаскиванием или стрелками на метке.`
                        : 'Все получат документ одновременно. Нужны решения всех.'
                  }
                >
                  <UserPicker inputId="f-approvers" ordered={form.routeMode === 'sequential'} value={form.approvers} invalid={hl('approvers')} excludeIds={[me.id]} excludeHint="Инициатор не может быть согласующим" ariaLabel="Добавить согласующего" onChange={(u) => update({ approvers: u })} />
                </Field>
                <Field label="Наблюдатели" optional htmlFor="f-observers" hint="Видят карточку и историю, решений не принимают.">
                  <UserPicker inputId="f-observers" value={form.observers} excludeIds={[me.id]} excludeHint="Инициатор видит карточку и так" ariaLabel="Добавить наблюдателя" onChange={(u) => update({ observers: u })} />
                </Field>
              </div>
            </section>

            {kind === 'order' && (
              <>
                <section className="form-section" aria-labelledby="s-signer">
                  <h2 className="form-section__title" id="s-signer">
                    Утверждающий <span className="field__required">*</span>
                  </h2>
                  <p className="form-section__hint">Сотрудник с полномочием «Утверждающий». После утверждения файлы приказа изменить нельзя.</p>
                  <Field label="Утверждающий" required htmlFor="f-signer" error={hl('signer') ? 'Выберите утверждающего' : null}>
                    <UserPicker inputId="f-signer" single role="signer" value={form.signer} invalid={hl('signer')} ariaLabel="Выбрать утверждающего" placeholder="Начните вводить фамилию утверждающего" onChange={(u) => update({ signer: u })} />
                  </Field>
                </section>
                <section className="form-section" aria-labelledby="s-acq">
                  <h2 className="form-section__title" id="s-acq">
                    Ознакомление
                  </h2>
                  <p className="form-section__hint">Сотрудники получат приказ после утверждения и подтвердят ознакомление.</p>
                  <div className="stack">
                    <Field label="Сотрудники" htmlFor="f-acq" hint={form.acquaintance.length ? `Выбрано ${count(form.acquaintance.length, ['сотрудник', 'сотрудника', 'сотрудников'])}` : 'Можно выбрать сотрудников по одному или подразделение целиком.'}>
                      <UserPicker inputId="f-acq" value={form.acquaintance} ariaLabel="Добавить в список ознакомления" onChange={(u) => update({ acquaintance: u })} />
                    </Field>
                    <div className="form-grid">
                      <Field label="Добавить подразделение целиком" htmlFor="f-acq-dept">
                        <select id="f-acq-dept" className="select" value={deptPick} onChange={(e) => void addDepartment(e.target.value)}>
                          <option value="">Выберите подразделение</option>
                          {(depts.data?.items ?? []).map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                  </div>
                </section>
              </>
            )}

            <section className="form-section" aria-labelledby="s-due">
              <h2 className="form-section__title" id="s-due">
                Срок
              </h2>
              <div className="form-grid">
                <Field label={kind === 'order' ? 'Срок согласования и ознакомления' : 'Срок согласования'} optional={!type.requireDeadline} required={type.requireDeadline} htmlFor="f-due" error={dueError ?? (hl('dueAt') ? 'Укажите срок' : null)} hint="Участники получат напоминание за сутки до срока.">
                  <input
                    id="f-due"
                    className="input input--date"
                    type="date"
                    min={today()}
                    value={form.due}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDueError(v && v < today() ? 'Дата в прошлом недопустима — выберите сегодняшнюю или более позднюю.' : null);
                      update({ due: v });
                    }}
                  />
                </Field>
              </div>
            </section>
          </div>
        </div>

        <aside className="layout-split__aside layout-split__aside--sticky">
          <section className="card" aria-labelledby="h-ready">
            <header className="card__header">
              <h2 className="card__title" id="h-ready">
                Готовность к запуску
              </h2>
              <span className="text-sm text-muted num">
                {doneCount} из {required.length}
              </span>
            </header>
            <div className="card__body stack">
              <div className={cx('progress', doneCount === required.length && 'progress--done')} role="progressbar" aria-valuenow={Math.round((doneCount / Math.max(1, required.length)) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={`Заполнено ${doneCount} из ${required.length} обязательных пунктов`}>
                <div className="progress__bar" style={{ width: `${(doneCount / Math.max(1, required.length)) * 100}%` }} />
              </div>
              <div className="checklist">
                {checks.map((c) => (
                  <button key={c.key} type="button" className={cx('checklist__item', c.done ? 'is-done' : c.optional ? 'is-optional' : 'is-missing')} onClick={() => focusTarget(c.target)}>
                    <span className="checklist__mark">
                      <Icon name="check" />
                    </span>
                    <span className="checklist__text">
                      {c.label}
                      <span className="checklist__note">{c.done ? c.doneNote : c.missingNote}</span>
                    </span>
                  </button>
                ))}
              </div>
              <Button variant="primary" block disabled={!ready} busy={launching} busyText="Запускаем…" onClick={launch}>
                {launchLabel}
              </Button>
              <p className="text-sm text-muted" aria-live="polite">
                {statusLine}
                {saving ? ' Сохраняем черновик…' : savedAt ? ` Черновик сохранён в ${time(savedAt)}.` : doc ? ` Изменено ${dateTimeFull(doc.updatedAt)}.` : ''}
              </p>
            </div>
          </section>
        </aside>
      </div>

      {confirmDelete && doc && (
        <ConfirmDialog
          title="Удалить черновик?"
          text="Черновик и прикреплённые к нему файлы будут удалены без возможности восстановления."
          confirmText="Удалить черновик"
          busyText="Удаляем…"
          cancelText="Не удалять"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await api.del(`/documents/${doc.id}`);
            setDirty(false);
            allowNav.current = true;
            toast.success('Черновик удалён');
            navigate(kind === 'order' ? '/orders' : '/approvals');
          }}
        />
      )}

      {blocker.state === 'blocked' && (
        <Modal
          title="Сохранить изменения?"
          size="sm"
          onClose={() => blocker.reset()}
          footer={
            <>
              <Button variant="ghost" onClick={() => blocker.proceed()}>
                Не сохранять
              </Button>
              <Button
                variant="primary"
                busy={saving}
                busyText="Сохраняем…"
                onClick={async () => {
                  try {
                    await save();
                    blocker.proceed();
                  } catch (e) {
                    blocker.reset();
                    toast.fail('Не удалось сохранить черновик', e);
                  }
                }}
              >
                Сохранить черновик
              </Button>
            </>
          }
        >
          <p>В черновике есть несохранённые изменения. Если уйти без сохранения, они пропадут.</p>
        </Modal>
      )}
    </>
  );
}

function EditSkeleton() {
  return (
    <Loading>
      <div className="stack">
        <span className="skeleton skeleton--title" />
        <div className="layout-split">
          <div className="card card__body stack">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="skeleton skeleton--row" />
            ))}
          </div>
          <div className="card card__body stack">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="skeleton skeleton--text" />
            ))}
          </div>
        </div>
      </div>
    </Loading>
  );
}
