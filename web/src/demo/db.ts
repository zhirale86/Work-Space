/**
 * Демонстрационный режим: «база данных» в памяти браузера.
 * Таблицы повторяют схему сервера (server/migrations), даты хранятся в миллисекундах.
 * Состояние сохраняется в localStorage (если оно доступно), содержимое файлов — отдельно.
 */
import type {
  BitrixLinkState,
  DocKind,
  DocStatus,
  EntityType,
  FileOwnerType,
  FileRole,
  MockTaskStatus,
  NotificationType,
  RoundOutcome,
  RouteMode,
  StepState,
  SystemRole,
  TaskStatus,
} from '../api/types';

export type Ms = number;

export interface UserRow {
  id: number;
  login: string;
  full_name: string;
  position: string;
  department_id: number | null;
  roles: SystemRole[];
  active: boolean;
  must_change_password: boolean;
  created_at: Ms;
}
export interface DeptRow {
  id: number;
  name: string;
  active: boolean;
}
export interface DocTypeRow {
  id: number;
  code: string;
  name: string;
  kind: DocKind;
  number_prefix: string;
  active: boolean;
  require_deal: boolean;
  require_file: boolean;
  require_excel: boolean;
  require_deadline: boolean;
  require_description: boolean;
}
export interface DocRow {
  id: number;
  number: string;
  doc_type_id: number;
  kind: DocKind;
  title: string;
  description: string;
  initiator_id: number;
  department_id: number | null;
  status: DocStatus;
  route_mode: RouteMode;
  due_at: Ms | null;
  deal_id: string | null;
  deal_title: string | null;
  deal_url: string | null;
  signer_id: number | null;
  order_date: string | null;
  signed_at: Ms | null;
  signed_by: number | null;
  launch_count: number;
  last_reminded_at: Ms | null;
  created_at: Ms;
  updated_at: Ms;
  launched_at: Ms | null;
  completed_at: Ms | null;
}
export interface ParticipantRow {
  document_id: number;
  user_id: number;
  role: 'approver' | 'observer' | 'acquaintance';
  position: number;
}
export interface RoundRow {
  id: number;
  document_id: number;
  round_no: number;
  mode: RouteMode;
  started_at: Ms;
  started_by: number;
  finished_at: Ms | null;
  outcome: RoundOutcome | null;
}
export interface StepRow {
  id: number;
  round_id: number;
  user_id: number;
  position: number;
  state: StepState;
  comment: string | null;
  activated_at: Ms | null;
  decided_at: Ms | null;
}
export interface AccessRow {
  id: number;
  document_id: number;
  user_id: number | null;
  department_id: number | null;
  granted_by: number;
}
export interface AckRow {
  document_id: number;
  user_id: number;
  file_version_id: number | null;
  acknowledged_at: Ms;
}
export interface FileRow {
  id: number;
  owner_type: FileOwnerType;
  owner_id: number;
  role: FileRole;
  title: string;
  created_by: number;
  created_at: Ms;
  deleted_at: Ms | null;
  deleted_by: number | null;
}
export interface VersionRow {
  id: number;
  file_id: number;
  version_no: number;
  original_name: string;
  ext: string;
  mime: string;
  size: number;
  sha256: string;
  storage_key: string;
  uploaded_by: number;
  uploaded_at: Ms;
}
export interface CommentRow {
  id: number;
  entity_type: EntityType;
  entity_id: number;
  author_id: number;
  body: string;
  created_at: Ms;
}
export interface TaskRow {
  id: number;
  number: string;
  title: string;
  body: string;
  author_id: number;
  assignee_id: number;
  due_at: Ms | null;
  document_id: number | null;
  status: TaskStatus;
  result_text: string | null;
  created_at: Ms;
  updated_at: Ms;
  completed_at: Ms | null;
}
export interface NotificationRow {
  id: number;
  user_id: number;
  type: NotificationType;
  title: string;
  body: string;
  entity_type: EntityType | null;
  entity_id: number | null;
  dedupe_key: string | null;
  created_at: Ms;
  read_at: Ms | null;
}
export interface AuditRow {
  id: number;
  at: Ms;
  actor_id: number | null;
  entity_type: string;
  entity_id: number | null;
  action: string;
  summary: string;
  details: Record<string, unknown>;
}
export interface LinkRow {
  document_id: number;
  external_task_id: string | null;
  state: BitrixLinkState;
  synced_status: DocStatus | null;
  attempts: number;
  last_error: string | null;
  last_attempt_at: Ms | null;
  next_attempt_at: Ms | null;
}
export interface MockDealRow {
  id: number;
  title: string;
  stage: string;
  company: string;
  amount: number;
}
export interface MockTaskRow {
  id: number;
  deal_id: number;
  marker: string;
  title: string;
  description: string;
  status: MockTaskStatus;
  created_at: Ms;
  updated_at: Ms;
}

