const PRIVATE_TEXT_KEYS = /name|email|student|enrollment|class|subject|section|year|title|label|description|date|user|id$/i
const SAFE_ENUM_KEYS = new Set(['type', 'source', 'mode', 'kind', 'strategy', 'aggregation', 'operator', 'comparison', 'direction', 'rounding', 'missingPolicy', 'resultType', 'inputType', 'mappingPolicy', 'periodStrategy'])
const SAFE_ENUM_VALUES = new Set([
  'number', 'numeric', 'string', 'boolean', 'category', 'percentage', 'points', 'letter', 'pass_fail', 'assessment', 'computed',
  'grading_component', 'grading_group', 'grading_period', 'current_standing', 'mastery', 'attendance', 'attendance_rate', 'ai_risk_level',
  'recent_scores', 'recent_score_average', 'recent_trend', 'missing_assessment_count', 'predicted_standing', 'risk_probability',
  'model_confidence', 'prediction_available', 'prediction_age_hours', 'ai_factor_count', 'data_basis', 'academic_record', 'derived', 'ai_prediction',
  'average', 'weighted_average', 'sum', 'minimum', 'maximum', 'latest', 'first', 'last', 'best', 'worst', 'all', 'any', 'none',
  'assessments', 'components', 'groups', 'periods', 'cumulative', 'independent', 'exact', 'threshold', 'interpolate', 'linear',
  'below', 'above', 'equals', 'not_equals', 'less_than', 'greater_than', 'less_than_or_equal', 'greater_than_or_equal', 'between',
  'at_most', 'at_least', 'contains', 'not_contains', 'is_true', 'is_false', 'in', 'not_in',
  'add', 'subtract', 'multiply', 'divide', 'min', 'max', 'round', 'floor', 'ceil', 'half_up', 'half_even', 'up', 'down',
  'improving', 'stable', 'declining', 'low', 'medium', 'high', 'pass', 'fail', 'incomplete_ongoing', 'incomplete_final',
])
const SAFE_SCHEMA_KEYS = new Set([
  'schemaVersion', 'definitionVersion', 'periods', 'groups', 'groupTypes', 'assessmentTypes', 'components', 'finalGradeConversion',
  'finalResult', 'calculationRootComponentId', 'finalPeriodId', 'id', 'name', 'description', 'shortCode', 'type', 'typeId',
  'groupTypeId', 'groupIds', 'componentId', 'components', 'groups', 'period', 'component', 'assessment', 'assessmentDefinition',
  'scoring', 'mapping', 'minimumPercentage', 'maximumPercentage', 'min', 'max', 'minValue', 'maxValue', 'value', 'percentage',
  'maxScore', 'maximumScore', 'weight', 'weightMode', 'calculation', 'periodCalculation', 'aggregation', 'mode', 'scope',
  'source', 'rules', 'rule', 'when', 'operator', 'threshold', 'numerator', 'denominator', 'override', 'sequence', 'count',
  'precision', 'rounding', 'passingPercentage', 'passingPoint', 'passingScale', 'failingScale', 'firstFailingPoint',
  'bestPoint', 'worstPoint', 'pointInterval', 'assessmentDefinition', 'grades', 'factors', 'levels', 'categories', 'match',
  'severity', 'priority', 'factorId', 'valueType', 'unit', 'origin', 'minimum', 'maximum', 'gradingComponentId',
  'gradingAggregation', 'gradingPeriodId', 'gradingGroupId', 'aiGenerated', 'requiresHumanReview', 'conditions', 'and', 'or',
  'resultType', 'formula', 'aggregationType', 'missingValuePolicy', 'optional', 'enabled', 'required', 'calculationType',
])

