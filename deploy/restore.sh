#!/usr/bin/env bash
# Восстановление системы документооборота из резервной копии, созданной deploy/backup.sh.
#
# Использование:
#   DATABASE_URL=postgres://... FILES_DIR=/srv/docflow/files deploy/restore.sh КАТАЛОГ_КОПИИ [--force]
#
#   DATABASE_URL — база, В КОТОРУЮ восстанавливаются данные (должна существовать; обычно пустая);
#   FILES_DIR    — каталог, В КОТОРЫЙ восстанавливаются файлы (создаётся при отсутствии);
#   --force      — разрешить восстановление в непустую базу и непустой каталог:
#                  объекты базы пересоздаются, содержимое каталога файлов заменяется.
#
# Перед восстановлением остановите приложение. Файл настроек из копии (env) не применяется
# автоматически — сравните его с действующим и при необходимости скопируйте вручную.
set -euo pipefail

fail() { echo "Ошибка: $*" >&2; exit 1; }

SRC="${1:-}"
FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1
[ -n "$SRC" ] || fail "укажите каталог резервной копии: restore.sh КАТАЛОГ_КОПИИ [--force]"
[ -d "$SRC" ] || fail "каталог резервной копии $SRC не найден"
[ -f "$SRC/db.dump" ] || fail "в каталоге $SRC нет файла db.dump"
[ -f "$SRC/files.tar.gz" ] || fail "в каталоге $SRC нет файла files.tar.gz"
[ -n "${DATABASE_URL:-}" ] || fail "не задана переменная DATABASE_URL (база для восстановления)"
[ -n "${FILES_DIR:-}" ] || fail "не задана переменная FILES_DIR (каталог для восстановления файлов)"
command -v pg_restore >/dev/null || fail "не найдена программа pg_restore (установите клиент PostgreSQL 16)"
command -v psql >/dev/null || fail "не найдена программа psql (установите клиент PostgreSQL 16)"

if [ -f "$SRC/SHA256SUMS" ]; then
  echo "Проверка контрольных сумм..." >&2
  (cd "$SRC" && sha256sum --quiet -c SHA256SUMS) || fail "контрольные суммы не совпадают — копия повреждена"
fi

TABLES="$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [ "$TABLES" != "0" ] && [ $FORCE -ne 1 ]; then
  fail "база не пуста (таблиц: $TABLES). Для замены данных запустите с --force"
fi
if [ -d "$FILES_DIR" ] && [ -n "$(ls -A "$FILES_DIR" 2>/dev/null)" ] && [ $FORCE -ne 1 ]; then
  fail "каталог $FILES_DIR не пуст. Для замены файлов запустите с --force"
fi

echo "Восстановление базы данных..." >&2
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
  --dbname="$DATABASE_URL" "$SRC/db.dump"

echo "Восстановление файлов в $FILES_DIR..." >&2
mkdir -p "$FILES_DIR"
if [ $FORCE -eq 1 ]; then
  find "$FILES_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
fi
tar -C "$FILES_DIR" -xzf "$SRC/files.tar.gz"
mkdir -p "$FILES_DIR/tmp"

echo "Восстановление завершено. Документов в базе: $(psql "$DATABASE_URL" -Atqc 'SELECT count(*) FROM documents')" >&2
if [ -f "$SRC/env" ]; then
  echo "Копия файла настроек: $SRC/env (не применяется автоматически)" >&2
fi
