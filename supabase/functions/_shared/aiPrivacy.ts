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

const STRUCTURAL_ENUM_KEYS = new Set(['type', 'source', 'mode', 'kind', 'strategy', 'aggregation', 'operator', 'comparison', 'direction', 'rounding', 'missingPolicy', 'resultType', 'inputType', 'mappingPolicy', 'periodStrategy', 'scope', 'severity', 'match', 'origin', 'unit', 'valueType', 'colorScheme', 'inputFeatures', 'outputFields', 'supportedScenarios'])
const STRUCTURAL_ENUM_VALUES = new Set([
  'number', 'number_array', 'boolean', 'category', 'percentage', 'probability', 'count', 'points', 'letter', 'pass_fail',
  'academic_record', 'derived', 'ai_prediction', 'current_standing', 'recent_scores', 'recent_score_average', 'recent_trend',
  'attendance', 'attendance_rate', 'missing_assessment_count', 'predicted_standing', 'risk_probability', 'ai_risk_level', 'trend',
  'grading_component', 'grading_group', 'average', 'highest', 'lowest', 'weighted', 'equal', 'points', 'linear', 'numeric_mapping', 'value_mapping',
  'exact', 'threshold', 'interpolate', 'assessments', 'components', 'groups', 'periods', 'period_formula', 'independent', 'cumulative', 'overall', 'per_period', 'per_group',
  'below', 'at_most', 'above', 'at_least', 'equals', 'not_equals', 'in', 'not_in', 'contains', 'not_contains', 'is_true', 'is_false',
  'all', 'any', 'priority', 'weighted', 'low', 'medium', 'high', 'passing', 'failing', 'incomplete', 'up', 'down', 'half_up', 'half_even',
  'green_to_red', 'white_to_red', 'custom', 'improving', 'stable', 'declining', 'percentage', 'fraction', 'decimal', 'round', 'floor', 'ceil',
  'minimum', 'maximum', 'latest', 'first', 'last', 'best', 'worst', 'sum', 'min', 'max', 'add', 'subtract', 'multiply', 'divide',
  'minimum_pass', 'custom', 'risk_level', 'factors', 'model_version', 'generated_at', 'assessment_score_predictions', 'evaluation_scores', 'assessment_results', 'assessment_instance_details',
])
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
    if (!privacyMap.ids.has(value)) privacyMap.ids.set(value, `ref_${crypto.randomUUID()}`)
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
        if (key === 'id' || /Id$/.test(key)) return genericId(item)
        if (key === 'name' || key === 'label' || key === 'shortCode') return `Item ${index + 1}`
        if (key === 'value' || key === 'threshold' || key === 'categories') return genericCategory(item)
        return STRUCTURAL_ENUM_KEYS.has(key) && STRUCTURAL_ENUM_VALUES.has(item.toLowerCase()) ? item.toLowerCase() : undefined
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
      if (childKey === 'id' || /Id$/.test(childKey)) {
        if (typeof child === 'string') output[childKey] = genericId(child)
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

/** Keeps numeric academic features only; it never forwards arbitrary record fields or strings. */
export function anonymizeAcademicData(records: Record<string, unknown>, allowAssessmentData: boolean, allowAttendance: boolean, mapCategory?: (value: string) => string | undefined, mapAssessmentRef?: (value: string) => string | undefined, mapStructuralRef?: (value: string) => string | undefined) {
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
        const safe: Record<string, number | string> = {}
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
