/**
 * Типы запросов и ответов API системы документооборота.
 *
 * Файл самодостаточен (без импортов) — интерфейс может подключать его напрямую.
 * Все пути — с префиксом `/api`. Даты и время — строки ISO 8601 (UTC), даты без времени — `ГГГГ-ММ-ДД`.
 * Подробное описание маршрутов — в `docs/04-api.md`.
 */

// ───────────────────────────── Общие ─────────────────────────────

export type Id = number;
/** Дата и время в формате ISO 8601, например `2026-11-14T08:30:00.000Z`. */
export type IsoDateTime = string;
/** Дата `ГГГГ-ММ-ДД`. */
export type IsoDate = string;

export interface ApiErrorBody {
  error: {
    /** Машинный код ошибки, см. `ErrorCode`. */
    code: ErrorCode;
    /** Готовый русский текст для показа пользователю. */
    message: string;
    /** Перечень замечаний (например, незаполненные поля при запуске). */
    details?: ErrorDetail[];
  };
}

export interface ErrorDetail {
  /** Имя поля запроса или логический ключ (`title`, `approvers`, `mainFile`, `deal`, …). */
  field: string;
  message: string;
}

export type ErrorCode =
  | 'validation' // 400 — некорректный формат запроса
  | 'unauthorized' // 401 — нет действующей сессии
  | 'invalid_credentials' // 401 — неверный логин или пароль
  | 'forbidden' // 403 — действие не разрешено
  | 'csrf' // 403 — нет заголовка X-Requested-With: docflow
  | 'password_change_required' // 403 — нужно сменить временный пароль
  | 'not_found' // 404 — объект не найден или нет доступа
  | 'conflict' // 409 — действие невозможно в текущем состоянии
  | 'payload_too_large' // 413 — превышен размер файла
  | 'unprocessable' // 422 — не выполнены требования к данным
  | 'too_many_requests' // 429 — слишком много попыток входа
  | 'bitrix_unavailable' // 502 — Битрикс24 недоступен (поиск и выбор сделки)
  | 'internal'; // 500

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Параметры разбивки на страницы (query). `pageSize` — от 1 до 100, по умолчанию 20. */
export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface OkResponse {
  ok: true;
}

// ───────────────────────────── Перечисления ─────────────────────────────

export type SystemRole = 'employee' | 'signer' | 'admin' | 'auditor';
export type DocKind = 'approval' | 'order';
export type DocStatus =
  | 'draft'
  | 'in_review'
  | 'rework'
  | 'on_signing'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'archived';
export type RouteMode = 'sequential' | 'parallel';
export type RoundOutcome = 'approved' | 'rework' | 'rejected' | 'cancelled';
export type StepState = 'waiting' | 'pending' | 'approved' | 'rework' | 'rejected' | 'skipped' | 'replaced';
export type Decision = 'approve' | 'rework' | 'reject';
export type TaskStatus = 'new' | 'in_progress' | 'review' | 'done' | 'cancelled';
export type FileRole = 'main' | 'attachment' | 'result';
export type FileOwnerType = 'document' | 'task';
export type EntityType = 'document' | 'task';
export type BitrixLinkState = 'pending' | 'synced' | 'error';
export type BitrixMode = 'mock' | 'rest';
export type MockTaskStatus = 'in_progress' | 'completed';
export type NotificationType =
  | 'approval_requested'
  | 'approval_rework'
  | 'approval_rejected'
  | 'approval_completed'
  | 'approval_cancelled'
  | 'sign_requested'
  | 'order_signed'
  | 'acknowledge_requested'
  | 'route_changed'
  | 'reminder'
  | 'participant_blocked'
  | 'task_assigned'
  | 'task_submitted'
  | 'task_accepted'
  | 'task_returned'
  | 'task_cancelled'
  | 'task_changed'
  | 'deadline_soon'
  | 'deadline_overdue'
  | 'comment_added';
