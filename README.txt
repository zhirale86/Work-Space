ДОКУМЕНТООБОРОТ UTECH
=====================

Внутренняя система согласования документов, приказов и поручений
с интеграцией со сделками Битрикс24. Тестовая модель по техническому
заданию docs/01-tz.md.


СОСТАВ
------

  server/             API на Node.js 22 + Fastify + PostgreSQL 16,
                      фоновые задания, адаптер Битрикс24 (эмулятор
                      и REST-вебхук), 63 интеграционных теста
  web/                Интерфейс на React + Vite, фирменный стиль UTECH
  deploy/             Docker Compose, nginx, резервное копирование
                      и восстановление
  design/ui-kit.html  Витрина дизайн-системы
  docs/               ТЗ, архитектурные решения, UX-спецификация,
                      справочник API, инструкции пользователя
                      и администратора


БЫСТРЫЙ ЗАПУСК
--------------

Нужны Node.js 22 и PostgreSQL 16 (база и пользователь — по
server/.env.example).

1. Сборка интерфейса:

     cd web
     npm ci
     npm run build

2. Сервер:

     cd server
     npm ci
     cp .env.example .env
     npm run build
     npm run migrate
     npm run seed
     npm start

3. Откройте в браузере http://localhost:3000
   Вход: ivanov / Test12345!
   Остальные учётные записи — в docs/06-admin-guide.md.

Тесты сервера:

     cd server
     npm test

(нужна база docflow_test, см. server/README.md)

Установка на сервер компании через Docker — deploy/README.md.


ДОКУМЕНТЫ
---------

  docs/01-tz.md            Техническое задание
  docs/02-architecture.md  Архитектура и решения по открытым вопросам ТЗ
                           (помечены «[решение]», требуют согласования)
  docs/03-ux.md            UX-спецификация
  docs/04-api.md           Справочник API
  docs/05-user-guide.md    Инструкция пользователя
  docs/06-admin-guide.md   Инструкция администратора
