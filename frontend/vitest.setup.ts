import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver; the AI grid map uses one to resize Leaflet (the PoC's test-setup.ts, B10).
// Assigned rather than vi.stubGlobal'd: `unstubGlobals` would remove it after a file's first test.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// PatternFly's managed sidebar (Page isManagedSidebar) is open from its xl breakpoint up, measured as
// the page element's width. jsdom has no layout, so every element is 0px wide and its window 1024px:
// the page reports the window's width, and the window is a desktop's. A test that needs a narrow window
// sets window.innerWidth itself.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('pf-v6-c-page') ? window.innerWidth : (clientWidth.get!.call(this) as number);
    },
  });
}

// No test reaches the network. A test that needs fetch stubs it (vi.stubGlobal, vi.spyOn, or a
// fetch passed in); one that forgets fails with the URL instead of calling the real one.
globalThis.fetch = (input) => Promise.reject(new Error(`unstubbed fetch: ${String(input)}`));

// The console keeps the notification center's list and its write watches in the tab's session
// storage; every test starts with an empty one, as a new tab does.
if (typeof window !== 'undefined') {
  afterEach(() => window.sessionStorage.clear());
}
