import { createUser } from './admin/service';
import { generatePassword } from './auth/passwords';
import { closePool } from './db';
import { runMigrations } from './migrate';
import { seedReference } from './seed';

/**
 * Первичная настройка рабочей установки без демонстрационных данных:
 * миграции, справочники (подразделения, типы документов) и учётная запись администратора
 * с временным паролем, который нужно сменить при первом входе.
 *
 *   node dist/src/create-admin.js <логин> "<ФИО>"
 */
async function main(): Promise<void> {
  const [login, ...nameParts] = process.argv.slice(2);
  const fullName = nameParts.join(' ').trim();
  if (!login || !fullName) {
    console.error('Использование: node dist/src/create-admin.js <логин> "<Фамилия Имя Отчество>"');
    process.exit(2);
  }
  await runMigrations((m) => console.log(m));
  await seedReference();
  const password = process.env.ADMIN_PASSWORD || generatePassword();
  const user = await createUser(null, { login, fullName, password, roles: ['employee', 'admin'], mustChangePassword: true });
  console.log(`Создана учётная запись администратора «${user.login}».`);
  console.log(`Временный пароль (сменить при первом входе): ${password}`);
}

main()
  .catch((err) => {
    console.error('Ошибка:', err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
