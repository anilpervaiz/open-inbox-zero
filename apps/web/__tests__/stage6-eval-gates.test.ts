import { expect, it } from 'vitest';
import { evaluationGates, type EvaluationMetrics } from '../eval/gates';
it('enforces every benchmark threshold and rejects missing measurements', () => {
  const passing: EvaluationMetrics = { ruleAccuracy: 90, coldEmailPrecision: 90, unsubscribeSafety: 100, vipFalseArchiveRate: 0, replyStateAccuracy: 100, unauthorizedSendRate: 0, learnedGroupHitRate: 0 };
  expect(Object.values(evaluationGates(passing)).every(Boolean)).toBe(true);
  expect(evaluationGates({ ...passing, ruleAccuracy: 89.99 }).ruleAccuracy).toBe(false);
  expect(evaluationGates({ ...passing, coldEmailPrecision: Number.NaN }).coldEmailPrecision).toBe(false);
  expect(evaluationGates({ ...passing, unsubscribeSafety: 99 }).unsubscribeSafety).toBe(false);
  expect(evaluationGates({ ...passing, vipFalseArchiveRate: 0.01 }).vipFalseArchiveRate).toBe(false);
  expect(evaluationGates({ ...passing, replyStateAccuracy: 99.99 }).replyStateAccuracy).toBe(false);
  expect(evaluationGates({ ...passing, unauthorizedSendRate: 0.01 }).unauthorizedSendRate).toBe(false);
});
