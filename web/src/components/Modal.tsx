import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Button, cx } from './ui';
import { errorText } from '../api/client';

interface ModalProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'lg';
  footerBetween?: boolean;
  /** Селектор элемента, который получает фокус при открытии. */
  initialFocus?: string;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Окно: фокус удерживается внутри, Esc и крестик закрывают без действия. */
export function Modal({ title, onClose, children, footer, size, footerBetween, initialFocus }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const target = (initialFocus && root?.querySelector<HTMLElement>(initialFocus)) || root?.querySelector<HTMLElement>('.modal__body ' + FOCUSABLE) || root?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Открытый выпадающий список внутри окна закрывается первым.
        if ((e.target as HTMLElement | null)?.getAttribute?.('aria-expanded') === 'true') return;
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === 'Tab' && root) {
        const els = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="modal-backdrop">
      <div ref={ref} className={cx('modal', size && `modal--${size}`)} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal__header">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          <button className="icon-btn icon-btn--sm modal__close" type="button" aria-label="Закрыть" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className={cx('modal__footer', footerBetween && 'modal__footer--between')}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  title: string;
  text: ReactNode;
  confirmText: string;
  busyText?: string;
  cancelText?: string;
  /** Поле комментария: подпись; без неё — простое подтверждение. */
  commentLabel?: string;
  /** Обязателен ли комментарий (минимум 5 символов). */
  commentRequired?: boolean;
  /** Окончание фразы «Напишите причину — без неё {action} нельзя.» */
  requiredAction?: string;
  commentHint?: string;
  onConfirm: (comment: string) => Promise<void>;
  onClose: () => void;
  children?: ReactNode;
}

/** Диалог подтверждения; опасные действия — с обязательным комментарием (раздел 3.3). */
export function ConfirmDialog({ title, text, confirmText, busyText, cancelText = 'Отмена', commentLabel, commentRequired, requiredAction, commentHint, onConfirm, onClose, children }: ConfirmProps) {
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();

  const submit = async () => {
    if (commentLabel && commentRequired && comment.trim().length < 5) {
      setError(comment.trim() ? 'Слишком коротко: напишите не меньше 5 символов.' : `Напишите причину — без неё ${requiredAction ?? 'продолжить'} нельзя.`);
      document.getElementById(fieldId)?.focus();
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      await onConfirm(comment.trim());
    } catch (e) {
      setServerError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      size="sm"
      onClose={busy ? () => undefined : onClose}
      initialFocus={commentLabel ? 'textarea' : '.btn--primary'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {cancelText}
          </Button>
          <Button variant="primary" onClick={submit} busy={busy} busyText={busyText}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p>{text}</p>
      {children}
      {commentLabel && (
        <div className={cx('field', error && 'field--error')}>
          <label className="field__label" htmlFor={fieldId}>
            {commentLabel}
            {commentRequired ? <span className="field__required">*</span> : null}
          </label>
          <textarea
            id={fieldId}
            className="textarea"
            rows={3}
            value={comment}
            aria-invalid={!!error}
            onChange={(e) => {
              setComment(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
            }}
          />
          {error ? (
            <span className="field__error" role="alert">
              <Icon name="alert" />
              {error}
            </span>
          ) : (
            commentHint && <span className="field__hint">{commentHint}</span>
          )}
        </div>
      )}
      {serverError && (
        <div className="alert alert--danger" role="alert">
          <Icon name="alert" />
          <div className="alert__body">{serverError}</div>
        </div>
      )}
    </Modal>
  );
}
