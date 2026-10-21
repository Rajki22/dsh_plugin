/**
 * Reconciliation contract test: two local workspaces, one shared session id,
 * and live projection snapshots. It proves the all-local total is deduped and
 * that the current workspace is reported separately from the other workspace.
 *
 *   node scripts/verify-reconciliation.mjs
 */

import { apply } from '../index.js';

process.env.DSH_WHALE_WIDGET_DISABLE_REFRESH = '1';

const routes = [];
const sessions = new Map([
  ['s-main', { totalCny: 10, currentTurnCny: 1 }],
  ['s-shared', { totalCny: 2, currentTurnCny: 0 }],
  ['s-other', { totalCny: 0.3, currentTurnCny: 0.1 }],
]);

const ctx = {
  effect(callback) {
    const disposer = callback();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  sessionProjections: {
    register() {
      return () => {};
    },
    snapshot(live) {
      return {
        values: {
          whaleCost: {
            totalCny: live.totalCny,
            currentTurnCny: live.currentTurnCny,
            turnSeq: 1,
            invalidTimeCount: 0,
          },
          tokenUsage: {
            uncachedInputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      };
    },
    stateOf() {
      return { model: { provider: 'deepseek-account', model: 'deepseek-flash' } };
    },
  },
  sessions: {
    get(id) {
      return sessions.get(id);
    },
  },
  workspaceRegistry: {
    list() {
      return [
        {
          id: 'ws-main',
          path: 'D:\\main',
          title: 'main',
          sessionIds: ['s-main', 's-shared'],
        },
        {
          id: 'ws-other',
          path: 'C:\\other',
          title: 'other',
          sessionIds: ['s-other', 's-shared'],
        },
      ];
    },
  },
  webServer: {
    tapIndex() {
      return () => {};
    },
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  timer: {
    interval() {
      return () => {};
    },
  },
};

await apply(ctx);

if (routes.length !== 6) throw new Error(`expected 6 routes, got ${routes.length}`);
const route = routes.find((entry) => entry.path === '/dsh-whale-widget/cost-reconciliation');
if (!route) throw new Error('reconciliation route missing');

let status = null;
let payload = null;
const res = {
  writeHead(code) {
    status = code;
  },
  end(body) {
    payload = JSON.parse(body);
  },
};
const req = {
  method: 'GET',
  url: '/dsh-whale-widget/cost-reconciliation?sessionId=s-main',
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
};
await route.handler(req, res);

if (status !== 200) throw new Error(`unexpected status ${status}`);
if (payload.currentWorkspace.id !== 'ws-main') throw new Error('current workspace mismatch');
if (Math.abs(payload.currentWorkspace.totalCny - 12) > 1e-9) throw new Error('current workspace total mismatch');
if (payload.allLocalWorkspaces.length !== 2) throw new Error('workspace list mismatch');
if (Math.abs(payload.allLocalTotal - 12.3) > 1e-9) throw new Error('all-local total mismatch');
if (Math.abs(payload.otherWorkspaceTotal - 0.3) > 1e-9) throw new Error('other workspace total mismatch');
if (payload.allLocalWorkspaces[1].sessionCount !== 1) throw new Error('shared session was not deduped');
if (Math.abs(payload.currentSession.totalCny - 10) > 1e-9) throw new Error('current session total mismatch');
if (Math.abs(payload.currentSession.currentTurnCny - 1) > 1e-9) throw new Error('current turn mismatch');

console.log('cost reconciliation verification: OK');
