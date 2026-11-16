/** Запрос на создание заказа в Битрикс24 по согласованному GPM-калькулятору. */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useApi } from '../../api/hooks';
import { ORDER_FLOW_NAME, type OrderRequestApprover, type OrderRequestInfo, type OrderRequestState } from '../../api/orderRequest';
import type { DocumentDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { Alert, Button } from '../../components/ui';
import { NBSP, dateTime, fileSize } from '../../lib/format';

function Approvers({ list }: { list: OrderRequestApprover[] }) {
  return (
    <ul className="order-req__approvers">
      {list.map((a) => (
        <li key={a.user.id}>
          <Icon name="check" size="sm" />
          <span>
            <span className="text-strong">{a.user.fullName}</span>
            <span className="text-muted">
              {a.user.position ? `, ${a.user.position}` : ''} — {dateTime(a.decidedAt)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function SentSummary({ r }: { r: OrderRequestInfo }) {
  return (
    <div className="stack stack--sm">
      <div className="row row--sm">
        <span className="badge badge--approved">Запрос отправлен</span>
        <span className="text-sm text-muted">{dateTime(r.createdAt)}</span>
      </div>
      <div>
        <div className="text-strong">
          {ORDER_FLOW_NAME} №{NBSP}
          {r.number}
        </div>
        <div className="text-sm text-muted">
          Отправил {r.author.fullName} · статус в Битрикс24: «{r.statusLabel}»
        </div>
      </div>
      <div className="text-sm">
        <div className="text-muted">Отметка в запросе:</div>
        GPM-калькулятор согласован {dateTime(r.approvedAt)}
      </div>
      <Approvers list={r.approvers} />
      <div className="text-sm order-req__file">
        <Icon name="file" size="sm" />
        <span>
          {r.file.name} · версия{NBSP}
          {r.file.versionNo}
        </span>
      </div>
      <a className="btn btn--secondary btn--block btn--sm" href={r.url} target="_blank" rel="noreferrer">
        Открыть запрос в Битрикс24
        <Icon name="external" />
      </a>
    </div>
  );
}

function SendModal({ doc, st, onClose, onSent }: { doc: DocumentDetail; st: OrderRequestState; onClose: () => void; onSent: (r: OrderRequestInfo) => void }) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = st.preview!;
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<OrderRequestInfo>(`/documents/${doc.id}/order-request`, { comment });
      toast.success('Запрос отправлен в Битрикс24', `${ORDER_FLOW_NAME} №${NBSP}${r.number}`);
      onSent(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить запрос');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Запрос на создание заказа"
      size="lg"
      onClose={onClose}
      initialFocus="textarea"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" icon="external" busy={busy} busyText="Отправляем…" onClick={send}>
            Отправить в Битрикс24
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="text-muted">
          В Битрикс24 будет создан элемент потока «{ORDER_FLOW_NAME}» в сделке, с отметкой о согласовании и последней версией GPM-калькулятора.
        </p>
        <dl className="dl">
          <dt className="dl__term">Сделка</dt>
          <dd className="dl__value">
            {doc.deal?.title ?? '—'} <span className="text-muted">№{NBSP}{doc.deal?.id}</span>
          </dd>
          <dt className="dl__term">Основание</dt>
          <dd className="dl__value">
            {doc.number} · {doc.title}
          </dd>
          <dt className="dl__term">Отметка</dt>
          <dd className="dl__value">
            <span className="badge badge--approved">GPM-калькулятор согласован</span> <span className="text-muted">{dateTime(p.approvedAt)}, запуск {p.roundNo}</span>
          </dd>
          <dt className="dl__term">Согласовали</dt>
          <dd className="dl__value">
            <Approvers list={p.approvers} />
          </dd>
          <dt className="dl__term">Вложение</dt>
          <dd className="dl__value">
            <span className="order-req__file">
              <Icon name="file" size="sm" />
              <span>
                {p.file.name} · версия {p.file.versionNo} (последняя) · {fileSize(p.file.size)}
              </span>
            </span>
          </dd>
        </dl>
        <label className="field">
          <span className="field__label">
            Комментарий для отдела, создающего заказ <span className="field__optional">необязательно</span>
          </span>
          <textarea className="textarea" rows={3} value={comment} maxLength={2000} placeholder="Например: счёт выставить до конца месяца, оплата 50 % аванс" onChange={(e) => setComment(e.target.value)} />
        </label>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

/** Блок в боковой колонке карточки и призыв к действию над карточкой. */
export function useOrderRequest(doc: DocumentDetail | null, enabled: boolean, onChanged?: () => void) {
  const st = useApi<OrderRequestState>(enabled && doc && doc.kind === 'approval' && doc.type.code === 'GPM' ? `/documents/${doc.id}/order-request` : null, { s: doc?.status });
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const data = st.data;
  // Ссылка «…?order=1» с главной сразу открывает окно отправки.
  useEffect(() => {
    if (params.get('order') === '1' && data?.canSend && data.preview) {
      setOpen(true);
      setParams((sp) => (sp.delete('order'), sp), { replace: true });
    }
  }, [params, data, setParams]);
  const reload = () => st.reload(true);

  if (!doc) return { banner: null, card: null, modal: null };
  const modal = open && data?.preview && <SendModal doc={doc} st={data} onClose={() => setOpen(false)} onSent={() => (setOpen(false), reload(), onChanged?.())} />;

  const banner =
    data?.canSend && data.preview ? (
      <Alert
        tone="success"
        title="GPM-калькулятор согласован"
        actions={
          <Button variant="primary" size="sm" icon="external" onClick={() => setOpen(true)}>
            Запросить создание заказа
          </Button>
        }
      >
        Отправьте в Битрикс24 запрос на создание заказа: в нём будет отметка о согласовании, список согласовавших и последняя версия калькулятора.
      </Alert>
    ) : data && !data.request && !data.canSend && data.preview ? (
      <Alert tone="info" title="GPM-калькулятор согласован">
        Запрос на создание заказа в Битрикс24 отправляет инициатор — {doc.initiator.fullName} (или администратор).
        {import.meta.env.VITE_DEMO === '1' && ' В демо переключитесь на него через «Демо-режим» в верхней панели.'}
      </Alert>
    ) : null;

  const card =
    data && (data.request || data.preview || data.reason) ? (
      <section className="card card--compact" aria-labelledby="c-order">
        <header className="card__header">
          <h2 className="card__title" id="c-order">
            Заказ в Битрикс24
          </h2>
        </header>
        <div className="card__body stack">
          {data.request ? (
            <SentSummary r={data.request} />
          ) : data.canSend ? (
            <>
              <p className="text-sm text-muted">Запрос ещё не отправлен.</p>
              <Button variant="secondary" size="sm" block icon="external" onClick={() => setOpen(true)}>
                Запросить создание заказа
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted">{doc.status === 'approved' ? data.reason : 'Запрос на создание заказа можно будет отправить после согласования GPM-калькулятора.'}</p>
          )}
        </div>
      </section>
    ) : null;

  return { banner, card, modal };
}
