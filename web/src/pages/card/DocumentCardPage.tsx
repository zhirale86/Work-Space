import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, upload } from '../../api/client';
import { useDocumentTitle, useInterval } from '../../api/hooks';
import type { BitrixRetryResponse, DocKind, DocumentDetail, FileItem, FileVersion, HistoryEntry, Page, UserRef } from '../../api/types';
import { DEFAULT_EXTS, Dropzone, EXCEL_EXTS, FileList, FilePickButton, checkFile, downloadVersion } from '../../components/Files';
import { Icon } from '../../components/Icon';
import { MoreMenu, type MenuItem } from '../../components/Menu';
import { ConfirmDialog } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Alert, Avatar, Button, Card, DocStatusBadge, Due, LoadError, Loading, OverdueBadge, PageHeader, TaskStatusBadge, cx } from '../../components/ui';
import { count, date, dateTime, DAYS, joinRu, NBSP, ofCount, ordinal, time } from '../../lib/format';
import { absoluteUrl, docEditPath, docPath } from '../../lib/status';
import { useCounters } from '../../layout/AppLayout';
import { useMe } from '../../layout/Auth';
import { NoAccess } from '../Misc';
import { TaskCreateModal } from '../tasks/TaskCreateModal';
import { AccessModal, AcquaintanceModal, ApproveModal, RouteModal } from './dialogs';
import { DealCard, HistoryCard, InfoCard, RouteCard } from './parts';
import { AcknowledgementTab } from './AcknowledgementTab';

type Dialog =
  | null
  | 'approve'
  | 'rework'
  | 'reject'
  | 'cancel'
  | 'route'
  | 'access'
  | 'sign'
  | 'sign-rework'
  | 'sign-reject'
  | 'archive'
  | 'acq'
  | 'task';

interface Panel {
  title: string;
  text?: ReactNode;
  actions?: ReactNode;
  calm: boolean;
  extra?: ReactNode;
}

const ackKey = (id: number) => `docflow:opened:${id}`;

function readOpened(id: number): boolean {
  try {
    return sessionStorage.getItem(ackKey(id)) === '1';
  } catch {
    return false;
  }
}

function daysAt(iso: string | null): string {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d < 1 ? 'меньше суток' : count(d, DAYS);
}

