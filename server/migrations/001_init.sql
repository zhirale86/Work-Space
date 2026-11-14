-- Начальная схема системы документооборота

CREATE TABLE departments (
  id      serial PRIMARY KEY,
  name    text NOT NULL UNIQUE,
  active  boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id                    serial PRIMARY KEY,
  login                 text NOT NULL UNIQUE,
  full_name             text NOT NULL,
  position              text NOT NULL DEFAULT '',
  department_id         integer REFERENCES departments(id),
  password_hash         text NOT NULL,
  roles                 text[] NOT NULL DEFAULT '{employee}',
  active                boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_department_idx ON users(department_id);
CREATE INDEX users_name_idx ON users(lower(full_name));

CREATE TABLE sessions (
  id            text PRIMARY KEY,            -- SHA-256 от токена; сам токен в базе не хранится
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE login_attempts (
  id     bigserial PRIMARY KEY,
  login  text NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_idx ON login_attempts(login, at);

CREATE TABLE doc_types (
  id                   serial PRIMARY KEY,
  code                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('approval','order')),
  number_prefix        text NOT NULL,
  active               boolean NOT NULL DEFAULT true,
  require_deal         boolean NOT NULL DEFAULT false,
  require_file         boolean NOT NULL DEFAULT false,
  require_excel        boolean NOT NULL DEFAULT false,
  require_deadline     boolean NOT NULL DEFAULT false,
  require_description  boolean NOT NULL DEFAULT false
);

CREATE TABLE documents (
  id                serial PRIMARY KEY,
  number            text NOT NULL UNIQUE,
  doc_type_id       integer NOT NULL REFERENCES doc_types(id),
  kind              text NOT NULL CHECK (kind IN ('approval','order')),
  title             text NOT NULL DEFAULT '',
  description       text NOT NULL DEFAULT '',
  initiator_id      integer NOT NULL REFERENCES users(id),
  department_id     integer REFERENCES departments(id),
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','in_review','rework','on_signing','approved','rejected','cancelled','archived')),
  route_mode        text NOT NULL DEFAULT 'sequential' CHECK (route_mode IN ('sequential','parallel')),
  due_at            timestamptz,
  deal_id           text,
  deal_title        text,
  deal_url          text,
  signer_id         integer REFERENCES users(id),
  order_date        date,
  signed_at         timestamptz,
  signed_by         integer REFERENCES users(id),
  launch_count      integer NOT NULL DEFAULT 0,
  last_reminded_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  launched_at       timestamptz,
  completed_at      timestamptz
);
CREATE INDEX documents_initiator_idx ON documents(initiator_id);
CREATE INDEX documents_status_idx ON documents(status);
CREATE INDEX documents_department_idx ON documents(department_id);
CREATE INDEX documents_type_idx ON documents(doc_type_id);
CREATE INDEX documents_created_idx ON documents(created_at DESC);
CREATE INDEX documents_deal_idx ON documents(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX documents_signer_idx ON documents(signer_id) WHERE signer_id IS NOT NULL;
CREATE INDEX documents_due_idx ON documents(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE document_participants (
  document_id  integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      integer NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('approver','observer','acquaintance')),
  position     integer NOT NULL DEFAULT 0,
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, role, user_id)
);
CREATE INDEX document_participants_user_idx ON document_participants(user_id, role);

CREATE TABLE document_access (
  id             serial PRIMARY KEY,
  document_id    integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id        integer REFERENCES users(id),
  department_id  integer REFERENCES departments(id),
  granted_by     integer REFERENCES users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (department_id IS NULL))
);
CREATE UNIQUE INDEX document_access_user_idx ON document_access(document_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX document_access_dept_idx ON document_access(document_id, department_id) WHERE department_id IS NOT NULL;
CREATE INDEX document_access_by_user_idx ON document_access(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX document_access_by_dept_idx ON document_access(department_id) WHERE department_id IS NOT NULL;

CREATE TABLE approval_rounds (
  id           serial PRIMARY KEY,
  document_id  integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  round_no     integer NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('sequential','parallel')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  started_by   integer NOT NULL REFERENCES users(id),
  finished_at  timestamptz,
  outcome      text CHECK (outcome IN ('approved','rework','rejected','cancelled')),
  UNIQUE (document_id, round_no)
);

CREATE TABLE approval_steps (
  id            serial PRIMARY KEY,
  round_id      integer NOT NULL REFERENCES approval_rounds(id) ON DELETE CASCADE,
  user_id       integer NOT NULL REFERENCES users(id),
  position      integer NOT NULL,
  state         text NOT NULL CHECK (state IN ('waiting','pending','approved','rework','rejected','skipped','replaced')),
  comment       text,
  activated_at  timestamptz,                -- когда участник получил документ (шаг стал pending)
  decided_at    timestamptz
);
CREATE INDEX approval_steps_round_idx ON approval_steps(round_id);
CREATE INDEX approval_steps_user_idx ON approval_steps(user_id, state);
-- один сотрудник — не более одного действующего шага в раунде
CREATE UNIQUE INDEX approval_steps_unique_user ON approval_steps(round_id, user_id) WHERE state <> 'replaced';

CREATE TABLE files (
  id          serial PRIMARY KEY,
  owner_type  text NOT NULL CHECK (owner_type IN ('document','task')),
  owner_id    integer NOT NULL,
  role        text NOT NULL CHECK (role IN ('main','attachment','result')),
  title       text NOT NULL DEFAULT '',
  created_by  integer NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  deleted_by  integer REFERENCES users(id)
);
CREATE INDEX files_owner_idx ON files(owner_type, owner_id);

CREATE TABLE file_versions (
  id             serial PRIMARY KEY,
  file_id        integer NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_no     integer NOT NULL,
  original_name  text NOT NULL,
  ext            text NOT NULL,
  mime           text NOT NULL,
  size           bigint NOT NULL,
  sha256         text NOT NULL,
  storage_key    text NOT NULL UNIQUE,
  uploaded_by    integer NOT NULL REFERENCES users(id),
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version_no)
);

CREATE TABLE round_files (
  round_id         integer NOT NULL REFERENCES approval_rounds(id) ON DELETE CASCADE,
  file_version_id  integer NOT NULL REFERENCES file_versions(id),
  PRIMARY KEY (round_id, file_version_id)
);

CREATE TABLE acknowledgements (
  document_id      integer NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id          integer NOT NULL REFERENCES users(id),
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  file_version_id  integer REFERENCES file_versions(id),
  PRIMARY KEY (document_id, user_id)
);

CREATE TABLE tasks (
  id            serial PRIMARY KEY,
  number        text NOT NULL UNIQUE,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  author_id     integer NOT NULL REFERENCES users(id),
  assignee_id   integer NOT NULL REFERENCES users(id),
  due_at        timestamptz,
  document_id   integer REFERENCES documents(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','review','done','cancelled')),
  result_text   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX tasks_author_idx ON tasks(author_id);
CREATE INDEX tasks_assignee_idx ON tasks(assignee_id);
CREATE INDEX tasks_status_idx ON tasks(status);
CREATE INDEX tasks_document_idx ON tasks(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX tasks_due_idx ON tasks(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE task_observers (
  task_id  integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id  integer NOT NULL REFERENCES users(id),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_observers_user_idx ON task_observers(user_id);

CREATE TABLE comments (
  id           serial PRIMARY KEY,
  entity_type  text NOT NULL CHECK (entity_type IN ('document','task')),
  entity_id    integer NOT NULL,
  author_id    integer NOT NULL REFERENCES users(id),
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_entity_idx ON comments(entity_type, entity_id, created_at);

CREATE TABLE notifications (
  id           bigserial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id),
  type         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  entity_type  text,
  entity_id    integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  dedupe_key   text
);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     integer REFERENCES users(id),   -- NULL — системный процесс
  entity_type  text NOT NULL,
  entity_id    integer,
  action       text NOT NULL,
  summary      text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id, id);
CREATE INDEX audit_at_idx ON audit_log(at DESC);
CREATE INDEX audit_actor_idx ON audit_log(actor_id);

CREATE TABLE bitrix_links (
  document_id       integer PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  external_task_id  text,
  state             text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','synced','error')),
  synced_status     text,
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  last_attempt_at   timestamptz,
  next_attempt_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bitrix_links_queue_idx ON bitrix_links(next_attempt_at) WHERE state IN ('pending','error');

CREATE TABLE counters (
  key    text PRIMARY KEY,
  value  integer NOT NULL
);

CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

-- Эмулятор Битрикс24
CREATE TABLE mock_deals (
  id       serial PRIMARY KEY,
  title    text NOT NULL,
  stage    text NOT NULL DEFAULT '',
  company  text NOT NULL DEFAULT '',
  amount   numeric(14,2) NOT NULL DEFAULT 0
);

CREATE TABLE mock_tasks (
  id           serial PRIMARY KEY,
  deal_id      integer NOT NULL REFERENCES mock_deals(id) ON DELETE CASCADE,
  marker       text NOT NULL UNIQUE,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mock_tasks_deal_idx ON mock_tasks(deal_id);
