/** Управление демонстрационным режимом: загрузка, сброс, сведения для карточек входа. */
import { actorOfUser } from './core';
import { clearSaved, db, loadSaved, saveNow, setDb, type State } from './db';
import { dashboard } from './reports';
import { type DemoPersona, USERS, buildSeed } from './seed';

const LS_STATE = 'docflow-demo:state';

export function loadOrSeed(): void {
  const saved = loadSaved();
  if (saved) setDb(saved);
  else resetData();
  // Демо открыто в нескольких вкладках (например, сделка Битрикс24 по ссылке) — состояние общее.
  window.addEventListener('storage', (e) => {
    if (e.key !== LS_STATE || !e.newValue) return;
    try {
      setDb(JSON.parse(e.newValue) as State);
    } catch {
      /* повреждённое сохранение — продолжаем с текущим состоянием */
    }
  });
}

export function resetData(): void {
  clearSaved();
  buildSeed();
  saveNow();
}

export interface PersonaInfo extends DemoPersona {
  id: number;
  departmentName: string;
  /** Сколько действий ждёт сотрудника на главной. */
  pending: number;
  overdue: number;
}

export function personas(): PersonaInfo[] {
  return USERS.flatMap((p) => {
    const u = db.users.find((x) => x.login === p.login && x.active);
    if (!u) return [];
    const d = dashboard(actorOfUser(u));
    const pending = d.toApprove.count + d.rework.count + d.toSign.count + d.toAcknowledge.count + d.myTasks.count + d.tasksToReview.count;
    return [
      {
        ...p,
        fullName: u.full_name,
        position: u.position,
        id: u.id,
        departmentName: db.departments.find((x) => x.id === u.department_id)?.name ?? '',
        pending,
        overdue: d.overdue.count,
      },
    ];
  });
}

/** Шаги сценария показа. */
export const SCENARIO: Array<{ who: string; text: string }> = [
  {
    who: 'Иванов',
    text: 'Создаёт согласование GPM без Excel-файла — кнопка запуска недоступна, система перечисляет, чего не хватает. Прикрепляет калькулятор, выбирает сделку и двух согласующих по очереди: Петрову и Смирнову — и запускает.',
  },
  { who: 'Петрова', text: 'Видит документ в «Моих действиях» и возвращает его на доработку с комментарием.' },
  { who: 'Иванов', text: 'Читает замечание в карточке, загружает версию 2 файла и запускает согласование повторно — новый раунд для всех.' },
  {
    who: 'Петрова и Смирнова',
    text: 'Согласуют по очереди — статус «Согласовано». В сделке эмулятора Битрикс24 задача обновилась; ссылка ведёт обратно в карточку.',
  },
  { who: 'Павлова → Орлов → Егоров', text: 'Приказ: создание, утверждение директором, ознакомление сотрудником; у инициатора — таблица ознакомления.' },
  { who: 'Васильева', text: 'Открывает чужую карточку по прямой ссылке и видит «нет доступа»; Белов («Контроль документов») видит всё.' },
  {
    who: 'Соколова',
    text: 'Администрирование → Битрикс24: включает «Эмулятор недоступен» — передача уходит в очередь ошибок; выключает и нажимает «Повторить».',
  },
];
