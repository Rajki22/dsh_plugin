import { clientTest } from './client-test-api.mjs';

if (clientTest.workspaceRefreshMs !== 15_000) {
  throw new Error(`unexpected workspace refresh interval ${clientTest.workspaceRefreshMs}`);
}
console.log('client workspace refresh policy: OK');
