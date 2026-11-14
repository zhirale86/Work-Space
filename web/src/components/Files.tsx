import { useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import type { ApprovalRound, FileItem, FileVersion } from '../api/types';
import { dateTime, ext, fileSize, NBSP } from '../lib/format';
import { Icon, type IconName } from './Icon';
import { Button, cx } from './ui';
import { useToast } from './Toast';

export const DEFAULT_EXTS = ['xlsx', 'xls', 'docx', 'doc', 'pdf', 'jpg', 'jpeg', 'png'];
export const EXCEL_EXTS = ['xlsx', 'xls'];
export const MAX_MB = 50;

/** Скачивание через fetch: ошибка видна пользователю, а не как пустая страница. */
export async function downloadVersion(v: FileVersion): Promise<void> {
  let res: Response;
  try {
    res = await fetch(v.downloadUrl, { credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Не удалось скачать файл.');
  }
  if (!res.ok) throw new ApiError(res.status, 'not_found', 'Не удалось скачать файл.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = v.originalName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function useDownload(onDone?: (v: FileVersion) => void) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);
  const run = async (v: FileVersion) => {
    setBusyId(v.id);
    try {
      await downloadVersion(v);
      onDone?.(v);
    } catch {
      toast.error('Не удалось скачать файл.', 'Проверьте подключение и попробуйте ещё раз.', () => void run(v));
    } finally {
      setBusyId(null);
    }
  };
  return { download: run, busyId };
}

export function FileIcon({ name }: { name: string }) {
  return (
    <span className="file__icon" aria-hidden="true">
      {(ext(name) || 'FILE').toUpperCase().slice(0, 4)}
    </span>
  );
}

/** Подпись версии по раундам: «на согласовании, запуск 2» / «возвращена на доработку, запуск 1». */
function versionNote(v: FileVersion, rounds: ApprovalRound[]): string {
  const r = rounds.find((x) => x.files.some((f) => f.version.id === v.id));
  if (!r) return 'ещё не отправлена';
  const outcome =
    r.outcome === null ? 'на согласовании' : r.outcome === 'approved' ? 'согласована' : r.outcome === 'rework' ? 'возвращена на доработку' : r.outcome === 'rejected' ? 'отклонена' : 'согласование отменено';
  return `${outcome}, запуск${NBSP}${r.roundNo}`;
}

interface FileListProps {
  files: FileItem[];
  rounds?: ApprovalRound[];
  /** Действия строки (новая версия, удаление) — для инициатора в черновике и на доработке. */
  rowActions?: (f: FileItem) => ReactNode;
  onDownloaded?: (v: FileVersion) => void;
  emptyText?: string;
}

export function FileList({ files, rounds = [], rowActions, onDownloaded, emptyText = 'Файлы не прикреплены' }: FileListProps) {
  const { download, busyId } = useDownload(onDownloaded);
  const sorted = [...files].sort((a, b) => (a.role === 'main' ? -1 : b.role === 'main' ? 1 : a.id - b.id));
  if (!sorted.length) return <p className="text-muted">{emptyText}</p>;
  return (
    <ul className="files">
      {sorted.map((f) => {
        const v = f.currentVersion;
        return (
          <li key={f.id} className="file">
            <div className="file__row">
              <FileIcon name={v.originalName} />
              <div className="file__main">
                <div className="file__name">
                  <a
                    href={v.downloadUrl}
                    onClick={(e) => {
                      e.preventDefault();
                      void download(v);
                    }}
                    title={v.originalName}
                  >
                    {v.originalName}
                  </a>
                  <span className="version-tag">Версия{NBSP}{v.versionNo}</span>
                </div>
                <div className="file__meta">
                  {f.role === 'main' ? 'Основной файл' : f.role === 'result' ? 'Результат' : 'Приложение'} · {fileSize(v.size)} · {v.uploadedBy.fullName} · {dateTime(v.uploadedAt)}
                </div>
              </div>
              <div className="file__actions">
                {rowActions?.(f)}
                <Button size="sm" icon="download" busy={busyId === v.id} onClick={() => void download(v)}>
                  Скачать
                </Button>
              </div>
            </div>
            {f.versions.length > 1 && (
              <ul className="file__versions" aria-label="Версии файла">
                {f.versions.map((ver) => {
                  const current = ver.id === v.id;
                  return (
                    <li key={ver.id} className={cx('file-version', current && 'is-current')}>
                      <span className="file-version__label">Версия{NBSP}{ver.versionNo}</span>
                      <span className="file-version__meta">
                        {dateTime(ver.uploadedAt)} · {ver.uploadedBy.fullName} · {versionNote(ver, rounds)}
                      </span>
                      {current ? (
                        <span className="text-sm text-muted">текущая</span>
                      ) : (
                        <Button variant="ghost" size="sm" busy={busyId === ver.id} onClick={() => void download(ver)}>
                          Скачать
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface FileProblem {
  title: string;
  hint: string;
}

/** Проверка файла до загрузки (тексты — раздел 4.4). */
export function checkFile(file: File, exts: string[], excelOnly = false, maxMb = MAX_MB): FileProblem | null {
  const e = ext(file.name);
  if (excelOnly && !EXCEL_EXTS.includes(e)) return { title: `Файл «${file.name}» не подходит`, hint: 'Для GPM-калькулятора нужен файл Excel: XLSX или XLS.' };
  if (!exts.includes(e))
    return { title: `Формат файла «${file.name}» не поддерживается`, hint: `Можно загрузить ${exts.filter((x) => x !== 'jpeg').map((x) => x.toUpperCase()).join(', ')}.` };
  if (file.size > maxMb * 1024 * 1024) return { title: `Файл «${file.name}» больше ${maxMb}${NBSP}МБ`, hint: 'Уменьшите файл или разделите его на части.' };
  return null;
}

interface DropzoneProps {
  title: string;
  hint: string;
  compact?: boolean;
  multiple?: boolean;
  accept?: string[];
  error?: FileProblem | null;
  disabled?: boolean;
  icon?: IconName;
  id?: string;
  onFiles: (files: File[]) => void;
}

export function Dropzone({ title, hint, compact, multiple, accept, error, disabled, icon, id, onFiles }: DropzoneProps) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const open = () => !disabled && input.current?.click();
  const iconName: IconName = error ? 'alert' : icon ?? (compact ? 'plus' : 'upload');
  return (
    <div
      id={id}
      className={cx('dropzone', compact && 'dropzone--compact', error && 'dropzone--error', over && 'is-active', disabled && 'is-disabled')}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const list = Array.from(e.dataTransfer.files);
        if (list.length) onFiles(multiple ? list : list.slice(0, 1));
      }}
    >
      <Icon name={iconName} size={compact ? undefined : 'lg'} className={error ? 'icon--brand' : 'dropzone__icon'} />
      <div>
        <div className="dropzone__title">{error ? error.title : title}</div>
        <div className="dropzone__hint">{error ? error.hint : hint}</div>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        multiple={multiple}
        accept={accept?.map((x) => `.${x}`).join(',')}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (list.length) onFiles(list);
        }}
      />
    </div>
  );
}

/** Строка загружаемого файла: ход загрузки или ошибка с повтором. */
export function UploadRow({ name, percent, error, onCancel, onRetry }: { name: string; percent: number; error?: string | null; onCancel?: () => void; onRetry?: () => void }) {
  return (
    <li className={cx('file', 'file--uploading', error && 'file--failed')}>
      <div className="file__row">
        <FileIcon name={name} />
        <div className="file__main">
          <div className="file__name">
            <span>{name}</span>
          </div>
          {error ? (
            <div className="file__meta text-danger">{error}</div>
          ) : (
            <>
              <div className="file__meta">Загружается — {percent}{NBSP}%</div>
              <div className="progress file__progress">
                <div className="progress__bar" style={{ width: `${percent}%` }} />
              </div>
            </>
          )}
        </div>
        <div className="file__actions">
          {error
            ? onRetry && (
                <Button size="sm" icon="refresh" onClick={onRetry}>
                  Повторить
                </Button>
              )
            : onCancel && (
                <Button variant="ghost" size="sm" onClick={onCancel}>
                  Отменить
                </Button>
              )}
        </div>
      </div>
    </li>
  );
}

/** Скрытый выбор файла для кнопки «Новая версия». */
export function FilePickButton({ children, onFile, accept, icon = 'upload', size = 'sm', variant = 'secondary', busy }: { children: ReactNode; onFile: (f: File) => void; accept?: string[]; icon?: IconName; size?: 'sm'; variant?: 'secondary' | 'ghost'; busy?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button size={size} variant={variant} icon={icon} busy={busy} busyText="Загружаем…" onClick={() => input.current?.click()}>
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept?.map((x) => `.${x}`).join(',')}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
    </>
  );
}