// These keys are constrained by the grading/evaluation contracts. Keep their
// exact values: lowercasing a legal enum (or dropping an uncommon enum) can
// turn an otherwise valid anonymized schema into a different, invalid schema.
// Values are copied from the grading_system_schema.json and
// evaluation_system_schema.json enum/const clauses. Unknown strings—even in
// enum-bearing properties—are dropped rather than forwarded as free text.
const STRUCTURAL_ENUM_VALUES: Record<string, ReadonlySet<string>> = {
  type: new Set(['overall', 'per_group', 'per_period', 'assessment_count']),
  source: new Set(['component', 'period_component', 'current_period', 'period_grade', 'current_standing', 'mastery', 'attendance', 'attendance_rate', 'recent_scores', 'recent_score_average', 'recent_trend', 'missing_assessment_count', 'predicted_standing', 'risk_probability', 'ai_risk_level', 'trend', 'model_confidence', 'prediction_available', 'prediction_age_hours', 'ai_factor_count', 'data_basis', 'grading_component', 'grading_group']),
  mode: new Set(['linear', 'numeric_mapping', 'value_mapping', 'points', 'equal', 'weighted', 'assessments', 'independent', 'period_formula', 'cumulative', 'equal_interval', 'mapping', 'nearest', 'floor', 'ceiling']),
  weightMode: new Set(['relative', 'absolute']),
  operator: new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'below', 'at_most', 'above', 'at_least', 'equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in', 'is_true', 'is_false', 'is_available', 'is_unavailable']),
  scope: new Set(['periods', 'groups', 'overall', 'per_period', 'per_group']),
  strategy: new Set(['priority', 'weighted']),
  severity: new Set(['low', 'medium', 'high']),
  unmatchedSeverity: new Set(['low', 'medium', 'high']),
  match: new Set(['any', 'all']),
  origin: new Set(['academic_record', 'derived', 'ai_prediction']),
  gradingAggregation: new Set(['average', 'highest', 'lowest']),
  unit: new Set(['percentage', 'probability', 'count', 'category', 'boolean']),
  valueType: new Set(['number', 'number_array', 'boolean', 'category']),
  missingValuePolicy: new Set(['ignore_rule', 'treat_as_zero', 'unavailable', 'return_unavailable']),
  missingPolicy: new Set(['ignore_rule', 'treat_as_zero', 'return_unavailable']),
  colorScheme: new Set(['green_to_red', 'white_to_red', 'custom']),
  supportedScenarios: new Set(['minimum', 'maximum', 'minimum_pass', 'stable', 'custom']),
  inputFeatures: new Set(['current_standing', 'recent_scores', 'attendance_rate', 'missing_assessment_count', 'assessment_results', 'assessment_instance_details']),
  outputFields: new Set(['predicted_standing', 'risk_probability', 'risk_level', 'trend', 'factors', 'model_version', 'data_basis', 'generated_at', 'assessment_score_predictions', 'evaluation_scores']),
  riskProbabilityMeaning: new Set(['heuristic', 'calibrated']),
  unavailablePolicy: new Set(['continue_with_available_rules', 'return_unavailable']),
  explanationPolicy: new Set(['show_model_factors_as_advisory', 'hide_model_factors']),
  roundingMode: new Set(['nearest', 'floor', 'ceiling']),
}
const PRIVATE_SCHEMA_KEYS = new Set([
  'name', 'label', 'short_code', 'description', 'title', 'student', 'student_id', 'student_number', 'class_number',
  'enrollment_id', 'class_id', 'class_record_id', 'subject', 'subject_name', 'section', 'year', 'academic_year',
  'year_level', 'email', 'user_id', 'institutional_id', 'program_id', 'assessment_date', 'due_at', 'effective_from',
  'effective_until', 'created_at', 'updated_at', 'created_by', 'updated_by',
])

