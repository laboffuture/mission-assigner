import type { Request, Response } from 'express';

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
