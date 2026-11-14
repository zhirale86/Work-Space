import { Readable } from 'node:stream';
import type { AdminCreateDocTypeRequest, SystemRole } from './api-types';
import { createDepartment, createDocType, createUser } from './admin/service';
import { decide, launchDocument } from './approvals/service';
import { processBitrixQueue } from './bitrix/sync';
import type { Actor } from './common';
import { config } from './config';
import { closePool, getPool, one, rows } from './db';
import { addDocumentComment, createDocument } from './documents/service';
import { samplePdf, sampleXlsx } from './files/samples';
import { uploadFile } from './files/service';
import { checkDeadlines } from './jobs/deadlines';
import { runMigrations } from './migrate';
import { acknowledge, signOrder } from './orders/service';
import { addTaskComment, createTask, transitionTask } from './tasks/service';

export const DEPARTMENTS = [
  'Sales',
  'IT',
  'Security',
  'Marketing',
  'Finance',
  'Юридический отдел',
  'Customer Service',
  'Engineering',
  'Services',
  'Logistics',
];

export const DOC_TYPES: AdminCreateDocTypeRequest[] = [
  { code: 'GPM', name: 'Согласование GPM-калькулятора', kind: 'approval', numberPrefix: 'GPM', requireDeal: true, requireFile: true, requireExcel: true },
  { code: 'APPROVAL', name: 'Другое согласование', kind: 'approval', numberPrefix: 'СГЛ' },
  { code: 'ORDER', name: 'Приказ', kind: 'order', numberPrefix: 'ПР', requireFile: true },
];

export const DEALS = [
  { title: 'Поставка серверного оборудования — ООО «Северсталь-Инфо»', stage: 'Коммерческое предложение', company: 'ООО «Северсталь-Инфо»', amount: 18_450_000 },
  { title: 'Модернизация ЦОД — АО «Балтийский завод»', stage: 'Согласование условий', company: 'АО «Балтийский завод»', amount: 42_300_000 },
  { title: 'Сервисный контракт 2027 — ПАО «ТрансКонтейнер»', stage: 'Подготовка договора', company: 'ПАО «ТрансКонтейнер»', amount: 6_900_000 },
  { title: 'Лицензии и внедрение — ГК «Агроэкспорт»', stage: 'Переговоры', company: 'ГК «Агроэкспорт»', amount: 3_780_000 },
  { title: 'Система видеонаблюдения — ТРЦ «Меридиан»', stage: 'Коммерческое предложение', company: 'ООО «Меридиан Девелопмент»', amount: 11_200_000 },
  { title: 'Сетевая инфраструктура — НИИ «Полюс»', stage: 'Квалификация', company: 'АО «НИИ «Полюс»', amount: 9_640_000 },
  { title: 'Поставка СХД — Банк «Приморье»', stage: 'Согласование условий', company: 'ПАО АКБ «Приморье»', amount: 27_900_000 },
  { title: 'Техническая поддержка — АО «Уралхиммаш»', stage: 'Подготовка договора', company: 'АО «Уралхиммаш»', amount: 2_150_000 },
  { title: 'Проектирование АСУ ТП — ООО «Волга-Цемент»', stage: 'Переговоры', company: 'ООО «Волга-Цемент»', amount: 15_300_000 },
  { title: 'Рабочие места и периферия — МФЦ Ленинградской области', stage: 'Тендер', company: 'ГБУ ЛО «МФЦ»', amount: 5_480_000 },
];

interface SeedUser {
  login: string;
  fullName: string;
  position: string;
  department: string;
  roles: SystemRole[];
}

