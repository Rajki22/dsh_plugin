import { clientTest } from './client-test-api.mjs';

const { normalizeCostValue } = clientTest;

const object = normalizeCostValue({
  totalCny: 7.35,
  currentTurnCny: 0.05,
  turnSeq: 123,
  invalidTimeCount: 2,
});
if (object.totalCny !== 7.35
  || object.currentTurnCny !== 0.05
  || object.turnSeq !== 123
  || object.invalidTimeCount !== 2) {
  throw new Error(`unexpected object normalization ${JSON.stringify(object)}`);
}
if (normalizeCostValue(1.25) !== null) throw new Error('numeric legacy form must be rejected');
if (normalizeCostValue({ totalCny: -1 }) !== null) throw new Error('negative total must be rejected');
if (normalizeCostValue(undefined) !== null) throw new Error('undefined must be rejected');
console.log('client cost wire normalization: OK');
