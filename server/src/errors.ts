import type { ErrorCode, ErrorDetail } from './api-types';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: ErrorDetail[]) => new AppError(400, 'validation', message, details);
export const unauthorized = (message = 'Требуется вход в систему') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав для выполнения действия') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Объект не найден или нет доступа') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const tooLarge = (message: string) => new AppError(413, 'payload_too_large', message);
export const unprocessable = (message: string, details?: ErrorDetail[]) =>
  new AppError(422, 'unprocessable', message, details);
