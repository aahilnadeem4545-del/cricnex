import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function toInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function toFloat(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'ERROR') {
    super(message);
    this.name = 'HttpError';
  }
}

export function badRequest(message: string, code = 'BAD_REQUEST'): HttpError {
  return new HttpError(400, message, code);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message, 'NOT_FOUND');
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, message, 'FORBIDDEN');
}

export function conflict(message: string, code = 'CONFLICT'): HttpError {
  return new HttpError(409, message, code);
}