function normalizedSchemaKey(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

export type SchemaPrivacyMap = { ids: Map<string, string>; categories: Map<string, string> }

/** Preserve grading/evaluation relationships while replacing all names, labels, IDs and categories with request-local tokens. */
export function anonymizeSchemaRepresentation(value: unknown, privacyMap: SchemaPrivacyMap): unknown {
  const genericId = (value: string) => {
    // Domain schema identifiers are UUID-constrained. Keep tokens random and
    // request-local while preserving that structural contract.
    if (!privacyMap.ids.has(value)) privacyMap.ids.set(value, crypto.randomUUID())
    return privacyMap.ids.get(value)
  }
  const genericCategory = (value: string) => {
    if (!privacyMap.categories.has(value)) privacyMap.categories.set(value, `category_${crypto.randomUUID()}`)
    return privacyMap.categories.get(value)
  }
  const visit = (item: unknown, key = '', index = 0): unknown => {
    if (Array.isArray(item)) return item.map((entry, entryIndex) => visit(entry, key, entryIndex))
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string') {
        if (key === 'id' || /Ids?$/.test(key)) return genericId(item)
        if (key === 'name' || key === 'label' || key === 'shortCode') return `Item ${index + 1}`
        if (key === 'value' || key === 'threshold' || key === 'categories') return genericCategory(item)
        return STRUCTURAL_ENUM_VALUES[key]?.has(item) ? item : undefined
      }
      return typeof item === 'number' || typeof item === 'boolean' ? item : undefined
    }
    const source = item as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(source)) {
      const normalizedKey = normalizedSchemaKey(childKey)
      if (PRIVATE_SCHEMA_KEYS.has(normalizedKey)) {
        if (['name', 'label', 'short_code'].includes(normalizedKey)) output[childKey] = `Item ${index + 1}`
        continue
      }
      if (childKey === 'officialRecordSystem') {
        output[childKey] = 'Institutional record system'
        continue
      }
      if (childKey === 'id' || /Ids?$/.test(childKey)) {
        if (typeof child === 'string') output[childKey] = genericId(child)
        else if (Array.isArray(child) && /Ids$/.test(childKey)) output[childKey] = child.map((reference) => typeof reference === 'string' ? genericId(reference) : undefined)
        continue
      }
      if (childKey === 'categories' && Array.isArray(child)) {
        output[childKey] = child.map((category) => typeof category === 'string' ? genericCategory(category) : visit(category, childKey))
        continue
      }
      const clean = visit(child, childKey, Object.keys(output).length)
      if (clean !== undefined) output[childKey] = clean
    }
    return output
  }
  return visit(value)
}

export function anonymizeCategory(value: string, privacyMap: SchemaPrivacyMap) {
  if (!privacyMap.categories.has(value)) privacyMap.categories.set(value, `category_${crypto.randomUUID()}`)
  return privacyMap.categories.get(value)!
}

export function restoreSchemaCategory(value: unknown, privacyMap: SchemaPrivacyMap): unknown {
  if (typeof value !== 'string') return value
  for (const [original, safe] of privacyMap.categories) if (safe === value) return original
  return value
}

/** Removes free text and identifier-bearing properties from schema representations. */
export function anonymizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(anonymizeSchema).filter((item) => item !== undefined)
  if (!value || typeof value !== 'object') return typeof value === 'number' || typeof value === 'boolean' ? value : undefined
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_TEXT_KEYS.test(key)) continue
    const numericKey = /^-?\d+(?:\.\d+)?$/.test(key) && Number(key) >= -100 && Number(key) <= 100
    if (!SAFE_SCHEMA_KEYS.has(key) && !numericKey) continue
    if (typeof item === 'string') {
      if (SAFE_ENUM_KEYS.has(key) && SAFE_ENUM_VALUES.has(item.toLowerCase())) output[key] = item.toLowerCase()
      continue
    }
    const clean = anonymizeSchema(item)
    if (clean !== undefined) output[key] = clean
  }
  return output
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = numeric(value)
  return parsed !== undefined && parsed >= minimum && parsed <= maximum ? parsed : undefined
}

const ASSESSMENT_CONTEXT_DAY_LIMIT = 36500
const MILLISECONDS_PER_DAY = 86_400_000

/**
 * Project canonical assessment dates to request-local ordinal/relative context.
 * The returned objects contain no identifiers or absolute date strings; callers
 * should use the input row's id only as a private in-memory lookup key.
 */
