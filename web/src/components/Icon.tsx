import type { ReactElement } from 'react';

/** Линейные значки из витрины design/ui-kit.html (31 символ), толщина линии задана в ui.css (.icon). */
const PATHS = {
  'home': <><path d="M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z" /></>,
  'approve': <><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /><path d="m9 14 2 2 4-4.5" /></>,
  'order': <><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 16h6" /></>,
  'task': <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  'report': <><path d="M4 20h16" /><path d="M7 20v-7M12 20V5M17 20v-10" /></>,
  'admin': <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  'bell': <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5h4" /></>,
  'search': <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  'plus': <><path d="M12 5v14M5 12h14" /></>,
  'check': <><path d="m5 12.5 4.5 4.5L19 7" /></>,
  'x': <><path d="M6 6l12 12M18 6 6 18" /></>,
  'chevron-down': <><path d="m6 9 6 6 6-6" /></>,
  'chevron-left': <><path d="m15 6-6 6 6 6" /></>,
  'chevron-right': <><path d="m9 6 6 6-6 6" /></>,
  'clock': <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  'download': <><path d="M12 4v11M7.5 11 12 15.5 16.5 11" /><path d="M5 19.5h14" /></>,
  'upload': <><path d="M12 16V5M7.5 9 12 4.5 16.5 9" /><path d="M5 19.5h14" /></>,
  'file': <><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /></>,
  'external': <><path d="M13 5h6v6" /><path d="M19 5 10.5 13.5" /><path d="M17 14v5H5V7h5" /></>,
  'refresh': <><path d="M19 12a7 7 0 1 1-2.2-5.1" /><path d="M19 4.5V8h-3.5" /></>,
  'return': <><path d="M9 7 4.5 11.5 9 16" /><path d="M4.5 11.5H14a5.5 5.5 0 0 1 0 11h-2" transform="translate(0 -3)" /></>,
  'alert': <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.5M12 17v.2" /></>,
  'info': <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8v.2" /></>,
  'more': <><circle cx="5.5" cy="12" r=".9" /><circle cx="12" cy="12" r=".9" /><circle cx="18.5" cy="12" r=".9" /></>,
  'calendar': <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  'menu': <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  'parallel': <><path d="M4 12h4M16 12h4" /><path d="M8 12c2 0 2-5 4-5h4M8 12c2 0 2 5 4 5h4" /></>,
  'inbox': <><path d="M4 13 6.5 5h11L20 13v6H4z" /><path d="M4 13h5l1 2.5h4l1-2.5h5" /></>,
  'eye': <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  'sort': <><path d="M8 5v14M4.5 15.5 8 19l3.5-3.5M16 19V5M12.5 8.5 16 5l3.5 3.5" /></>,
  'link': <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  size?: 'sm' | 'lg';
  className?: string;
  /** Подпись для значка без текста рядом; без неё значок декоративный. */
  label?: string;
}

export function Icon({ name, size, className, label }: IconProps) {
  const cls = ['icon', size ? `icon--${size}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} focusable="false">
      {PATHS[name]}
    </svg>
  );
}
