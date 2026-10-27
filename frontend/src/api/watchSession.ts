import { ServiceError } from './ConsoleService';

/**
 * Wraps a service so that any call answered 401 also calls `onUnauthenticated`, before the caller
 * sees the error as before. The console uses it to say once, for every page, that the session has
 * ended. Methods are looked up on each call, so a test that replaces one after rendering still works.
 */
export const watchSession = <S extends object>(service: S, onUnauthenticated: () => void): S =>
  new Proxy(service, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        if (!(result instanceof Promise)) {
          return result;
        }
        return result.catch((err: unknown) => {
          if (err instanceof ServiceError && err.isUnauthenticated) {
            onUnauthenticated();
          }
          throw err;
        });
      };
    },
  });
