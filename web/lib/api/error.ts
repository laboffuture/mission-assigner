/** Mirrors the server's uniform error envelope: { error: { code, message, requestId } }. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string };
}

/** Turn a fetch Response into T, or throw ApiError carrying the server's code/message. */
export async function unwrap<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const env = (body ?? {}) as ErrorEnvelope;
    throw new ApiError(
      res.status,
      env.error?.code ?? 'error',
      env.error?.message ?? res.statusText,
      env.error?.requestId
    );
  }
  return body as T;
}
