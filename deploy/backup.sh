#!/usr/bin/env bash
# Резервная копия системы документооборота: база данных, каталог файлов и файл настроек.
#
# Использование:
#   DATABASE_URL=postgres://... FILES_DIR=/srv/docflow/files deploy/backup.sh [КАТАЛОГ_КОПИЙ]
#
# Переменные окружения:
#   DATABASE_URL      — строка подключения к базе (обязательно);
#   FILES_DIR         — каталог файлов приложения (обязательно);
#   BACKUP_DIR        — каталог для копий, если не передан аргументом (по умолчанию ./backups);
#   ENV_FILE          — файл настроек для копирования (по умолчанию deploy/.env рядом со скриптом);
#   BACKUP_KEEP_DAYS  — удалять копии старше указанного числа дней (по умолчанию не удалять).
#
# Результат — каталог <КАТАЛОГ_КОПИЙ>/<ГГГГММДД-ЧЧММСС>/ с файлами:
#   db.dump        — pg_dump в формате custom;
#   files.tar.gz   — архив каталога файлов (без временного подкаталога tmp);
#   env            — копия файла настроек (если он найден);
#   manifest.txt   — сведения о копии;  SHA256SUMS — контрольные суммы.
# Последняя строка вывода — путь к созданному каталогу.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "Ошибка: $*" >&2; exit 1; }

[ -n "${DATABASE_URL:-}" ] || fail "не задана переменная DATABASE_URL"
[ -n "${FILES_DIR:-}" ] || fail "не задана переменная FILES_DIR"
[ -d "$FILES_DIR" ] || fail "каталог файлов $FILES_DIR не найден"
command -v pg_dump >/dev/null || fail "не найдена программа pg_dump (установите клиент PostgreSQL 16)"

ROOT="${1:-${BACKUP_DIR:-./backups}}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$ROOT/$STAMP"
n=1
while [ -e "$DEST" ]; do DEST="$ROOT/$STAMP-$n"; n=$((n + 1)); done

umask 077
mkdir -p "$DEST"
# При ошибке незавершённая копия удаляется, чтобы её не приняли за рабочую.
trap 'rc=$?; if [ $rc -ne 0 ]; then rm -rf "$DEST"; echo "Резервная копия не создана" >&2; fi' EXIT

echo "Копия базы данных..." >&2
pg_dump --format=custom --no-owner --no-privileges --file="$DEST/db.dump" "$DATABASE_URL"

echo "Архив каталога файлов $FILES_DIR..." >&2
tar -C "$FILES_DIR" --exclude=./tmp -czf "$DEST/files.tar.gz" .

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$DEST/env"
  ENV_NOTE="$ENV_FILE"
else
  ENV_NOTE="не найден ($ENV_FILE)"
  echo "Предупреждение: файл настроек $ENV_FILE не найден — копия создана без него" >&2
fi

{
  echo "Резервная копия системы документооборота"
  echo "Создана: $(date -Iseconds)"
  echo "Узел: $(hostname)"
  echo "Файлов в архиве: $(tar -tzf "$DEST/files.tar.gz" | grep -vc '/$' || true)"
  echo "Файл настроек: $ENV_NOTE"
} >"$DEST/manifest.txt"

(cd "$DEST" && sha256sum db.dump files.tar.gz $( [ -f env ] && echo env ) >SHA256SUMS)

if [ -n "${BACKUP_KEEP_DAYS:-}" ]; then
  find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$BACKUP_KEEP_DAYS" -print -exec rm -rf {} + >&2 || true
fi

echo "Резервная копия создана: $DEST" >&2
echo "$DEST"
