import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { BadRequestSchema } from '../../gen/google/rpc/error_details_pb';
import { ServiceError } from '../ConsoleService';
import { describeError, toServiceError, type ApiErrorKind } from './errors';
import { fakeClients } from './testing';

const badRequest = (...violations: [field: string, description: string][]) => ({
  desc: BadRequestSchema,
  value: create(BadRequestSchema, {
    fieldViolations: violations.map(([field, description]) => ({ field, description })),
  }),
});

/** Table rows with the code's name first, for the test titles. */
const byName = <R extends unknown[]>(rows: [Code, ...R][]) =>
  rows.map(([code, ...rest]) => [Code[code], code, ...rest] as [string, Code, ...R]);

describe('describeError', () => {
  it.each(
    byName<[ApiErrorKind, string]>([
      [Code.NotFound, 'notFound', "object with identifier 'site-x' not found"],
      [Code.Aborted, 'conflict', "object with identifier 'a' has resource version 3, the request carries 2"],
      [Code.InvalidArgument, 'invalid', 'Invalid domain format: x'],
      [Code.OutOfRange, 'invalid', 'offset out of range'],
      [Code.PermissionDenied, 'forbidden', 'managedclusters is forbidden'],
      [Code.AlreadyExists, 'error', 'A organization with the same name already exists.'],
      [Code.FailedPrecondition, 'error', 'Keycloak realm "ai-grid": Realm not found.'],
    ]),
  )("%s (%i) is %s with the backend's message", (_name, code, kind, message) => {
    expect(describeError(new ConnectError(message, code))).toEqual({ kind, code, message });
  });

  it.each(
    byName<[ApiErrorKind, string]>([
      [Code.Unauthenticated, 'unauthenticated', 'The AI Grid backend rejected your credentials. Log in again.'],
      [Code.Unimplemented, 'notAvailable', 'The AI Grid backend does not support this operation.'],
      [Code.Unavailable, 'unavailable', 'The AI Grid backend is unavailable. Try again.'],
      [Code.DeadlineExceeded, 'unavailable', 'The AI Grid backend did not respond in time. Try again.'],
      [
        Code.ResourceExhausted,
        'unavailable',
        'The request is too large, or the AI Grid backend is limiting requests. Try again later.',
      ],
      [Code.Canceled, 'unavailable', 'The AI Grid backend is unavailable. Try again.'],
      // Never the backend's own words about its failure: they can name its internals.
      [Code.Internal, 'error', 'The AI Grid backend failed to process the request.'],
      [Code.Unknown, 'error', 'The AI Grid backend failed to process the request.'],
      [Code.DataLoss, 'error', 'The AI Grid backend failed to process the request.'],
    ]),
  )("%s (%i) is %s with the console's message where the backend's is about itself", (_name, code, kind, message) => {
    const got = describeError(new ConnectError('dial tcp 192.0.2.1:443: connection refused', code));
    expect(got).toEqual({ kind, code, message });
  });

  it("names a field the backend refused, from google.rpc.BadRequest's violations", () => {
    const err = new ConnectError('the tenant is invalid', Code.InvalidArgument, undefined, [
      badRequest(['metadata.name', 'Name can not be null'], ['spec.domains[0]', 'Invalid domain format: x']),
      badRequest(['metadata.name', 'a second message for the same field']),
    ]);
    expect(describeError(err)).toEqual({
      kind: 'invalid',
      code: Code.InvalidArgument,
      message: 'the tenant is invalid',
      fieldErrors: { 'metadata.name': 'Name can not be null', 'spec.domains[0]': 'Invalid domain format: x' },
    });
  });

  it('reads field violations only on InvalidArgument, as the BFF does', () => {
    const err = new ConnectError('stale', Code.Aborted, undefined, [badRequest(['metadata.version', 'stale'])]);
    expect(describeError(err).fieldErrors).toBeUndefined();
  });

  it('reads the details a backend sent over the wire', async () => {
    const { clients } = fakeClients({
      tenants: {
        create: () => {
          throw new ConnectError('the tenant is invalid', Code.InvalidArgument, undefined, [
            badRequest(['metadata.name', 'Name can not be null']),
          ]);
        },
      },
    });
    const err = await clients.tenants.create({}).catch((e: unknown) => e);
    expect(describeError(err).fieldErrors).toEqual({ 'metadata.name': 'Name can not be null' });
  });

  it('describes what is not a ConnectError as an error', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'error',
      code: Code.Unknown,
      message: 'The AI Grid backend failed to process the request.',
    });
  });
});

describe('toServiceError', () => {
  it.each(
    byName<[number]>([
      [Code.InvalidArgument, 422],
      [Code.Unauthenticated, 401],
      [Code.PermissionDenied, 403],
      [Code.NotFound, 404],
      [Code.AlreadyExists, 409],
      [Code.Aborted, 409],
      [Code.FailedPrecondition, 412],
      [Code.ResourceExhausted, 429],
      [Code.Unimplemented, 501],
      [Code.Unavailable, 503],
      [Code.DeadlineExceeded, 504],
      [Code.Internal, 502],
    ]),
  )('%s (%i) is the status the BFF answers for it, %i', (_name, code, status) => {
    const err = toServiceError(new ConnectError('x', code));
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.status).toBe(status);
  });

  it('keeps the UI states the pages read from a ServiceError', () => {
    expect(toServiceError(new ConnectError('stale', Code.Aborted)).isConflict).toBe(true);
    expect(toServiceError(new ConnectError('', Code.Unimplemented)).isNotImplemented).toBe(true);
    expect(toServiceError(new ConnectError('', Code.Unauthenticated)).isUnauthenticated).toBe(true);
    const invalid = toServiceError(
      new ConnectError('bad', Code.InvalidArgument, undefined, [badRequest(['spec.domains[0]', 'Invalid'])]),
    );
    expect(invalid.fieldErrors).toEqual({ 'spec.domains[0]': 'Invalid' });
    expect(invalid.message).toBe('bad');
  });
});
