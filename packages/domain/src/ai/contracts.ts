import type { EvaluationDefinition, EvaluationScalar, EvaluationValue } from '../evaluation/engine';
import type { GradingDefinition } from '../grading/engine';

/** Capabilities supported by the future provider gateway. */
export type AiTask =
  | 'performance_evaluation'
  | 'trend_prediction'
  | 'assessment_score_prediction'
  | 'feedback_draft';

/** Provider IDs are metadata only; provider credentials belong on the server. */
export type AiProviderId = 'custom' | 'openai' | 'gemini' | (string & {});

/**
 * A server-side routing choice. Parallel runs keep provider results separate;
 * combining them requires an explicit task-specific policy.
 */
export type AiProviderPlan =
  | { mode: 'single'; providers: readonly [AiProviderId] }
  | { mode: 'fallback'; providers: readonly [AiProviderId, AiProviderId, ...AiProviderId[]] }
  | { mode: 'parallel'; providers: readonly [AiProviderId, AiProviderId, ...AiProviderId[]] };

/**
 * Privacy-projected schema snapshots interpreted by a task, when relevant.
 * Never put raw domain definitions here; the server-side privacy projection
 * strips free text, names, and reusable IDs before any provider request.
 */
export type AiSchemaContext = {
  gradingSystem?: GradingDefinition;
  evaluationCriteria?: EvaluationDefinition;
  gradingSystemVersion?: string;
  evaluationCriteriaVersion?: string;
};

/**
 * Provider inputs use opaque record references. The app/edge layer owns the
 * mapping between these references and enrollment IDs; providers don't need
 * student names, enrollment IDs, or other database identifiers.
 */
export type AiRecordInput<TInput = Record<string, unknown>> = {
  /** Fresh random reference for this request only; never reuse it. */
  recordRef: string;
  input: TInput;
};

export type AiTaskRequest<TInput = Record<string, unknown>> = {
  contractVersion: 1;
  task: AiTask;
  schemaContext: AiSchemaContext;
  records: readonly AiRecordInput<TInput>[];
};

export type AiEvidence = {
  /** Per-request opaque reference; never a database or reusable schema ID. */
  factorRef: string;
  value: number | string | boolean | null;
  explanation: string;
};

/** The criteria engine, not the model, turns these values into risk levels. */
export type AiPerformanceEvaluationOutput = {
  factorValues: EvaluationValue;
  evidence: AiEvidence[];
};

export type AiTrendPredictionOutput = {
  direction: 'improving' | 'stable' | 'declining' | 'unavailable';
  forecast: Array<{
    /** Per-request opaque reference; never a period name or database ID. */
    periodRef: string;
    predictedStanding: number;
    confidence?: number | null;
  }>;
};

export type AiStandingPredictionOutput = {
  predictedStanding: number;
  riskProbability: number | null;
  evaluationScores?: Record<string, EvaluationScalar | EvaluationScalar[] | null>;
  aiRiskLevel?: string | null;
  trend: 'improving' | 'stable' | 'declining';
  factors: string[];
};

export type AiPredictedAssessmentResult =
  | { kind: 'numeric'; value: number; maximum: number }
  | { kind: 'categorical'; value: string };

export type AiAssessmentScorePredictionOutput = {
  predictions: Array<{
    /** Per-request opaque reference; never an assessment title or database ID. */
    assessmentRef: string;
    result: AiPredictedAssessmentResult;
    confidence?: number | null;
    evidence?: string[];
  }>;
};

export type AiTaskOutputByTask = {
  performance_evaluation: AiPerformanceEvaluationOutput;
  trend_prediction: AiTrendPredictionOutput;
  assessment_score_prediction: AiAssessmentScorePredictionOutput;
  feedback_draft: { body: string };
};

export type AiProviderRunMetadata = {
  provider: AiProviderId;
  model: string;
  modelVersion?: string;
  promptVersion?: string;
  generatedAt: string;
};

export type AiProviderRecordOutput<TOutput> = {
  recordRef: string;
  output: TOutput;
};

/** Each provider retains its own provenance and outputs until policy resolves them. */
export type AiProviderTaskResult<TOutput> = {
  metadata: AiProviderRunMetadata;
  records: readonly AiProviderRecordOutput<TOutput>[];
};

export type AiTaskResponse<TTask extends AiTask> = {
  contractVersion: 1;
  task: TTask;
  advisoryOnly: true;
  providers: readonly AiProviderTaskResult<AiTaskOutputByTask[TTask]>[];
};
