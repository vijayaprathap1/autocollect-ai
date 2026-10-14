export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") => new ApiError(400, code, message);

export const unauthorized = (message = "Unauthorized", code = "UNAUTHORIZED") => new ApiError(401, code, message);

export const forbidden = (message = "Forbidden", code = "FORBIDDEN") => new ApiError(403, code, message);

export const notFound = (message = "Not found", code = "NOT_FOUND") => new ApiError(404, code, message);

export const conflict = (message: string, code = "CONFLICT") => new ApiError(409, code, message);

export const unavailable = (message: string, code = "SERVICE_UNAVAILABLE") => new ApiError(503, code, message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Validate a UUID path/body parameter, returning a 404 (not a 500) for junk ids. */
export function assertUuid(value: unknown, what = "Resource"): string {
  if (!isUuid(value)) throw notFound(`${what} not found`);
  return value;
}