export type DocumentScope = 'all' | 'mine' | 'to_approve' | 'to_sign' | 'to_acknowledge';
export type TaskScope = 'all' | 'assigned' | 'authored';
export type ReportCode =
  | 'approvals_in_progress'
  | 'approvals_overdue'
  | 'documents_rework'
  | 'tasks_in_progress'
  | 'tasks_overdue'
  | 'orders_pending_acknowledgement'
  | 'approvals_by_employee'
  | 'approvals_by_department';
/** Действие, которого система ждёт от текущего пользователя по документу. */
export type MyDocumentAction = 'approve' | 'sign' | 'acknowledge' | 'rework' | null;

export interface LabeledCode<T extends string = string> {
  code: T;
  label: string;
}

/** `GET /meta` — все перечисления с русскими подписями и действующие ограничения. */
export interface MetaResponse {
  roles: LabeledCode<SystemRole>[];
  docKinds: LabeledCode<DocKind>[];
  /** Подписи статусов документа-согласования. */
  docStatuses: LabeledCode<DocStatus>[];
  /** Подписи статусов приказа (отличается `approved` — «Утверждён»). */
  orderStatuses: LabeledCode<DocStatus>[];
  routeModes: LabeledCode<RouteMode>[];
  roundOutcomes: LabeledCode<RoundOutcome>[];
  stepStates: LabeledCode<StepState>[];
  decisions: LabeledCode<Decision>[];
  taskStatuses: LabeledCode<TaskStatus>[];
  fileRoles: LabeledCode<FileRole>[];
  bitrixLinkStates: LabeledCode<BitrixLinkState>[];
  notificationTypes: LabeledCode<NotificationType>[];
  reports: LabeledCode<ReportCode>[];
  limits: {
    maxFileMb: number;
    maxFilesPerCard: number;
    maxCardTotalMb: number;
    allowedExtensions: string[];
  };
  bitrixMode: BitrixMode;
}

// ───────────────────────────── Пользователи и справочники ─────────────────────────────

export interface DepartmentRef {
  id: Id;
  name: string;
}

export interface Department extends DepartmentRef {
  active: boolean;
}

/** Краткие сведения о сотруднике для отображения в карточках и списках. */
export interface UserRef {
  id: Id;
  fullName: string;
  position: string;
  department: DepartmentRef | null;
  /** `false` — учётная запись заблокирована. */
  active: boolean;
}

/** Текущий пользователь (`GET /auth/me`, ответ `POST /auth/login`). */
export interface CurrentUser extends UserRef {
  login: string;
  roles: SystemRole[];
  roleLabels: string[];
  mustChangePassword: boolean;
}

export interface LoginRequest {
  login: string;
  password: string;
}
export interface LoginResponse {
  user: CurrentUser;
}
export interface MeResponse {
  user: CurrentUser;
}
export interface ChangePasswordRequest {
  currentPassword: string;
  /** Не короче 8 символов. */
  newPassword: string;
}

/** `GET /users` (query). Возвращает только активных сотрудников. */
export interface UsersQuery extends PageQuery {
  /** Поиск по ФИО, логину и должности. */
  q?: string;
  departmentId?: Id;
  /** Отбор по системной роли, например `signer` для выбора утверждающего. */
  role?: SystemRole;
}

export interface DocType {
  id: Id;
  code: string;
  name: string;
  kind: DocKind;
  kindLabel: string;
  numberPrefix: string;
  active: boolean;
  requireDeal: boolean;
  requireFile: boolean;
  requireExcel: boolean;
  requireDeadline: boolean;
  requireDescription: boolean;
}

// ───────────────────────────── Файлы ─────────────────────────────

export interface FileVersion {
  id: Id;
  fileId: Id;
  versionNo: number;
  originalName: string;
  ext: string;
  mime: string;
  size: number;
  sha256: string;
  uploadedBy: UserRef;
  uploadedAt: IsoDateTime;
  /** Относительный путь скачивания: `/api/file-versions/<id>/download`. */
  downloadUrl: string;
}

export interface FileItem {
  id: Id;
  ownerType: FileOwnerType;
  ownerId: Id;
  role: FileRole;
  roleLabel: string;
  title: string;
  createdAt: IsoDateTime;
  /** Заполнено, если файл удалён из карточки (версии остаются в истории раундов). */
  deletedAt: IsoDateTime | null;
  /** Последняя версия. */
  currentVersion: FileVersion;
  /** Все версии, от новой к старой. */
  versions: FileVersion[];
}

