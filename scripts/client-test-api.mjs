import fs from 'node:fs';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

const React = {
  Fragment: Symbol('Fragment'),
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
  startTransition: (callback) => callback(),
};

const windowObject = {
  __ModuleLoader__: {
    load(definition) {
      windowObject.moduleExports = definition.factory((id) => {
        if (id === 'react') return React;
        throw new Error(`unexpected client dependency: ${id}`);
      });
    },
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
  innerWidth: 1280,
  innerHeight: 800,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: (handle) => clearTimeout(handle),
};

new Function('window', source)(windowObject);

if (!windowObject.moduleExports || !windowObject.moduleExports.__test) {
  throw new Error('client test API was not exported');
}

export const clientTest = windowObject.moduleExports.__test;
