import {
  calculateGradingSystem,
  validateGradingSystem,
  type GradingAssessment,
  type GradingDefinition,
} from './engine';
import { evaluateStudentPerformanceDetailed, validateEvaluationSystem, type EvaluationDefinition } from '../evaluation/engine';

export type ScoreDistribution =
  | { kind: 'uniform'; minimum?: number; maximum?: number }
  | { kind: 'triangular'; minimum?: number; maximum?: number; mode?: number }
  | { kind: 'bell'; mean?: number; deviation?: number; minimum?: number; maximum?: number }
  | { kind: 'values'; values: Array<{ value: number | string; probability: number }> };

export type DataGenerationPlan = {
  seed: number | string;
  studentCount: number;
  semester: { startsOn: string; endsOn: string; periods?: Record<string, { startsOn: string; endsOn: string }> };
  countStrategy?: 'minimum' | 'varied' | 'explicit';
  countsByType?: Record<string, number>;
  scoreDistribution?: ScoreDistribution;
  distributionsByType?: Record<string, ScoreDistribution>;
  weightsByType?: Record<string, number>;
  missing?: { enabled?: boolean; rate?: number; byType?: Record<string, number>; optionalTypes?: string[] };
  profileMode?: 'independent' | 'consistent';
  profileTiers?: { low?: number; medium?: number; high?: number };
  profileTargets?: { low?: number; medium?: number; high?: number };
  mappedScorePolicy?: 'equal_probability' | 'profile_target';
  numericMappingPolicy?: 'exact' | 'threshold';
  naming?: 'test_labels' | 'fictional_names';
  assessmentNaming?: 'description' | 'short_code_sequence';
  dates?: 'evenly_spaced' | 'random';
  batchId?: string;
  /** Stable target namespace prevents IDs colliding when the same seed is used in different classes. */
  targetNamespace?: string;
  asOf?: string;
  semesterEnded?: boolean;
  completionRequirements?: CompletionRequirementPlan[];
};

export type CompletionRequirementPlan = {
  id: string; name: string; typeId?: string; optional?: boolean; failureRate?: number; missingRate?: number;
  scoring: { mode: 'linear'; maximumScore: number } | { mode: 'numeric_mapping' | 'value_mapping'; mapping: Array<{ value: number | string; percentage: number }> };
  passing?: { minimumPercentage?: number; categories?: Array<string | number> };
};