/** Версия файла в снимке раунда согласования. */
export interface RoundFile {
  fileId: Id;
  role: FileRole;
  roleLabel: string;
  title: string;
  version: FileVersion;
}

// ───────────────────────────── Документы ─────────────────────────────

export interface DealRef {
  id: string;
  title: string | null;
  /** Ссылка на сделку в Битрикс24 (или на страницу эмулятора). */
  url: string;
}

export interface DocumentListItem {
  id: Id;
  number: string;
  kind: DocKind;
  kindLabel: string;
  type: { id: Id; code: string; name: string };
  title: string;
  status: DocStatus;
  statusLabel: string;
  initiator: UserRef;
  department: DepartmentRef | null;
  createdAt: IsoDateTime;
  dueAt: IsoDateTime | null;
  /** Срок прошёл, а процесс не завершён. */
  overdue: boolean;
  deal: DealRef | null;
  myAction: MyDocumentAction;
  myActionLabel: string | null;
}

/** `GET /documents` (query). */
export interface DocumentsQuery extends PageQuery {
  /** Поиск по номеру, названию и названию сделки. */
  q?: string;
  /** По умолчанию `all` — все доступные пользователю документы. */
  scope?: DocumentScope;
  kind?: DocKind;
  typeId?: Id;
  /** Один статус или несколько через запятую. */
  status?: string;
  initiatorId?: Id;
  departmentId?: Id;
  /** Период создания, `ГГГГ-ММ-ДД` включительно. */
  createdFrom?: IsoDate;
  createdTo?: IsoDate;
  /** Идентификатор или часть названия сделки. */
  deal?: string;
  /** `true` — только с нарушенным сроком. */
  overdue?: boolean;
}

export interface CreateDocumentRequest {
  typeId: Id;
  title?: string;
  description?: string;
  /** ISO-дата-время либо `ГГГГ-ММ-ДД` (тогда срок — конец этого дня). */
  dueAt?: string | null;
  routeMode?: RouteMode;
  /** Идентификатор сделки Битрикс24 (только для согласований). */
  dealId?: string | null;
  /** Согласующие в порядке маршрута. */
  approverIds?: Id[];
  observerIds?: Id[];
  /** Утверждающий (только для приказа; сотрудник с ролью `signer`). */
  signerId?: Id | null;
  /** Список ознакомления (только для приказа). */
  acquaintanceIds?: Id[];
  /** Дата приказа; если не указана — проставляется при утверждении. */
  orderDate?: IsoDate | null;
}

/** `PATCH /documents/:id` — все поля необязательны; изменяются только переданные. */
export type UpdateDocumentRequest = Omit<CreateDocumentRequest, 'typeId'>;

export interface ApprovalStep {
  id: Id;
  user: UserRef;
  position: number;
  state: StepState;
  stateLabel: string;
  comment: string | null;
  activatedAt: IsoDateTime | null;
  decidedAt: IsoDateTime | null;
}

export interface ApprovalRound {
  id: Id;
  roundNo: number;
  mode: RouteMode;
  modeLabel: string;
  startedAt: IsoDateTime;
  startedBy: UserRef;
  finishedAt: IsoDateTime | null;
  outcome: RoundOutcome | null;
  outcomeLabel: string | null;
  steps: ApprovalStep[];
  /** Версии файлов, рассматривавшиеся в этом раунде. */
  files: RoundFile[];
}

export interface AcknowledgementItem {
  user: UserRef;
  acknowledgedAt: IsoDateTime | null;
  /** Версия основного файла приказа, с которой ознакомился сотрудник. */
  fileVersionId: Id | null;
  fileVersionNo: number | null;
}

export interface AcknowledgementSummary {
  /** Ожидается подтверждений (без заблокированных, не успевших ознакомиться). */
  total: number;
  acknowledged: number;
  pending: number;
  items: AcknowledgementItem[];
}