export interface State {
  version: number;
  /** Когда состояние сохранено последний раз (для сдвига дат при повторном открытии). */
  savedAt: Ms;
  seq: Record<string, number>;
  counters: Record<string, number>;
  users: UserRow[];
  departments: DeptRow[];
  docTypes: DocTypeRow[];
  documents: DocRow[];
  participants: ParticipantRow[];
  rounds: RoundRow[];
  steps: StepRow[];
  roundFiles: Array<{ round_id: number; file_version_id: number }>;
  access: AccessRow[];
  acks: AckRow[];
  files: FileRow[];
  versions: VersionRow[];
  comments: CommentRow[];
  tasks: TaskRow[];
  taskObservers: Array<{ task_id: number; user_id: number }>;
  notifications: NotificationRow[];
  audit: AuditRow[];
  bitrixLinks: LinkRow[];
  mockDeals: MockDealRow[];
  mockTasks: MockTaskRow[];
  settings: { mockUnavailable: boolean };
  session: { userId: number | null };
}

export const STATE_VERSION = 3;

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    savedAt: Date.now(),
    seq: {},
    counters: {},
    users: [],
    departments: [],
    docTypes: [],
    documents: [],
    participants: [],
    rounds: [],
    steps: [],
    roundFiles: [],
    access: [],
    acks: [],
    files: [],
    versions: [],
    comments: [],
    tasks: [],
    taskObservers: [],
    notifications: [],
    audit: [],
    bitrixLinks: [],
    mockDeals: [],
    mockTasks: [],
    settings: { mockUnavailable: false },
    session: { userId: null },
  };
}

/** Текущее состояние «базы». */
export let db: State = emptyState();
export function setDb(s: State): void {
  db = s;
}

export function nextId(table: string): number {
  db.seq[table] = (db.seq[table] ?? 0) + 1;
  return db.seq[table];
}

// ───────────── Часы ─────────────

let fixedNow: Ms | null = null;
/** Текущий момент; при заполнении демонстрационных данных часы «переводятся» в прошлое. */
export const now = (): Ms => fixedNow ?? Date.now();
export function setClock(ms: Ms | null): void {
  fixedNow = ms;
}

// ───────────── Содержимое файлов ─────────────

/** Содержимое версий файлов: ключ хранения → байты. */
const blobs = new Map<string, Uint8Array>();

const LS_STATE = 'docflow-demo:state';
const LS_BLOB = 'docflow-demo:blob:';
/** Файлы крупнее этого размера в localStorage не сохраняются (живут до перезагрузки страницы). */
const MAX_PERSIST_BYTES = 1_500_000;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function putBlob(key: string, bytes: Uint8Array): void {
  blobs.set(key, bytes);
  if (bytes.length > MAX_PERSIST_BYTES) return;
  try {
    localStorage.setItem(LS_BLOB + key, toBase64(bytes));
  } catch {
    /* не поместилось или хранилище недоступно — файл доступен до перезагрузки страницы */
  }
}

export function getBlob(key: string): Uint8Array | null {
  const mem = blobs.get(key);
  if (mem) return mem;
  try {
    const b64 = localStorage.getItem(LS_BLOB + key);
    if (b64) {
      const bytes = fromBase64(b64);
      blobs.set(key, bytes);
      return bytes;
    }
  } catch {
    /* хранилище недоступно */
  }
  return null;
}

// ───────────── Сохранение ─────────────

let saveTimer: number | null = null;

export function saveSoon(): void {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 50);
}

export function saveNow(): void {
  db.savedAt = Date.now();
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(db));
  } catch {
    /* без хранилища демо работает до перезагрузки страницы */
  }
}

/** Ключи дат во всех таблицах: при повторном открытии демо сдвигаются на прошедшее время. */
const DATE_KEY = /(_at|At)$/;

function shiftDates(s: State, delta: number): void {
  for (const value of Object.values(s)) {
    if (!Array.isArray(value)) continue;
    for (const row of value as Array<Record<string, unknown>>) {
      for (const k of Object.keys(row)) {
        if (DATE_KEY.test(k) && typeof row[k] === 'number') row[k] = (row[k] as number) + delta;
      }
    }
  }
}

/** Загружает сохранённое состояние; null — сохранения нет или оно другой версии. */
export function loadSaved(): State | null {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return null;
    const s = JSON.parse(raw) as State;
    if (s.version !== STATE_VERSION) return null;
    // Демонстрационные сроки остаются правдоподобными: всё «прожитое» время закрытой вкладки
    // переносится вперёд, как будто показ продолжается с того же места.
    const delta = Date.now() - s.savedAt;
    if (delta > 3600_000) shiftDates(s, delta);
    return s;
  } catch {
    return null;
  }
}

export function clearSaved(): void {
  blobs.clear();
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('docflow-demo:')) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* хранилище недоступно */
  }
}
