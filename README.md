# Документооборот UTECH

Внутренняя система согласования документов, приказов и поручений с интеграцией со сделками Битрикс24. Тестовая модель по техническому заданию `docs/01-tz.md`.

## Состав

| Каталог | Содержимое |
|---|---|
| `server/` | API на Node.js 22 + Fastify + PostgreSQL 16, фоновые задания, адаптер Битрикс24 (эмулятор и REST-вебхук), 63 интеграционных теста |
| `web/` | Интерфейс на React + Vite, фирменный стиль UTECH |
| `deploy/` | Docker Compose, nginx, резервное копирование и восстановление |
| `design/ui-kit.html` | Витрина дизайн-системы |
| `docs/` | ТЗ, архитектурные решения, UX-спецификация, справочник API, инструкции пользователя и администратора |

## Быстрый запуск

Нужны Node.js 22 и PostgreSQL 16 (база и пользователь — по `server/.env.example`).

```bash
cd web && npm ci && npm run build
```

```bash
cd server && npm ci && cp .env.example .env && npm run build && npm run migrate && npm run seed && npm start
```

Откройте `http://localhost:3000`, вход — `ivanov` / `Test12345!` (остальные учётные записи — в `docs/06-admin-guide.md`).

Тесты сервера: `cd server && npm test` (нужна база `docflow_test`, см. `server/README.md`). Установка на сервер компании через Docker — `deploy/README.md`.

## Документы

1. `docs/01-tz.md` — техническое задание.
2. `docs/02-architecture.md` — архитектура и решения по открытым вопросам ТЗ (помечены «[решение]», требуют согласования).
3. `docs/03-ux.md` — UX-спецификация.
4. `docs/04-api.md` — справочник API.
5. `docs/05-user-guide.md` — инструкция пользователя.
6. `docs/06-admin-guide.md` — инструкция администратора.