export interface BitrixLinkInfo {
  state: BitrixLinkState;
  stateLabel: string;
  externalTaskId: string | null;
  /** Статус документа, переданный последним. */
  syncedStatus: DocStatus | null;
  syncedStatusLabel: string | null;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: IsoDateTime | null;
  nextAttemptAt: IsoDateTime | null;
}

export interface Comment {
  id: Id;
  author: UserRef;
  body: string;
  createdAt: IsoDateTime;
}

export interface AddCommentRequest {
  body: string;
}

export interface DocumentPermissions {
  /** Редактирование полей и состава участников (черновик, доработка; инициатор). */
  canEdit: boolean;
  canDelete: boolean;
  canLaunch: boolean;
  /** Загрузка, новые версии и удаление файлов. */
  canManageFiles: boolean;
  /** Принять решение как согласующий (есть шаг в состоянии `pending`). */
  canDecide: boolean;
  /** Утвердить, вернуть или отклонить приказ. */
  canSign: boolean;
  canCancel: boolean;
  canArchive: boolean;
  canAcknowledge: boolean;
  canChangeRoute: boolean;
  canManageAccess: boolean;
  canManageAcquaintance: boolean;
  canViewAcknowledgements: boolean;
  canRemind: boolean;
  canCopy: boolean;
  canRetryBitrix: boolean;
  canComment: boolean;
  canCreateTask: boolean;
}

export interface DocumentTaskRef {
  id: Id;
  number: string;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  assignee: UserRef;
  dueAt: IsoDateTime | null;
  overdue: boolean;
}

export interface DocumentDetail {
  id: Id;
  number: string;
  kind: DocKind;
  kindLabel: string;
  type: DocType;
  title: string;
  description: string;
  status: DocStatus;
  statusLabel: string;
  routeMode: RouteMode;
  routeModeLabel: string;
  dueAt: IsoDateTime | null;
  overdue: boolean;
  initiator: UserRef;
  department: DepartmentRef | null;
  deal: DealRef | null;
  /** Сделку можно менять только до первого запуска. */
  dealLocked: boolean;
  signer: UserRef | null;
  orderDate: IsoDate | null;
  signedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  launchedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  /** Сколько раз процесс запускался. */
  launchCount: number;
  /** Плановый состав согласующих (для следующего запуска), по порядку. */
  approvers: UserRef[];
  observers: UserRef[];
  /** Список ознакомления (приказ). */
  acquaintance: UserRef[];
  /** Раунды согласования, от нового к старому. */
  rounds: ApprovalRound[];
  /** Действующие файлы карточки. */
  files: FileItem[];
  /** Мой шаг в текущем раунде, если он есть. */
  myStep: ApprovalStep | null;
  myAction: MyDocumentAction;
  myActionLabel: string | null;
  /** Моё ознакомление: `required` — я в списке ознакомления. */
  myAcknowledgement: { required: boolean; acknowledgedAt: IsoDateTime | null };
  /** Сводка ознакомления — только для инициатора, утверждающего и роли `auditor`, иначе `null`. */
  acknowledgements: AcknowledgementSummary | null;
  /** Индивидуальный доступ — виден инициатору и роли `auditor`, иначе `null`. */
  access: { users: UserRef[]; departments: DepartmentRef[] } | null;
  /** Поручения по документу, доступные текущему пользователю. */
  tasks: DocumentTaskRef[];
  /** Состояние передачи в Битрикс24 (`null`, если сделки нет или процесс не запускался). */
  bitrix: BitrixLinkInfo | null;
  comments: Comment[];
  permissions: DocumentPermissions;
}

export interface LaunchRequest {
  /** Если передан — сохраняется как режим маршрута документа. */
  routeMode?: RouteMode;
}

export interface DecisionRequest {
  decision: Decision;
  /** Обязателен (не из одних пробелов) для `rework` и `reject`. */
  comment?: string;
}

export type SignRequest = DecisionRequest;

export interface CancelRequest {
  /** Причина отмены — обязательна. */
  reason: string;
}

export type RouteChangeRequest =
  | {
      action: 'replace';
      /** Кого заменить (участник, ещё не принявший решение). */
      fromUserId: Id;
      toUserId: Id;
      /** Причина — обязательна. */
      reason: string;
    }
  | {
      action: 'add';
      /** Кого добавить (в конец маршрута; в параллельном — в группу). */
      toUserId: Id;
      reason: string;
    };

