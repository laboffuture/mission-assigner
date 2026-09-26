import { z } from 'zod';

/**
 * Per-endpoint request schemas (Item 3). Params/query arrive as strings, so ids
 * and numeric query values are coerced. Business rules (e.g. "the assignment
 * must be graded before feedback") stay in the service layer — these schemas
 * only validate the shape and types of input.
 */

const posInt = z.coerce.number().int().positive();
const nonNegInt = z.coerce.number().int().min(0);

export const studentIdParams = z.object({ studentId: posInt });
export const slotIdParams = z.object({ slotId: posInt });
export const missionIdParams = z.object({ missionId: posInt });
export const assignmentIdParams = z.object({ assignmentId: posInt });
export const idParams = z.object({ id: posInt });

export const resolveAssistanceBody = z.object({
  note: z.string().trim().min(1, 'a resolution note is required').max(1000),
});

/**
 * Dev login-as. The id must BE a JSON number, not merely something Number()
 * can turn into one: the route used to do `Number(req.body?.studentId)`, so
 * `{"studentId":[1]}` signed you in as user 1 (Number([1]) === 1), and so did
 * `"1"` and `[["1"]]` (audit #48).
 */
export const loginAsBody = z.object({
  studentId: z.number('studentId must be a number').int('studentId must be an integer').positive(),
  // The LMS theme, as the LTI launch will carry it. Optional, and cosmetic.
  theme: z.enum(['nebula', 'horizon']).optional(),
});

export const submitBody = z.object({
  assignmentId: posInt,
  selected: z.string().min(1),
  // Item 8 (idempotency) may also send an Idempotency-Key header; not a body field.
});

export const feedbackBody = z.object({
  answers: z
    .array(z.object({ question_key: z.string().min(1), value: z.string() }))
    .optional()
    .default([]),
});

/**
 * The weekly pilot report. `weeks` overrides the configured window; `format=html`
 * asks for the emailable document instead of the JSON.
 */
export const pilotReportQuery = z.object({
  weeks: posInt.max(104).optional(),
  format: z.enum(['json', 'html']).optional(),
});

// Cursor-based pagination (Item 9): opaque cursor OR legacy limit/offset.
export const listQuery = z.object({
  limit: posInt.max(100).optional(),
  offset: nonNegInt.optional(),
  cursor: z.string().min(1).optional(),
});
