/** Форматирование дат, сроков, чисел и имён по правилам docs/03-ux.md (раздел 3.2). */

export const NBSP = ' ';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const DAY_MS = 24 * 3600 * 1000;

export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** «2 дня», «5 дней» — число и слово через неразрывный пробел. */
export function count(n: number, forms: [string, string, string]): string {
  return `${n}${NBSP}${plural(n, forms)}`;
}

export const DAYS: [string, string, string] = ['день', 'дня', 'дней'];
export const HOURS: [string, string, string] = ['час', 'часа', 'часов'];
export const MINUTES: [string, string, string] = ['минуту', 'минуты', 'минут'];

const pad = (n: number) => String(n).padStart(2, '0');

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

export function time(v: string | Date): string {
  const d = toDate(v);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «12 ноября» (год — если не текущий). */
export function date(v: string | Date, forceYear = false): string {
  const d = toDate(v);
  const year = forceYear || d.getFullYear() !== new Date().getFullYear() ? `${NBSP}${d.getFullYear()}` : '';
  return `${d.getDate()}${NBSP}${MONTHS[d.getMonth()]}${year}`;
}

/** «12 ноября, 10:15». */
export function dateTime(v: string | Date): string {
  return `${date(v)}, ${time(v)}`;
}

/** «12 ноября 2026, 18:00» — для подсказок и блока «Сведения». */
export function dateTimeFull(v: string | Date): string {
  return `${date(v, true)}, ${time(v)}`;
}

/** «12.11.2026» — в таблицах. */
export function dateShort(v: string | Date): string {
  const d = toDate(v);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Дата `ГГГГ-ММ-ДД` (для полей дат и фильтров) — по местному времени. */
export function isoDay(v: Date): string {
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

/** Дата без времени `ГГГГ-ММ-ДД` → «12 ноября 2026». */
export function dayText(v: string, forceYear = true): string {
  const [y, m, d] = v.split('-').map(Number);
  return date(new Date(y, m - 1, d), forceYear);
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** «2 часа назад», «вчера, 18:00», «9 ноября, 15:30». */
export function ago(v: string | Date): string {
  const d = toDate(v);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'только что';
  if (diff < 3600_000) return `${count(Math.floor(diff / 60_000), MINUTES)} назад`;
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / DAY_MS);
  if (days === 0) return `${count(Math.floor(diff / 3600_000), HOURS)} назад`;
  if (days === 1) return `вчера, ${time(d)}`;
  return dateTime(d);
}

export type DueTone = 'normal' | 'soon' | 'overdue' | 'done' | 'none';

export interface DueInfo {
  text: string;
  tone: DueTone;
  title: string;
  /** Просрочка в днях (≥ 1) или 0. */
  overdueDays: number;
}

/** Длительность просрочки: «3 дня», меньше суток — «5 часов». */
export function overdueSpan(dueAt: string | Date, now = Date.now()): string {
  const diff = now - toDate(dueAt).getTime();
  if (diff < DAY_MS) return count(Math.max(1, Math.floor(diff / 3600_000)), HOURS);
  return count(Math.floor(diff / DAY_MS), DAYS);
}

/**
 * Относительный срок по таблице 3.2: «Осталось 6 дней», «Сегодня до 18:00», «Завтра до 18:00»,
 * «Просрочено на 3 дня», «Завершено 12 ноября», «Без срока».
 */
export function due(dueAt: string | null | undefined, completedAt?: string | null, completedVerb = 'Завершено'): DueInfo {
  if (completedAt) {
    return { text: `${completedVerb} ${date(completedAt)}`, tone: 'done', title: dateTimeFull(completedAt), overdueDays: 0 };
  }
  if (!dueAt) return { text: 'Без срока', tone: 'none', title: 'Срок не задан', overdueDays: 0 };
  const d = toDate(dueAt);
  const now = new Date();
  const title = `Срок: ${dateTimeFull(d)}`;
  const diff = d.getTime() - now.getTime();
  if (diff <= 0) {
    return { text: `Просрочено на ${overdueSpan(d)}`, tone: 'overdue', title, overdueDays: Math.max(1, Math.floor(-diff / DAY_MS)) };
  }
  const dayDiff = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (dayDiff === 0) return { text: `Сегодня до ${time(d)}`, tone: 'soon', title, overdueDays: 0 };
  if (dayDiff === 1 && diff < DAY_MS) return { text: `Завтра до ${time(d)}`, tone: 'soon', title, overdueDays: 0 };
  const days = Math.max(1, dayDiff);
  return { text: `${plural(days, ['Остался', 'Осталось', 'Осталось'])} ${count(days, DAYS)}`, tone: 'normal', title, overdueDays: 0 };
}

/** «184 КБ», «1,2 МБ». */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}${NBSP}Б`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}${NBSP}КБ`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0).replace('.', ',')}${NBSP}МБ`;
}

/** «18 400 000 ₽». */
export function money(n: number): string {
  return `${Math.round(n).toLocaleString('ru-RU').replace(/\s/g, NBSP)}${NBSP}₽`;
}

/** Инициалы для аватара: «Иванов Алексей» → «ИА». */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** «Иванов Алексей Дмитриевич» → «Иванов А. Д.» — для компактных мест. */
export function shortName(fullName: string): string {
  const [last, first, middle] = fullName.trim().split(/\s+/);
  if (!first) return last ?? '';
  return `${last}${NBSP}${first[0]}.${middle ? `${NBSP}${middle[0]}.` : ''}`;
}

/** Перечисление «А, Б и В». */
export function joinRu(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

/** Порядковое числительное для «Вы — второй согласующий из четырёх». */
const ORD = ['первый', 'второй', 'третий', 'четвёртый', 'пятый', 'шестой', 'седьмой', 'восьмой', 'девятый', 'десятый'];
const OF = ['одного', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти', 'десяти'];
export function ordinal(n: number): string {
  return ORD[n - 1] ?? `${n}-й`;
}
export function ofCount(n: number): string {
  return OF[n - 1] ?? String(n);
}

/** Текст в «ёлочках». */
export function q(s: string): string {
  return `«${s}»`;
}

export function ext(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}
