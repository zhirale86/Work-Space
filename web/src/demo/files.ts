/**
 * Файлы и версии (server/src/files): права изменения, проверки содержимого, история, скачивание.
 * Содержимое хранится в памяти браузера (и в localStorage, если помещается).
 */
import type { FileItem, FileOwnerType, FileRole, FileVersion, RoundFile } from '../api/types';
import { FILE_ROLE_LABELS } from '../../../server/src/labels';
import { conflict, forbidden, notFound, tooLarge, unprocessable } from '../../../server/src/errors';
import { type Actor, DOC_NOT_FOUND, TASK_NOT_FOUND, audit, clean, isoReq, iso, refOf, requireDocument, requireTask } from './core';
import { type FileRow, type VersionRow, db, getBlob, nextId, now, putBlob } from './db';

export const FILE_NOT_FOUND = 'Файл не найден или нет доступа';

export const LIMITS = {
  maxFileMb: 50,
  maxFilesPerCard: 20,
  maxCardTotalMb: 200,
  allowedExtensions: ['xlsx', 'xls', 'docx', 'doc', 'pdf', 'jpg', 'jpeg', 'png'],
};

export const MIME_BY_EXT: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

function toVersion(v: VersionRow): FileVersion {
  return {
    id: v.id,
    fileId: v.file_id,
    versionNo: v.version_no,
    originalName: v.original_name,
    ext: v.ext,
    mime: v.mime,
    size: v.size,
    sha256: v.sha256,
    uploadedBy: refOf(v.uploaded_by),
    uploadedAt: isoReq(v.uploaded_at),
    downloadUrl: `/api/file-versions/${v.id}/download`,
  };
}

const mainFirst = (a: FileRow, b: FileRow): number => Number(b.role === 'main') - Number(a.role === 'main') || a.id - b.id;

/** Действующие файлы карточки со всеми версиями. */
export function listFiles(ownerType: FileOwnerType, ownerId: number): FileItem[] {
  return db.files
    .filter((f) => f.owner_type === ownerType && f.owner_id === ownerId && f.deleted_at === null)
    .sort(mainFirst)
    .map((f) => {
      const vs = db.versions.filter((v) => v.file_id === f.id).sort((a, b) => b.version_no - a.version_no).map(toVersion);
      return {
        id: f.id,
        ownerType: f.owner_type,
        ownerId: f.owner_id,
        role: f.role,
        roleLabel: FILE_ROLE_LABELS[f.role],
        title: f.title,
        createdAt: isoReq(f.created_at),
        deletedAt: iso(f.deleted_at),
        currentVersion: vs[0],
        versions: vs,
      };
    })
    .filter((f) => f.currentVersion);
}

/** Последняя версия каждого действующего файла карточки. */
export function latestVersions(ownerType: FileOwnerType, ownerId: number): Array<{ file: FileRow; version: VersionRow }> {
  const out: Array<{ file: FileRow; version: VersionRow }> = [];
  for (const f of db.files.filter((x) => x.owner_type === ownerType && x.owner_id === ownerId && x.deleted_at === null)) {
    const v = db.versions.filter((x) => x.file_id === f.id).sort((a, b) => b.version_no - a.version_no)[0];
    if (v) out.push({ file: f, version: v });
  }
  return out;
}

export function roundFiles(roundId: number): RoundFile[] {
  const list: Array<{ f: FileRow; v: VersionRow }> = [];
  for (const rf of db.roundFiles.filter((x) => x.round_id === roundId)) {
    const v = db.versions.find((x) => x.id === rf.file_version_id);
    const f = v && db.files.find((x) => x.id === v.file_id);
    if (v && f) list.push({ f, v });
  }
  return list
    .sort((a, b) => mainFirst(a.f, b.f))
    .map(({ f, v }) => ({ fileId: f.id, role: f.role, roleLabel: FILE_ROLE_LABELS[f.role], title: f.title, version: toVersion(v) }));
}

export type UploadTarget =
  | { kind: 'new'; ownerType: FileOwnerType; ownerId: number; role: FileRole; title?: string }
  | { kind: 'version'; fileId: number };

interface Owner {
  ownerType: FileOwnerType;
  ownerId: number;
  role: FileRole;
  file: FileRow | null;
}

