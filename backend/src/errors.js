export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details)
export const unauthorized = (message = 'Требуется вход в систему') => new HttpError(401, 'UNAUTHORIZED', message)
export const forbidden = (message = 'Недостаточно прав', code = 'FORBIDDEN') => new HttpError(403, code, message)
export const notFound = (message = 'Не найдено') => new HttpError(404, 'NOT_FOUND', message)
export const conflict = (message, code = 'CONFLICT') => new HttpError(409, code, message)
