import '@testing-library/jest-dom/vitest';

// jsdom has no ResizeObserver; the AI Grid map uses one to resize Leaflet (the PoC's test-setup.ts, B10).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
