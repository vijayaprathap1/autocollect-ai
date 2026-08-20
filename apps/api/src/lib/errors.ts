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

export const badRequest = (message: string, code = "BAD_REQUEST") =>
  new ApiError(400, code, message);

export const unauthorized = (message = "Unauthorized", code = "UNAUTHORIZED") =>
  new ApiError(401, code, message);

export const forbidden = (message = "Forbidden", code = "FORBIDDEN") =>
  new ApiError(403, code, message);

export const notFound = (message = "Not found", code = "NOT_FOUND") =>
  new ApiError(404, code, message);