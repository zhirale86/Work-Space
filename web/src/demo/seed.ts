/**
 * Демонстрационные данные по мотивам server/src/seed.ts. Документы и поручения создаются теми же
 * функциями, что обслуживают запросы, с «переводом часов» в прошлое — поэтому история, уведомления,
 * раунды и записи эмулятора Битрикс24 согласованы между собой, а сроки отсчитываются от момента открытия демо.
 */
import type { AdminCreateDocTypeRequest, SystemRole } from '../api/types';
import * as admin from './admin';
import { processBitrixQueue } from './bitrix';
import { type Actor, actorOfUser } from './core';
import { type State, db, emptyState, setClock, setDb } from './db';
import * as docs from './documents';
import { saveFile } from './files';
import { checkDeadlines } from './reports';
import { sampleDocx, samplePdf, sampleXlsx } from './samples';
import * as tasks from './tasks';

export const DEPARTMENTS = ['Sales', 'IT', 'Security', 'Marketing', 'Finance', 'Юридический отдел', 'Customer Service', 'Engineering', 'Services', 'Logistics'];

const DOC_TYPES: AdminCreateDocTypeRequest[] = [
  { code: 'GPM', name: 'Согласование GPM-калькулятора', kind: 'approval', numberPrefix: 'GPM', requireDeal: true, requireFile: true, requireExcel: true },
  { code: 'APPROVAL', name: 'Другое согласование', kind: 'approval', numberPrefix: 'СГЛ' },
  { code: 'ORDER', name: 'Приказ', kind: 'order', numberPrefix: 'ПР', requireFile: true },
];