/** Право изменять файлы: доступ к карточке (404), роль в процессе (403), состояние процесса (409). */
export function authorizeModify(actor: Actor, target: UploadTarget): Owner {
  let owner: Owner;
  if (target.kind === 'version') {
    const file = db.files.find((f) => f.id === target.fileId);
    if (!file) throw notFound(FILE_NOT_FOUND);
    owner = { ownerType: file.owner_type, ownerId: file.owner_id, role: file.role, file };
  } else {
    owner = { ownerType: target.ownerType, ownerId: target.ownerId, role: target.role, file: null };
  }
  if (owner.ownerType === 'document') {
    let doc;
    try {
      doc = requireDocument(actor, owner.ownerId);
    } catch (e) {
      if (target.kind === 'version') throw notFound(FILE_NOT_FOUND);
      throw e;
    }
    if (owner.file?.deleted_at) throw notFound(FILE_NOT_FOUND);
    if (owner.role === 'result') throw unprocessable('Недопустимая роль файла для документа');
    if (doc.initiator_id !== actor.id) throw forbidden('Изменять файлы может только инициатор документа');
    if (doc.status !== 'draft' && doc.status !== 'rework') {
      throw conflict(
        doc.status === 'in_review' || doc.status === 'on_signing'
          ? 'Файлы нельзя изменять, пока документ находится на согласовании или утверждении'
          : 'Файлы завершённого документа изменять нельзя',
      );
    }
  } else {
    let task;
    try {
      task = requireTask(actor, owner.ownerId);
    } catch (e) {
      if (target.kind === 'version') throw notFound(FILE_NOT_FOUND);
      throw e;
    }
    if (owner.file?.deleted_at) throw notFound(FILE_NOT_FOUND);
    if (owner.role === 'main') throw unprocessable('Недопустимая роль файла для поручения');
    const isAuthor = task.author_id === actor.id;
    const isAssignee = task.assignee_id === actor.id;
    if (!isAuthor && !isAssignee) throw forbidden('Прикреплять файлы могут только постановщик и исполнитель поручения');
    if (task.status === 'done' || task.status === 'cancelled') throw conflict('Файлы завершённого поручения изменять нельзя');
    if (owner.role === 'result' && !isAssignee) throw forbidden('Файл результата прикрепляет исполнитель поручения');
    if (owner.file && owner.file.created_by !== actor.id) throw forbidden('Новую версию загружает сотрудник, прикрепивший файл');
  }
  return owner;
}

function checkLimits(owner: Owner, addSize: number, addsFile: boolean): void {
  const files = db.files.filter((f) => f.owner_type === owner.ownerType && f.owner_id === owner.ownerId && f.deleted_at === null);
  const ids = new Set(files.map((f) => f.id));
  const total = db.versions.filter((v) => ids.has(v.file_id)).reduce((s, v) => s + v.size, 0);
  if (addsFile && files.length >= LIMITS.maxFilesPerCard) throw unprocessable(`В карточке может быть не более ${LIMITS.maxFilesPerCard} файлов`);
  if (total + addSize > LIMITS.maxCardTotalMb * 1024 * 1024) {
    throw unprocessable(`Общий объём файлов карточки не может превышать ${LIMITS.maxCardTotalMb} МБ`);
  }
}

// ───────────── Проверка содержимого ─────────────

export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().replace(/^\.+/, '');
  return (cleaned || 'file').slice(-200);
}
export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

const SIGNATURES: Record<string, number[][]> = {
  zip: [[0x50, 0x4b, 0x03, 0x04]],
  ole: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  jpg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
};
const SIGNATURE_BY_EXT: Record<string, string> = { xlsx: 'zip', docx: 'zip', xls: 'ole', doc: 'ole', pdf: 'pdf', jpg: 'jpg', jpeg: 'jpg', png: 'png' };

