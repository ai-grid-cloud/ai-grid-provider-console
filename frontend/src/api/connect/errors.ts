import { Code, ConnectError } from '@connectrpc/connect';
import { BadRequestSchema } from '../../gen/google/rpc/error_details_pb';
import { ServiceError } from '../ConsoleService';

/**
 * The states a page shows for a failed call, as it shows them for the BFF's JSON API today:
 * `notFound` (the object doesn't exist), `conflict` (it changed since the page read it: Aborted on a
 * stale version), `invalid` (the backend refused a value; `fieldErrors` says which field),
 * `forbidden`, `unauthenticated` (the console checks its session; the page shows nothing),
 * `notAvailable` (the backend has no such RPC yet), `unavailable` (try again), and `error`.
 */
export type ApiErrorKind =
  'notFound' | 'conflict' | 'invalid' | 'forbidden' | 'unauthenticated' | 'notAvailable' | 'unavailable' | 'error';

export type ApiError = {
  kind: ApiErrorKind;
  code: Code;
  /** The backend's own message where it is about the request; the console's own otherwise. */
  message: string;
  /** InvalidArgument only: google.rpc.BadRequest's field violations, field path to description. */
  fieldErrors?: Record<string, string>;
};

/**
 * The codes whose message is about the request, which the page shows as the backend wrote it, as
 * the BFF does (bff/internal/api/errors.go, classify). Every other code gets the console's words:
 * a message about the backend's own failure (Internal, Unknown, DataLoss, a dial error) can name
 * its internals.
 */
const requestCodes = new Set<Code>([
  Code.InvalidArgument,
  Code.OutOfRange,
  Code.PermissionDenied,
  Code.NotFound,
  Code.AlreadyExists,
  Code.Aborted,
  Code.FailedPrecondition,
]);

/** The console's words for the other codes, as the BFF's; the rest share genericMessage. */
const genericMessage = 'The AI Grid backend failed to process the request.';
const consoleMessages: Partial<Record<Code, string>> = {
  [Code.Unauthenticated]: 'The AI Grid backend rejected your credentials. Log in again.',
  [Code.Unimplemented]: 'The AI Grid backend does not support this operation.',
  [Code.Unavailable]: 'The AI Grid backend is unavailable. Try again.',
  [Code.Canceled]: 'The AI Grid backend is unavailable. Try again.',
  [Code.DeadlineExceeded]: 'The AI Grid backend did not respond in time. Try again.',
  // The relay answers an oversized body (over 1 MiB) with this code too, which no retry fixes.
  [Code.ResourceExhausted]: 'The request is too large, or the AI Grid backend is limiting requests. Try again later.',
};

const kinds: Partial<Record<Code, ApiErrorKind>> = {
  [Code.NotFound]: 'notFound',
  [Code.Aborted]: 'conflict',
  [Code.InvalidArgument]: 'invalid',
  [Code.OutOfRange]: 'invalid',
  [Code.PermissionDenied]: 'forbidden',
  [Code.Unauthenticated]: 'unauthenticated',
  [Code.Unimplemented]: 'notAvailable',
  [Code.Unavailable]: 'unavailable',
  [Code.Canceled]: 'unavailable',
  [Code.DeadlineExceeded]: 'unavailable',
  [Code.ResourceExhausted]: 'unavailable',
};

/** The field violations of every google.rpc.BadRequest detail; the first message per field wins. */
const fieldErrorsOf = (err: ConnectError): Record<string, string> | undefined => {
  let out: Record<string, string> | undefined;
  for (const detail of err.findDetails(BadRequestSchema)) {
    for (const { field, description } of detail.fieldViolations) {
      out ??= {};
      if (!(field in out)) {
        out[field] = description;
      }
    }
  }
  return out;
};

/** What a page shows for a failed Connect call (or anything else a call threw). */
export const describeError = (reason: unknown): ApiError => {
  const err = ConnectError.from(reason);
  const kind = kinds[err.code] ?? 'error';
  const message = requestCodes.has(err.code)
    ? err.rawMessage || genericMessage
    : (consoleMessages[err.code] ?? genericMessage);
  const fieldErrors = err.code === Code.InvalidArgument ? fieldErrorsOf(err) : undefined;
  return fieldErrors ? { kind, code: err.code, message, fieldErrors } : { kind, code: err.code, message };
};

/** The HTTP status the BFF answers for each gRPC code (bff/internal/api/errors.go, classify). */
const statuses: Partial<Record<Code, number>> = {
  [Code.InvalidArgument]: 422,
  [Code.OutOfRange]: 422,
  [Code.Unauthenticated]: 401,
  [Code.PermissionDenied]: 403,
  [Code.NotFound]: 404,
  [Code.AlreadyExists]: 409,
  [Code.Aborted]: 409,
  [Code.FailedPrecondition]: 412,
  [Code.ResourceExhausted]: 429,
  [Code.Unimplemented]: 501,
  [Code.DeadlineExceeded]: 504,
  [Code.Unavailable]: 503,
  [Code.Canceled]: 503,
};

/**
 * The same failure as the ServiceError the BFF's JSON API would have produced, so the components
 * that render one today (LoadError, the delete and form hooks) render a Connect call's alike.
 */
export const toServiceError = (reason: unknown): ServiceError => {
  const { code, message, fieldErrors } = describeError(reason);
  return new ServiceError(statuses[code] ?? 502, message, fieldErrors);
};