export interface AccessRequest {
  /** Полный новый перечень сотрудников с индивидуальным доступом. */
  userIds: Id[];
  /** Полный новый перечень подразделений с доступом. */
  departmentIds: Id[];
}

export interface AcquaintanceRequest {
  /** Полный перечень; после утверждения приказа список можно только дополнять. */
  userIds: Id[];
}

export interface HistoryEntry {
  id: number;
  at: IsoDateTime;
  /** `null` — системный процесс. */
  actor: UserRef | null;
  actorName: string;
  action: string;
  /** Готовая русская фраза. */
  summary: string;
  details: Record<string, unknown>;
}

// ───────────────────────────── Поручения ─────────────────────────────

export interface TaskDocumentRef {
  id: Id;
  number: string;
  title: string;
  /** Есть ли у текущего пользователя доступ к карточке документа-основания. */
  accessible: boolean;
}

export interface TaskListItem {
  id: Id;
  number: string;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  author: UserRef;
  assignee: UserRef;
  dueAt: IsoDateTime | null;
  overdue: boolean;
  createdAt: IsoDateTime;
  document: TaskDocumentRef | null;
}

export interface TaskPermissions {
  /** Изменение названия, содержания, срока, исполнителя, наблюдателей (постановщик, пока не завершено). */
  canEdit: boolean;
  canStart: boolean;
  canSubmit: boolean;
  canAccept: boolean;
  canReturn: boolean;
  canCancel: boolean;
  canUploadFiles: boolean;
  canComment: boolean;
}

export interface TaskDetail extends TaskListItem {
  body: string;
  resultText: string | null;
  updatedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  observers: UserRef[];
  files: FileItem[];
  comments: Comment[];
  permissions: TaskPermissions;
}

/** `GET /tasks` (query). */
export interface TasksQuery extends PageQuery {
  /** Поиск по номеру и названию. */
  q?: string;
  /** По умолчанию `all` — все доступные пользователю поручения. */
  scope?: TaskScope;
  /** Один статус или несколько через запятую. */
  status?: string;
  overdue?: boolean;
  documentId?: Id;
}

export interface CreateTaskRequest {
  title: string;
  body?: string;
  assigneeId: Id;
  /** ISO-дата-время либо `ГГГГ-ММ-ДД` (конец дня). */
  dueAt?: string | null;
  /** Документ-основание; не указывается для самостоятельного поручения. */
  documentId?: Id | null;
  observerIds?: Id[];
}

export interface UpdateTaskRequest {
  title?: string;
  body?: string;
  assigneeId?: Id;
  dueAt?: string | null;
  observerIds?: Id[];
}

export interface SubmitTaskRequest {
  /** Результат исполнения — обязателен. */
  resultText: string;
}
export interface ReturnTaskRequest {
  /** Комментарий — обязателен. */
  comment: string;
}
export interface CancelTaskRequest {
  /** Причина — обязательна. */
  reason: string;
}

// ───────────────────────────── Уведомления ─────────────────────────────

export interface NotificationItem {
  id: number;
  type: NotificationType;
  typeLabel: string;
  title: string;
  body: string;
  /** Карточка, на которую ведёт уведомление. */
  entityType: EntityType | null;
  entityId: Id | null;
  createdAt: IsoDateTime;
  readAt: IsoDateTime | null;
}

export interface NotificationsQuery extends PageQuery {
  /** `true` — только непрочитанные. */
  unread?: boolean;
}

export interface UnreadCountResponse {
  count: number;
}

// ───────────────────────────── Главная и отчёты ─────────────────────────────

export interface DashboardBlock<T> {
  count: number;
  /** Не более пяти первых записей. */
  items: T[];
}