export const USERS: SeedUser[] = [
  { login: 'admin', fullName: 'Соколова Ирина Викторовна', position: 'Системный администратор', department: 'IT', roles: ['employee', 'admin'] },
  { login: 'auditor', fullName: 'Белов Андрей Николаевич', position: 'Руководитель службы внутреннего контроля', department: 'Security', roles: ['employee', 'auditor'] },
  { login: 'director', fullName: 'Орлов Сергей Павлович', position: 'Генеральный директор', department: 'Finance', roles: ['employee', 'signer'] },
  { login: 'ivanov', fullName: 'Иванов Алексей Дмитриевич', position: 'Менеджер по продажам', department: 'Sales', roles: ['employee'] },
  { login: 'petrova', fullName: 'Петрова Мария Сергеевна', position: 'Руководитель отдела продаж', department: 'Sales', roles: ['employee'] },
  { login: 'kuznetsov', fullName: 'Кузнецов Дмитрий Олегович', position: 'Менеджер по работе с ключевыми клиентами', department: 'Sales', roles: ['employee'] },
  { login: 'smirnova', fullName: 'Смирнова Елена Андреевна', position: 'Финансовый контролёр', department: 'Finance', roles: ['employee'] },
  { login: 'volkov', fullName: 'Волков Игорь Михайлович', position: 'Финансовый директор', department: 'Finance', roles: ['employee', 'signer'] },
  { login: 'morozova', fullName: 'Морозова Анна Владимировна', position: 'Юрисконсульт', department: 'Юридический отдел', roles: ['employee'] },
  { login: 'lebedev', fullName: 'Лебедев Павел Игоревич', position: 'Руководитель юридического отдела', department: 'Юридический отдел', roles: ['employee'] },
  { login: 'novikov', fullName: 'Новиков Артём Сергеевич', position: 'Главный инженер', department: 'Engineering', roles: ['employee'] },
  { login: 'fedorova', fullName: 'Фёдорова Ольга Николаевна', position: 'Инженер-проектировщик', department: 'Engineering', roles: ['employee'] },
  { login: 'zaitsev', fullName: 'Зайцев Кирилл Андреевич', position: 'Системный инженер', department: 'IT', roles: ['employee'] },
  { login: 'pavlova', fullName: 'Павлова Наталья Юрьевна', position: 'Руководитель отдела логистики', department: 'Logistics', roles: ['employee'] },
  { login: 'egorov', fullName: 'Егоров Максим Викторович', position: 'Сервисный инженер', department: 'Services', roles: ['employee'] },
  { login: 'vasilieva', fullName: 'Васильева Дарья Алексеевна', position: 'Маркетолог', department: 'Marketing', roles: ['employee'] },
];

/** Справочники: подразделения, типы документов, сделки эмулятора. Идемпотентно. */
export async function seedReference(): Promise<void> {
  const db = getPool();
  for (const name of DEPARTMENTS) {
    if (!(await one(db, 'SELECT 1 FROM departments WHERE lower(name) = lower($1)', [name]))) await createDepartment(null, name);
  }
  for (const t of DOC_TYPES) {
    if (!(await one(db, 'SELECT 1 FROM doc_types WHERE code = $1', [t.code]))) await createDocType(null, t);
  }
  if (!(await one(db, 'SELECT 1 FROM mock_deals LIMIT 1'))) {
    for (const d of DEALS) {
      await db.query('INSERT INTO mock_deals (title, stage, company, amount) VALUES ($1, $2, $3, $4)', [d.title, d.stage, d.company, d.amount]);
    }
  }
}

/** Тестовые учётные записи. Идемпотентно (по логину). */
export async function seedUsers(password: string = config.seedPassword): Promise<void> {
  const db = getPool();
  for (const u of USERS) {
    if (await one(db, 'SELECT 1 FROM users WHERE login = $1', [u.login])) continue;
    const dept = await one<{ id: number }>(db, 'SELECT id FROM departments WHERE name = $1', [u.department]);
    await createUser(null, {
      login: u.login,
      fullName: u.fullName,
      position: u.position,
      departmentId: dept?.id ?? null,
      roles: u.roles,
      password,
      mustChangePassword: false,
    });
  }
}

export async function actorByLogin(login: string): Promise<Actor> {
  const u = await one<{ id: number; login: string; full_name: string; roles: SystemRole[]; department_id: number | null }>(
    getPool(),
    'SELECT id, login, full_name, roles, department_id FROM users WHERE login = $1',
    [login],
  );
  if (!u) throw new Error(`Учётная запись ${login} не найдена`);
  return { id: u.id, login: u.login, fullName: u.full_name, roles: u.roles, departmentId: u.department_id };
}

const inDays = (n: number): string => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString();

