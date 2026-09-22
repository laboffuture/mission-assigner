import type { Request, Response } from 'express';
import { isDbUnavailable, UNAVAILABLE_MESSAGE } from './dbErrors.js';
import { logger } from './logger.js';

/**
 * One consistent error shape for every rejection (Item 3):
 *   { error: { code, message, requestId, ...extra } }
 * The requestId is the pino-http request id, so a client error can be traced
 * straight to the server logs. A stack trace is never included.
 */
export function errorBody(req: Request, code: string, message: string, extra?: Record<string, unknown>) {
  return { error: { code, message, requestId: (req as any).id, ...(extra ?? {}) } };
}

export function sendError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return res.status(status).json(errorBody(req, code, message, extra));
}

/**
 * An unexpected failure inside a handler. A database outage becomes 503
 * service_unavailable (logged as a database error); anything else is a 500
 * with the handler's generic message. Both are logged at ERROR — someone
 * needs to act on either.
 */
export function sendServerError(
  req: Request,
  res: Response,
  err: unknown,
  message: string,
  logMessage = 'request failed'
): Response {
  const log = (req as any).log ?? logger;
  if (isDbUnavailable(err)) {
    log.error({ err }, 'database unavailable');
    return sendError(req, res, 503, 'service_unavailable', UNAVAILABLE_MESSAGE);
  }
  log.error({ err }, logMessage);
  return sendError(req, res, 500, 'internal_error', message);
}