export interface DashboardResponse {
  /** Согласования, ожидающие моего решения. */
  toApprove: DashboardBlock<DocumentListItem>;
  /** Мои документы, возвращённые на доработку. */
  rework: DashboardBlock<DocumentListItem>;
  /** Приказы, ожидающие моего утверждения. */
  toSign: DashboardBlock<DocumentListItem>;
  /** Приказы, с которыми мне нужно ознакомиться. */
  toAcknowledge: DashboardBlock<DocumentListItem>;
  /** Поручения, где я исполнитель, не завершённые. */
  myTasks: DashboardBlock<TaskListItem>;
  /** Поручения, где я постановщик, ожидающие проверки. */
  tasksToReview: DashboardBlock<TaskListItem>;
  /** Просрочено: документы и поручения, по которым действие ожидается от меня. */
  overdue: { count: number; documents: DocumentListItem[]; tasks: TaskListItem[] };
  unreadNotifications: number;
}

export interface ReportSummaryItem {
  code: ReportCode;
  label: string;
  /** Количество записей в пределах прав доступа пользователя. */
  count: number;
}
export interface ReportSummaryResponse {
  items: ReportSummaryItem[];
}

export interface OrderAcknowledgementReportItem extends DocumentListItem {
  ackTotal: number;
  ackDone: number;
  ackPending: number;
}

export interface ApprovalsByEmployeeItem {
  user: UserRef;
  /** Ожидают решения сейчас. */
  pending: number;
  /** Из ожидающих — с нарушенным сроком. */
  overdue: number;
  approved: number;
  returned: number;
  rejected: number;
  total: number;
}

export interface ApprovalsByDepartmentItem {
  department: DepartmentRef | null;
  inProgress: number;
  rework: number;
  approved: number;
  rejected: number;
  cancelled: number;
  total: number;
}

/** `GET /reports/:reportCode` (query). */
export interface ReportQuery extends PageQuery {
  /** Отбор по сотруднику (для `approvals_by_employee` — согласующий, для остальных — инициатор или исполнитель). */
  userId?: Id;
  departmentId?: Id;
}

export type ReportResponse =
  | ({ code: 'approvals_in_progress' | 'approvals_overdue' | 'documents_rework'; label: string } & Page<DocumentListItem>)
  | ({ code: 'tasks_in_progress' | 'tasks_overdue'; label: string } & Page<TaskListItem>)
  | ({ code: 'orders_pending_acknowledgement'; label: string } & Page<OrderAcknowledgementReportItem>)
  | ({ code: 'approvals_by_employee'; label: string } & Page<ApprovalsByEmployeeItem>)
  | ({ code: 'approvals_by_department'; label: string } & Page<ApprovalsByDepartmentItem>);

// ───────────────────────────── Битрикс24 ─────────────────────────────

export interface Deal {
  id: string;
  title: string;
  url: string;
  /** Стадия, компания и сумма возвращаются только эмулятором и поиском; в карточке не хранятся. */
  stage?: string;
  company?: string;
  amount?: number;
}

export interface DealsResponse {
  items: Deal[];
}

export interface BitrixRetryResponse {
  bitrix: BitrixLinkInfo;
}

export interface MockTask {
  id: Id;
  dealId: Id;
  marker: string;
  title: string;
  description: string;
  status: MockTaskStatus;
  statusLabel: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Ссылка на карточку согласования, извлечённая из описания задачи. */
  cardUrl: string | null;
  /** Идентификатор документа из маркера `DOCFLOW-<id>`. */
  documentId: Id | null;
}

export interface MockDeal {
  id: Id;
  title: string;
  stage: string;
  company: string;
  amount: number;
  url: string;
  tasksCount: number;
}

export interface MockDealDetail extends MockDeal {
  tasks: MockTask[];
}

// ───────────────────────────── Администрирование ─────────────────────────────

export interface AdminUser extends UserRef {
  login: string;
  roles: SystemRole[];
  roleLabels: string[];
  mustChangePassword: boolean;
  createdAt: IsoDateTime;
}

export interface AdminUsersQuery extends PageQuery {
  q?: string;
  departmentId?: Id;
  /** `true` — только активные, `false` — только заблокированные. */
  active?: boolean;
  role?: SystemRole;
}

