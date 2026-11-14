# Установка и сопровождение системы документооборота

Состав: приложение (Node.js 22, интерфейс и API в одном процессе) и PostgreSQL 16 — в Docker Compose;
HTTPS обеспечивает обратный прокси (nginx) на том же сервере. Состояние системы — только база данных
и каталог файлов, поэтому резервная копия = дамп базы + архив файлов + файл настроек `.env`.

| Файл | Назначение |
|---|---|
| `Dockerfile` | многоэтапная сборка: `web/` → `web/dist`, затем сервер; итоговый образ `node:22-slim`, пользователь `node` |
| `docker-compose.yml` | сервисы `app` и `db` (postgres:16), тома `db-data` и `files-data`, настройки из `.env` |
| `.env.example` | образец настроек |
| `backup.sh`, `restore.sh` | резервное копирование и восстановление (работают без Docker: нужны `pg_dump`/`pg_restore`/`psql` 16, `tar`) |
| `nginx.conf.example` | обратный прокси с HTTPS |

## Требования к серверу

- Linux x86_64, Docker Engine 24+ с плагином Compose v2 (сборка использует BuildKit).
- Для резервного копирования — клиент PostgreSQL 16 на сервере (`apt install postgresql-client-16`
  из репозитория apt.postgresql.org) и `tar`, `sha256sum`.
- Ориентир для 500 сотрудников / 150 одновременных пользователей: 2 vCPU, 4 ГБ ОЗУ, диск под файлы с запасом.
- Сертификат для HTTPS (внутренний УЦ компании).

## Установка

```bash
# 1. Исходный код
sudo mkdir -p /opt/docflow && sudo chown "$USER" /opt/docflow
git clone <репозиторий> /opt/docflow && cd /opt/docflow/deploy

# 2. Настройки
cp .env.example .env && chmod 600 .env
#    обязательно: POSTGRES_PASSWORD, PUBLIC_URL; для боевого Битрикс24 — BITRIX_MODE=rest,
#    BITRIX_WEBHOOK_URL, BITRIX_PORTAL_URL, BITRIX_RESPONSIBLE_ID

# 3. Сборка и запуск (миграции базы применяются автоматически при старте приложения)
docker compose up -d --build
docker compose ps                      # app и db — healthy
curl -s http://127.0.0.1:3000/api/health   # {"ok":true}

# 4. Начальные данные: подразделения, типы документов, сделки эмулятора, тестовые
#    учётные записи и демонстрационные документы (только для тестовой модели!)
docker compose run --rm app node dist/src/seed.js

# 5. HTTPS
sudo cp nginx.conf.example /etc/nginx/conf.d/docflow.conf   # поправить server_name и сертификаты
sudo nginx -t && sudo systemctl reload nginx
```

После шага 4 вход: `admin` / пароль из `SEED_PASSWORD` (по умолчанию `Test12345!`). Перечень тестовых
учётных записей — в `server/README.md`. Перед вводом в эксплуатацию смените пароли или заблокируйте
тестовые записи в разделе «Администрирование».

Рабочая установка без демонстрационных данных — вместо шага 4 создайте справочники и администратора:

```bash
docker compose run --rm app node dist/src/create-admin.js admin "Соколова Ирина Викторовна"
# выводит временный пароль; при первом входе система потребует его сменить
```

## Обновление

```bash
cd /opt/docflow
./deploy/backup.sh ...            # сначала резервная копия (см. ниже)
git pull
cd deploy && docker compose up -d --build   # новые миграции применяются при старте
docker compose logs -f app        # «Применена миграция …» / «Новых миграций нет»
```

Откат: верните предыдущую версию кода (`git checkout <тег>`), пересоберите образ и, если новая версия
уже применила миграции, восстановите базу из копии, сделанной перед обновлением.

## Резервное копирование

`backup.sh` создаёт каталог `<КАТАЛОГ>/<ГГГГММДД-ЧЧММСС>/` с файлами `db.dump` (pg_dump, формат custom),
`files.tar.gz` (каталог файлов без временного подкаталога `tmp`), `env` (копия `.env`), `manifest.txt`
и `SHA256SUMS`. Скрипт использует переменные `DATABASE_URL` и `FILES_DIR`; `ENV_FILE` (по умолчанию
`deploy/.env`), `BACKUP_KEEP_DAYS` (удаление старых копий) — необязательны.

В Docker-установке база доступна на `127.0.0.1:${DB_PORT}`, файлы — в томе `docflow_files-data`:

```bash
cd /opt/docflow/deploy
set -a; . ./.env; set +a
export DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:${DB_PORT:-5432}/$POSTGRES_DB"
export FILES_DIR="$(docker volume inspect -f '{{ .Mountpoint }}' docflow_files-data)"
sudo -E BACKUP_KEEP_DAYS=30 ./backup.sh /srv/backups/docflow
```

Ежедневно в 02:30 (cron root): поместите строки выше в `/opt/docflow/deploy/backup-cron.sh` и добавьте
`30 2 * * * /opt/docflow/deploy/backup-cron.sh >>/var/log/docflow-backup.log 2>&1`.
Копии храните также вне сервера; периодичность и срок хранения согласуются с IT (ТЗ 19.5).
Копия согласована, если во время её создания не идёт загрузка файлов; для полной гарантии
снимайте её в нерабочее время или на время копирования останавливайте `app` (`docker compose stop app`).

Без Docker (сервер и PostgreSQL установлены напрямую) достаточно задать `DATABASE_URL` и `FILES_DIR`
из настроек приложения и запустить `./backup.sh /srv/backups/docflow`.

## Восстановление

`restore.sh КАТАЛОГ_КОПИИ [--force]` восстанавливает базу в `DATABASE_URL` и файлы в `FILES_DIR`.
Сначала проверяются контрольные суммы. В непустую базу или непустой каталог восстановление выполняется
только с `--force` (объекты базы пересоздаются, содержимое каталога файлов заменяется). Файл настроек из
копии (`env`) автоматически не применяется — сравните его с действующим `.env`.

```bash
cd /opt/docflow/deploy
docker compose stop app
set -a; . ./.env; set +a
export DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:${DB_PORT:-5432}/$POSTGRES_DB"
export FILES_DIR="$(docker volume inspect -f '{{ .Mountpoint }}' docflow_files-data)"
sudo -E ./restore.sh /srv/backups/docflow/20261114-023000 --force
sudo chown -R 1000:1000 "$FILES_DIR"      # владелец — пользователь node в контейнере
docker compose start app
```

Проверка восстановления на отдельном стенде (рекомендуется после каждого изменения процедуры):
создайте пустую базу (`createdb docflow_check`), выполните `restore.sh` с `DATABASE_URL` этой базы и пустым
`FILES_DIR`, запустите приложение на них и откройте документ с файлом. Этот сценарий автоматически
проверяется тестом `server/test/backup.test.ts` (критерий приёмки 17).

## Журналы и диагностика

- `docker compose logs app` — журнал приложения (JSON, уровень `LOG_LEVEL`);
- `GET /api/health` — проверка приложения и соединения с базой (используется в HEALTHCHECK образа);
- состояние передачи в Битрикс24, очередь и ошибки — «Администрирование → Интеграция» (`/api/admin/bitrix`);
- журнал действий пользователей — «Администрирование → Журнал» (`/api/admin/audit`).