export function buildAssessmentTemporalContext(
  rows: readonly { id: string; assessment_date?: string | null; due_at?: string | null }[],
  cutoffMs: number,
): Map<string, { sequence: number; relative_day?: number; due_in_days?: number }> {
  if (!Number.isFinite(cutoffMs)) throw new TypeError('Assessment context cutoff must be finite')
  const parsed = rows.map((row) => {
    if (!row || typeof row.id !== 'string' || !row.id) {
      throw new TypeError('Assessment context requires canonical identifiers')
    }
    if (row.assessment_date != null && typeof row.assessment_date !== 'string') {
      throw new TypeError('Assessment context contains an invalid assessment date')
    }
    const date = row.assessment_date == null || row.assessment_date === ''
      ? undefined
      : Date.parse(`${row.assessment_date}T00:00:00.000Z`)
    if (date !== undefined && !Number.isFinite(date)) throw new TypeError('Assessment context contains an invalid assessment date')
    const dueAt = typeof row.due_at === 'string' && row.due_at.length ? Date.parse(row.due_at) : undefined
    if (dueAt !== undefined && !Number.isFinite(dueAt)) throw new TypeError('Assessment context contains an invalid due date')
    return { id: row.id, date, dueAt }
  })
  const distinctDates = [...new Set(parsed.flatMap((row) => row.date === undefined ? [] : [row.date]))].sort((a, b) => a - b)
  // Undated instances tie at sequence zero; dated ranks start at one. This
  // encodes no arbitrary ordering for missing dates and keeps their time flag off.
  const rankByDate = new Map(distinctDates.map((date, rank) => [date, rank + 1]))
  const output = new Map<string, { sequence: number; relative_day?: number; due_in_days?: number }>()
  for (const row of parsed) {
    if (output.has(row.id)) throw new TypeError('Assessment context contains duplicate assessment identifiers')
    const relativeDay = row.date === undefined ? undefined : (row.date - cutoffMs) / MILLISECONDS_PER_DAY
    const dueInDays = row.dueAt === undefined ? undefined : (row.dueAt - cutoffMs) / MILLISECONDS_PER_DAY
    output.set(row.id, {
      sequence: row.date === undefined ? 0 : rankByDate.get(row.date)!,
      ...(relativeDay !== undefined && Math.abs(relativeDay) <= ASSESSMENT_CONTEXT_DAY_LIMIT ? { relative_day: relativeDay } : {}),
      ...(dueInDays !== undefined && Math.abs(dueInDays) <= ASSESSMENT_CONTEXT_DAY_LIMIT ? { due_in_days: dueInDays } : {}),
    })
  }
  return output
}

