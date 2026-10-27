import { act, renderHook, waitFor } from '@testing-library/react';
import { useServiceData } from '../hooks/useServiceData';

/** A promise the test resolves by hand. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

it('keeps the newest answer when an older request finishes after it', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const answers = [first.promise, second.promise];
  const { result } = renderHook(() => useServiceData(() => answers.shift()!, '', 0));
  let refresh!: Promise<void>;
  act(() => {
    refresh = result.current[3]();
  });
  await act(async () => {
    second.resolve('new');
    await refresh;
  });
  expect(result.current[0]).toBe('new');
  await act(async () => {
    first.resolve('old');
    await first.promise;
  });
  await waitFor(() => expect(result.current[1]).toBe(true));
  expect(result.current[0]).toBe('new');
});

it('shows a poll that takes longer than the interval instead of replacing it, then polls again', async () => {
  vi.useFakeTimers();
  try {
    const slow = deferred<string>();
    const request = vi.fn(() => slow.promise);
    const { result } = renderHook(() => useServiceData(request, '', 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      slow.resolve('answer');
      await slow.promise;
    });
    expect(result.current[0]).toBe('answer');
    expect(result.current[1]).toBe(true);
    // Polling picks up again after the answer, and after a failure.
    request.mockImplementationOnce(() => Promise.reject(new Error('down')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current[2]?.message).toBe('down');
    request.mockImplementation(() => Promise.resolve('back'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(result.current[0]).toBe('back');
    expect(result.current[2]).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the newest error when an older request succeeds after it', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const answers = [first.promise, second.promise.then(() => Promise.reject(new Error('newer failed')))];
  const { result } = renderHook(() => useServiceData(() => answers.shift()!, 'initial', 0));
  let refresh!: Promise<void>;
  act(() => {
    refresh = result.current[3]();
  });
  await act(async () => {
    second.resolve('');
    await refresh;
  });
  expect(result.current[2]?.message).toBe('newer failed');
  await act(async () => {
    first.resolve('old');
    await first.promise;
  });
  expect(result.current[0]).toBe('initial');
  expect(result.current[2]?.message).toBe('newer failed');
});

describe('in a hidden tab', () => {
  let hidden = false;
  const setHidden = (value: boolean) => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips polls while the tab is hidden and asks again when it shows after the interval', async () => {
    const request = vi.fn(() => Promise.resolve('answer'));
    renderHook(() => useServiceData(request, '', 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(1);
    act(() => setHidden(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not ask again when the tab shows before the answer is an interval old', async () => {
    const request = vi.fn(() => Promise.resolve('answer'));
    renderHook(() => useServiceData(request, '', 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => setHidden(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(1);
    // The next tick polls as usual.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not ask again on showing the tab for data loaded once', async () => {
    const request = vi.fn(() => Promise.resolve('answer'));
    renderHook(() => useServiceData(request, '', 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => setHidden(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
      setHidden(false);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