export interface AdminCreateUserRequest {
  /** 3–64 символа: латинские буквы, цифры, точка, дефис, подчёркивание. */
  login: string;
  fullName: string;
  position?: string;
  departmentId?: Id | null;
  /** По умолчанию `['employee']`. */
  roles?: SystemRole[];
  /** Не короче 8 символов. */
  password: string;
  /** По умолчанию `true` — сотрудник обязан сменить пароль при первом входе. */
  mustChangePassword?: boolean;
}

export interface AdminUpdateUserRequest {
  fullName?: string;
  position?: string;
  departmentId?: Id | null;
  roles?: SystemRole[];
}

export interface AdminResetPasswordRequest {
  /** Если не передан — сервер создаёт временный пароль и возвращает его в ответе. */
  password?: string;
}
export interface AdminResetPasswordResponse {
  /** Временный пароль (показывается один раз). */
  temporaryPassword: string;
}

export interface AdminDepartmentRequest {
  name?: string;
  active?: boolean;
}

export interface AdminCreateDocTypeRequest {
  /** Уникальный код, латиница/цифры/подчёркивание. */
  code: string;
  name: string;
  kind: DocKind;
  /** Префикс номера, например `GPM`. */
  numberPrefix: string;
  requireDeal?: boolean;
  requireFile?: boolean;
  requireExcel?: boolean;
  requireDeadline?: boolean;
  requireDescription?: boolean;
}

export interface AdminUpdateDocTypeRequest {
  name?: string;
  numberPrefix?: string;
  active?: boolean;
  requireDeal?: boolean;
  requireFile?: boolean;
  requireExcel?: boolean;
  requireDeadline?: boolean;
  requireDescription?: boolean;
}

export interface AdminBitrixQueueItem {
  documentId: Id;
  documentNumber: string;
  documentStatus: DocStatus;
  documentStatusLabel: string;
  dealId: string | null;
  link: BitrixLinkInfo;
}

export interface AdminBitrixState {
  mode: BitrixMode;
  /** Настроен ли адрес вебхука (для режима `rest`); сам адрес не раскрывается. */
  webhookConfigured: boolean;
  /** Переключатель «Битрикс24 недоступен» эмулятора. */
  mockUnavailable: boolean;
  counts: { pending: number; synced: number; error: number };
  /** Записи в состояниях `pending` и `error`. */
  queue: AdminBitrixQueueItem[];
}

export interface AdminBitrixMockRequest {
  unavailable: boolean;
}

export interface AdminBitrixRetryRequest {
  /** Если не указан — повторяются все записи с ошибкой и ожидающие. */
  documentId?: Id;
}
export interface AdminBitrixRetryResponse {
  processed: number;
  synced: number;
  failed: number;
}

export interface AdminAuditQuery extends PageQuery {
  entityType?: string;
  entityId?: Id;
  actorId?: Id;
  action?: string;
  /** Период, `ГГГГ-ММ-ДД` включительно. */
  from?: IsoDate;
  to?: IsoDate;
  /** Поиск по тексту записи. */
  q?: string;
}

export interface AdminAuditEntry extends Omit<HistoryEntry, 'details'> {
  entityType: string;
  entityId: Id | null;
  /** Подробности возвращаются только пользователю с ролью `auditor`, иначе `null`. */
  details: Record<string, unknown> | null;
}

/** Служебные сведения о документе для администратора (без содержимого: названия, описания, файлов, комментариев). */
export interface AdminDocumentItem {
  id: Id;
  number: string;
  kind: DocKind;
  kindLabel: string;
  typeName: string;
  status: DocStatus;
  statusLabel: string;
  initiator: UserRef;
  department: DepartmentRef | null;
  createdAt: IsoDateTime;
  dueAt: IsoDateTime | null;
}

export interface AdminDocumentDetail extends AdminDocumentItem {
  routeMode: RouteMode;
  routeModeLabel: string;
  signer: UserRef | null;
  /** Шаги текущего (или последнего) раунда. */
  steps: ApprovalStep[];
  bitrix: BitrixLinkInfo | null;
  canCancel: boolean;
  canChangeRoute: boolean;
  canArchive: boolean;
}

export interface AdminDocumentsQuery extends PageQuery {
  /** Поиск по номеру. */
  q?: string;
  status?: string;
  initiatorId?: Id;
}
