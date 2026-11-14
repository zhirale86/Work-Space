/** Файлы: проверка содержимого, ограничения, права на скачивание. */
import './env';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { DocumentDetail, FileItem } from '../src/api-types';
import { makeZip } from '../src/files/samples';
import {
  config,
  expectStatus,
  makeApproval,
  makeGpm,
  makeUser,
  samplePdf,
  sampleXlsx,
  setup,
  teardown,
  xlsx,
} from './helpers';

before(setup);
after(teardown);

async function draft() {
  const initiator = await makeUser();
  const a = await makeUser();
  const doc = await makeApproval(initiator, [a], { launch: false });
  return { initiator, a, doc };
}

describe('Файлы', () => {
  test('файл .xlsx с содержимым PDF отклоняется', async () => {
    const { initiator, doc } = await draft();
    const r = await initiator.api.upload(`/api/documents/${doc.id}/files?role=main`, 'расчёт.xlsx', samplePdf());
    expectStatus(r, 422);
    assert.match(r.body.error.message, /не соответствует расширению/);
    // ZIP без книги Excel тоже не считается XLSX; DOCX под видом XLSX — тоже.
    const zip = makeZip([{ name: 'word/document.xml', data: '<w/>' }]);
    expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files`, 'книга.xlsx', zip), 422);
    // PNG под видом PDF.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files`, 'скан.pdf', png), 422);
    const d = await initiator.api.get<DocumentDetail>(`/api/documents/${doc.id}`);
    assert.equal(d.body.files.length, 0);
  });

  test('файлы с макросами (.xlsm, а также xlsx с vbaProject.bin) отклоняются', async () => {
    const { initiator, doc } = await draft();
    const r = await initiator.api.upload(`/api/documents/${doc.id}/files`, 'макрос.xlsm', xlsx());
    expectStatus(r, 422);
    assert.match(r.body.error.message, /макрос/);
    const withVba = sampleXlsx([['a', 1]], [{ name: 'xl/vbaProject.bin', data: 'VBA' }]);
    const r2 = await initiator.api.upload(`/api/documents/${doc.id}/files`, 'книга.xlsx', withVba);
    expectStatus(r2, 422);
    assert.match(r2.body.error.message, /макрос/);
    expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files`, 'скрипт.exe', Buffer.from('MZ')), 422);
    expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files`, 'пусто.pdf', Buffer.alloc(0)), 422);
  });

  test('превышение размера файла — 413, временные файлы не остаются', async () => {
    const { initiator, doc } = await draft();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(config.maxFileMb * 1024 * 1024 + 10, 0x20)]);
    const r = await initiator.api.upload(`/api/documents/${doc.id}/files`, 'большой.pdf', big);
    expectStatus(r, 413);
    assert.equal(r.body.error.code, 'payload_too_large');
    const tmp = path.join(config.filesDir, 'tmp');
    assert.deepEqual(fs.readdirSync(tmp), []);
    // Файл в пределах лимита принимается.
    const ok = await initiator.api.upload(`/api/documents/${doc.id}/files`, 'нормальный.pdf', samplePdf());
    expectStatus(ok, 201);
  });

  test('кириллическое имя файла сохраняется и отдаётся в Content-Disposition', async () => {
    const { initiator, a, doc } = await draft();
    const up = await initiator.api.upload<FileItem>(`/api/documents/${doc.id}/files?role=main`, 'Коммерческое предложение №5.pdf', samplePdf());
    expectStatus(up, 201);
    assert.equal(up.body.currentVersion.originalName, 'Коммерческое предложение №5.pdf');
    assert.equal(up.body.currentVersion.mime, 'application/pdf');
    expectStatus(await initiator.api.post(`/api/documents/${doc.id}/launch`), 200);
    const dl = await a.api.get(up.body.currentVersion.downloadUrl);
    expectStatus(dl, 200);
    assert.match(String(dl.headers['content-disposition']), /filename\*=UTF-8''%D0%9A/);
    assert.equal(dl.headers['content-type'], 'application/pdf');
    // Второй основной документ не добавляется — только новая версия.
    expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files?role=main`, 'ещё.pdf', samplePdf()), 409);
  });

  test('администратор без роли «Контроль документов» не получает файл чужого документа', async () => {
    const initiator = await makeUser();
    const a = await makeUser();
    const admin = await makeUser({ roles: ['employee', 'admin'] });
    const auditor = await makeUser({ roles: ['employee', 'auditor'] });
    const doc = await makeGpm(initiator, [a]);
    const url = doc.files[0].currentVersion.downloadUrl;
    const r = await admin.api.get(url);
    expectStatus(r, 404);
    assert.equal(r.body.error.message, 'Файл не найден или нет доступа');
    expectStatus(await admin.api.get(`/api/documents/${doc.id}`), 404);
    // Отдельное полномочие «Контроль документов» даёт доступ к содержимому.
    expectStatus(await auditor.api.get(url), 200);
    expectStatus(await auditor.api.get(`/api/documents/${doc.id}`), 200);
    // Несуществующая версия — тот же ответ.
    expectStatus(await initiator.api.get('/api/file-versions/999999/download'), 404);
  });

  test('только инициатор управляет файлами; удалённый файл не попадает в новый раунд', async () => {
    const { initiator, a, doc } = await draft();
    const f1 = await initiator.api.upload<FileItem>(`/api/documents/${doc.id}/files`, 'приложение1.pdf', samplePdf('one'));
    const f2 = await initiator.api.upload<FileItem>(`/api/documents/${doc.id}/files`, 'приложение2.pdf', samplePdf('two'));
    expectStatus(f1, 201);
    expectStatus(f2, 201);
    expectStatus(await initiator.api.del(`/api/files/${f2.body.id}`), 200);
    const launched = await initiator.api.post<DocumentDetail>(`/api/documents/${doc.id}/launch`);
    expectStatus(launched, 200);
    assert.deepEqual(launched.body.rounds[0].files.map((f) => f.fileId), [f1.body.id]);
    // Согласующий не может загружать файлы в чужую карточку.
    expectStatus(await a.api.upload(`/api/files/${f1.body.id}/versions`, 'моя.pdf', samplePdf()), 403, 'Сначала проверяется роль, затем состояние процесса.');
  });

  test('ограничение количества файлов в карточке', async () => {
    const { initiator, doc } = await draft();
    for (let i = 0; i < config.maxFilesPerCard; i++) {
      expectStatus(await initiator.api.upload(`/api/documents/${doc.id}/files`, `файл${i}.pdf`, samplePdf(String(i))), 201);
    }
    const r = await initiator.api.upload(`/api/documents/${doc.id}/files`, 'лишний.pdf', samplePdf());
    expectStatus(r, 422);
    assert.match(r.body.error.message, /не более 20 файлов/);
  });

  test('файлы поручения: результат прикрепляет исполнитель, посторонний не скачивает', async () => {
    const author = await makeUser();
    const assignee = await makeUser();
    const outsider = await makeUser();
    const t = (await author.api.post('/api/tasks', { title: 'С файлом', assigneeId: assignee.id })).body;
    expectStatus(await author.api.upload(`/api/tasks/${t.id}/files?role=result`, 'итог.pdf', samplePdf()), 403);
    const up = await assignee.api.upload<FileItem>(`/api/tasks/${t.id}/files?role=result`, 'итог.pdf', samplePdf());
    expectStatus(up, 201);
    expectStatus(await author.api.get(up.body.currentVersion.downloadUrl), 200);
    expectStatus(await outsider.api.get(up.body.currentVersion.downloadUrl), 404);
    expectStatus(await outsider.api.upload(`/api/tasks/${t.id}/files`, 'x.pdf', samplePdf()), 404);
  });
});
