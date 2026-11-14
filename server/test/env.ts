/**
 * Окружение тестов. Импортируется первым — до чтения конфигурации сервера.
 * Тесты всегда работают с отдельной базой (по умолчанию docflow_test) и временным каталогом файлов.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.TEST_DATABASE_URL || 'postgres://docflow:docflow@127.0.0.1:5433/docflow_test';
const dbName = new URL(url).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  // Защита от случайной очистки рабочей базы.
  throw new Error(`Тесты очищают базу данных; имя базы должно содержать «test», указано: ${dbName}`);
}

process.env.DATABASE_URL = url;
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-test-files-'));
process.env.LOG_LEVEL = 'silent';
process.env.JOBS_ENABLED = 'false';
process.env.BITRIX_MODE = 'mock';
process.env.PUBLIC_URL = 'http://docflow.test';
process.env.MAX_FILE_MB = '1';
process.env.MAX_FILES_PER_CARD = '20';
process.env.MAX_CARD_TOTAL_MB = '200';
process.env.WEB_DIST = path.join(os.tmpdir(), 'docflow-test-no-web');
process.env.SEED_PASSWORD = 'Test12345!';

export const TEST_DATABASE_URL = url;