/** Keeps numeric academic features only; it never forwards arbitrary record fields or strings. */
export function anonymizeAcademicData(
  records: Record<string, unknown>,
  allowAssessmentData: boolean,
  allowAttendance: boolean,
  mapCategory?: (value: string) => string | undefined,
  mapAssessmentRef?: (value: string) => string | undefined,
  mapStructuralRef?: (value: string) => string | undefined,
  assessmentContext?: {
    version: 1
    cutoffMs: number
    resolveValue?: (source: Record<string, unknown>, assessmentId: string) => number | string | undefined
    undatedAssessmentIds?: ReadonlySet<string>
  },
) {
  const output: Record<string, unknown> = {}
  if (allowAssessmentData) {
    for (const key of ['current_standing', 'predicted_standing', 'risk_probability', 'missing_assessment_count', 'recent_scores', 'period_grades', 'component_grades', 'group_grades']) {
      const value = records[key]
      if (Array.isArray(value)) {
        const values = value.map((item) => boundedNumber(item, 0, 100)).filter((item): item is number => item !== undefined)
        if (values.length) output[key] = values
      } else {
        const limits: Record<string, [number, number]> = {
          current_standing: [0, 100], predicted_standing: [0, 100], risk_probability: [0, 1], missing_assessment_count: [0, 100000],
        }
        const [minimum, maximum] = limits[key] ?? [0, 100]
        const valueNumber = boundedNumber(value, minimum, maximum)
        if (valueNumber !== undefined) output[key] = valueNumber
      }
    }
    if (Array.isArray(records.assessment_results)) {
      output.assessment_results = records.assessment_results.map((item) => {
        if (!item || typeof item !== 'object') return null
        const source = item as Record<string, unknown>
        const safe: Record<string, number | string | null> = {}
        const maximum = boundedNumber(source.maximum_score ?? source.max_score ?? source.maximum, 0.000001, 100000)
        const score = maximum === undefined ? undefined : boundedNumber(source.score ?? source.raw_score, 0, maximum)
        const percentage = boundedNumber(source.percentage ?? source.mapped_percentage, 0, 100)
        const weight = boundedNumber(source.weight, 0, 100)
        if (score !== undefined) safe.score = score
        else if (typeof source.score === 'string' && source.score.length <= 100 && mapCategory) {
          const mapped = mapCategory(source.score)
          if (mapped !== undefined) safe.score = mapped
        }
        if (percentage !== undefined) safe.percentage = percentage
        if (maximum !== undefined) safe.maximum_score = maximum
        if (weight !== undefined) safe.weight = weight
        const assessmentId = source.assessmentRef ?? source.assessment_id
        if (typeof assessmentId === 'string' && mapAssessmentRef) {
          const reference = mapAssessmentRef(assessmentId)
          if (reference !== undefined) safe.assessment_ref = reference
        }
        if (assessmentContext?.version === 1) {
          // V1's result contract is intentionally smaller: only the opaque
          // assessment reference and raw schema-domain value reach the model.
          delete safe.score
          delete safe.percentage
          delete safe.maximum_score
          delete safe.weight
          delete safe.period_ref
          delete safe.group_ref
          delete safe.categorical_value
          const assessmentId = source.assessmentRef ?? source.assessment_id
          if (typeof assessmentId !== 'string' || !mapAssessmentRef) throw new TypeError('Assessment result has no valid reference')
          const reference = mapAssessmentRef(assessmentId)
          if (reference === undefined) throw new TypeError('Assessment result references an unknown assessment')
          safe.assessment_ref = reference
          if (!['raw_score', 'score', 'categorical_value'].some((key) => source[key] !== undefined && source[key] !== null)) {
            // Frontend inventories can include a row for every assessment,
            // with null score fields for work that has not been graded. Keep
            // reference validation, then omit the row so it remains a query
            // target. Non-null values still pass the strict domain resolver.
            return null
          }
          const rawValue = assessmentContext.resolveValue
            ? assessmentContext.resolveValue(source, assessmentId)
            : source.categorical_value ?? source.score ?? source.raw_score
          if (assessmentContext.resolveValue && typeof rawValue === 'number' && Number.isFinite(rawValue)) {
            // The callback validates the value against the canonical assessment
            // scoring mode and mapping, not client-supplied maxima.
            safe.value = rawValue
          } else if (typeof rawValue === 'number' && Number.isFinite(rawValue) && maximum !== undefined && rawValue >= 0 && rawValue <= maximum) {
            safe.value = rawValue
          } else if (typeof rawValue === 'string' && rawValue.length <= 100 && mapCategory) {
            const mapped = mapCategory(rawValue)
            if (mapped !== undefined) safe.value = mapped
          } else if (typeof rawValue === 'number' && Number.isFinite(rawValue) && maximum === undefined) {
            // The caller may already have validated a numeric mapping against
            // the canonical grading schema, where the score is not a percentage.
            safe.value = rawValue
          } else {
            throw new TypeError('Assessment result value is outside its grading domain')
          }
          const observedAtText = source.updated_at ?? source.observed_at
          let observedDay: number | null = null
          if (typeof observedAtText === 'string') {
            const observedAt = Date.parse(observedAtText)
            if (!Number.isFinite(observedAt)) throw new TypeError('Assessment result has an invalid observation time')
            observedDay = (observedAt - assessmentContext.cutoffMs) / MILLISECONDS_PER_DAY
            if (observedDay > 0) throw new TypeError('Assessment result observation is after the request cutoff')
          }
          if (assessmentContext.undatedAssessmentIds?.has(assessmentId)) observedDay = null
          else if (observedAtText == null) observedDay = 0
          safe.observed_day = observedDay
          return safe
        }
        if (typeof source.periodId === 'string' && mapStructuralRef) {
          const reference = mapStructuralRef(source.periodId)
          if (reference !== undefined) safe.period_ref = reference
        }
        if (typeof source.groupId === 'string' && mapStructuralRef) {
          const reference = mapStructuralRef(source.groupId)
          if (reference !== undefined) safe.group_ref = reference
        }
        if (typeof source.categorical_value === 'string' && source.categorical_value.length <= 100 && mapCategory) {
          const mapped = mapCategory(source.categorical_value)
          if (mapped !== undefined) safe.categorical_value = mapped
        }
        return safe
      }).filter((item) => item !== null)
    }
  }
  if (allowAttendance) {
    for (const key of ['attendance', 'attendance_rate']) {
      const value = boundedNumber(records[key], 0, 100)
      if (value !== undefined) output[key] = value
    }
  }
  return output
}

