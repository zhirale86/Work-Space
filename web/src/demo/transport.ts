/**
 * Транспорт демонстрационного режима: вместо сети запросы клиента обрабатывает сервер в памяти.
 * Ответы приходят с небольшой задержкой, чтобы были видны состояния загрузки.
 */
import type { Transport } from '../api/client';
import { type DemoResponse, handle } from './server';

const delay = (): number => 150 + Math.round(Math.random() * 150);

function abortError(): DOMException {
  return new DOMException('Запрос отменён', 'AbortError');
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(t);
      reject(abortError());
    });
  });
}

function toResponse(r: DemoResponse): Response {
  if (r.file) {
    const fallback = r.file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return new Response(new Blob([r.file.bytes as BlobPart], { type: r.file.mime }), {
      status: 200,
      headers: {
        'Content-Type': r.file.mime,
        'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(r.file.name)}`,
      },
    });
  }
  return new Response(JSON.stringify(r.json ?? null), { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function demoFetch(input: string, init: RequestInit = {}): Promise<Response> {
  await wait(delay(), init.signal);
  const res = await handle({ method: (init.method ?? 'GET').toUpperCase(), url: input, headers: new Headers(init.headers), body: init.body ?? null });
  if (init.signal?.aborted) throw abortError();
  return toResponse(res);
}

type Listener = ((ev: ProgressEvent) => void) | null;

/** Упрощённый XMLHttpRequest для загрузки файлов: ход выполнения, отмена, ответ сервера. */
class DemoXhr {
  status = 0;
  responseText = '';
  withCredentials = false;
  onload: Listener = null;
  onerror: Listener = null;
  onabort: Listener = null;
  upload: { onprogress: Listener } = { onprogress: null };
  private method = 'POST';
  private url = '';
  private headers = new Headers();
  private aborted = false;
  private timers: number[] = [];

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.timers.forEach((t) => window.clearTimeout(t));
    this.onabort?.(new ProgressEvent('abort'));
  }
  send(body: FormData): void {
    const file = body.get('file');
    const total = file instanceof Blob ? Math.max(file.size, 1) : 1;
    const steps = 5;
    const step = 90;
    for (let i = 1; i <= steps; i++) {
      this.timers.push(
        window.setTimeout(() => {
          if (!this.aborted) this.upload.onprogress?.(new ProgressEvent('progress', { lengthComputable: true, loaded: Math.round((total * i) / steps), total }));
        }, i * step),
      );
    }
    this.timers.push(
      window.setTimeout(() => {
        if (this.aborted) return;
        void handle({ method: this.method, url: this.url, headers: this.headers, body }).then((r) => {
          if (this.aborted) return;
          this.status = r.status;
          this.responseText = JSON.stringify(r.json ?? null);
          this.onload?.(new ProgressEvent('load'));
        });
      }, steps * step + 60),
    );
  }
}

export const demoTransport: Transport = {
  fetch: demoFetch,
  createXhr: () => new DemoXhr() as unknown as XMLHttpRequest,
};
