import { Code, ConnectError } from '@connectrpc/connect';
import { ServiceError } from '../api/ConsoleService';
import { isUnknownOutcome } from './unknownOutcome';

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });

// Which failed writes may still have landed (unknown), and which the backend refused (definite).
it.each<[string, unknown, boolean]>([
  // Unknown: the call was cut, never reached an answer, or the browser stopped waiting.
  ["the BFF's 504 (deadline_exceeded)", new ConnectError('did not respond in time', Code.DeadlineExceeded), true],
  [
    "the relay's 502, a router's 502, 503 or 504 (unavailable)",
    new ConnectError('unreachable', Code.Unavailable),
    true,
  ],
  ['an aborted fetch (canceled)', new ConnectError('aborted', Code.Canceled), true],
  ['an aborted fetch as connect-web wraps it', ConnectError.from(abortError()), true],
  ['a failed fetch as connect-web wraps it', ConnectError.from(new TypeError('Failed to fetch')), true],
  ['a failed fetch, unwrapped', new TypeError('Failed to fetch'), true],
  ['an aborted fetch, unwrapped', abortError(), true],
  ['the JSON API: no answer at all', new ServiceError(0, 'Unable to reach the console server.'), true],
  ['the JSON API: 503', new ServiceError(503, 'The AI grid backend is unavailable. Try again.'), true],
  ['the JSON API: 504', new ServiceError(504, 'The AI grid backend did not respond in time. Try again.'), true],
  // Definite: the backend (or the BFF in front of it) answered and refused.
  ['a refused value (invalid_argument)', new ConnectError('bad uri', Code.InvalidArgument), false],
  ['a taken name (already_exists)', new ConnectError('exists', Code.AlreadyExists), false],
  ['a stale version (aborted)', new ConnectError('changed', Code.Aborted), false],
  ['a model still in use (failed_precondition)', new ConnectError('in use', Code.FailedPrecondition), false],
  ['not found', new ConnectError('gone', Code.NotFound), false],
  ['permission denied', new ConnectError('no', Code.PermissionDenied), false],
  ['unauthenticated', new ConnectError('log in', Code.Unauthenticated), false],
  ['an RPC the backend lacks (unimplemented)', new ConnectError('no', Code.Unimplemented), false],
  ['a body over 1 MiB (resource_exhausted)', new ConnectError('too large', Code.ResourceExhausted), false],
  ["the backend's own failure (internal)", new ConnectError('boom', Code.Internal), false],
  ['an unknown code the backend sent', new ConnectError('boom', Code.Unknown), false],
  ['the JSON API: 409', new ServiceError(409, 'conflict'), false],
  ['the JSON API: 422', new ServiceError(422, 'invalid'), false],
  ["the JSON API: 502, the backend's other codes", new ServiceError(502, 'failed'), false],
  ['anything else thrown', new Error('a bug'), false],
])('%s: unknown=%s', (_name, err, unknown) => {
  expect(isUnknownOutcome(err)).toBe(unknown);
});