function includesAscii(bytes: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

const failFile = (message: string) => unprocessable(message, [{ field: 'file', message }]);

export function validateContent(name: string, bytes: Uint8Array): void {
  const ext = extensionOf(name);
  if (bytes.length > LIMITS.maxFileMb * 1024 * 1024) throw tooLarge(`Размер файла превышает ${LIMITS.maxFileMb} МБ`);
  if (bytes.length === 0) throw failFile('Файл пуст');
  if (['xlsm', 'docm', 'xltm', 'dotm', 'xlsb', 'pptm'].includes(ext)) throw failFile('Файлы с макросами не принимаются');
  if (!ext || !LIMITS.allowedExtensions.includes(ext)) throw failFile(`Недопустимый тип файла. Разрешены: ${LIMITS.allowedExtensions.join(', ')}`);
  const kind = SIGNATURE_BY_EXT[ext];
  if (kind && !SIGNATURES[kind].some((sig) => sig.every((b, i) => bytes[i] === b))) {
    throw failFile(`Содержимое файла не соответствует расширению .${ext}`);
  }
  if (ext === 'xlsx' || ext === 'docx') {
    if (includesAscii(bytes, 'vbaProject.bin')) throw failFile('Файлы с макросами не принимаются');
    if (!includesAscii(bytes, ext === 'xlsx' ? 'xl/workbook' : 'word/document')) throw failFile(`Содержимое файла не соответствует расширению .${ext}`);
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Вне защищённого контекста — упрощённая контрольная сумма (только для показа).
    let h1 = 0x811c9dc5;
    for (const b of bytes) h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    return h1.toString(16).padStart(8, '0').repeat(8);
  }
}

/** Сохранение принятого файла: новая запись или новая версия, история — сразу. */
export function saveFile(actor: Actor, target: UploadTarget, originalNameRaw: string, bytes: Uint8Array, sha256: string): FileItem {
  const owner = authorizeModify(actor, target);
  const originalName = sanitizeFileName(originalNameRaw);
  validateContent(originalName, bytes);
  checkLimits(owner, bytes.length, target.kind === 'new');
  const ext = extensionOf(originalName);
  let fileId: number;
  let versionNo = 1;
  if (target.kind === 'new') {
    if (owner.ownerType === 'document' && owner.role === 'main') {
      const existing = db.files.some((f) => f.owner_type === 'document' && f.owner_id === owner.ownerId && f.role === 'main' && f.deleted_at === null);
      if (existing) throw conflict('Основной документ уже прикреплён — загрузите его новую версию');
    }
    fileId = nextId('files');
    db.files.push({
      id: fileId,
      owner_type: owner.ownerType,
      owner_id: owner.ownerId,
      role: owner.role,
      title: clean(target.title).slice(0, 300),
      created_by: actor.id,
      created_at: now(),
      deleted_at: null,
      deleted_by: null,
    });
  } else {
    fileId = target.fileId;
    versionNo = Math.max(0, ...db.versions.filter((v) => v.file_id === fileId).map((v) => v.version_no)) + 1;
  }
  const versionId = nextId('versions');
  const key = `v${versionId}-${Math.random().toString(16).slice(2, 10)}`;
  putBlob(key, bytes);
  db.versions.push({
    id: versionId,
    file_id: fileId,
    version_no: versionNo,
    original_name: originalName,
    ext,
    mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
    size: bytes.length,
    sha256,
    storage_key: key,
    uploaded_by: actor.id,
    uploaded_at: now(),
  });
  const roleLabel = FILE_ROLE_LABELS[owner.role].toLowerCase();
  audit({
    actorId: actor.id,
    entityType: owner.ownerType,
    entityId: owner.ownerId,
    action: versionNo === 1 ? 'file.uploaded' : 'file.version_uploaded',
    summary: versionNo === 1 ? `Прикреплён файл (${roleLabel})` : `Загружена новая версия файла (${roleLabel}) — версия ${versionNo}`,
    details: { fileId, versionNo, fileName: originalName, size: bytes.length, sha256, role: owner.role },
  });
  touchOwner(owner);
  return listFiles(owner.ownerType, owner.ownerId).find((i) => i.id === fileId)!;
}

function touchOwner(owner: Owner): void {
  const row = owner.ownerType === 'document' ? db.documents.find((d) => d.id === owner.ownerId) : db.tasks.find((t) => t.id === owner.ownerId);
  if (row) row.updated_at = now();
}

/** Удаление файла из карточки; версии остаются в снимках раундов. */
export function deleteFile(actor: Actor, fileId: number): void {
  const owner = authorizeModify(actor, { kind: 'version', fileId });
  const f = db.files.find((x) => x.id === fileId)!;
  f.deleted_at = now();
  f.deleted_by = actor.id;
  const last = db.versions.filter((v) => v.file_id === fileId).sort((a, b) => b.version_no - a.version_no)[0];
  audit({
    actorId: actor.id,
    entityType: owner.ownerType,
    entityId: owner.ownerId,
    action: 'file.deleted',
    summary: `Файл удалён из карточки (${FILE_ROLE_LABELS[owner.role].toLowerCase()})`,
    details: { fileId, fileName: last?.original_name ?? null },
  });
  touchOwner(owner);
}

/** Скачивание версии: доступ — как к карточке-владельцу. */
export function openDownload(actor: Actor, versionId: number): { name: string; mime: string; bytes: Uint8Array } {
  const v = db.versions.find((x) => x.id === versionId);
  const f = v && db.files.find((x) => x.id === v.file_id);
  if (!v || !f) throw notFound(FILE_NOT_FOUND);
  try {
    if (f.owner_type === 'document') requireDocument(actor, f.owner_id);
    else requireTask(actor, f.owner_id);
  } catch {
    throw notFound(FILE_NOT_FOUND);
  }
  const bytes = getBlob(v.storage_key);
  if (!bytes) {
    throw notFound('Содержимое файла не сохранилось после перезагрузки страницы демо (файл был слишком большим для хранилища браузера)');
  }
  return { name: v.original_name, mime: v.mime, bytes };
}

export { DOC_NOT_FOUND, TASK_NOT_FOUND };
