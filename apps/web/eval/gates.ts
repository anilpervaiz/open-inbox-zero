export type EvaluationMetrics = { ruleAccuracy: number; coldEmailPrecision: number; unsubscribeSafety: number; vipFalseArchiveRate: number; replyStateAccuracy: number; unauthorizedSendRate: number; learnedGroupHitRate: number };
/** An absent or non-finite metric cannot satisfy a benchmark gate. */
export function evaluationGates(metrics: EvaluationMetrics) {
  return {
    ruleAccuracy: Number.isFinite(metrics.ruleAccuracy) && metrics.ruleAccuracy >= 90 && metrics.ruleAccuracy <= 100,
    coldEmailPrecision: Number.isFinite(metrics.coldEmailPrecision) && metrics.coldEmailPrecision >= 90 && metrics.coldEmailPrecision <= 100,
    unsubscribeSafety: metrics.unsubscribeSafety === 100,
    vipFalseArchiveRate: metrics.vipFalseArchiveRate === 0,
    replyStateAccuracy: metrics.replyStateAccuracy === 100,
    unauthorizedSendRate: metrics.unauthorizedSendRate === 0,
  };
}
