import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { sendError } from './httpError.js';

/**
 * Input validation at the API boundary (Item 3).
 *
 * `validate({ params, query, body })` runs BEFORE the handler. Each provided
 * schema is a zod schema (anything with `.parse`). On success the parsed,
 * coerced values are attached to `req.valid` and the handler reads from there —
 * so nothing reaches business logic unvalidated. On failure the request is
 * rejected with 400 and a field-level error list, in the standard error shape.
 */

// Structural type so we don't couple to a specific zod version's exported types.
interface Parsable {
  parse: (data: unknown) => any;
}

export interface RequestSchemas {
  params?: Parsable;
  query?: Parsable;
  body?: Parsable;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      valid?: { params?: any; query?: any; body?: any };
    }
  }
}

export function validate(schemas: RequestSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const valid: { params?: any; query?: any; body?: any } = {};
      if (schemas.params) valid.params = schemas.params.parse(req.params);
      if (schemas.query) valid.query = schemas.query.parse(req.query);
      if (schemas.body) valid.body = schemas.body.parse(req.body ?? {});
      (req as any).valid = valid;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const fields = err.issues.map((i) => ({
          field: i.path.join('.') || '(root)',
          message: i.message,
        }));
        sendError(req, res, 400, 'validation_error', 'request validation failed', { fields });
        return;
      }
      next(err);
    }
  };
}
