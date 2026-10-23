// HTTP-aware errors thrown by validation and routes; the request handler turns them into responses.
export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export const bad = (msg) => new HttpError(400, msg);
export const notFound = (what) => new HttpError(404, `${what} not found`);