export function DocumentCardPage({ kind }: { kind: DocKind }) {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const { refresh: refreshCounters } = useCounters();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [routeFrom, setRouteFrom] = useState<number | undefined>();
  const [stale, setStale] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [syncedJustNow, setSyncedJustNow] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [opened, setOpened] = useState(() => readOpened(id));
  const [uploading, setUploading] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const tab = params.get('tab') ?? 'main';

  const loadHistory = useCallback(() => {
    api
      .get<Page<HistoryEntry>>(`/documents/${id}/history`, { pageSize: 100 })
      .then((p) => setHistory(p.items))
      .catch(() => undefined);
  }, [id]);

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setError(null);
      return api
        .get<DocumentDetail>(`/documents/${id}`)
        .then((d) => {
          setDoc(d);
          setChanged(false);
          setStale(null);
          loadHistory();
          return d;
        })
        .catch((e) => {
          if (!quiet) setError(e instanceof ApiError ? e : new ApiError(0, 'internal', ''));
          return null;
        });
    },
    [id, loadHistory],
  );

  useEffect(() => {
    setDoc(null);
    setOpened(readOpened(id));
    void load();
  }, [load, id]);

  const apply = (d: DocumentDetail) => {
    setDoc(d);
    setChanged(false);
    loadHistory();
    refreshCounters();
  };

  // Карточку изменили, пока она открыта, — предлагаем обновить; ожидание передачи — обновляем сами.
  useInterval(
    () => {
      if (!doc || dialog) return;
      api
        .get<DocumentDetail>(`/documents/${id}`)
        .then((d) => {
          if (doc.bitrix?.state === 'pending' && d.updatedAt === doc.updatedAt) setDoc(d);
          else if (d.updatedAt !== doc.updatedAt) setChanged(true);
        })
        .catch(() => undefined);
    },
    doc?.bitrix?.state === 'pending' ? 5000 : 30000,
    !!doc,
  );

  const title = doc?.title || doc?.number;
  useDocumentTitle(title ?? (kind === 'order' ? 'Приказ' : 'Согласование'));

  const markOpened = (v: FileVersion) => {
    if (!doc) return;
    const main = doc.files.find((f) => f.role === 'main');
    if (main && main.versions.some((x) => x.id === v.id)) {
      setOpened(true);
      try {
        sessionStorage.setItem(ackKey(doc.id), '1');
      } catch {
        /* хранилище недоступно — флаг живёт до перезагрузки */
      }
    }
  };

  const handleStale = (e: unknown): boolean => {
    if (e instanceof ApiError && e.status === 409) {
      setDialog(null);
      setStale(e.message.includes('отмен') ? 'Решение больше не требуется: согласование отменено.' : `Решение больше не требуется: ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}`);
      return true;
    }
    return false;
  };

  const decide = (decision: 'approve' | 'rework' | 'reject', endpoint: 'decision' | 'sign') => async (c: string) => {
    try {
      const d = await api.post<DocumentDetail>(`/documents/${id}/${endpoint}`, { decision, comment: c || undefined });
      setDialog(null);
      apply(d);
      const msg =
        endpoint === 'sign'
          ? decision === 'approve'
            ? 'Приказ утверждён и направлен на ознакомление'
            : decision === 'rework'
              ? 'Приказ возвращён на доработку'
              : 'Приказ отклонён'
          : decision === 'approve'
            ? 'Вы согласовали документ'
            : decision === 'rework'
              ? 'Документ возвращён на доработку'
              : 'Согласование отклонено';
      toast.success(msg);
    } catch (e) {
      if (!handleStale(e)) throw e;
    }
  };

  const retryBitrix = async () => {
    setRetrying(true);
    try {
      const r = await api.post<BitrixRetryResponse>(`/documents/${id}/bitrix/retry`);
      if (r.bitrix.state === 'synced') {
        toast.success('Статус передан в Битрикс24');
        setSyncedJustNow(true);
      } else toast.error('Не удалось передать статус', r.bitrix.lastError ?? 'Битрикс24 не ответил. Повторим автоматически.', retryBitrix);
      setDoc((d) => (d ? { ...d, bitrix: r.bitrix } : d));
      loadHistory();
    } catch (e) {
      toast.fail('Не удалось передать статус', e, retryBitrix);
    } finally {
      setRetrying(false);
    }
  };

  const relaunch = async () => {
    if (!doc) return;
    setLaunching(true);
    try {
      const d = await api.post<DocumentDetail>(`/documents/${id}/launch`, { routeMode: doc.routeMode });
      apply(d);
      const pending = d.rounds[0]?.steps.filter((s) => s.state === 'pending') ?? [];
      toast.success(kind === 'order' ? (d.status === 'on_signing' ? 'Приказ направлен на утверждение' : 'Приказ направлен на согласование') : 'Согласование запущено повторно', pending.length > 1 ? `Документ получили ${count(pending.length, ['согласующий', 'согласующих', 'согласующих'])}.` : pending[0] ? `Документ получил ${pending[0].user.fullName}.` : undefined);
    } catch (e) {
      if (e instanceof ApiError && e.details.length) toast.error('Запуск невозможен', e.details.map((x) => x.message).join('; '));
      else toast.fail('Согласование не запущено', e, relaunch);
    } finally {
      setLaunching(false);
    }
  };

  const uploadTo = async (path: string, f: File, okText: string) => {
    setUploading(true);
    setAttachError(null);
    try {
      await upload<FileItem>(path, f).promise;
      toast.success(okText, f.name);
      await load(true);
    } catch (e) {
      toast.fail('Не удалось загрузить', e);
    } finally {
      setUploading(false);
    }
  };

  const sendComment = async () => {
    if (!comment.trim()) return;
    setSending(true);
    try {
      await api.post(`/documents/${id}/comments`, { body: comment.trim() });
      setComment('');
      toast.success('Комментарий отправлен');
      await load(true);
    } catch (e) {
      toast.fail('Комментарий не отправлен', e, sendComment);
    } finally {
      setSending(false);
    }
  };

  const ack = useMemo(() => doc?.acknowledgements ?? null, [doc]);

  if (error) return error.status === 404 || error.status === 400 ? <NoAccess /> : <LoadError title="Не удалось загрузить карточку" onRetry={() => void load()} />;
  if (!doc) return <CardSkeleton />;
  if (doc.kind !== kind) {
    navigate(docPath(doc.kind, doc.id), { replace: true });
    return null;
  }

  const order = doc.kind === 'order';
  const p = doc.permissions;
  const isInitiator = doc.initiator.id === me.id;
  const round = doc.rounds[0] && !doc.rounds[0].finishedAt ? doc.rounds[0] : null;
  const lastRound = doc.rounds[0] ?? null;
  const pending = round?.steps.filter((s) => s.state === 'pending') ?? [];
  const live = round?.steps.filter((s) => s.state !== 'replaced') ?? [];
  const mainFile = doc.files.find((f) => f.role === 'main') ?? null;
  const reworkStep = lastRound?.steps.find((s) => s.state === 'rework');
  const rejectStep = lastRound?.steps.find((s) => s.state === 'rejected');
  const cancelEntry = history.find((h) => h.action === 'document.cancelled');
  const signEntry = history.find((h) => h.action === 'order.returned' || h.action === 'order.rejected');
  const prevRework = doc.rounds[1]?.steps.find((s) => s.state === 'rework');
  const mainVersion = mainFile?.currentVersion.versionNo ?? 1;
  const ackPending = ack ? ack.items.filter((i) => !i.acknowledgedAt && i.user.active) : [];
  const ackLate = doc.dueAt && new Date(doc.dueAt).getTime() < Date.now() ? ackPending.length : 0;

  // ───── Блок ожидаемого действия ─────
  const panel = ((): Panel => {
    if (p.canDecide && doc.myStep) {
      const s = doc.myStep;
      const n = live.length;
      const pos = live.filter((x) => x.position <= s.position).length;
      let text =
        round?.mode === 'parallel'
          ? `Документ рассматривают одновременно ${n} ${n === 1 ? 'согласующий' : 'согласующих'} — нужны решения всех.`
          : n > 1
            ? `Вы — ${ordinal(pos)} согласующий из ${ofCount(n)}.`
            : 'Вы — единственный согласующий.';
      if (doc.launchCount > 1) text += ` Рассмотрите версию${NBSP}${mainVersion} файла: ${doc.initiator.fullName} доработал(а) её${prevRework?.user.department ? ` по замечанию ${prevRework.user.department.name}` : ' по замечаниям'}.`;
      return {
        title: 'Ожидается ваше решение',
        text,
        calm: false,
        actions: (
          <>
            <Button variant="primary" icon="check" onClick={() => setDialog('approve')}>
              Согласовать
            </Button>
            <Button onClick={() => setDialog('rework')}>Вернуть на доработку</Button>
            <Button variant="danger" onClick={() => setDialog('reject')}>
              Отклонить
            </Button>
          </>
        ),
      };
    }
    if (p.canSign) {
      const approved = (lastRound?.steps ?? []).filter((s) => s.state === 'approved').map((s) => s.user.fullName);
      return {
        title: 'Приказ ждёт вашего утверждения',
        text: approved.length ? `Согласовали: ${joinRu(approved)}.` : 'Приказ направлен на утверждение без согласующих.',
        calm: false,
        actions: (
          <>
            <Button variant="primary" icon="check" onClick={() => setDialog('sign')}>
              Утвердить
            </Button>
            <Button onClick={() => setDialog('sign-rework')}>Вернуть на доработку</Button>
            <Button variant="danger" onClick={() => setDialog('sign-reject')}>
              Отклонить
            </Button>
          </>
        ),
      };
    }
    if (order && doc.myAcknowledgement.required && !doc.myAcknowledgement.acknowledgedAt && p.canAcknowledge) {
      return {
        title: 'Ознакомьтесь с приказом',
        text: `Откройте файл приказа и подтвердите ознакомление.${doc.dueAt ? ` Срок — до ${date(doc.dueAt)}.` : ''}`,
        calm: false,
        actions: (
          <>
            <Button
              variant="primary"
              icon="check"
              disabled={!opened}
              onClick={async () => {
                try {
                  const d = await api.post<DocumentDetail>(`/documents/${id}/acknowledge`);
                  apply(d);
                  toast.success('Ознакомление подтверждено');
                } catch (e) {
                  toast.fail('Ознакомление не подтверждено', e);
                }
              }}
            >
              Подтвердить ознакомление
            </Button>
            {mainFile && (
              <Button
                icon="download"
                onClick={async () => {
                  try {
                    await downloadVersion(mainFile.currentVersion);
                    markOpened(mainFile.currentVersion);
                  } catch {
                    toast.error('Не удалось скачать файл.', 'Проверьте подключение и попробуйте ещё раз.');
                  }
                }}
              >
                Скачать приказ
              </Button>
            )}
          </>
        ),
        extra: !opened && <p className="text-sm text-muted">Сначала откройте файл приказа.</p>,
      };
    }
    if (order && doc.myAcknowledgement.acknowledgedAt) {
      const mine = ack?.items.find((i) => i.user.id === me.id);
      const at = doc.myAcknowledgement.acknowledgedAt;
      return { title: `Вы ознакомились с приказом ${date(at)} в ${time(at)}`, text: mine?.fileVersionNo ? `Версия ${mine.fileVersionNo} файла.` : undefined, calm: true };
    }
    if (isInitiator && doc.status === 'draft') {
      const miss: string[] = [];
      if (!doc.title.trim()) miss.push('название');
      if (doc.type.requireDeal && !doc.deal) miss.push('сделку');
      if ((doc.type.requireFile || doc.type.requireExcel) && !mainFile) miss.push(doc.type.requireExcel ? 'Excel-файл' : 'файл');
      if (order && !doc.signer) miss.push('утверждающего');
      if (!order && !doc.approvers.length) miss.push('согласующих');
      return {
        title: 'Черновик не запущен',
        text: miss.length ? `Осталось заполнить: ${joinRu(miss)}.` : 'Всё готово к запуску.',
        calm: false,
        actions: (
          <Link className="btn btn--primary" to={docEditPath(doc.kind, doc.id)}>
            Продолжить заполнение
          </Link>
        ),
      };
    }
    if (isInitiator && doc.status === 'rework') {
      const who = reworkStep ?? null;
      const text = who ? `${who.user.fullName}${who.user.department ? `, ${who.user.department.name}` : ''}: «${who.comment ?? ''}»` : signEntry ? `${signEntry.actorName}: «${String(signEntry.details?.comment ?? '')}»` : 'Замечания — в истории карточки.';
      return {
        title: 'Документ возвращён вам на доработку',
        text,
        calm: false,
        actions: (
          <>
            <Button variant="primary" busy={launching} busyText="Запускаем…" onClick={relaunch}>
              Запустить повторно
            </Button>
            {mainFile && p.canManageFiles ? (
              <FilePickButton size="sm" busy={uploading} accept={doc.type.requireExcel ? EXCEL_EXTS : DEFAULT_EXTS} onFile={(f) => {
                const problem = checkFile(f, doc.type.requireExcel ? EXCEL_EXTS : DEFAULT_EXTS, doc.type.requireExcel);
                if (problem) toast.error(problem.title, problem.hint);
                else void uploadTo(`/files/${mainFile.id}/versions`, f, 'Новая версия загружена');
              }}>
                Загрузить новую версию
              </FilePickButton>
            ) : null}
            <Link className="btn btn--ghost" to={docEditPath(doc.kind, doc.id)}>
              Изменить карточку
            </Link>
          </>
        ),
      };
    }
    if (doc.status === 'approved' && order) {
      if (isInitiator || p.canViewAcknowledgements) {
        return {
          title: 'Приказ утверждён, идёт ознакомление',
          text: ack ? `Ознакомились ${ack.acknowledged} из ${ack.total}.${ack.pending ? ` Не ознакомились: ${ack.pending}${ackLate ? `, из них ${ackLate} с нарушением срока` : ''}.` : ' Ознакомлены все.'}` : undefined,
          calm: true,
          actions:
            p.canRemind || p.canArchive ? (
              <>
                {p.canRemind && (
                  <Button
                    onClick={async () => {
                      try {
                        await api.post(`/documents/${id}/remind`);
                        toast.success(`Напоминание отправлено ${count(ackPending.length, ['сотруднику', 'сотрудникам', 'сотрудникам'])}`);
                      } catch (e) {
                        toast.fail('Напоминание не отправлено', e);
                      }
                    }}
                  >
                    Напомнить не ознакомившимся
                  </Button>
                )}
                {p.canArchive && <Button onClick={() => setDialog('archive')}>В архив</Button>}
              </>
            ) : undefined,
        };
      }
      return { title: 'Приказ утверждён', text: doc.signedAt ? `Утверждён ${date(doc.signedAt)}.` : undefined, calm: true };
    }
    if (doc.status === 'approved') {
      return { title: 'Согласование завершено', text: doc.completedAt ? `Все согласующие приняли положительное решение ${date(doc.completedAt)} в ${time(doc.completedAt)}.` : 'Все согласующие приняли положительное решение.', calm: true };
    }
    if (doc.status === 'rejected') {
      const who = rejectStep;
      return {
        title: order ? 'Приказ отклонён' : 'Согласование отклонено',
        text: who ? `${who.user.fullName}${who.user.department ? `, ${who.user.department.name}` : ''}: «${who.comment ?? ''}»` : signEntry ? `${signEntry.actorName}: «${String(signEntry.details?.comment ?? '')}»` : undefined,
        calm: true,
        actions: isInitiator && p.canCopy ? <Button onClick={copy}>Создать новое на основе этого</Button> : undefined,
      };
    }
    if (doc.status === 'cancelled') {
      return {
        title: order ? 'Приказ отменён' : 'Согласование отменено',
        text: cancelEntry ? `${cancelEntry.actorName} отменил(а) ${date(cancelEntry.at)}: «${String(cancelEntry.details?.reason ?? '')}»` : undefined,
        calm: true,
        actions: isInitiator && p.canCopy ? <Button onClick={copy}>Создать новое на основе этого</Button> : undefined,
      };
    }
    if (doc.status === 'archived') return { title: 'Приказ в архиве', text: 'Приказ доступен участникам для чтения. Новые поручения по нему создавать нельзя.', calm: true };
    if (doc.myStep && doc.myStep.state === 'waiting') {
      const cur = pending.map((s) => s.user.fullName);
      return { title: 'Ваша очередь ещё не подошла', text: `Сейчас документ у ${cur.length ? joinRu(cur) : 'предыдущего согласующего'}. Вы получите уведомление, когда потребуется ваше решение.`, calm: true };
    }
    if (doc.myStep && doc.myStep.state === 'approved' && doc.myStep.decidedAt) {
      const rest = pending.map((s) => s.user.fullName);
      return {
        title: `Вы согласовали документ ${date(doc.myStep.decidedAt)}`,
        text: doc.status === 'on_signing' ? `Приказ на утверждении у ${doc.signer?.fullName ?? 'утверждающего'}.` : rest.length ? `Дальше документ рассматривают: ${joinRu(rest)}.` : undefined,
        calm: true,
      };
    }
    if (isInitiator && doc.status === 'in_review') {
      return {
        title: 'Документ на согласовании',
        text: round?.mode === 'parallel' ? `Ждём решения: ${joinRu(pending.map((s) => s.user.fullName))}.` : pending[0] ? `Сейчас решение принимает ${pending[0].user.fullName} — документ ждёт решения ${daysAt(pending[0].activatedAt)}.` : undefined,
        calm: true,
        actions: p.canRemind ? <Button onClick={remind}>Напомнить согласующим</Button> : undefined,
      };
    }
    if (isInitiator && doc.status === 'on_signing') {
      return { title: 'Приказ на утверждении', text: doc.signer ? `Утверждающий — ${doc.signer.fullName}.` : undefined, calm: true, actions: p.canRemind ? <Button onClick={remind}>Напомнить утверждающему</Button> : undefined };
    }
    const holder = doc.status === 'on_signing' ? doc.signer?.fullName : pending.map((s) => s.user.fullName).join(', ');
    const since = doc.status === 'on_signing' ? null : pending[0]?.activatedAt;
    return { title: 'От вас ничего не требуется', text: holder ? `Документ у ${holder}${since ? ` с ${date(since)}` : ''}.` : undefined, calm: true };
  })();

  async function copy() {
    try {
      const d = await api.post<DocumentDetail>(`/documents/${id}/copy`);
      toast.success('Создан новый черновик', 'Файлы и решения не копируются — прикрепите файлы заново.');
      navigate(docEditPath(d.kind, d.id));
    } catch (e) {
      toast.fail('Не удалось создать копию', e);
    }
  }

  async function remind() {
    try {
      const d = await api.post<DocumentDetail>(`/documents/${id}/remind`);
      apply(d);
      toast.success('Напоминание отправлено');
    } catch (e) {
      toast.fail('Напоминание не отправлено', e);
    }
  }

  const menu: MenuItem[] = [
    { label: 'Изменить маршрут', icon: 'admin', hidden: !p.canChangeRoute || !round, onSelect: () => setDialog('route') },
    { label: 'Настроить доступ', icon: 'eye', hidden: !p.canManageAccess, onSelect: () => setDialog('access') },
    {
      label: 'Скопировать ссылку',
      icon: 'link',
      onSelect: () => {
        const url = absoluteUrl(docPath(doc.kind, doc.id));
        navigator.clipboard?.writeText(url).then(
          () => toast.info('Ссылка скопирована.'),
          () => toast.error('Не удалось скопировать ссылку', url),
        );
      },
    },
    { label: 'Повторить передачу в Битрикс24', icon: 'refresh', hidden: !(p.canRetryBitrix && doc.bitrix?.state === 'error'), onSelect: () => void retryBitrix() },
    { label: 'Создать копию', icon: 'file', hidden: !p.canCopy || doc.status === 'rejected' || doc.status === 'cancelled', onSelect: () => void copy() },
    { label: order ? 'Отменить приказ' : 'Отменить согласование', danger: true, divider: true, hidden: !p.canCancel, onSelect: () => setDialog('cancel') },
  ];

  const ackBadge =
    order && doc.status === 'approved' && ack ? (
      ack.pending === 0 ? (
        <span className="badge badge--done">Ознакомлены все</span>
      ) : (
        <span className="badge badge--acquaint">
          Ознакомление: {ack.acknowledged} из {ack.total}
        </span>
      )
    ) : null;

  const filesLocked = ['in_review', 'on_signing'].includes(doc.status);

  const filesCard = (
    <Card title="Файлы" count={doc.files.length || undefined}>
      <div className="stack">
        <FileList
          files={doc.files}
          rounds={doc.rounds}
          onDownloaded={markOpened}
          rowActions={(f) =>
            p.canManageFiles && (
              <FilePickButton busy={uploading} accept={f.role === 'main' && doc.type.requireExcel ? EXCEL_EXTS : DEFAULT_EXTS} onFile={(file) => {
                const problem = checkFile(file, f.role === 'main' && doc.type.requireExcel ? EXCEL_EXTS : DEFAULT_EXTS, f.role === 'main' && doc.type.requireExcel);
                if (problem) toast.error(problem.title, problem.hint);
                else void uploadTo(`/files/${f.id}/versions`, file, 'Новая версия загружена');
              }}>
                Новая версия
              </FilePickButton>
            )
          }
        />
        {p.canManageFiles && (
          <Dropzone
            compact
            title="Добавить приложения"
            hint="XLSX, XLS, DOCX, DOC, PDF, JPG, PNG — до 50 МБ каждый"
            accept={DEFAULT_EXTS}
            error={attachError ? { title: 'Файл не подходит', hint: attachError } : null}
            disabled={uploading}
            onFiles={(list) => {
              const f = list[0];
              const problem = checkFile(f, DEFAULT_EXTS);
              if (problem) setAttachError(`${problem.title}. ${problem.hint}`);
              else void uploadTo(`/documents/${id}/files?role=${mainFile ? 'attachment' : 'main'}`, f, 'Файл загружен');
            }}
          />
        )}
        {!p.canManageFiles && filesLocked && isInitiator && <p className="text-sm text-muted">Пока документ на {doc.status === 'on_signing' ? 'утверждении' : 'согласовании'}, файлы изменить нельзя.</p>}
      </div>
    </Card>
  );

  const signerCard = order && doc.signer && (
    <Card title="Утверждающий">
      <div className="person-row">
        <Avatar name={doc.signer.fullName} />
        <div className="person-row__main">
          <div className="text-strong">{doc.signer.fullName}</div>
          <div className="text-sm text-muted">{[doc.signer.position, doc.signer.department?.name].filter(Boolean).join(', ')}</div>
        </div>
        {doc.status === 'on_signing' ? (
          <span className="badge badge--review">Ожидается решение</span>
        ) : doc.signedAt ? (
          <span className="badge badge--approved" title={dateTime(doc.signedAt)}>
            Утвердил(а) {date(doc.signedAt)}
          </span>
        ) : (
          <span className="badge badge--neutral">{doc.status === 'draft' || doc.status === 'in_review' ? 'После согласования' : '—'}</span>
        )}
      </div>
    </Card>
  );

  const historyCard = (
    <HistoryCard
      entries={history}
      comments={doc.comments}
      rounds={doc.rounds}
      title={order ? 'История' : 'История'}
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
              <textarea className="textarea" rows={1} placeholder={order ? 'Комментарий увидят все участники' : 'Комментарий увидят все участники согласования'} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            <Button type="submit" busy={sending} busyText="Отправляем…" disabled={!comment.trim()}>
              Отправить
            </Button>
          </form>
        )
      }
    />
  );

  const description = doc.description.trim() && (
    <Card title="Описание">
      <p className="text-lg pre-wrap">{doc.description}</p>
    </Card>
  );

  const tasksTab = (
    <Card
      title="Поручения по приказу"
      count={doc.tasks.length || undefined}
      flush
      actions={
        p.canCreateTask && (
          <Button size="sm" icon="plus" onClick={() => setDialog('task')}>
            Создать поручение
          </Button>
        )
      }
    >
      {!doc.tasks.length ? (
        <div className="empty empty--compact">
          <div className="empty__title">По этому приказу поручений нет</div>
          {p.canCreateTask && (
            <div className="empty__actions">
              <Button size="sm" onClick={() => setDialog('task')}>
                Создать поручение
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="table-wrap table-wrap--flat">
          <table className="table table--dense table--clickable">
            <thead>
              <tr>
                <th scope="col">Номер</th>
                <th scope="col">Поручение</th>
                <th scope="col">Статус</th>
                <th scope="col">Исполнитель</th>
                <th scope="col">Срок</th>
              </tr>
            </thead>
            <tbody>
              {doc.tasks.map((t) => (
                <tr key={t.id} className={cx(t.overdue && 'is-overdue')} onClick={() => navigate(`/tasks/${t.id}`)}>
                  <td className="td-nowrap td-muted">{t.number}</td>
                  <td className="td-main">
                    <Link className="table__title" to={`/tasks/${t.id}`}>
                      {t.title}
                    </Link>
                  </td>
                  <td className="td-nowrap">
                    <TaskStatusBadge status={t.status} />
                  </td>
                  <td className="td-nowrap">{t.assignee.fullName}</td>
                  <td className="td-nowrap">{t.status === 'done' || t.status === 'cancelled' ? <span className="due due--done">{t.statusLabel}</span> : <Due at={t.dueAt} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );

  const stages = order && (
    <ol className="stages" aria-label="Этапы приказа">
      {[
        ...(doc.approvers.length || doc.rounds.some((r) => r.steps.length) ? [{ key: 'review', label: 'Согласование', done: ['on_signing', 'approved', 'archived'].includes(doc.status), current: doc.status === 'in_review' }] : []),
        { key: 'sign', label: 'Утверждение', done: ['approved', 'archived'].includes(doc.status), current: doc.status === 'on_signing' },
        { key: 'ack', label: 'Ознакомление', done: doc.status === 'archived' || (doc.status === 'approved' && !!ack && ack.pending === 0), current: doc.status === 'approved' && !(ack && ack.pending === 0) },
      ].map((s, i) => (
        <li key={s.key} className={cx('stages__item', s.done && 'is-done', s.current && 'is-current')} aria-current={s.current ? 'step' : undefined}>
          {i > 0 && <Icon name="chevron-right" className="stages__sep" />}
          <span className="stages__mark">{s.done ? <Icon name="check" /> : i + 1}</span>
          {s.label}
        </li>
      ))}
    </ol>
  );

  const orderTabs = order && [
    { key: 'main', label: 'Приказ' },
    ...(ack ? [{ key: 'ack', label: 'Ознакомление', count: `${ack.acknowledged} из ${ack.total}` }] : []),
    { key: 'tasks', label: 'Поручения', count: String(doc.tasks.length) },
    { key: 'history', label: 'История' },
  ];

  const setTab = (k: string) => {
    const sp = new URLSearchParams(params);
    if (k === 'main') sp.delete('tab');
    else sp.set('tab', k);
    setParams(sp, { replace: true });
  };

  const main = (
    <div className="stack stack--lg">
      <section className={cx('action-panel', panel.calm && 'action-panel--calm')} aria-label="Ожидаемое действие">
        <div className="action-panel__main">
          <h2 className="action-panel__title">{panel.title}</h2>
          {panel.text && <p className="action-panel__text">{panel.text}</p>}
        </div>
        {panel.actions && <div className="action-panel__actions">{panel.actions}</div>}
        {panel.extra}
      </section>
      {order && orderTabs && (
        <div className="tabs" role="tablist" aria-label="Разделы приказа">
          {orderTabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={cx('tab', tab === t.key && 'is-active')} onClick={() => setTab(t.key)}>
              {t.label}
              {'count' in t && t.count !== undefined && <span className="tab__count">{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      {(!order || tab === 'main') && (
        <>
          {description}
          <RouteCard
            doc={doc}
            meId={me.id}
            onReplace={
              p.canChangeRoute
                ? (u: UserRef) => {
                    setRouteFrom(u.id);
                    setDialog('route');
                  }
                : undefined
            }
          />
          {signerCard}
          {filesCard}
          {!order && historyCard}
        </>
      )}
      {order && tab === 'ack' && ack && <AcknowledgementTab doc={doc} onAdd={p.canManageAcquaintance ? () => setDialog('acq') : undefined} />}
      {order && tab === 'tasks' && tasksTab}
      {order && tab === 'history' && historyCard}
    </div>
  );

  return (
    <>
      <PageHeader
        crumbs={[{ to: order ? '/orders' : '/approvals', label: order ? 'Приказы' : 'Согласования' }, { label: doc.number }]}
        title={order ? `Приказ №${NBSP}${doc.number.replace(/^\D+-?\d{4}-0*/, '') || doc.number} «${doc.title}»` : doc.title || doc.number}
        badges={
          <>
            <DocStatusBadge kind={doc.kind} status={doc.status} label={doc.statusLabel} />
            {doc.overdue && <OverdueBadge at={doc.dueAt} />}
            {ackBadge}
          </>
        }
        meta={
          <>
            <span className="num">{doc.number}</span>
            {order ? doc.orderDate ? <span>от {date(doc.orderDate + 'T00:00:00', true)}</span> : null : <span>{doc.type.name}</span>}
            <span>
              Инициатор: {doc.initiator.fullName}
              {doc.department ? `, ${doc.department.name}` : ''}
            </span>
            <span>Создано {date(doc.createdAt, true)}</span>
          </>
        }
        actions={<MoreMenu items={menu} />}
      />
      {stages}
      <div className="stack card-alerts">
        {changed && (
          <Alert tone="info" actions={<Button size="sm" icon="refresh" onClick={() => void load(true)}>Обновить</Button>}>
            Карточка изменилась, пока вы её просматривали.
          </Alert>
        )}
        {stale && (
          <Alert tone="warning" actions={<Button size="sm" icon="refresh" onClick={() => void load(true)}>Обновить</Button>}>
            {stale}
          </Alert>
        )}
        {doc.bitrix?.state === 'error' && (
          <Alert
            tone="danger"
            title="Статус не передан в Битрикс24"
            actions={
              p.canRetryBitrix && (
                <Button size="sm" icon="refresh" busy={retrying} busyText="Передаём…" onClick={retryBitrix}>
                  Повторить передачу
                </Button>
              )
            }
          >
            Сервер Битрикс24 не ответил. {order ? 'Приказ сохранён' : 'Согласование сохранено и продолжается'}, статус в сделке устарел.
          </Alert>
        )}
        {syncedJustNow && doc.bitrix?.state === 'synced' && <Alert tone="success">Статус передан в Битрикс24</Alert>}
      </div>
      <div className="layout-split">
        {main}
        <aside className="layout-split__aside">
          {!order && <DealCard doc={doc} onRetry={p.canRetryBitrix ? retryBitrix : undefined} retrying={retrying} />}
          <InfoCard doc={doc} />
        </aside>
      </div>

      {dialog === 'approve' && <ApproveModal onClose={() => setDialog(null)} onConfirm={decide('approve', 'decision')} />}
      {dialog === 'rework' && (
        <ConfirmDialog
          title="Вернуть на доработку?"
          text={`Инициатор ${doc.initiator.fullName} получит ваши замечания, загрузит исправленный файл и запустит согласование заново — для всех согласующих.`}
          commentLabel="Что нужно исправить"
          commentRequired
          requiredAction="вернуть на доработку"
          confirmText="Вернуть на доработку"
          busyText="Возвращаем…"
          onClose={() => setDialog(null)}
          onConfirm={decide('rework', 'decision')}
        />
      )}
      {dialog === 'reject' && (
        <ConfirmDialog
          title="Отклонить согласование?"
          text={`Процесс завершится со статусом «Отклонено». Инициатор ${doc.initiator.fullName} получит уведомление с вашим комментарием.`}
          commentLabel="Причина отклонения"
          commentRequired
          requiredAction="отклонить"
          confirmText={order ? 'Отклонить' : 'Отклонить согласование'}
          busyText="Отклоняем…"
          cancelText="Не отклонять"
          onClose={() => setDialog(null)}
          onConfirm={decide('reject', 'decision')}
        />
      )}
      {dialog === 'sign' && (
        <ApproveModal
          title="Утвердить приказ?"
          confirm="Утвердить приказ"
          text={`После утверждения файлы приказа изменить нельзя. Приказ будет направлен на ознакомление ${count(doc.acquaintance.length, ['сотруднику', 'сотрудникам', 'сотрудникам'])}.`}
          onClose={() => setDialog(null)}
          onConfirm={decide('approve', 'sign')}
        />
      )}
      {dialog === 'sign-rework' && (
        <ConfirmDialog
          title="Вернуть на доработку?"
          text={`Инициатор ${doc.initiator.fullName} получит ваши замечания, исправит приказ и направит его заново.`}
          commentLabel="Что нужно исправить"
          commentRequired
          requiredAction="вернуть на доработку"
          confirmText="Вернуть на доработку"
          busyText="Возвращаем…"
          onClose={() => setDialog(null)}
          onConfirm={decide('rework', 'sign')}
        />
      )}
      {dialog === 'sign-reject' && (
        <ConfirmDialog
          title="Отклонить приказ?"
          text="Приказ получит статус «Отклонён». Инициатор получит уведомление с вашим комментарием."
          commentLabel="Причина отклонения"
          commentRequired
          requiredAction="отклонить"
          confirmText="Отклонить приказ"
          busyText="Отклоняем…"
          cancelText="Не отклонять"
          onClose={() => setDialog(null)}
          onConfirm={decide('reject', 'sign')}
        />
      )}
      {dialog === 'cancel' && (
        <ConfirmDialog
          title={order ? 'Отменить приказ?' : 'Отменить согласование?'}
          text={order ? 'Процесс остановится, участники получат уведомление. Возобновить отменённый приказ нельзя.' : 'Процесс остановится, участники получат уведомление. Возобновить отменённое согласование нельзя.'}
          commentLabel="Причина отмены"
          commentRequired
          requiredAction="отменить"
          confirmText={order ? 'Отменить приказ' : 'Отменить согласование'}
          busyText="Отменяем…"
          cancelText="Не отменять"
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            const r = await api.post<DocumentDetail | { ok: true }>(`/documents/${id}/cancel`, { reason });
            setDialog(null);
            toast.success(order ? 'Приказ отменён' : 'Согласование отменено');
            if ('id' in r) apply(r);
            else void load(true);
          }}
        />
      )}
      {dialog === 'archive' && (
        <ConfirmDialog
          title="Перенести приказ в архив?"
          text="Приказ останется доступен участникам, новые поручения по нему создавать будет нельзя."
          confirmText="Перенести в архив"
          busyText="Переносим…"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const r = await api.post<DocumentDetail | { ok: true }>(`/documents/${id}/archive`);
            setDialog(null);
            toast.success('Приказ перенесён в архив');
            if ('id' in r) apply(r);
            else void load(true);
          }}
        />
      )}
      {dialog === 'route' && (
        <RouteModal
          doc={doc}
          initialFrom={routeFrom}
          onClose={() => {
            setDialog(null);
            setRouteFrom(undefined);
          }}
          onDone={(d, text) => {
            setDialog(null);
            setRouteFrom(undefined);
            toast.success(text);
            if (d) apply(d);
            else void load(true);
          }}
        />
      )}
      {dialog === 'access' && (
        <AccessModal
          doc={doc}
          onClose={() => setDialog(null)}
          onDone={(d) => {
            setDialog(null);
            apply(d);
            toast.success('Доступ обновлён');
          }}
        />
      )}
      {dialog === 'acq' && (
        <AcquaintanceModal
          doc={doc}
          onClose={() => setDialog(null)}
          onDone={(d) => {
            setDialog(null);
            apply(d);
            toast.success('Список ознакомления дополнен');
          }}
        />
      )}
      {dialog === 'task' && (
        <TaskCreateModal
          document={{ id: doc.id, number: doc.number, title: doc.title, accessible: true }}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            void load(true);
          }}
        />
      )}
    </>
  );
}

function CardSkeleton() {
  return (
    <Loading>
      <div className="stack">
        <span className="skeleton skeleton--text" style={{ width: 160 }} />
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--text" style={{ width: '50%' }} />
        <div className="layout-split section">
          <div className="stack stack--lg">
            <span className="skeleton skeleton--tile" />
            <div className="card card__body stack">
              <span className="skeleton skeleton--row" />
              <span className="skeleton skeleton--row" />
            </div>
            <div className="card card__body stack">
              <span className="skeleton skeleton--row" />
            </div>
          </div>
          <div className="stack">
            <div className="card card__body stack">
              <span className="skeleton skeleton--text" />
              <span className="skeleton skeleton--text" />
            </div>
          </div>
        </div>
      </div>
    </Loading>
  );
}

