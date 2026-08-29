import { jest } from "@jest/globals";

/**
 * Replaces `conf` with an in-memory store.
 *
 * The real Conf writes to the user's config directory, which os.homedir()
 * resolves outside jest's sandboxed process.env -- so a test that exercises
 * profile syncing would rewrite the developer's own taskonaut config.
 *
 * Must be called before importing index.js.
 *
 * @returns {{store: Map, reset: Function}} The backing store.
 */
export function mockConf() {
  const store = new Map();

  class FakeConf {
    constructor({ schema = {} } = {}) {
      this.defaults = Object.fromEntries(
        Object.entries(schema).map(([key, value]) => [key, value.default]),
      );
    }

    get path() {
      return "/dev/null/taskonaut/config.json";
    }

    get store() {
      return { ...this.defaults, ...Object.fromEntries(store) };
    }

    get(key) {
      return store.has(key) ? store.get(key) : this.defaults[key];
    }

    set(key, value) {
      store.set(key, value);
    }

    clear() {
      store.clear();
    }
  }

  jest.unstable_mockModule("conf", () => ({ default: FakeConf }));

  return { store, reset: () => store.clear() };
}