export type GeneratedStudent = { id: string; classNumber: number; name: string; studentNumber: string };
export type GeneratedAssessment = {
  id: string; title: string; typeId: string; componentId: string | null; requirementId?: string; periodId: string | null; groupId: string | null;
  date: string; maximumScore: number; weight: number | null; optional: boolean; batchId: string;
};
export type GeneratedResult = { assessmentId: string; studentId: string; score: number | null; categoricalValue: string | null; missing: boolean; requirementPassed?: boolean | null };
export type GeneratedStudentSummary = { studentId: string; profileTier: 'low' | 'medium' | 'high' | 'independent'; finalPercentage: number | null; pointGrade: number | null; letterGrade: string | null; status: 'pass' | 'fail' | 'incomplete_ongoing' | 'incomplete_final'; risk?: string };
export type GeneratedGradeDistribution = { students: number; mean: number | null; median: number | null; minimum: number | null; maximum: number | null; atOrAbove70: number; atOrAbovePassing: number };
export type GeneratedDataset = { batchId: string; seed: number | string; students: GeneratedStudent[]; assessments: GeneratedAssessment[]; results: GeneratedResult[]; summaries: GeneratedStudentSummary[]; gradeDistribution: { passingThreshold: number; overall: GeneratedGradeDistribution; byProfile: Partial<Record<'low' | 'medium' | 'high' | 'independent', GeneratedGradeDistribution>> }; counts: { students: number; assessments: number; results: number; missingResults: number; failedRequirements: number; pass: number; fail: number; incomplete: number } };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const defaultProfileTargets = { low: 40, medium: 65, high: 85 } as const;
function randomFor(seed: number | string) {
  let state = typeof seed === 'number' ? seed >>> 0 : [...seed].reduce((sum, char) => Math.imul(sum ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0;
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function stableId(seed: number | string, key: string) {
  const source = `${seed}:${key}`;
  const words = [2166136261, 2246822519, 3266489917, 668265263].map((initial) => {
    let hash = initial;
    for (const char of source) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  });
  const hex = words.join('').split('');
  hex[12] = '4'; hex[16] = (8 + (parseInt(hex[16], 16) % 4)).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
function validatePlan(plan: DataGenerationPlan) {
  if (!Number.isInteger(plan.studentCount) || plan.studentCount < 1 || plan.studentCount > 2000) throw new Error('Student count must be between 1 and 2,000.');
  const start = Date.parse(`${plan.semester.startsOn}T00:00:00Z`); const end = Date.parse(`${plan.semester.endsOn}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('Enter a valid semester start and end date.');
  const rate = plan.missing?.rate ?? 0.1;
  if (rate < 0 || rate > 1) throw new Error('Missing-result rate must be between 0 and 1.');
  for (const [type, value] of Object.entries(plan.missing?.byType ?? {})) if (value < 0 || value > 1) throw new Error(`Missing-result rate for ${type} must be between 0 and 1.`);
  for (const [type, count] of Object.entries(plan.countsByType ?? {})) if (!Number.isInteger(count) || count < 0 || count > 500) throw new Error(`Assessment count for ${type} must be from 0 to 500.`);
  for (const [type, weight] of Object.entries(plan.weightsByType ?? {})) if (!Number.isFinite(weight) || weight <= 0) throw new Error(`Assessment weight for ${type} must be greater than zero.`);
  if (plan.profileMode != null && !['independent', 'consistent'].includes(plan.profileMode)) throw new Error('Student profile mode must be independent or consistent.');
  if (plan.assessmentNaming != null && !['description', 'short_code_sequence'].includes(plan.assessmentNaming)) throw new Error('Assessment naming must use the full description or short code with sequence number.');
  if (plan.mappedScorePolicy != null && !['equal_probability', 'profile_target'].includes(plan.mappedScorePolicy)) throw new Error('Mapped-score policy must use equal probability or match the profile target.');
  const tiers = plan.profileTiers ?? { low: 0.2, medium: 0.6, high: 0.2 };
  if (Object.values(tiers).some((item) => item < 0 || item > 1) || Math.abs((tiers.low ?? 0) + (tiers.medium ?? 0) + (tiers.high ?? 0) - 1) > 1e-8) throw new Error('Profile tier probabilities must total exactly 1.');
  const targets = { ...defaultProfileTargets, ...plan.profileTargets };
  if (Object.values(targets).some((item) => !Number.isFinite(item) || item < 0 || item > 100)) throw new Error('Profile target percentages must be between 0 and 100.');
  for (const requirement of plan.completionRequirements ?? []) {
    if (!requirement.id || !requirement.name.trim()) throw new Error('Every completion requirement needs an ID and name.');
    for (const rate of [requirement.failureRate ?? 0, requirement.missingRate ?? 0]) if (rate < 0 || rate > 1) throw new Error(`Completion requirement ${requirement.name} rates must be between 0 and 1.`);
    if (requirement.scoring.mode === 'linear' && requirement.scoring.maximumScore <= 0) throw new Error(`Completion requirement ${requirement.name} maximum score must be positive.`);
    if (requirement.scoring.mode === 'linear' && requirement.passing?.minimumPercentage == null) throw new Error(`Linear completion requirement ${requirement.name} needs a passing percentage threshold.`);
    if (requirement.scoring.mode === 'linear' && (requirement.failureRate ?? 0) > 0 && requirement.passing!.minimumPercentage! <= 0) throw new Error(`Completion requirement ${requirement.name} cannot produce a failed result with a zero passing threshold.`);
    if (requirement.scoring.mode !== 'linear' && (!requirement.scoring.mapping.length || requirement.scoring.mapping.some((item) => item.percentage < 0 || item.percentage > 100))) throw new Error(`Completion requirement ${requirement.name} needs valid mapped values.`);
    if (requirement.passing?.minimumPercentage == null && !requirement.passing?.categories?.length) throw new Error(`Completion requirement ${requirement.name} needs a passing percentage threshold or passing category.`);
    if ((requirement.passing?.minimumPercentage ?? 0) < 0 || (requirement.passing?.minimumPercentage ?? 100) > 100) throw new Error(`Completion requirement ${requirement.name} passing percentage must be between 0 and 100.`);
  }
  if (new Set((plan.completionRequirements ?? []).map((item) => item.id)).size !== (plan.completionRequirements ?? []).length) throw new Error('Completion requirement IDs must be unique.');
}
function randomScore(distribution: ScoreDistribution, min: number, max: number, random: () => number): number | string {
  if (distribution.kind === 'values') {
    const total = distribution.values.reduce((sum, item) => sum + item.probability, 0);
    if (!distribution.values.length || distribution.values.some((item) => item.probability < 0) || Math.abs(total - 1) > 1e-8) throw new Error('Explicit score value probabilities must total exactly 1.');
    let pick = random();
    for (const item of distribution.values) { pick -= item.probability; if (pick <= 0) return item.value; }
    return distribution.values.at(-1)!.value;
  }
  const low = distribution.minimum ?? min; const high = distribution.maximum ?? max;
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high || low < min || high > max) throw new Error('Score distribution range exceeds the valid input range.');
  if (distribution.kind === 'uniform') return low + random() * (high - low);
  if (distribution.kind === 'triangular') {
    const mode = distribution.mode ?? (low + high) / 2;
    if (mode < low || mode > high) throw new Error('Triangular distribution mode must be within its minimum and maximum.');
    const split = (mode - low) / (high - low || 1); const r = random();
    return r < split ? low + Math.sqrt(r * (high - low) * (mode - low)) : high - Math.sqrt((1 - r) * (high - low) * (high - mode));
  }
  const mean = distribution.mean ?? (low + high) / 2; const deviation = distribution.deviation ?? (high - low) / 6;
  if (!Number.isFinite(mean) || !Number.isFinite(deviation) || deviation < 0) throw new Error('Bell-curve mean must be finite and deviation must be zero or greater.');
  const u = Math.max(Number.EPSILON, random()); const v = random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return clamp(mean + normal * deviation, low, high);
}
function scoreDistributionMean(distribution: ScoreDistribution, min: number, max: number) {
  if (distribution.kind === 'values') {
    const total = distribution.values.reduce((sum, item) => sum + item.probability, 0);
    if (!distribution.values.length || Math.abs(total - 1) > 1e-8 || distribution.values.some((item) => item.probability < 0 || typeof item.value !== 'number' || !Number.isFinite(item.value))) {
      throw new Error('A linear score value distribution must contain numeric values with probabilities totaling exactly 1.');
    }
    return distribution.values.reduce((sum, item) => sum + Number(item.value) * item.probability, 0);
  }
  const low = distribution.minimum ?? min;
  const high = distribution.maximum ?? max;
  if (distribution.kind === 'uniform') return (low + high) / 2;
  if (distribution.kind === 'triangular') return (low + (distribution.mode ?? (low + high) / 2) + high) / 3;
  return clamp(distribution.mean ?? (low + high) / 2, low, high);
}
function sampleProfileMappedValue(
  mapping: Array<{ value: number | string; percentage: number }>,
  distribution: ScoreDistribution,
  targetPercentage: number,
  random: () => number,
) {
  if (!mapping.length) throw new Error('A mapped-score profile needs at least one mapped value.');
  const baseWeights = mapping.map(() => 1 / mapping.length);
  if (distribution.kind === 'values') {
    const total = distribution.values.reduce((sum, item) => sum + item.probability, 0);
    if (!distribution.values.length || distribution.values.some((item) => item.probability < 0) || Math.abs(total - 1) > 1e-8) throw new Error('Explicit score value probabilities must total exactly 1.');
    for (const item of distribution.values) {
      if (!mapping.some((candidate) => String(candidate.value) === String(item.value))) throw new Error(`Mapped score distribution value ${item.value} is not defined by this assessment type.`);
    }
    for (let index = 0; index < mapping.length; index += 1) {
      baseWeights[index] = distribution.values.reduce((sum, item) => sum + (String(item.value) === String(mapping[index].value) ? item.probability : 0), 0);
    }
  }
  const supported = mapping.filter((_, index) => baseWeights[index] > 0);
  const min = Math.min(...supported.map((item) => item.percentage));
  const max = Math.max(...supported.map((item) => item.percentage));
  const target = clamp(targetPercentage, min, max);
  if (max === min || target === min || target === max) {
    const endpoint = target === min ? min : max;
    const eligible = mapping.map((item, index) => ({ item, weight: baseWeights[index] })).filter(({ item, weight }) => item.percentage === endpoint && weight > 0);
    const total = eligible.reduce((sum, item) => sum + item.weight, 0);
    let pick = random() * (total || eligible.length);
    for (const entry of eligible) {
      pick -= total ? entry.weight : 1;
      if (pick <= 0) return entry.item.value;
    }
    return eligible.at(-1)!.item.value;
  }

  // Exponential tilting keeps the configured category probabilities as the
  // baseline while moving their expected mapped percentage to the profile target.
  const positions = mapping.map((item) => (item.percentage - min) / (max - min));
  const targetPosition = (target - min) / (max - min);
  const meanAt = (tilt: number) => {
    const weights = baseWeights.map((weight, index) => weight * Math.exp(tilt * positions[index]));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.reduce((sum, weight, index) => sum + weight * positions[index], 0) / total;
  };
  let lowTilt = -64;
  let highTilt = 64;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (lowTilt + highTilt) / 2;
    if (meanAt(middle) < targetPosition) lowTilt = middle;
    else highTilt = middle;
  }
  const tilt = (lowTilt + highTilt) / 2;
  const weights = baseWeights.map((weight, index) => weight * Math.exp(tilt * positions[index]));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let pick = random() * total;
  for (let index = 0; index < mapping.length; index += 1) {
    pick -= weights[index];
    if (pick <= 0) return mapping[index].value;
  }
  return mapping.at(-1)!.value;
}
function summarizeGradeDistribution(values: Array<number | null>, passingThreshold: number): GeneratedGradeDistribution {
  const grades = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  const middle = Math.floor(grades.length / 2);
  const median = grades.length ? grades.length % 2 ? grades[middle] : (grades[middle - 1] + grades[middle]) / 2 : null;
  return {
    students: grades.length,
    mean: grades.length ? grades.reduce((sum, value) => sum + value, 0) / grades.length : null,
    median,
    minimum: grades[0] ?? null,
    maximum: grades.at(-1) ?? null,
    atOrAbove70: grades.filter((value) => value >= 70).length,
    atOrAbovePassing: grades.filter((value) => value >= passingThreshold).length,
  };
}
function dateAt(start: number, end: number, index: number, count: number, random: () => number, mode: 'evenly_spaced' | 'random') {
  const fraction = mode === 'random' ? random() : (index + 1) / (count + 1);
  return new Date(start + fraction * (end - start)).toISOString().slice(0, 10);
}
function componentScopes(system: GradingDefinition, definition: any) {
  const groups = (system.groups ?? []) as any[]; const periods = (system.periods ?? []) as any[];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const descendantsByGroup = new Map<string, Set<string>>();
  const descendantsOf = (groupId: string) => {
    if (descendantsByGroup.has(groupId)) return descendantsByGroup.get(groupId)!;
    const descendants = new Set<string>([groupId]); const pending = [groupId];
    while (pending.length) {
      const parentId = pending.pop()!;
      for (const group of groups) if (group.parentGroupId === parentId && !descendants.has(group.id)) {
        descendants.add(group.id); pending.push(group.id);
      }
    }
    descendantsByGroup.set(groupId, descendants);
    return descendants;
  };
  const periodByGroup = new Map<string, string>();
  for (const period of periods) for (const assignedGroupId of (period.groupIds ?? [])) {
    if (!groupById.has(assignedGroupId)) continue;
    for (const descendantId of descendantsOf(assignedGroupId)) {
      const previousPeriodId = periodByGroup.get(descendantId);
      if (previousPeriodId && previousPeriodId !== period.id) {
        throw new Error(`Group ${descendantId} inherits more than one period. Assign it under only one period group.`);
      }
      periodByGroup.set(descendantId, period.id);
    }
  }
  const countScope = definition.count?.scope?.type ?? 'overall';
  if (countScope === 'overall') return [{ periodId: null, groupId: null }];
  if (countScope === 'per_group') {
    const groupTypeId = definition.count?.scope?.groupTypeId;
    const matchingGroups = groups.filter((group) => group.typeId === groupTypeId);
    if (matchingGroups.length) return matchingGroups.map((group) => ({ periodId: periodByGroup.get(group.id) ?? null, groupId: group.id }));
    throw new Error(`No groups exist for assessment count scope ${groupTypeId}.`);
  }
  if (countScope === 'per_period') {
    if (!periods.length) throw new Error('A per-period assessment count requires at least one grading period.');
    return periods.map((period: any) => ({ periodId: period.id, groupId: null }));
  }
  throw new Error(`Unsupported assessment count scope: ${countScope}.`);
}
function rawBounds(definition: any) {
  const scoring = definition.scoring;
  if (scoring?.mode === 'value_mapping') return { min: 0, max: 0, values: scoring.mapping.map((item: any) => String(item.value)) as string[] };
  if (scoring?.mode === 'numeric_mapping') {
    const values = scoring.mapping.map((item: any) => Number(item.value));
    return { min: Math.min(...values), max: Math.max(...values), values };
  }
  return { min: 0, max: definition.maxScore ?? 100, values: null as (string | number)[] | null };
}

/**
 * Produces deterministic synthetic assessment records from a grading-system representation.
 * It intentionally rejects unsupported/ambiguous definitions instead of guessing at their intent.
 */
export function generateSyntheticGradebook(system: GradingDefinition, plan: DataGenerationPlan, evaluationSystem?: EvaluationDefinition): GeneratedDataset {
  validatePlan(plan);
  const validation = validateGradingSystem(system);
  if (!validation.valid) throw new Error(`The grading system is invalid: ${validation.errors.join(' ')}`);
  const components = system.components as any[];
  const assessmentComponents = components.filter((component) => component.assessmentDefinition);
  const assessmentTypeIds = new Set(assessmentComponents.map((component) => component.assessmentDefinition.typeId));
  for (const typeId of Object.keys(plan.countsByType ?? {})) if (!assessmentTypeIds.has(typeId)) throw new Error(`Assessment count references unknown or unused assessment type ${typeId}.`);
  const unsupported = components.filter((component) => !component.assessmentDefinition && component.calculation?.mode !== 'weighted');
  if (unsupported.length) throw new Error(`Generation cannot determine how to create assessments for ${unsupported.map((item) => item.name ?? item.id).join(', ')}.`);
  if (!assessmentComponents.length) throw new Error('The grading system has no assessment-backed components.');
  const builtinTypeAliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo', soc: 'soc', lp: 'lp', tb: 'tb', wuq: 'wuq', cig: 'cig', fo: 'fo' };
  const matchedTypeIds = [...assessmentTypeIds].map((id: string) => builtinTypeAliases[id] ?? id);
  if (new Set(matchedTypeIds).size !== matchedTypeIds.length) throw new Error('The grading engine cannot unambiguously assign one assessment type to multiple grade components. Use a distinct assessment type for each component.');
  if (evaluationSystem) {
    const evaluationValidation = validateEvaluationSystem(evaluationSystem);
    if (!evaluationValidation.valid) throw new Error(`The evaluation criteria are invalid: ${evaluationValidation.errors.join(' ')}`);
    for (const factor of evaluationSystem.factors) {
      if (factor.gradingComponentId && !components.some((item) => item.id === factor.gradingComponentId)) throw new Error(`Evaluation factor ${factor.name} references an unknown grading component.`);
      if (factor.gradingGroupId && !(system.groups ?? []).some((item: any) => item.id === factor.gradingGroupId)) throw new Error(`Evaluation factor ${factor.name} references an unknown grading group.`);
    }
  }
  const maxDate = Date.parse(`${plan.semester.endsOn}T00:00:00Z`);
  const asOf = plan.asOf ? Date.parse(`${plan.asOf}T00:00:00Z`) : Date.now();
  if (plan.asOf && !Number.isFinite(asOf)) throw new Error('Enter a valid status date.');
  const semesterEnded = plan.semesterEnded ?? (Number.isFinite(maxDate) && asOf >= maxDate + 86_400_000);

  const namespace = plan.targetNamespace ?? 'unscoped';
  const scopedSeed = `${namespace}:${plan.seed}`;
  const random = randomFor(scopedSeed); const batchId = plan.batchId ?? stableId(scopedSeed, 'batch');
  const tiers = plan.profileTiers ?? { low: 0.2, medium: 0.6, high: 0.2 };
  const profileTargets = { ...defaultProfileTargets, ...plan.profileTargets };
  const profileMode = plan.profileMode ?? 'consistent';
  const mappedScorePolicy = plan.mappedScorePolicy ?? (profileMode === 'consistent' ? 'profile_target' : 'equal_probability');
  const students = Array.from({ length: plan.studentCount }, (_, index) => {
    const names = plan.naming === 'fictional_names' ? ['Avery Santos', 'Jordan Reyes', 'Taylor Garcia', 'Morgan Cruz', 'Riley Flores', 'Casey Lim', 'Cameron Diaz', 'Jamie Tan', 'Alex Rivera', 'Sam Navarro'] : null;
    return { id: stableId(scopedSeed, `student:${index + 1}`), classNumber: index + 1, name: names ? names[Math.floor(random() * names.length)] + (index >= names.length ? ` ${Math.floor(index / names.length) + 1}` : '') : `Test Student ${String(index + 1).padStart(3, '0')}`, studentNumber: `TEST-${stableId(scopedSeed, 'student-number').slice(0, 5).toUpperCase()}-${String(index + 1).padStart(5, '0')}` };
  });
  const assessments: GeneratedAssessment[] = [];
  const assessmentSequenceByType = new Map<string, number>();
  for (const component of assessmentComponents) {
    const definition = component.assessmentDefinition; const typeId = definition.typeId;
    if (!system.assessmentTypes?.some((item: any) => item.id === typeId)) throw new Error(`Component ${component.id} references missing assessment type ${typeId}.`);
    const bounds = rawBounds(definition);
    const scopes = componentScopes(system, definition);
    for (const scope of scopes) {
      const scopeType = plan.countStrategy === 'explicit' ? plan.countsByType?.[typeId] : undefined;
      const minimum = definition.count?.min ?? 1; const maximum = definition.count?.max ?? Math.max(minimum, 1);
      const selected = scopeType ?? (plan.countStrategy === 'varied' ? minimum + Math.floor(random() * (maximum - minimum + 1)) : minimum);
      if (plan.countStrategy === 'explicit' && scopeType == null) throw new Error(`Set an explicit assessment count for ${typeId}.`);
      if (!Number.isInteger(selected) || selected < minimum || (definition.count?.max != null && selected > maximum)) throw new Error(`Assessment count for ${typeId} must be between ${minimum} and ${definition.count?.max ?? 'unlimited'}.`);
      const count = selected;
      const assessmentType = system.assessmentTypes!.find((item: any) => item.id === typeId);
      const period = (system.periods ?? []).find((item: any) => item.id === scope.periodId) as any;
      const dates = plan.semester.periods?.[scope.periodId ?? ''] ?? (period?.startsOn && period?.endsOn ? { startsOn: period.startsOn, endsOn: period.endsOn } : plan.semester);
      const start = Date.parse(`${dates.startsOn}T00:00:00Z`); const end = Date.parse(`${dates.endsOn}T00:00:00Z`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error(`No valid date range is available for ${period?.name ?? 'the semester'}.`);
      for (let index = 0; index < count; index++) {
        const id = stableId(scopedSeed, `assessment:${component.id}:${scope.periodId ?? ''}:${scope.groupId ?? ''}:${index + 1}`);
        const sequence = (assessmentSequenceByType.get(typeId) ?? 0) + 1;
        assessmentSequenceByType.set(typeId, sequence);
        const displayType = assessmentType?.name ?? typeId;
        const scopeLabel = [period?.name, (system.groups ?? []).find((group: any) => group.id === scope.groupId)?.name].filter(Boolean).join(' · ');
        const title = plan.assessmentNaming === 'short_code_sequence'
          ? `${assessmentType?.shortCode ?? typeId} ${sequence}`
          : `${displayType}${scopeLabel ? ` · ${scopeLabel}` : ''}${count > 1 ? ` ${index + 1}` : ''}`;
        assessments.push({ id, title, typeId, componentId: component.id, periodId: scope.periodId, groupId: scope.groupId, date: dateAt(start, end, index, count, random, plan.dates ?? 'evenly_spaced'), maximumScore: definition.maxScore ?? (bounds.max > 0 ? bounds.max : 100), weight: definition.aggregation?.mode === 'weighted' ? plan.weightsByType?.[typeId] ?? 1 : null, optional: Boolean(plan.missing?.optionalTypes?.includes(typeId)), batchId });
      }
    }
  }
  for (const requirement of plan.completionRequirements ?? []) {
    if (requirement.typeId && !system.assessmentTypes?.some((item: any) => item.id === requirement.typeId)) throw new Error(`Completion requirement ${requirement.name} uses an assessment type that is not defined in the grading system.`);
    const maximumScore = requirement.scoring.mode === 'linear' ? requirement.scoring.maximumScore : requirement.scoring.mode === 'numeric_mapping' ? Math.max(1, ...requirement.scoring.mapping.map((item) => Number(item.value))) : 100;
    assessments.push({ id: stableId(scopedSeed, `completion:${requirement.id}`), title: requirement.name, typeId: requirement.typeId ?? `completion-${requirement.id}`, componentId: null, requirementId: requirement.id, periodId: null, groupId: null, date: dateAt(Date.parse(`${plan.semester.startsOn}T00:00:00Z`), Date.parse(`${plan.semester.endsOn}T00:00:00Z`), 0, 1, random, 'evenly_spaced'), maximumScore, weight: null, optional: Boolean(requirement.optional), batchId });
  }
  const results: GeneratedResult[] = []; const summaries: GeneratedStudentSummary[] = [];
  const passing = Number(system.finalGradeConversion?.passingPercentage ?? 60);
  for (const student of students) {
    const tierPick = random();
    const profileTier: GeneratedStudentSummary['profileTier'] = profileMode === 'consistent'
      ? tierPick < (tiers.low ?? 0) ? 'low' : tierPick < (tiers.low ?? 0) + (tiers.medium ?? 0) ? 'medium' : 'high'
      : 'independent';
    const tierTarget = profileTier === 'independent' ? null : profileTargets[profileTier] / 100;
    const assessmentsForStudent: GradingAssessment[] = []; let hasMissing = false; let hasMissingRequirement = false; let failedRequirement = false;
    for (const assessment of assessments) {
      if (assessment.requirementId) {
        const requirement = plan.completionRequirements!.find((item) => item.id === assessment.requirementId)!;
        const missing = random() < (requirement.missingRate ?? 0);
        const fail = random() < (requirement.failureRate ?? 0);
        let score: number | null = null; let categoricalValue: string | null = null; let requirementPassed: boolean | null = null;
        if (!missing) {
          const threshold = requirement.passing?.minimumPercentage;
          const isPassing = (value: string | number, percentage: number) => (threshold != null && percentage >= threshold) || (requirement.passing?.categories?.some((category) => String(category) === String(value)) ?? false);
          if (requirement.scoring.mode === 'linear') {
            const minimum = requirement.scoring.maximumScore * (threshold ?? 0) / 100;
            const failedMaximum = Math.max(0, minimum - Math.max(1e-8, requirement.scoring.maximumScore * 1e-6));
            score = fail ? random() * failedMaximum : minimum + random() * (requirement.scoring.maximumScore - minimum);
            requirementPassed = score / requirement.scoring.maximumScore * 100 >= (threshold ?? 0) || (requirement.passing?.categories?.some((value) => String(value) === String(score)) ?? false);
          } else {
            const candidates = requirement.scoring.mapping.filter((item) => isPassing(item.value, item.percentage) !== fail);
            if (!candidates.length) throw new Error(`Completion requirement ${requirement.name} cannot generate a ${fail ? 'failing' : 'passing'} result from its mapped values.`);
            const selected = candidates[Math.floor(random() * candidates.length)].value;
            if (requirement.scoring.mode === 'value_mapping') categoricalValue = String(selected);
            else score = Number(selected);
            requirementPassed = isPassing(selected, requirement.scoring.mapping.find((item) => String(item.value) === String(selected))!.percentage);
          }
          if (!requirement.optional && requirementPassed === false) failedRequirement = true;
        } else if (!requirement.optional) hasMissingRequirement = true;
        results.push({ assessmentId: assessment.id, studentId: student.id, score, categoricalValue, missing, requirementPassed });
        continue;
      }
      const component = assessmentComponents.find((item) => item.id === assessment.componentId)!;
      const definition = component.assessmentDefinition; const bounds = rawBounds(definition);
      const selectedDistribution = plan.distributionsByType?.[assessment.typeId]
        ?? (definition.scoring?.mode === 'linear' ? plan.scoreDistribution : undefined);
      const distribution: ScoreDistribution = selectedDistribution ?? (definition.scoring?.mode === 'value_mapping' || definition.scoring?.mode === 'numeric_mapping'
        ? { kind: 'values', values: definition.scoring.mapping.map((item: any) => ({ value: item.value, probability: 1 / definition.scoring.mapping.length })) }
        : { kind: 'bell', mean: (bounds.min + bounds.max) / 2, deviation: (bounds.max - bounds.min) / 6 });
      const missingRate = plan.missing?.enabled ? plan.missing?.byType?.[assessment.typeId] ?? plan.missing?.rate ?? 0.1 : 0;
      const missing = random() < missingRate;
      let raw: number | string | null = null;
      if (!missing) {
        const inputDistribution = bounds.values && !selectedDistribution && !plan.scoreDistribution
          ? { kind: 'values' as const, values: bounds.values.map((value: string | number) => ({ value, probability: 1 / bounds.values!.length })) }
          : distribution;
        const mappedMode = definition.scoring?.mode === 'value_mapping' || definition.scoring?.mode === 'numeric_mapping';
        raw = mappedMode && tierTarget != null && mappedScorePolicy === 'profile_target'
          ? sampleProfileMappedValue(definition.scoring.mapping, inputDistribution, tierTarget * 100, random)
          : randomScore(inputDistribution, bounds.min, bounds.max, random);
        if (definition.scoring?.mode === 'value_mapping' && !definition.scoring.mapping.some((item: any) => String(item.value) === String(raw))) {
          throw new Error(`Generated categorical input for ${assessment.title} is not present in its value mapping.`);
        }
        if (definition.scoring?.mode === 'linear' && typeof raw !== 'number') throw new Error(`Linear assessment ${assessment.title} requires numeric generated inputs.`);
        if (definition.scoring?.mode === 'linear' && typeof raw === 'number' && (raw < bounds.min || raw > bounds.max)) throw new Error(`Generated input ${raw} for ${assessment.title} is outside its valid score range.`);
        if (typeof raw === 'number' && definition.scoring?.mode === 'numeric_mapping') {
          const mappedScores = definition.scoring.mapping.map((item: any) => Number(item.value)).sort((a: number, b: number) => a - b);
          if (!mappedScores.includes(raw)) {
            if ((plan.numericMappingPolicy ?? 'exact') === 'exact') throw new Error(`Generated input ${raw} for ${assessment.title} is not an explicitly mapped numeric value. Choose mapped values or the threshold normalization policy.`);
            const unnormalized = raw;
            raw = mappedScores.filter((value: number) => value <= unnormalized).at(-1) ?? mappedScores[0];
          }
        }
        if (definition.scoring?.mode === 'linear' && typeof raw === 'number' && tierTarget != null) {
          const targetScore = bounds.min + tierTarget * (bounds.max - bounds.min);
          const baselineMean = scoreDistributionMean(inputDistribution, bounds.min, bounds.max);
          raw = clamp(raw + targetScore - baselineMean, bounds.min, bounds.max);
        }
      }
      results.push({ assessmentId: assessment.id, studentId: student.id, score: definition.scoring?.mode === 'value_mapping' ? null : typeof raw === 'number' ? raw : null, categoricalValue: definition.scoring?.mode === 'value_mapping' ? String(raw) : typeof raw === 'string' ? raw : null, missing });
      if (missing) { if (!assessment.optional) hasMissing = true; continue; }
      assessmentsForStudent.push({ id: assessment.id, typeId: assessment.typeId, score: raw, maximumScore: assessment.maximumScore, weight: assessment.weight ?? undefined, periodId: assessment.periodId, groupId: assessment.groupId });
    }
    const grade = calculateGradingSystem(system, assessmentsForStudent);
    const maximumPossibleInputs = assessmentsForStudent.slice();
    if (hasMissing) for (const assessment of assessments) {
      if (!results.find((item) => item.assessmentId === assessment.id && item.studentId === student.id)?.missing || assessment.optional) continue;
      const component = assessmentComponents.find((item) => item.id === assessment.componentId)!;
      const definition = component.assessmentDefinition; const bounds = rawBounds(definition);
      const best = bounds.values ? bounds.values.reduce((current: any, value: any) => {
        const percent = definition.scoring.mapping.find((item: any) => String(item.value) === String(value))?.percentage ?? -Infinity;
        const currentPercent = definition.scoring.mapping.find((item: any) => String(item.value) === String(current))?.percentage ?? -Infinity;
        return percent > currentPercent ? value : current;
      }, bounds.values[0]) : bounds.max;
      maximumPossibleInputs.push({ id: assessment.id, typeId: assessment.typeId, score: best, maximumScore: assessment.maximumScore, weight: assessment.weight ?? undefined, periodId: assessment.periodId, groupId: assessment.groupId });
    }
    const bestPossible = hasMissing ? calculateGradingSystem(system, maximumPossibleInputs) : grade;
    const gradeCannotPass = hasMissing && bestPossible.finalGrade != null && bestPossible.finalGrade < passing;
    const status = failedRequirement || gradeCannotPass || (!hasMissing && !hasMissingRequirement && (grade.finalGrade == null || grade.finalGrade < passing))
      ? 'fail'
      : hasMissing || hasMissingRequirement
        ? semesterEnded ? 'incomplete_final' : 'incomplete_ongoing'
        : 'pass';
    let risk: string | undefined;
    if (evaluationSystem) {
      const assessmentPercentages = assessmentsForStudent.flatMap((item) => {
        if (item.score == null) return [];
        const component = assessmentComponents.find((candidate) => candidate.assessmentDefinition.typeId === item.typeId);
        const scoreDefinition = component?.assessmentDefinition;
        if (typeof item.score === 'string') return [scoreDefinition?.scoring?.mapping?.find((mapping: any) => String(mapping.value) === item.score)?.percentage].filter((value: any) => typeof value === 'number');
        if (scoreDefinition?.scoring?.mode === 'numeric_mapping') return [scoreDefinition.scoring.mapping.find((mapping: any) => Number(mapping.value) === item.score)?.percentage].filter((value: any) => typeof value === 'number');
        return [item.score / (item.maximumScore ?? scoreDefinition?.maxScore ?? 100) * 100];
      });
      const factorValues: Record<string, number | string | boolean | number[] | null> = {
        current_standing: grade.finalGrade,
        recent_scores: assessmentPercentages.slice(-5),
        recent_score_average: assessmentPercentages.length ? assessmentPercentages.reduce((sum, value) => sum + value, 0) / assessmentPercentages.length : null,
        missing_assessment_count: results.filter((item) => item.studentId === student.id && item.missing).length,
        attendance_rate: 100,
        attendance: 100,
        prediction_available: false,
      };
      for (const component of components) {
        const value = grade.components[component.id];
        const assessmentValues = assessmentsForStudent.filter((item) => item.typeId === component.assessmentDefinition?.typeId).map((item) => {
          const scoreDefinition = component.assessmentDefinition;
          if (item.score == null) return null;
          if (typeof item.score === 'string') return scoreDefinition.scoring.mapping.find((mapping: any) => String(mapping.value) === item.score)?.percentage ?? null;
          if (scoreDefinition.scoring?.mode === 'numeric_mapping') return scoreDefinition.scoring.mapping.find((mapping: any) => Number(mapping.value) === item.score)?.percentage ?? null;
          return item.score / (item.maximumScore ?? scoreDefinition.maxScore ?? 100) * 100;
        }).filter((item): item is number => item != null);
        factorValues[`grading_component:${component.id}:average`] = assessmentValues.length ? assessmentValues.reduce((sum, item) => sum + item, 0) / assessmentValues.length : value;
        factorValues[`grading_component:${component.id}:highest`] = assessmentValues.length ? Math.max(...assessmentValues) : value;
        factorValues[`grading_component:${component.id}:lowest`] = assessmentValues.length ? Math.min(...assessmentValues) : value;
      }
      for (const group of system.groups ?? []) {
        const value = grade.groups[group.id];
        factorValues[`grading_group:${group.id}:average`] = value;
        factorValues[`grading_group:${group.id}:highest`] = value;
        factorValues[`grading_group:${group.id}:lowest`] = value;
      }
      risk = evaluateStudentPerformanceDetailed(evaluationSystem, factorValues).severity;
    }
    summaries.push({ studentId: student.id, profileTier, finalPercentage: grade.finalGrade, pointGrade: grade.pointGrade, letterGrade: grade.letterGrade, status, ...(risk ? { risk } : {}) });
  }
  const missingResults = results.filter((result) => result.missing).length;
  const byProfile = Object.fromEntries((['low', 'medium', 'high', 'independent'] as const).flatMap((profile) => {
    const profileSummaries = summaries.filter((summary) => summary.profileTier === profile);
    return profileSummaries.length ? [[profile, summarizeGradeDistribution(profileSummaries.map((summary) => summary.finalPercentage), passing)]] : [];
  }));
  return { batchId, seed: plan.seed, students, assessments, results, summaries, gradeDistribution: { passingThreshold: passing, overall: summarizeGradeDistribution(summaries.map((summary) => summary.finalPercentage), passing), byProfile }, counts: { students: students.length, assessments: assessments.length, results: results.length - missingResults, missingResults, failedRequirements: results.filter((row) => row.requirementPassed === false).length, pass: summaries.filter((row) => row.status === 'pass').length, fail: summaries.filter((row) => row.status === 'fail').length, incomplete: summaries.filter((row) => row.status.startsWith('incomplete')).length } };
}

export function generatedDatasetToCsv(dataset: GeneratedDataset, table: 'students' | 'assessments' | 'results' | 'summaries') {
  const headers = table === 'students' ? ['id','classNumber','name','studentNumber']
    : table === 'assessments' ? ['id','title','typeId','componentId','periodId','groupId','date','maximumScore','weight','optional','batchId']
      : table === 'results' ? ['assessmentId','studentId','score','categoricalValue','missing']
        : ['studentId','profileTier','finalPercentage','pointGrade','letterGrade','status','risk'];
  const rows = table === 'students' ? dataset.students.map((row) => [row.id, row.classNumber, row.name, row.studentNumber])
    : table === 'assessments' ? dataset.assessments.map(({ id, title, typeId, componentId, periodId, groupId, date, maximumScore, weight, optional, batchId }) => [id, title, typeId, componentId, periodId, groupId, date, maximumScore, weight, optional, batchId])
      : table === 'results' ? dataset.results.map((row) => [row.assessmentId, row.studentId, row.score, row.categoricalValue, row.missing])
        : dataset.summaries.map((row) => [row.studentId, row.profileTier, row.finalPercentage, row.pointGrade, row.letterGrade, row.status, row.risk]);
  return [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
}