const DEALS = [
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

export interface DemoPersona {
  login: string;
  fullName: string;
  position: string;
  department: string;
  roles: SystemRole[];
  /** Роль в сценарии показа (для карточек входа). */
  demoRole: string;
  /** Ключевой участник сценария — показывается в первом ряду. */
  key?: boolean;
}

export const USERS: DemoPersona[] = [
  { login: 'ivanov', fullName: 'Иванов Алексей Дмитриевич', position: 'Менеджер по продажам', department: 'Sales', roles: ['employee'], demoRole: 'Инициатор GPM', key: true },
  { login: 'petrova', fullName: 'Петрова Мария Сергеевна', position: 'Руководитель отдела продаж', department: 'Sales', roles: ['employee'], demoRole: 'Согласующий', key: true },
  { login: 'smirnova', fullName: 'Смирнова Елена Андреевна', position: 'Финансовый контролёр', department: 'Finance', roles: ['employee'], demoRole: 'Согласующий', key: true },
  { login: 'director', fullName: 'Орлов Сергей Павлович', position: 'Генеральный директор', department: 'Finance', roles: ['employee', 'signer'], demoRole: 'Утверждает приказы', key: true },
  { login: 'pavlova', fullName: 'Павлова Наталья Юрьевна', position: 'Руководитель отдела логистики', department: 'Logistics', roles: ['employee'], demoRole: 'Инициатор приказов', key: true },
  { login: 'egorov', fullName: 'Егоров Максим Викторович', position: 'Сервисный инженер', department: 'Services', roles: ['employee'], demoRole: 'Исполнитель поручений', key: true },
  { login: 'vasilieva', fullName: 'Васильева Дарья Алексеевна', position: 'Маркетолог', department: 'Marketing', roles: ['employee'], demoRole: 'Нет доступа к GPM', key: true },
  { login: 'admin', fullName: 'Соколова Ирина Викторовна', position: 'Системный администратор', department: 'IT', roles: ['employee', 'admin'], demoRole: 'Администратор', key: true },
  { login: 'auditor', fullName: 'Белов Андрей Николаевич', position: 'Руководитель службы внутреннего контроля', department: 'Security', roles: ['employee', 'auditor'], demoRole: 'Контроль документов', key: true },
  { login: 'kuznetsov', fullName: 'Кузнецов Дмитрий Олегович', position: 'Менеджер по работе с ключевыми клиентами', department: 'Sales', roles: ['employee'], demoRole: 'Инициатор GPM' },
  { login: 'volkov', fullName: 'Волков Игорь Михайлович', position: 'Финансовый директор', department: 'Finance', roles: ['employee', 'signer'], demoRole: 'Согласующий, утверждающий' },
  { login: 'lebedev', fullName: 'Лебедев Павел Игоревич', position: 'Руководитель юридического отдела', department: 'Юридический отдел', roles: ['employee'], demoRole: 'Согласующий' },
  { login: 'morozova', fullName: 'Морозова Анна Владимировна', position: 'Юрисконсульт', department: 'Юридический отдел', roles: ['employee'], demoRole: 'Инициатор согласований' },
  { login: 'novikov', fullName: 'Новиков Артём Сергеевич', position: 'Главный инженер', department: 'Engineering', roles: ['employee'], demoRole: 'Постановщик поручений' },
  { login: 'fedorova', fullName: 'Фёдорова Ольга Николаевна', position: 'Инженер-проектировщик', department: 'Engineering', roles: ['employee'], demoRole: 'Исполнитель поручений' },
  { login: 'zaitsev', fullName: 'Зайцев Кирилл Андреевич', position: 'Системный инженер', department: 'IT', roles: ['employee'], demoRole: 'Сотрудник' },
];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function buildSeed(): State {
  setDb(emptyState());
  const T = Date.now();
  const today = new Date(T);
  today.setHours(0, 0, 0, 0);
  /** Момент `days` дней назад в `hour`:`min` по местному времени; не позже, чем за час до «сейчас». */
  const at = (days: number, hour: number, min = 0): number => Math.min(today.getTime() - days * DAY + hour * HOUR + min * 60_000, T - HOUR);
  /** Срок: конец рабочего дня через `days` дней. */
  const dueIn = (days: number): string => new Date(today.getTime() + days * DAY + 18 * HOUR).toISOString();
  const step = (ms: number) => {
    setClock(ms);
    processBitrixQueue();
  };

  try {
    step(at(30, 9));
    for (const name of DEPARTMENTS) admin.createDepartment(null, name);
    for (const t of DOC_TYPES) admin.createDocType(null, t);
    DEALS.forEach((d, i) => db.mockDeals.push({ id: i + 1, ...d }));
    db.seq.mockDeals = DEALS.length;
    const a: Record<string, Actor> = {};
    for (const u of USERS) {
      const dept = db.departments.find((d) => d.name === u.department);
      const created = admin.createUser(null, {
        login: u.login,
        fullName: u.fullName,
        position: u.position,
        departmentId: dept?.id ?? null,
        roles: u.roles,
        password: 'Test12345!',
        mustChangePassword: false,
      });
      a[u.login] = actorOfUser(db.users.find((x) => x.id === created.id)!);
    }
    /** Сюжеты выполняются в порядке создания карточек — тогда и номера идут по времени. */
    const stories: Array<{ at: number; run: () => void }> = [];
    let holidayOrderId = 0;
    const story = (atMs: number, run: () => void) => stories.push({ at: atMs, run });
    const typeId = (code: string) => db.docTypes.find((t) => t.code === code)!.id;

    const attach = (actor: Actor, docId: number, role: 'main' | 'attachment', name: string, bytes: Uint8Array) =>
      saveFile(actor, { kind: 'new', ownerType: 'document', ownerId: docId, role }, name, bytes, fakeSha(bytes));
    const newVersion = (actor: Actor, fileId: number, name: string, bytes: Uint8Array) => saveFile(actor, { kind: 'version', fileId }, name, bytes, fakeSha(bytes));
    const gpm = (revenue: number, cost: number) => sampleXlsx([['Показатель', 'Значение'], ['Выручка, руб.', revenue], ['Себестоимость, руб.', cost], ['GPM', Math.round((1 - cost / revenue) * 100) / 100]]);

    // 1. GPM Иванова — на согласовании, последовательно; Петрова согласовала, ждём Смирнову.
    story(at(6, 10), () => {
      step(at(6, 10));
      const d1 = docs.createDocument(a.ivanov, {
        typeId: typeId('GPM'),
        title: `GPM: ${DEALS[0].title}`,
        description: 'Расчёт маржинальности по поставке серверного оборудования. Скидка 7 % согласована с клиентом.',
        dealId: '1',
        dueAt: dueIn(4),
        routeMode: 'sequential',
        approverIds: [a.petrova.id, a.smirnova.id, a.lebedev.id],
        observerIds: [a.kuznetsov.id],
      });
      attach(a.ivanov, d1.id, 'main', 'GPM-калькулятор_Северсталь-Инфо.xlsx', gpm(18_450_000, 12_730_500));
      attach(a.ivanov, d1.id, 'attachment', 'Коммерческое_предложение.pdf', samplePdf(['Commercial offer', 'Server equipment supply']));
      step(at(6, 11, 20));
      docs.launchDocument(a.ivanov, d1.id);
      step(at(5, 9, 40));
      docs.decide(a.petrova, d1.id, 'approve', 'Маржа в пределах политики, согласовано.');
    });
    // 2. GPM Иванова — на доработке: замечание Смирновой, загружена версия 2 (ещё не отправлена).
    story(at(5, 14), () => {
      step(at(5, 14));
      const d2 = docs.createDocument(a.ivanov, {
        typeId: typeId('GPM'),
        title: `GPM: ${DEALS[1].title}`,
        description: 'Модернизация ЦОД, этап 1. Нестандартные условия оплаты: аванс 30 %, остаток — после приёмки.',
        dealId: '2',
        dueAt: dueIn(3),
        routeMode: 'parallel',
        approverIds: [a.petrova.id, a.smirnova.id],
      });
      const f2 = attach(a.ivanov, d2.id, 'main', 'GPM_Балтийский_завод.xlsx', gpm(42_300_000, 34_686_000));
      step(at(5, 14, 30));
      docs.launchDocument(a.ivanov, d2.id);
      step(at(4, 10, 15));
      docs.decide(a.smirnova, d2.id, 'rework', 'GPM ниже порога 20 %. Пересчитайте с учётом логистики и приложите обоснование скидки.');
      step(at(1, 16, 10));
      newVersion(a.ivanov, f2.id, 'GPM_Балтийский_завод_v2.xlsx', gpm(42_300_000, 33_417_000));
      attach(a.ivanov, d2.id, 'attachment', 'Обоснование_скидки.docx', sampleDocx(['Обоснование скидки по сделке «Модернизация ЦОД»', 'Логистика включена в себестоимость.']));
    });
    // 3. GPM Иванова — согласовано; запись в сделке эмулятора закрыта со статусом «Согласовано».
    story(at(9, 10), () => {
      step(at(9, 10));
      const d3 = docs.createDocument(a.ivanov, {
        typeId: typeId('GPM'),
        title: `GPM: ${DEALS[2].title}`,
        description: 'Сервисный контракт на 2027 год.',
        dealId: '3',
        dueAt: dueIn(-2),
        approverIds: [a.petrova.id, a.volkov.id],
      });
      attach(a.ivanov, d3.id, 'main', 'GPM_ТрансКонтейнер_2027.xlsx', gpm(6_900_000, 4_002_000));
      step(at(9, 11));
      docs.launchDocument(a.ivanov, d3.id);
      step(at(8, 15));
      docs.decide(a.petrova, d3.id, 'approve');
      step(at(7, 12, 30));
      docs.decide(a.volkov, d3.id, 'approve', 'Согласовано.');
    });
    // 4. GPM Петровой — у Смирновой, срок нарушен.
    story(at(4, 9, 30), () => {
      step(at(4, 9, 30));
      const d4 = docs.createDocument(a.petrova, {
        typeId: typeId('GPM'),
        title: `GPM (доп. соглашение): ${DEALS[0].title}`,
        description: 'Дополнительная поставка запасных частей по действующему договору.',
        dealId: '1',
        dueAt: new Date(T - 26 * HOUR).toISOString(),
        approverIds: [a.smirnova.id],
      });
      attach(a.petrova, d4.id, 'main', 'GPM_доп_соглашение.xlsx', gpm(2_400_000, 1_752_000));
      step(at(4, 10));
      docs.launchDocument(a.petrova, d4.id);
    });
    // 5. Согласование Кузнецова — у Петровой, срок нарушен.
    story(at(3, 11), () => {
      step(at(3, 11));
      const d5 = docs.createDocument(a.kuznetsov, {
        typeId: typeId('APPROVAL'),
        title: 'Скидка 12 % для ГК «Агроэкспорт» сверх политики',
        description: 'Клиент готов подписать договор до конца месяца при условии дополнительной скидки.',
        dueAt: new Date(T - 30 * HOUR).toISOString(),
        approverIds: [a.petrova.id],
      });
      attach(a.kuznetsov, d5.id, 'main', 'Служебная_записка_скидка.docx', sampleDocx(['Служебная записка', 'Прошу согласовать скидку 12 % для ГК «Агроэкспорт».']));
      step(at(3, 11, 30));
      docs.launchDocument(a.kuznetsov, d5.id);
    });
    // 6. Другое согласование — отклонено.
    story(at(12, 10), () => {
      step(at(12, 10));
      const d6 = docs.createDocument(a.morozova, {
        typeId: typeId('APPROVAL'),
        title: 'Типовой договор поставки, редакция 4',
        description: 'Обновление типовой формы договора: изменены разделы об ответственности и порядке приёмки.',
        approverIds: [a.lebedev.id, a.volkov.id],
      });
      attach(a.morozova, d6.id, 'main', 'Договор_поставки_ред4.pdf', samplePdf(['Supply contract, revision 4']));
      step(at(12, 10, 30));
      docs.launchDocument(a.morozova, d6.id);
      step(at(11, 16));
      docs.decide(a.lebedev, d6.id, 'reject', 'Редакция противоречит утверждённой договорной политике. Готовим новую версию с нуля.');
    });
    // 7. Черновик.
    story(at(2, 15), () => {
      step(at(2, 15));
      const d7 = docs.createDocument(a.fedorova, {
        typeId: typeId('APPROVAL'),
        title: 'Техническое задание на проектирование АСУ ТП',
        description: 'Черновик ТЗ для согласования с главным инженером и юристами.',
        approverIds: [a.novikov.id],
      });
      attach(a.fedorova, d7.id, 'main', 'ТЗ_АСУ_ТП_черновик.pdf', samplePdf(['Draft specification', 'Process control system']));
    });
    // 8. Приказ — утверждён, идёт ознакомление.
    story(at(10, 9), () => {
      step(at(10, 9));
      const o1 = docs.createDocument(a.pavlova, {
        typeId: typeId('ORDER'),
        title: 'О порядке отгрузки оборудования в праздничные дни',
        description: 'Устанавливает график дежурств склада и порядок согласования срочных отгрузок.',
        approverIds: [a.lebedev.id],
        signerId: a.director.id,
        acquaintanceIds: [a.ivanov.id, a.petrova.id, a.egorov.id, a.zaitsev.id, a.smirnova.id, a.admin.id, a.auditor.id],
      });
      holidayOrderId = o1.id;
      attach(a.pavlova, o1.id, 'main', 'Приказ_отгрузка_праздничные_дни.pdf', samplePdf(['Order: holiday shipping schedule']));
      step(at(10, 10));
      docs.launchDocument(a.pavlova, o1.id);
      step(at(9, 12));
      docs.decide(a.lebedev, o1.id, 'approve');
      step(at(8, 10));
      docs.signOrder(a.director, o1.id, 'approve');
      step(at(8, 11, 5));
      docs.acknowledge(a.ivanov, o1.id);
      step(at(7, 9, 50));
      docs.acknowledge(a.zaitsev, o1.id);
      step(at(7, 13));
      docs.addDocumentComment(a.petrova, o1.id, 'Коллеги, график дежурств отдела продаж пришлю до пятницы.');
    });
    // 9. Приказ — на утверждении у директора.
    story(at(2, 10), () => {
      step(at(2, 10));
      const o2 = docs.createDocument(a.lebedev, {
        typeId: typeId('ORDER'),
        title: 'Об утверждении регламента договорной работы',
        description: 'Вводит в действие регламент согласования договоров с контрагентами.',
        signerId: a.director.id,
        acquaintanceIds: [a.morozova.id, a.petrova.id, a.volkov.id, a.egorov.id],
        dueAt: dueIn(4),
      });
      attach(a.lebedev, o2.id, 'main', 'Приказ_регламент_договорной_работы.pdf', samplePdf(['Order: contract workflow regulation']));
      step(at(2, 10, 30));
      docs.launchDocument(a.lebedev, o2.id);
    });
    // 10. GPM Кузнецова — передача в Битрикс24 не прошла (эмулятор был недоступен).
    story(T - 60 * 60_000, () => {
      step(T - 60 * 60_000);
      const d8 = docs.createDocument(a.kuznetsov, {
        typeId: typeId('GPM'),
        title: `GPM: ${DEALS[4].title}`,
        description: 'Поставка и монтаж системы видеонаблюдения, 140 камер.',
        dealId: '5',
        dueAt: dueIn(6),
        approverIds: [a.volkov.id],
      });
      attach(a.kuznetsov, d8.id, 'main', 'GPM_Меридиан.xlsx', gpm(11_200_000, 8_064_000));
      step(T - 55 * 60_000);
      admin.setMockUnavailable(a.admin, true);
      step(T - 50 * 60_000);
      docs.launchDocument(a.kuznetsov, d8.id);
      for (const m of [50, 49, 44, 29]) step(T - m * 60_000);
      step(T - 25 * 60_000);
      admin.setMockUnavailable(a.admin, false);
    });
    // Поручения.
    story(at(7, 14), () => {
      step(at(7, 14));
      const t1 = tasks.createTask(a.pavlova, {
        title: 'Подготовить график дежурств склада на праздничные дни',
        body: 'Согласовать с сервисной службой и направить в отдел продаж.',
        assigneeId: a.egorov.id,
        dueAt: dueIn(5),
        documentId: holidayOrderId,
      });
      step(at(6, 9));
      tasks.transitionTask(a.egorov, t1.id, 'start');
    });
    story(at(3, 10), () => {
      step(at(3, 10));
      tasks.createTask(a.petrova, {
        title: 'Актуализировать контакты ключевых клиентов в CRM',
        body: 'Проверить карточки компаний из топ-20 и обновить ответственных лиц.',
        assigneeId: a.ivanov.id,
        dueAt: dueIn(2),
      });
    });
    story(at(5, 11), () => {
      step(at(5, 11));
      const t3 = tasks.createTask(a.petrova, {
        title: 'Собрать отзывы клиентов по сервисному обслуживанию',
        body: 'Не меньше пяти отзывов, для презентации на совещании отдела.',
        assigneeId: a.ivanov.id,
        dueAt: new Date(T - 28 * HOUR).toISOString(),
      });
      step(at(4, 9));
      tasks.transitionTask(a.ivanov, t3.id, 'start');
    });
    story(at(4, 12), () => {
      step(at(4, 12));
      const t4 = tasks.createTask(a.volkov, {
        title: 'Сверить дебиторскую задолженность за III квартал',
        body: 'Подготовить акт сверки по контрагентам с задолженностью свыше 1 млн руб.',
        assigneeId: a.smirnova.id,
        dueAt: dueIn(1),
      });
      step(at(3, 9));
      tasks.transitionTask(a.smirnova, t4.id, 'start');
      step(at(1, 17));
      tasks.transitionTask(a.smirnova, t4.id, 'submit', 'Сверка выполнена, расхождений нет. Акты направлены контрагентам.');
    });
    story(at(6, 15), () => {
      step(at(6, 15));
      const t5 = tasks.createTask(a.petrova, { title: 'Подготовить презентацию для ГК «Агроэкспорт»', assigneeId: a.kuznetsov.id, dueAt: dueIn(-3) });
      step(at(5, 16));
      tasks.transitionTask(a.kuznetsov, t5.id, 'submit', 'Презентация готова и отправлена клиенту.');
      step(at(4, 9, 30));
      tasks.transitionTask(a.petrova, t5.id, 'accept');
    });
    story(at(2, 12), () => {
      step(at(2, 12));
      const t6 = tasks.createTask(a.petrova, {
        title: 'Подготовить расчёт для тендера МФЦ Ленинградской области',
        assigneeId: a.kuznetsov.id,
        dueAt: dueIn(3),
      });
      step(at(1, 11));
      tasks.transitionTask(a.kuznetsov, t6.id, 'submit', 'Расчёт готов: итоговая цена 5,3 млн руб., маржа 24 %.');
    });
    story(at(8, 10), () => {
      step(at(8, 10));
      const t7 = tasks.createTask(a.novikov, {
        title: 'Проверить спецификацию оборудования по проекту АСУ ТП',
        body: 'Срок был согласован устно — прошу завершить в ближайшее время.',
        assigneeId: a.fedorova.id,
        dueAt: new Date(T - 2 * DAY).toISOString(),
      });
      step(at(3, 15));
      tasks.addTaskComment(a.fedorova, t7.id, 'Жду уточнённый перечень датчиков от заказчика, без него спецификацию не закрыть.');
    });
    story(at(1, 9), () => {
      step(at(1, 9));
      tasks.createTask(a.zaitsev, { title: 'Обновить сертификаты на почтовом сервере', assigneeId: a.zaitsev.id, dueAt: dueIn(10) });
    });
    story(at(1, 10), () => {
      step(at(1, 10));
      const winter = tasks.createTask(a.pavlova, {
        title: 'Проверить укомплектованность сервисных машин к зимнему сезону',
        body: 'Цепи, инструмент, запас расходников. Результат — фото и короткий отчёт.',
        assigneeId: a.egorov.id,
        dueAt: dueIn(2),
      });
      step(T - 3 * HOUR);
      tasks.transitionTask(a.egorov, winter.id, 'submit', 'Все четыре машины укомплектованы, фото и опись приложены к отчёту в общей папке.');
    });
    story(at(1, 12), () => {
      step(at(1, 12));
      tasks.createTask(a.petrova, {
        title: 'Подготовить макет листовки к отраслевой выставке',
        body: 'Формат А5, две стороны: решения для ЦОД и сервисные контракты. Тексты согласовать с отделом продаж.',
        assigneeId: a.vasilieva.id,
        dueAt: dueIn(5),
      });
    });
    for (const s of stories.sort((x, y) => x.at - y.at)) s.run();

    step(T - 5 * 60_000);
    checkDeadlines();
  } finally {
    setClock(null);
  }

  // Журнал и уведомления — в хронологическом порядке; старые уведомления уже прочитаны.
  db.audit.sort((x, y) => x.at - y.at || x.id - y.id).forEach((r, i) => (r.id = i + 1));
  db.seq.audit = db.audit.length;
  db.notifications.sort((x, y) => x.created_at - y.created_at || x.id - y.id).forEach((n, i) => {
    n.id = i + 1;
    if (n.created_at < T - 2 * DAY) n.read_at = n.created_at + HOUR;
  });
  db.seq.notifications = db.notifications.length;
  db.session.userId = null;
  return db;
}

/** Контрольная сумма для демонстрационных файлов (без асинхронного WebCrypto при заполнении). */
function fakeSha(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  let out = '';
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

