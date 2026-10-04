import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage();
export const withSource = (name, fn) => als.run(name, fn);
export const currentSource = () => als.getStore() ?? 'untagged';
