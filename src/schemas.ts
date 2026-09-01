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

// Cursor-based pagination (Item 9): opaque cursor OR legacy limit/offset.
export const listQuery = z.object({
  limit: posInt.max(100).optional(),
  offset: nonNegInt.optional(),
  cursor: z.string().min(1).optional(),
});