export function anonymizeEvaluationValues(definition: Record<string, unknown>, values: Record<string, unknown>, allowAssessmentData: boolean, allowAttendance: boolean, mapCategory?: (value: string) => string | undefined) {
  const output: Record<string, number | number[] | string | boolean> = {}
  const factors = Array.isArray(definition.factors) ? definition.factors as Record<string, unknown>[] : []
  for (let index = 0; index < factors.length; index++) {
    const factor = factors[index]
    const source = typeof factor.source === 'string' ? factor.source : ''
    const isAttendance = source === 'attendance' || source === 'attendance_rate'
    if (isAttendance ? !allowAttendance : !allowAssessmentData) continue
    const aggregation = typeof factor.gradingAggregation === 'string' ? factor.gradingAggregation : 'average'
    const key = source === 'grading_component' && typeof factor.gradingComponentId === 'string'
      ? `grading_component:${factor.gradingComponentId}:${aggregation}`
      : source === 'grading_group' && typeof factor.gradingGroupId === 'string'
        ? `grading_group:${factor.gradingGroupId}:${aggregation}`
        : source
    const value = values[key]
    if (Array.isArray(value)) {
      const minimum = numeric(factor.minimum) ?? Number.NEGATIVE_INFINITY
      const maximum = numeric(factor.maximum) ?? Number.POSITIVE_INFINITY
      const safeValues = value.map((item) => boundedNumber(item, minimum, maximum)).filter((item): item is number => item !== undefined)
      if (safeValues.length) output[`factor_${index + 1}`] = safeValues
    } else if (typeof value === 'string' && (factor.valueType === 'category' || ['trend', 'recent_trend', 'ai_risk_level', 'data_basis'].includes(source)) && mapCategory) {
      const mapped = mapCategory(value)
      if (mapped !== undefined) output[`factor_${index + 1}`] = mapped
    } else if (typeof value === 'boolean' && (factor.valueType === 'boolean' || source === 'prediction_available')) {
      output[`factor_${index + 1}`] = value
    } else {
      const minimum = numeric(factor.minimum) ?? Number.NEGATIVE_INFINITY
      const maximum = numeric(factor.maximum) ?? Number.POSITIVE_INFINITY
      const safeValue = boundedNumber(value, minimum, maximum)
      if (safeValue !== undefined) output[`factor_${index + 1}`] = safeValue
    }
  }
  return output
}

export function anonymizeEvaluationFactorRows(rows: unknown, allowAssessmentData: boolean, allowAttendance: boolean) {
  const output: Record<string, number | number[]> = {}
  if (!Array.isArray(rows)) return output
  rows.forEach((row: any, index: number) => {
    const source = typeof row?.source === 'string' ? row.source : ''
    const isAttendance = source === 'attendance' || source === 'attendance_rate'
    if (isAttendance ? !allowAttendance : !allowAssessmentData) return
    const bounds: Record<string, [number, number]> = {
      risk_probability: [0, 1], model_confidence: [0, 1], missing_assessment_count: [0, 100000],
      ai_factor_count: [0, 100000], prediction_age_hours: [0, 1000000],
    }
    const [minimum, maximum] = bounds[source] ?? [0, 100]
    const value = row?.value
    if (Array.isArray(value)) {
      const clean = value.map((item: unknown) => boundedNumber(item, minimum, maximum)).filter((item): item is number => item !== undefined)
      if (clean.length) output[`factor_${index + 1}`] = clean
    } else {
      const clean = boundedNumber(value, minimum, maximum)
      if (clean !== undefined) output[`factor_${index + 1}`] = clean
    }
  })
  return output
}

export function opaqueRecordRef() {
  return `record_${crypto.randomUUID()}`
}

export function shuffleForProvider<T>(items: T[]) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) {
    const random = new Uint32Array(1)
    crypto.getRandomValues(random)
    const other = random[0] % (index + 1)
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}