/** Демонстрационные документы и поручения — через те же сервисные функции, что и API. */
async function seedDemo(): Promise<void> {
  const db = getPool();
  if (await one(db, 'SELECT 1 FROM documents LIMIT 1')) return;
  const a: Record<string, Actor> = {};
  for (const u of USERS) a[u.login] = await actorByLogin(u.login);
  const types = await rows<{ id: number; code: string }>(db, 'SELECT id, code FROM doc_types');
  const typeId = (code: string) => types.find((t) => t.code === code)!.id;
  const deals = await rows<{ id: number; title: string }>(db, 'SELECT id, title FROM mock_deals ORDER BY id');
  const xlsx = (actor: Actor, docId: number, name: string, gpm: number) =>
    uploadFile(
      actor,
      { kind: 'new', ownerType: 'document', ownerId: docId, role: 'main' },
      Readable.from(sampleXlsx([['Показатель', 'Значение'], ['Выручка, руб.', 18450000], ['GPM', gpm]])),
      name,
    );
  const pdf = (actor: Actor, docId: number, role: 'main' | 'attachment', name: string, text: string) =>
    uploadFile(actor, { kind: 'new', ownerType: 'document', ownerId: docId, role }, Readable.from(samplePdf(text)), name);

  // 1. GPM — на согласовании, последовательный маршрут, первый согласовал.
  const d1 = await createDocument(a.ivanov, {
    typeId: typeId('GPM'),
    title: `GPM: ${deals[0].title}`,
    description: 'Расчёт маржинальности по поставке серверного оборудования. Скидка 7 % согласована с клиентом.',
    dealId: String(deals[0].id),
    dueAt: inDays(5),
    routeMode: 'sequential',
    approverIds: [a.petrova.id, a.smirnova.id, a.lebedev.id],
    observerIds: [a.kuznetsov.id],
  });
  await xlsx(a.ivanov, d1.id, 'GPM-калькулятор_Северсталь-Инфо.xlsx', 0.31);
  await pdf(a.ivanov, d1.id, 'attachment', 'Коммерческое_предложение.pdf', 'Commercial offer');
  await launchDocument(a.ivanov, d1.id);
  await decide(a.petrova, d1.id, 'approve', 'Маржа в пределах политики, согласовано.');

  // 2. GPM — на доработке (параллельный маршрут, возврат финансовым контролёром).
  const d2 = await createDocument(a.kuznetsov, {
    typeId: typeId('GPM'),
    title: `GPM: ${deals[1].title}`,
    description: 'Модернизация ЦОД, этап 1. Нестандартные условия оплаты.',
    dealId: String(deals[1].id),
    dueAt: inDays(3),
    routeMode: 'parallel',
    approverIds: [a.petrova.id, a.smirnova.id],
  });
  await xlsx(a.kuznetsov, d2.id, 'GPM_Балтийский_завод.xlsx', 0.18);
  await launchDocument(a.kuznetsov, d2.id);
  await decide(a.smirnova, d2.id, 'rework', 'GPM ниже порога 20 %. Пересчитайте с учётом логистики и приложите обоснование скидки.');

  // 3. GPM — согласовано.
  const d3 = await createDocument(a.ivanov, {
    typeId: typeId('GPM'),
    title: `GPM: ${deals[2].title}`,
    description: 'Сервисный контракт на 2027 год.',
    dealId: String(deals[2].id),
    dueAt: inDays(7),
    approverIds: [a.petrova.id, a.volkov.id],
  });
  await xlsx(a.ivanov, d3.id, 'GPM_ТрансКонтейнер_2027.xlsx', 0.42);
  await launchDocument(a.ivanov, d3.id);
  await decide(a.petrova, d3.id, 'approve');
  await decide(a.volkov, d3.id, 'approve', 'Согласовано.');

  // 4. Второе согласование по той же сделке — на согласовании.
  const d4 = await createDocument(a.petrova, {
    typeId: typeId('GPM'),
    title: `GPM (доп. соглашение): ${deals[0].title}`,
    description: 'Дополнительная поставка запасных частей.',
    dealId: String(deals[0].id),
    dueAt: inDays(2),
    approverIds: [a.smirnova.id],
  });
  await xlsx(a.petrova, d4.id, 'GPM_доп_соглашение.xlsx', 0.27);
  await launchDocument(a.petrova, d4.id);

  // 5. Другое согласование — отклонено.
  const d5 = await createDocument(a.morozova, {
    typeId: typeId('APPROVAL'),
    title: 'Типовой договор поставки, редакция 4',
    description: 'Обновление типовой формы договора: изменены разделы об ответственности и порядке приёмки.',
    approverIds: [a.lebedev.id, a.volkov.id],
  });
  await pdf(a.morozova, d5.id, 'main', 'Договор_поставки_ред4.pdf', 'Supply contract, revision 4');
  await launchDocument(a.morozova, d5.id);
  await decide(a.lebedev, d5.id, 'reject', 'Редакция противоречит утверждённой договорной политике. Готовим новую версию с нуля.');

  // 6. Черновик.
  const d6 = await createDocument(a.fedorova, {
    typeId: typeId('APPROVAL'),
    title: 'Техническое задание на проектирование АСУ ТП',
    description: 'Черновик ТЗ для согласования с главным инженером и юристами.',
    approverIds: [a.novikov.id],
  });
  await pdf(a.fedorova, d6.id, 'main', 'ТЗ_АСУ_ТП_черновик.pdf', 'Draft specification');

  // 7. Приказ — утверждён, идёт ознакомление.
  const o1 = await createDocument(a.pavlova, {
    typeId: typeId('ORDER'),
    title: 'О порядке отгрузки оборудования в праздничные дни',
    description: 'Устанавливает график дежурств склада и порядок согласования срочных отгрузок.',
    approverIds: [a.lebedev.id],
    signerId: a.director.id,
    acquaintanceIds: [a.ivanov.id, a.petrova.id, a.egorov.id, a.zaitsev.id, a.vasilieva.id],
  });
  await pdf(a.pavlova, o1.id, 'main', 'Приказ_отгрузка_праздничные_дни.pdf', 'Order: holiday shipping schedule');
  await launchDocument(a.pavlova, o1.id);
  await decide(a.lebedev, o1.id, 'approve');
  await signOrder(a.director, o1.id, 'approve');
  await acknowledge(a.ivanov, o1.id);
  await acknowledge(a.zaitsev, o1.id);
  await addDocumentComment(a.petrova, o1.id, 'Коллеги, график дежурств отдела продаж пришлю до пятницы.');

  // 8. Приказ — на утверждении.
  const o2 = await createDocument(a.lebedev, {
    typeId: typeId('ORDER'),
    title: 'Об утверждении регламента договорной работы',
    description: 'Вводит в действие регламент согласования договоров с контрагентами.',
    signerId: a.director.id,
    acquaintanceIds: [a.morozova.id, a.petrova.id, a.volkov.id],
    dueAt: inDays(4),
  });
  await pdf(a.lebedev, o2.id, 'main', 'Приказ_регламент_договорной_работы.pdf', 'Order: contract workflow regulation');
  await launchDocument(a.lebedev, o2.id);

  // Поручения.
  const t1 = await createTask(a.pavlova, {
    title: 'Подготовить график дежурств склада на праздничные дни',
    body: 'Согласовать с сервисной службой и направить в отдел продаж.',
    assigneeId: a.egorov.id,
    dueAt: inDays(6),
    documentId: o1.id,
  });
  await transitionTask(a.egorov, t1.id, 'start');
  await createTask(a.petrova, {
    title: 'Актуализировать контакты ключевых клиентов в CRM',
    body: 'Проверить карточки компаний из топ-20 и обновить ответственных лиц.',
    assigneeId: a.ivanov.id,
    dueAt: inDays(3),
  });
  const t3 = await createTask(a.volkov, {
    title: 'Сверить дебиторскую задолженность за III квартал',
    body: 'Подготовить акт сверки по контрагентам с задолженностью свыше 1 млн руб.',
    assigneeId: a.smirnova.id,
    dueAt: inDays(1),
  });
  await transitionTask(a.smirnova, t3.id, 'start');
  await transitionTask(a.smirnova, t3.id, 'submit', 'Сверка выполнена, расхождений нет. Акты направлены контрагентам.');
  const t4 = await createTask(a.petrova, {
    title: 'Подготовить презентацию для ГК «Агроэкспорт»',
    assigneeId: a.kuznetsov.id,
    dueAt: inDays(2),
  });
  await transitionTask(a.kuznetsov, t4.id, 'submit', 'Презентация готова и отправлена клиенту.');
  await transitionTask(a.petrova, t4.id, 'accept');
  const t5 = await createTask(a.novikov, {
    title: 'Проверить спецификацию оборудования по проекту АСУ ТП',
    body: 'Срок был согласован устно — прошу завершить в ближайшее время.',
    assigneeId: a.fedorova.id,
    dueAt: inDays(-2),
  });
  await addTaskComment(a.fedorova, t5.id, 'Жду уточнённый перечень датчиков от заказчика, без него спецификацию не закрыть.');
  await createTask(a.zaitsev, {
    title: 'Обновить сертификаты на почтовом сервере',
    assigneeId: a.zaitsev.id,
    dueAt: inDays(10),
  });
}

export async function seedAll(log: (m: string) => void = () => {}): Promise<void> {
  await runMigrations(log);
  await seedReference();
  log('Справочники и сделки эмулятора готовы');
  await seedUsers();
  log(`Учётные записи готовы (${USERS.length})`);
  await seedDemo();
  await processBitrixQueue({ force: true });
  await checkDeadlines();
  log('Демонстрационные документы и поручения готовы');
}

if (require.main === module) {
  // Немедленная синхронизация выполняется явно в конце — фоновые попытки не нужны.
  config.jobsEnabled = false;
  seedAll((m) => console.log(m))
    .then(() => closePool())
    .catch(async (err) => {
      console.error('Ошибка заполнения начальными данными:', err);
      await closePool();
      process.exit(1);
    });
}
