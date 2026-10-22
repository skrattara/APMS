import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { anonymizeAcademicData, anonymizeEvaluationValues, anonymizeSchemaRepresentation, buildAssessmentTemporalContext, opaqueRecordRef, restoreSchemaCategory, shuffleForProvider } from '../_shared/aiPrivacy.ts'
import { aiServiceConfigurationFromEnvironment, createAIServiceConnector, finalizeCustomServiceUsage, reserveCustomServiceUsage, safeAIServiceFailure, type AIServiceConfiguration, type AIServiceProbe, type CustomUsageClient } from '../_shared/aiService.ts'
import { persistableAIScores } from '../_shared/persistableAIScores.ts'
import defaultGradingSystem from '../_shared/defaultGradingSystem.json' with { type: 'json' }
import defaultEvaluationSystem from '../_shared/defaultEvaluationSystem.json' with { type: 'json' }
import { addRequestTrace, BoundedRequestError, BoundedResponseError, createRequestTrace, logRequestTrace, PROVIDER_RESPONSE_LIMIT_BYTES, readBodyThenAuthenticate, readBoundedResponseText, requestBoundFetch, RequestAuthorizationError, RequestDeadlineError, setRequestStage, withinRequestDeadline, type RequestTrace } from '../_shared/requestLifecycle.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Expose-Headers': 'X-APMS-Error-Code, X-APMS-Request-ID',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type PredictionInput = {
  enrollment_id: string
  evaluation_values: Record<string, unknown>
  evaluated_risk_level?: string
  records: Record<string, unknown>
}

type RequestBody = {
  class_id: string
  // These snapshots are only used to detect stale clients; the edge function
  // resolves the active definitions itself before contacting a provider.
  grading_system: Record<string, any>
  evaluation_criteria: Record<string, any>
  inputs: PredictionInput[]
}

const json = (body: unknown, status = 200, errorCode?: string) => new Response(JSON.stringify(errorCode ? { ...(body as Record<string, unknown>), code: errorCode } : body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...(errorCode ? { 'X-APMS-Error-Code': errorCode } : {}) },
})

function safeCustomProviderFailure(error: unknown, trace: RequestTrace): Response {
  const failure = safeAIServiceFailure(error)
  trace.failureCode = failure.code
  trace.upstreamStatus = failure.upstreamStatus
  const messages: Record<typeof failure.code, string> = {
    provider_authentication_failed: 'The prediction provider rejected its configured credentials',
    provider_request_rejected: 'The prediction provider rejected the prediction request',
    provider_busy: 'The prediction provider is busy; try again later',
    provider_unavailable: 'The prediction provider is unavailable',
    provider_connection_failed: 'The prediction provider could not be reached',
    provider_timeout: 'The prediction provider timed out',
    invalid_response: 'The prediction provider returned an invalid response',
    request_too_large: 'The anonymized custom-model request exceeds the service request limit',
  }
  return json({ error: messages[failure.code], ...(failure.upstreamStatus ? { upstream_status: failure.upstreamStatus } : {}) }, failure.status, failure.code)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readGeminiText(payload: any): string {
  return payload?.candidates?.[0]?.content?.parts
    ?.filter((part: any) => typeof part?.text === 'string')
    ?.map((part: any) => part.text)
    ?.join('') ?? ''
}

function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, ''))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function factorFor(definition: Record<string, any>, source: string) {
  return (definition.factors as any[]).find((factor) => factor.source === source)
}

function validatePrediction(result: any, evaluation: Record<string, any>, dataBasis: string, outputFields: Set<string>, privacyMap: { ids: Map<string, string>; categories: Map<string, string> }) {
  if (result?.assessment_score_predictions != null) return 'Assessment score predictions must use the assessment_predictions output field.'
  const allowedKeys = new Set(['record_ref', 'record_id', 'predicted_standing', 'trend', ...(outputFields.has('risk_probability') ? ['risk_probability'] : []), ...(outputFields.has('risk_level') ? ['ai_risk_level', 'risk_level'] : []), ...(outputFields.has('factors') ? ['factors'] : []), ...(outputFields.has('evaluation_scores') ? ['evaluation_scores'] : []), ...(outputFields.has('assessment_score_predictions') ? ['assessment_predictions'] : [])])
  if (Object.keys(result ?? {}).some((key) => !allowedKeys.has(key))) return 'The provider returned fields outside the active output contract.'
  if (!isFiniteInRange(result?.predicted_standing, 0, 100)) return 'Predicted standing must be a number from 0 to 100.'
  const standingFactor = factorFor(evaluation, 'predicted_standing')
  if (standingFactor && !isFiniteInRange(result.predicted_standing, standingFactor.minimum ?? 0, standingFactor.maximum ?? 100)) return 'Predicted standing is outside the applied evaluation factor range.'
  if (result.risk_probability !== null && result.risk_probability !== undefined) {
    if (!outputFields.has('risk_probability')) return 'Risk probability is not an allowed output for the applied evaluation criteria.'
    if (!isFiniteInRange(result.risk_probability, 0, 1)) return 'Risk probability must be a number from 0 to 1.'
    const probabilityFactor = factorFor(evaluation, 'risk_probability')
    if (probabilityFactor && !isFiniteInRange(result.risk_probability, probabilityFactor.minimum ?? 0, probabilityFactor.maximum ?? 1)) return 'Risk probability is outside the applied evaluation factor range.'
  }
  if (outputFields.has('risk_probability') && result.risk_probability == null) return 'The applied prediction output contract requires risk probability.'
  if (!['improving', 'stable', 'declining'].includes(result.trend)) return 'Trend is not an allowed value.'
  const trendFactor = factorFor(evaluation, 'trend') ?? factorFor(evaluation, 'recent_trend')
  if (trendFactor?.categories?.length && !trendFactor.categories.includes(result.trend)) return 'Trend is not an allowed evaluation category.'
  const riskLevelFactor = factorFor(evaluation, 'ai_risk_level')
  if (result.ai_risk_level != null && (!outputFields.has('risk_level') || !riskLevelFactor?.categories?.includes(result.ai_risk_level))) return 'AI risk level is not an allowed category in the applied evaluation criteria.'
  if (outputFields.has('factors') && (!Array.isArray(result.factors) || result.factors.length > 8 || result.factors.some((item: unknown) => typeof item !== 'string' || item.length > 500))) return 'Prediction explanations must be a list of at most eight short text items.'
  if (!outputFields.has('factors') && result.factors != null) return 'Prediction explanations are not an allowed output for the applied evaluation criteria.'
  const scoreValidation = decodeAndValidateEvaluationScores(result.evaluation_scores, evaluation, result, outputFields, privacyMap)
  if (scoreValidation.error) return scoreValidation.error
  result.evaluation_scores = scoreValidation.values
  const generatedValues: Record<string, unknown> = {
    predicted_standing: result.predicted_standing,
    risk_probability: result.risk_probability ?? null,
    // The provider contract has no independent confidence score; keep this
    // reserved factor unavailable instead of mislabeling risk probability.
    model_confidence: null,
    prediction_available: true,
    trend: result.trend,
    recent_trend: result.trend,
    ai_risk_level: result.ai_risk_level,
    prediction_age_hours: 0,
    ai_factor_count: Array.isArray(result.factors) ? result.factors.length : 0,
    data_basis: dataBasis,
    ...Object.fromEntries(Object.entries(result.evaluation_scores ?? {}).flatMap(([factorId, value]) => {
      const factor = (evaluation.factors as any[]).find((item) => item.id === factorId)
      return factor ? [[factor.source, value]] : []
    })),
  }
  for (const factor of evaluation.factors as any[]) {
    if (factor.aiGenerated !== true && factor.origin !== 'ai_prediction') continue
    const value = generatedValues[factor.source]
    if (value === undefined || value === null) {
      if (factor.required || factor.missingValuePolicy === 'unavailable') return `The active evaluation criteria require an AI value for ${factor.source}.`
      continue
    }
    const category = factor.valueType === 'category' || ['trend', 'recent_trend', 'ai_risk_level', 'data_basis'].includes(factor.source)
    const boolean = factor.valueType === 'boolean' || factor.source === 'prediction_available'
    if (category && (typeof value !== 'string' || (factor.categories?.length && !factor.categories.includes(value)))) return `The AI value for ${factor.source} is not an allowed category.`
    if (boolean && typeof value !== 'boolean') return `The AI value for ${factor.source} must be boolean.`
    if (factor.valueType === 'number_array' && (!Array.isArray(value) || value.length > 1000 || value.some((item: unknown) => typeof item !== 'number' || !Number.isFinite(item) || (factor.minimum != null && item < factor.minimum) || (factor.maximum != null && item > factor.maximum)))) return `The AI values for ${factor.source} are outside the allowed range.`
    if (!category && !boolean && factor.valueType !== 'number_array' && (typeof value !== 'number' || !Number.isFinite(value) || (factor.minimum != null && value < factor.minimum) || (factor.maximum != null && value > factor.maximum))) return `The AI value for ${factor.source} is outside its allowed numeric range.`
  }
  return null
}

function decodeAndValidateEvaluationScores(raw: unknown, evaluation: Record<string, any>, result: any, outputFields: Set<string>, privacyMap: { ids: Map<string, string>; categories: Map<string, string> }) {
  const empty = { values: {} as Record<string, unknown>, error: null as string | null }
  if (!outputFields.has('evaluation_scores')) return raw == null ? empty : { ...empty, error: 'Evaluation scores are not an allowed output for the applied evaluation criteria.' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...empty, error: 'Evaluation scores must be an object keyed by applied factor reference.' }
  const sourcesWithBuiltInOutput = new Set(['predicted_standing', ...(outputFields.has('risk_probability') ? ['risk_probability', 'model_confidence'] : []), 'trend', 'recent_trend', ...(outputFields.has('risk_level') ? ['ai_risk_level'] : []), 'prediction_available', 'prediction_age_hours', ...(outputFields.has('factors') ? ['ai_factor_count'] : [])])
  const values = raw as Record<string, unknown>
  const accepted: Record<string, unknown> = {}
  const originalId = new Map([...privacyMap.ids.entries()].map(([original, safe]) => [safe, original]))
  for (const [safeFactorId, encoded] of Object.entries(values)) {
    const factorId = originalId.get(safeFactorId)
    if (factorId === undefined) return { ...empty, error: 'Evaluation scores may only contain active AI-generated factor references.' }
    const factor = (evaluation.factors as any[]).find((item) => item.id === factorId)
    if (!factor || (factor.aiGenerated !== true && factor.origin !== 'ai_prediction')) return { ...empty, error: 'Evaluation scores may only contain active AI-generated factor references.' }
    if (sourcesWithBuiltInOutput.has(factor.source)) return { ...empty, error: `The factor ${factor.source} is already provided by the prediction fields and cannot be overridden.` }
    if (encoded === null) {
      if (factor.required || factor.missingValuePolicy === 'unavailable') return { ...empty, error: `The required evaluation score for ${factor.source} is missing.` }
      continue
    }
    let value: unknown = encoded
    if (typeof value === 'string') value = restoreSchemaCategory(value, privacyMap)
    const valueType = factor.valueType ?? (['trend', 'recent_trend', 'ai_risk_level', 'data_basis'].includes(factor.source) ? 'category' : 'number')
    if (valueType === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (factor.minimum != null && value < factor.minimum) || (factor.maximum != null && value > factor.maximum)) return { ...empty, error: `The evaluation score for ${factor.source} is outside its allowed numeric range.` }
    } else if (valueType === 'category') {
      if (typeof value !== 'string' || (factor.categories?.length && !factor.categories.includes(value))) return { ...empty, error: `The evaluation score for ${factor.source} is not an allowed category.` }
    } else if (valueType === 'boolean') {
      if (typeof value !== 'boolean') return { ...empty, error: `The evaluation score for ${factor.source} must be boolean.` }
    } else if (!Array.isArray(value) || value.length > 1000 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || (factor.minimum != null && item < factor.minimum) || (factor.maximum != null && item > factor.maximum))) {
      return { ...empty, error: `The evaluation scores for ${factor.source} are invalid.` }
    }
    accepted[factorId] = value
  }
  for (const factor of evaluation.factors as any[]) {
    if (factor.aiGenerated !== true && factor.origin !== 'ai_prediction') continue
    if (!sourcesWithBuiltInOutput.has(factor.source) && (factor.required || factor.missingValuePolicy === 'unavailable') && accepted[factor.id] === undefined) return { ...empty, error: `The required evaluation score for ${factor.source} is missing.` }
  }
  return { values: accepted, error: null }
}

function validateAssessmentPredictions(raw: unknown, instances: Record<string, any>[], outputFields: Set<string>, privacyMap: { ids: Map<string, string>; categories: Map<string, string> }, existingAssessmentRefs = new Set<string>()) {
  const empty = { values: [] as Record<string, unknown>[], error: null as string | null }
  if (!outputFields.has('assessment_score_predictions')) return raw == null ? empty : { ...empty, error: 'Assessment predictions are not allowed by the applied evaluation criteria.' }
  if (!Array.isArray(raw)) return { ...empty, error: 'Assessment predictions must be a list.' }
  const byRef = new Map(instances.map((instance) => [instance.assessment_ref, instance]))
  const seen = new Set<string>()
  const values: Record<string, unknown>[] = []
  for (const prediction of raw) {
    if (Object.keys(prediction ?? {}).some((key) => !['assessment_ref', 'result', 'kind', 'numeric_value', 'categorical_value', 'maximum', 'confidence', 'evidence'].includes(key))) return { ...empty, error: 'An assessment prediction contains fields outside the supported contract.' }
    const ref = prediction?.assessment_ref
    const instance = typeof ref === 'string' ? byRef.get(ref) : undefined
    if (!instance || seen.has(ref)) return { ...empty, error: 'An assessment prediction references an unknown or repeated assessment instance.' }
    if (existingAssessmentRefs.has(ref)) return { ...empty, error: 'The provider predicted a score for an assessment that already has a recorded result.' }
    seen.add(ref)
    const scoring = instance.scoring
    const hasNestedResult = prediction.result != null
    const hasFlatEncoding = prediction.kind != null || prediction.numeric_value != null || prediction.categorical_value != null || prediction.maximum != null
    if (hasNestedResult && hasFlatEncoding) return { ...empty, error: `Assessment ${ref} mixes result encodings.` }
    const result = prediction.result ?? (prediction.kind === 'numeric'
      ? { kind: 'numeric', value: prediction.numeric_value, maximum: prediction.maximum }
      : prediction.kind === 'categorical'
        ? { kind: 'categorical', value: prediction.categorical_value }
        : null)
    if (!result || typeof result !== 'object') return { ...empty, error: `Assessment ${ref} has no valid result.` }
    if (Object.keys(result).some((key) => !['kind', 'value', 'maximum'].includes(key))) return { ...empty, error: `Assessment ${ref} contains fields outside the result contract.` }
    if (scoring.mode === 'value_mapping') {
      if (prediction.kind === 'numeric' || prediction.numeric_value != null || prediction.maximum != null) return { ...empty, error: `Assessment ${ref} contains numeric fields for categorical scoring.` }
      const value = restoreSchemaCategory(result.value, privacyMap)
      const allowed = (scoring.mapping ?? []).map((item: any) => restoreSchemaCategory(item.value, privacyMap))
      if (result.kind !== 'categorical' || typeof value !== 'string' || !allowed.includes(value)) return { ...empty, error: `Assessment ${ref} must use a category allowed by the active grading system.` }
      result.value = value
    } else {
      if (prediction.kind === 'categorical' || prediction.categorical_value != null) return { ...empty, error: `Assessment ${ref} contains categorical fields for numeric scoring.` }
      const maximum = instance.maximum_score
      if (result.kind !== 'numeric' || typeof result.value !== 'number' || !Number.isFinite(result.value) || result.value < 0 || result.value > maximum || result.maximum !== maximum) return { ...empty, error: `Assessment ${ref} must use a numeric score within its instance maximum.` }
      if (scoring.mode === 'numeric_mapping') {
        const allowed = (scoring.mapping ?? []).map((item: any) => item.value)
        if (!allowed.includes(result.value)) return { ...empty, error: `Assessment ${ref} must use a numeric score allowed by the active grading system.` }
      }
    }
    if (prediction.confidence != null && (typeof prediction.confidence !== 'number' || !Number.isFinite(prediction.confidence) || prediction.confidence < 0 || prediction.confidence > 1)) return { ...empty, error: `Assessment ${ref} confidence must be from 0 to 1.` }
    if (prediction.evidence != null && (!Array.isArray(prediction.evidence) || prediction.evidence.length > 8 || prediction.evidence.some((item: unknown) => typeof item !== 'string' || item.length > 500))) return { ...empty, error: `Assessment ${ref} evidence is invalid.` }
    values.push({ ...prediction, result })
  }
  for (const instance of instances) if (!instance.optional && !existingAssessmentRefs.has(instance.assessment_ref) && !seen.has(instance.assessment_ref)) return { ...empty, error: `A result prediction is missing for required assessment ${instance.assessment_ref}.` }
  return { values, error: null }
}

function validateAssessmentInstanceCounts(grading: Record<string, any>, instances: Record<string, any>[], mapRef: (value: string) => string | undefined, inventory: 'complete' | 'partial' = 'complete') {
  for (const component of grading.components ?? []) {
    const definition = component.assessmentDefinition
    if (!definition?.count) continue
    const typeRef = mapRef(definition.typeId)
    const matching = instances.filter((instance) => instance.assessment_type_ref === typeRef)
    const violates = (scope: any[]) => (inventory === 'complete' && definition.count.min != null && scope.length < definition.count.min) || (definition.count.max != null && scope.length > definition.count.max)
    const scopeType = definition.count.scope?.type ?? 'overall'
    if (scopeType === 'overall' && violates(matching)) return `Assessment count for ${definition.typeId} violates the active overall count constraint.`
    if (scopeType === 'per_period') for (const period of grading.periods ?? []) {
      const periodRef = mapRef(period.id)
      if (violates(matching.filter((instance) => instance.period_ref === periodRef))) return `Assessment count for ${definition.typeId} violates an active period count constraint.`
    }
    if (scopeType === 'per_group') for (const group of grading.groups ?? []) {
      if (group.typeId !== definition.count.scope.groupTypeId) continue
      const groupRef = mapRef(group.id)
      if (violates(matching.filter((instance) => instance.group_ref === groupRef))) return `Assessment count for ${definition.typeId} violates an active group count constraint.`
    }
  }
  return null
}

function openAiStrictSchema(geminiSchema: Record<string, any>) {
  const convert = (value: Record<string, any>): Record<string, any> => {
    const typeMap: Record<string, string> = { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object' }
    if (value.type === 'OBJECT') {
      const properties = Object.fromEntries(Object.entries(value.properties ?? {}).map(([key, child]) => [key, convert(child as Record<string, any>)]))
      const required = Object.keys(properties)
      const originallyRequired = new Set<string>(value.required ?? [])
      for (const key of required) if (!originallyRequired.has(key)) properties[key] = { anyOf: [properties[key], { type: 'null' }] }
      return { type: 'object', properties, required, additionalProperties: false }
    }
    if (value.type === 'ARRAY') return { type: 'array', items: convert(value.items) }
    return { type: typeMap[value.type] ?? value.type?.toLowerCase(), ...(value.enum ? { enum: value.enum } : {}), ...(value.description ? { description: value.description } : {}) }
  }
  return {
    type: 'object',
    properties: { predictions: { type: 'array', items: convert(geminiSchema.items) } },
    required: ['predictions'],
    additionalProperties: false,
  }
}

async function loadAppliedDefinitions(adminClient: any, userClient: any, classId: string, facultyId: string) {
  const [criteriaResult, classResult] = await Promise.all([
    adminClient.from('criteria_sets').select('grading_system_id,grading_system_definition').eq('class_record_id', classId).eq('status', 'active').order('version', { ascending: false }).limit(1).maybeSingle(),
    userClient.from('class_records').select('department_id').eq('id', classId).maybeSingle(),
  ])
  if (criteriaResult.error || classResult.error || !classResult.data) throw new Error('Applied class schemas could not be resolved.')

  const criteria = criteriaResult.data as any
  let grading = criteria?.grading_system_definition as Record<string, any> | null
  if (!grading && criteria?.grading_system_id) {
    const { data } = await adminClient.from('grading_systems').select('definition').eq('id', criteria.grading_system_id).maybeSingle()
    grading = data?.definition as Record<string, any> | null
  }
  if (!grading) {
    const { data } = await adminClient.from('system_settings').select('value').eq('key', 'grading.default_system_definition').maybeSingle()
    grading = data?.value as Record<string, any> | null
  }
  grading ??= defaultGradingSystem as Record<string, any>

  const [facultyResult, assignmentResult, legacyResult] = await Promise.all([
    adminClient.from('faculty_class_evaluation_systems').select('definition').eq('class_record_id', classId).eq('faculty_user_id', facultyId).maybeSingle(),
    adminClient.from('class_evaluation_criteria').select('evaluation_criteria_systems(definition)').eq('class_record_id', classId).maybeSingle(),
    adminClient.from('evaluation_systems').select('definition').eq('department_id', classResult.data.department_id).maybeSingle(),
  ])
  const related = (assignmentResult.data as any)?.evaluation_criteria_systems
  let evaluation = facultyResult.data?.definition ?? related?.definition ?? legacyResult.data?.definition ?? defaultEvaluationSystem
  if (Array.isArray(evaluation?.factors)) {
    const retiredIds = new Set(evaluation.factors.filter((factor: any) => factor.source === 'mastery').map((factor: any) => factor.id))
    if (retiredIds.size) evaluation = {
      ...evaluation,
      factors: evaluation.factors.filter((factor: any) => !retiredIds.has(factor.id)),
      levels: evaluation.levels.map((level: any) => ({ ...level, rules: level.rules.filter((rule: any) => !retiredIds.has(rule.factorId)) })),
    }
  }
  if (facultyResult.error || assignmentResult.error || legacyResult.error) throw new Error('Applied evaluation criteria could not be resolved.')
  if (!grading || !Array.isArray(grading.components) || !grading.finalResult || !Array.isArray(evaluation?.factors) || !Array.isArray(evaluation?.levels)) {
    throw new Error('A valid active grading system and evaluation criteria must be applied before predictions can run.')
  }
  return { grading, evaluation }
}

async function handlePredictionRequest(request: Request, trace: RequestTrace): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Reject oversized bodies before auth or database network work. The caller
  // still has to provide a syntactically valid bearer header.
  let requestContext: { authorization: string; body: unknown; authentication: { userClient: any; caller: any; callerError: any } }
  try {
    requestContext = await readBodyThenAuthenticate(request, 1_000_000, trace, async (token, authorization) => {
      const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
        auth: { persistSession: false },
        global: { headers: { Authorization: authorization }, fetch: requestBoundFetch(trace) },
      })
      const { data: caller, error: callerError } = await userClient.auth.getUser(token)
      return { userClient, caller, callerError }
    })
  }
  catch (error) {
    if (error instanceof RequestAuthorizationError) return json({ error: 'Authentication required' }, 401)
    if (error instanceof BoundedRequestError && error.tooLarge) return json({ error: 'Prediction request exceeds the 1 MB limit' }, 413, 'request_too_large')
    if (error instanceof RequestDeadlineError) throw error
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const parsedBody = requestContext.body
  if (!isObjectRecord(parsedBody)) return json({ error: 'Invalid prediction request' }, 400)
  const body = parsedBody as unknown as RequestBody
  trace.recordCount = Array.isArray(body.inputs) ? body.inputs.length : undefined
  const { userClient, caller, callerError } = requestContext.authentication
  if (callerError || !caller.user) return json({ error: 'Invalid session' }, 401)
  if (typeof body.class_id !== 'string' || !body.class_id.trim() || !isObjectRecord(body.grading_system) || !isObjectRecord(body.evaluation_criteria) || !Array.isArray(body.inputs) || !body.inputs.length) return json({ error: 'Class, schema snapshots, and at least one student record are required' }, 400)
  if (body.inputs.length > 100) return json({ error: 'A maximum of 100 students can be predicted per request' }, 400)
  if (body.inputs.some((item) => !isObjectRecord(item) || typeof item.enrollment_id !== 'string' || !item.enrollment_id.trim() || !isObjectRecord(item.evaluation_values) || !isObjectRecord(item.records))) return json({ error: 'Each prediction needs an enrollment, schema-derived factor values, and student record context' }, 400)
  if (new Set(body.inputs.map((item) => item.enrollment_id)).size !== body.inputs.length) return json({ error: 'Each enrollment may appear only once in a prediction request' }, 400)

  setRequestStage(trace, 'database_authorization')
  const { error: permissionError } = await userClient.rpc('faculty_assert_ai_access', { p_class_record_id: body.class_id, p_feature: 'predictions' })
  if (permissionError) return json({ error: 'You are not authorized to run predictions for this class' }, 403)

  // RLS confirms class access; this second check prevents requesting predictions for another class's enrollment.
  const { data: classRecord, error: classError } = await userClient.from('class_records').select('id').eq('id', body.class_id).eq('status', 'active').maybeSingle()
  if (classError || !classRecord) return json({ error: 'You do not have access to this class' }, 403)
  const enrollmentIds = [...new Set(body.inputs.map((input) => input.enrollment_id))]
  const { data: enrollments, error: enrollmentError } = await userClient.from('enrollments').select('id').eq('class_record_id', body.class_id).eq('status', 'active').in('id', enrollmentIds)
  if (enrollmentError || (enrollments?.length ?? 0) !== enrollmentIds.length) return json({ error: 'One or more students are outside this class' }, 403)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) return json({ error: 'AI privacy controls are unavailable' }, 503)
  const adminClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey, { auth: { persistSession: false }, global: { fetch: requestBoundFetch(trace) } })
  setRequestStage(trace, 'database_context')
  let applied: { grading: Record<string, any>; evaluation: Record<string, any> }
  try { applied = await loadAppliedDefinitions(adminClient, userClient, body.class_id, caller.user.id) }
  catch (error) { return json({ error: error instanceof Error ? error.message : 'Applied class schemas could not be resolved' }, 409) }
  if (stableJson(body.grading_system) !== stableJson(applied.grading) || stableJson(body.evaluation_criteria) !== stableJson(applied.evaluation)) {
    return json({ error: 'The applied grading or evaluation schema changed. Refresh the class and try again.' }, 409, 'applied_schema_changed')
  }
  const gradingSystem = applied.grading
  const evaluationCriteria = applied.evaluation
  const allowedSeverity = new Set(['low', 'medium', 'high', 'unavailable', ...evaluationCriteria.levels.map((level: any) => level.severity)])
  if (body.inputs.some((item) => !allowedSeverity.has(String(item.evaluated_risk_level)))) return json({ error: 'A supplied evaluation result does not match the applied evaluation criteria.' }, 400)
  const aiConfig = evaluationCriteria.ai
  if (!aiConfig || aiConfig.enabled !== true) return json({ error: 'AI prediction is disabled in the applied evaluation criteria' }, 403)
  const supportedScenarios = aiConfig.supportedScenarios ?? []
  if (!supportedScenarios.includes('stable')) return json({ error: 'The applied evaluation criteria do not allow the current prediction scenario' }, 409)
  const inputFeatures = new Set<string>((Array.isArray(aiConfig.inputFeatures) ? aiConfig.inputFeatures : []).filter((feature: unknown): feature is string => typeof feature === 'string'))
  const outputFields = new Set<string>((Array.isArray(aiConfig.outputFields) ? aiConfig.outputFields : []).filter((field: unknown): field is string => typeof field === 'string'))
  if (!inputFeatures.size || !outputFields.has('predicted_standing') || !outputFields.has('trend')) return json({ error: 'The applied evaluation criteria do not define the inputs and outputs required for this prediction task' }, 409)
  if (inputFeatures.has('assessment_results') && !inputFeatures.has('assessment_instance_details')) return json({ error: 'The applied evaluation criteria must include assessment instance details whenever assessment results are shared' }, 409)
  if (outputFields.has('assessment_score_predictions') && (!inputFeatures.has('assessment_results') || !inputFeatures.has('assessment_instance_details'))) return json({ error: 'Assessment score predictions require the applied criteria to include both existing assessment results and assessment instance details as AI inputs.' }, 409)
  const { data: settingRows, error: settingsError } = await adminClient.from('system_settings').select('key,value').in('key', ['ai.enabled', 'ai.assessment_data.enabled', 'ai.attendance_data.enabled'])
  if (settingsError) return json({ error: 'AI privacy controls are unavailable' }, 503)
  const settings = new Map((settingRows ?? []).map((row: any) => [row.key, row.value]))
  const enabled = (key: string) => settings.get(key) === true || settings.get(key) === 'true'
  if (!enabled('ai.enabled')) return json({ error: 'AI features are disabled by the System Administrator' }, 403)
  const allowAssessmentData = enabled('ai.assessment_data.enabled')
  const allowAttendance = enabled('ai.attendance_data.enabled')
  if (!allowAssessmentData) return json({ error: 'AI predictions require System Admin approval to share anonymous assessment data' }, 403)

  const saveRun = async (provider: string, model: string, modelVersion: string, dataBasis: string, predictions: any[]) => {
    const modelName = `${provider}:${model}`
    const inputSnapshot = {
      advisory_only: true,
      record_count: body.inputs.length,
      data_basis: dataBasis,
      ai_provenance: { provider, model, model_version: modelVersion, data_basis: dataBasis, recorded_at: new Date().toISOString() },
    }
    const { data: runId, error: saveError } = await userClient.rpc('faculty_save_prediction_run', {
      p_class_record_id: body.class_id,
      p_model_name: modelName,
      p_model_version: modelVersion,
      p_input_snapshot: inputSnapshot,
      p_predictions: predictions.map((prediction) => {
        const input = body.inputs.find((item) => item.enrollment_id === prediction.enrollment_id)
        return {
          enrollment_id: prediction.enrollment_id,
          predicted_score: prediction.predicted_standing,
          trend: prediction.trend,
          risk_level: input?.evaluated_risk_level,
          confidence: prediction.risk_probability,
          factors: prediction.factors,
          data_basis: prediction.data_basis,
          // Keep the legacy deterministic risk_level snapshot intact. The
          // independently validated model category is saved under the active
          // AI factor ID so a refresh cannot mistake the snapshot for model output.
          evaluation_scores: persistableAIScores(prediction, evaluationCriteria.factors, outputFields),
          assessment_predictions: (prediction.assessment_predictions ?? []).map((item: any) => ({ assessment_id: item.assessment_id, result: item.result, confidence: item.confidence, evidence: item.evidence })),
        }
      }),
    })
    if (saveError || typeof runId !== 'string') throw new Error('Validated predictions could not be saved under the signed-in Faculty session.')
    const { data: modelVersionRow, error: modelError } = await adminClient.from('model_versions').update({ provider }).eq('name', modelName).eq('version', modelVersion).select('id').maybeSingle()
    if (modelError || !modelVersionRow) throw new Error('AI model provenance could not be recorded.')
    const { error: snapshotError } = await adminClient.from('prediction_runs').update({ input_snapshot: inputSnapshot }).eq('id', runId)
    if (snapshotError) throw new Error('AI provider provenance could not be recorded for the saved prediction run.')
    return runId as string
  }

  const schemaPrivacyMap = { ids: new Map<string, string>(), categories: new Map<string, string>() }
  const safeGrading = anonymizeSchemaRepresentation(gradingSystem, schemaPrivacyMap)
  const safeEvaluation = anonymizeSchemaRepresentation(evaluationCriteria, schemaPrivacyMap)
  const mapKnownCategory = (value: string) => schemaPrivacyMap.categories.get(value)
  const mapKnownStructuralRef = (value: string) => schemaPrivacyMap.ids.get(value)
  const assessmentRefs = new Map<string, string>()
  const assessmentIdsByRef = new Map<string, string>()
  const assessmentContextCutoffMs = Date.now()
  let assessmentRowsForContext: any[] = []
  const assessmentScoringById = new Map<string, { mode: string; maximum: number; mapping: { value: unknown; percentage: number }[] }>()
  let safeAssessmentInstances: Record<string, unknown>[] = []
  if (inputFeatures.has('assessment_results') || inputFeatures.has('assessment_instance_details')) {
    const { data: assessmentRows, error: assessmentError } = await adminClient.from('assessments')
      .select('id,type,component_key,maximum_score,grading_type_id,grading_group_id,grading_period_id,grading_instance_weight,optional,assessment_date,due_at')
      .eq('class_record_id', body.class_id).neq('status', 'archived')
    if (assessmentError) return json({ error: 'Assessment instance context could not be verified' }, 503)
    assessmentRowsForContext = assessmentRows ?? []
    const builtinAliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo', 'start of class': 'soc', "let's practice": 'lp', reflection_work: 'tb', 'wrap-up quiz': 'wuq', project: 'fo', soc: 'soc', lp: 'lp', tb: 'tb', wuq: 'wuq', cig: 'cig', fo: 'fo' }
    const resolveType = (value: unknown) => typeof value === 'string' ? value : ''
    const resolveDefinition = (row: any) => {
      const candidates = [row.grading_type_id, row.component_key, row.type].map(resolveType)
      return gradingSystem.components.find((component: any) => candidates.some((candidate) => candidate && (component.assessmentDefinition?.typeId === candidate || (builtinAliases[candidate.toLowerCase()] ?? candidate.toLowerCase()) === (builtinAliases[component.assessmentDefinition?.typeId?.toLowerCase()] ?? component.assessmentDefinition?.typeId?.toLowerCase()))))
    }
    for (const row of assessmentRows ?? []) {
      const component = resolveDefinition(row)
      const maximum = Number(row.maximum_score)
      if (!component?.assessmentDefinition || !Number.isFinite(maximum) || maximum <= 0 || maximum > 100000) return json({ error: 'An assessment instance does not conform to the active grading-system definition' }, 409)
      const countScope = component.assessmentDefinition.count?.scope
      if (countScope?.type === 'per_period' && typeof row.grading_period_id !== 'string') return json({ error: 'An assessment instance needs a grading period required by the active count constraint' }, 409, 'assessment_count_constraint')
      if (countScope?.type === 'per_group') {
        const scopedGroup = typeof row.grading_group_id === 'string' ? gradingSystem.groups?.find((group: any) => group.id === row.grading_group_id) : undefined
        if (!scopedGroup || scopedGroup.typeId !== countScope.groupTypeId) return json({ error: 'An assessment instance needs a grading group of the type required by the active count constraint' }, 409, 'assessment_count_constraint')
      }
      const assessmentRef = opaqueRecordRef().replace(/^record_/, 'assessment_')
      assessmentRefs.set(row.id, assessmentRef)
      assessmentIdsByRef.set(assessmentRef, row.id)
      if (!inputFeatures.has('assessment_instance_details') && !inputFeatures.has('assessment_results')) continue
      const scoring = component.assessmentDefinition.scoring
      assessmentScoringById.set(row.id, {
        mode: scoring.mode,
        maximum,
        mapping: Array.isArray(scoring.mapping) ? scoring.mapping.map((item: any) => ({ value: item.value, percentage: item.percentage })) : [],
      })
      const safeScoring = scoring.mode === 'linear'
        ? { mode: 'linear', maximum_score: maximum }
        : { mode: scoring.mode, mapping: scoring.mapping.map((item: any) => ({ value: typeof item.value === 'string' ? mapKnownCategory(item.value) : item.value, percentage: item.percentage })) }
      const safeInstance: Record<string, unknown> = {
        assessment_ref: assessmentRef,
        assessment_type_ref: mapKnownStructuralRef(component.assessmentDefinition.typeId),
        maximum_score: maximum,
        scoring: safeScoring,
        optional: Boolean(row.optional),
      }
      const periodRef = typeof row.grading_period_id === 'string' ? mapKnownStructuralRef(row.grading_period_id) : undefined
      const groupRef = typeof row.grading_group_id === 'string' ? mapKnownStructuralRef(row.grading_group_id) : undefined
      if ((row.grading_period_id && !periodRef) || (row.grading_group_id && !groupRef)) return json({ error: 'An assessment instance references a period or group outside the active grading system' }, 409)
      if (row.grading_period_id && row.grading_group_id) {
        const period = gradingSystem.periods?.find((item: any) => item.id === row.grading_period_id)
        const group = gradingSystem.groups?.find((item: any) => item.id === row.grading_group_id)
        if (Array.isArray(period?.groupIds)) {
          const ancestors = new Set<string>([group?.id].filter(Boolean))
          let parent = group
          while (parent?.parentGroupId && !ancestors.has(parent.parentGroupId)) {
            ancestors.add(parent.parentGroupId)
            parent = gradingSystem.groups?.find((item: any) => item.id === parent.parentGroupId)
          }
          if (!period || !group || !period.groupIds.some((id: string) => ancestors.has(id))) return json({ error: 'An assessment instance group does not belong to its assigned grading period' }, 409)
        }
      }
      if (periodRef) safeInstance.period_ref = periodRef
      if (groupRef) safeInstance.group_ref = groupRef
      if (row.grading_instance_weight != null) {
        const weight = Number(row.grading_instance_weight)
        if (!Number.isFinite(weight) || weight < 0) return json({ error: 'An assessment instance has an invalid grading weight' }, 409)
        safeInstance.weight = weight
      }
      if (component.assessmentDefinition.aggregation?.mode === 'weighted' && row.grading_instance_weight == null) return json({ error: 'A weighted assessment instance is missing its required schema weight' }, 409)
      safeAssessmentInstances.push(safeInstance)
    }
  }
  const allowedRecord: Record<string, unknown> = {}
  for (const feature of inputFeatures) {
    if (feature === 'current_standing') allowedRecord.current_standing = undefined
    if (feature === 'recent_scores') allowedRecord.recent_scores = undefined
    if (feature === 'missing_assessment_count') allowedRecord.missing_assessment_count = undefined
    if (feature === 'attendance_rate' && allowAttendance) allowedRecord.attendance_rate = undefined
    if (feature === 'assessment_results' && allowAssessmentData) allowedRecord.assessment_results = undefined
  }
  const safeInputs = shuffleForProvider(body.inputs.map((input, originalIndex) => ({
    original_index: originalIndex,
    record_ref: opaqueRecordRef(),
    factor_values: anonymizeEvaluationValues({ ...evaluationCriteria, factors: evaluationCriteria.factors.filter((factor: any) => inputFeatures.has(factor.source)) }, input.evaluation_values, allowAssessmentData, allowAttendance, mapKnownCategory),
    records: anonymizeAcademicData(Object.fromEntries(Object.keys(allowedRecord).map((key) => [key, key === 'recent_scores' ? input.records.recent_scores ?? input.records.recent_assessment_percentages : input.records[key]])), allowAssessmentData, allowAttendance, mapKnownCategory, (id) => assessmentRefs.get(id), mapKnownStructuralRef),
  })))
  const providerInput: Record<string, unknown> = { grading_system: safeGrading, evaluation_criteria: safeEvaluation, inputs: safeInputs.map(({ record_ref, factor_values, records }) => ({ record_ref, factor_values, records })) }
  if (inputFeatures.has('assessment_instance_details')) providerInput.assessment_instances = safeAssessmentInstances
  if (outputFields.has('assessment_score_predictions') && !allowAssessmentData) return json({ error: 'Assessment score predictions require System Admin approval to share anonymous assessment data.' }, 403)
  if (outputFields.has('assessment_score_predictions') && safeAssessmentInstances.length === 0) return json({ error: 'Assessment score predictions require at least one active assessment instance.' }, 409)
  let incompleteAssessmentInventory = false
  // The inventory may still be included as model input when predictions for
  // future assessment scores are disabled. Validate every attached instance
  // and mark below-minimum snapshots as partial so the worker uses the same
  // count semantics for standing/risk-only forecasts.
  if (inputFeatures.has('assessment_instance_details') && safeAssessmentInstances.length > 0) {
    const assessmentInstances = safeAssessmentInstances as Record<string, any>[]
    const partialError = validateAssessmentInstanceCounts(gradingSystem, assessmentInstances, mapKnownStructuralRef, 'partial')
    if (partialError) return json({ error: partialError }, 409, 'assessment_count_constraint')
    const completeError = validateAssessmentInstanceCounts(gradingSystem, assessmentInstances, mapKnownStructuralRef, 'complete')
    incompleteAssessmentInventory = completeError !== null
  }
  const serializedInput = JSON.stringify(providerInput)
  if (new TextEncoder().encode(serializedInput).byteLength > 700_000) return json({ error: 'The applied schemas and student data exceed the prediction request limit' }, 413)

  const configuredProvider = String(aiConfig.provider ?? 'Gemini').trim().toLowerCase()
  if (['custom', 'custom model', 'apms custom'].includes(configuredProvider)) {
    trace.provider = 'custom'
    let configuration: AIServiceConfiguration
    try { configuration = aiServiceConfigurationFromEnvironment((name) => Deno.env.get(name)) }
    catch {
      return json({ error: 'The selected custom AI service is not configured correctly' }, 503)
    }
    if (!configuration.configured) return json({ error: 'The selected custom AI service is not configured' }, 503)
    const model = configuration.model ?? 'custom-model'
    const connector = createAIServiceConnector(configuration, requestBoundFetch(trace))
    let probedWorkerStatus: AIServiceProbe | null = null
    let conditionedInputs: typeof safeInputs | null = null
    let conditionedInstances: typeof safeAssessmentInstances | null = null
    if (incompleteAssessmentInventory || outputFields.has('assessment_score_predictions')) {
      trace.phase = 'status'
      setRequestStage(trace, 'provider_status')
      try { probedWorkerStatus = await connector.probe() }
      catch (error) {
        const failure = safeAIServiceFailure(error)
        trace.failureCode = failure.code
        trace.upstreamStatus = failure.upstreamStatus
        return json({ error: 'The custom AI service status check failed; no prediction request was sent', ...(failure.upstreamStatus ? { upstream_status: failure.upstreamStatus } : {}) }, failure.status, failure.code)
      }
      if (!probedWorkerStatus.ready) {
        trace.failureCode = 'provider_unavailable'
        return json({ error: 'The custom AI service is not ready; no prediction request was sent.' }, 503, trace.failureCode)
      }
      if (outputFields.has('assessment_score_predictions') && probedWorkerStatus.capabilities.assessment_instance_conditioning !== true) {
        return json({ error: 'The loaded model does not support assessment-specific score prediction. Update the model artifact or disable Assessment score predictions to continue with standing and risk forecasts.' }, 409, 'assessment_context_unsupported')
      }
      if (incompleteAssessmentInventory && probedWorkerStatus.capabilities.partial_assessment_inventory !== true) {
        return json({ error: 'The custom model does not advertise support for partial assessment inventories. Update the runtime image or disable Assessment score predictions for this test.' }, 409, 'partial_inventory_unsupported')
      }
      if (outputFields.has('assessment_score_predictions')) {
        try {
          const temporalContext = buildAssessmentTemporalContext(assessmentRowsForContext.map((row: any) => ({
            id: row.id,
            assessment_date: row.assessment_date ?? null,
            due_at: row.due_at ?? null,
          })), assessmentContextCutoffMs)
          const undatedAssessmentIds = new Set(assessmentRowsForContext
            .filter((row: any) => typeof row.assessment_date !== 'string' || !row.assessment_date)
            .map((row: any) => String(row.id)))
          conditionedInstances = safeAssessmentInstances.map((instance) => {
            const assessmentId = assessmentIdsByRef.get(String(instance.assessment_ref))
            const temporal = assessmentId ? temporalContext.get(assessmentId) : undefined
            if (!temporal) throw new TypeError('Assessment context metadata is unavailable')
            return { ...instance, ...temporal }
          })
          conditionedInputs = safeInputs.map((input) => {
            const sourceRecords = body.inputs[input.original_index].records
            const contextResults = anonymizeAcademicData(
              { assessment_results: sourceRecords?.assessment_results },
              true,
              false,
              mapKnownCategory,
              (id) => assessmentRefs.get(id),
              mapKnownStructuralRef,
              {
                version: 1,
                cutoffMs: assessmentContextCutoffMs,
                undatedAssessmentIds,
                resolveValue: (source, assessmentId) => {
                  const domain = assessmentScoringById.get(assessmentId)
                  if (!domain) return undefined
                  const raw = domain.mode === 'value_mapping'
                    ? source.categorical_value ?? source.score ?? source.raw_score
                    : source.raw_score ?? source.score
                  if (typeof raw === 'number' && Number.isFinite(raw)) {
                    if (domain.mode === 'linear') return raw >= 0 && raw <= domain.maximum ? raw : undefined
                    return domain.mapping.some((entry) => typeof entry.value === 'number' && entry.value === raw) ? raw : undefined
                  }
                  if (typeof raw === 'string' && domain.mode === 'value_mapping'
                    && domain.mapping.some((entry) => typeof entry.value === 'string' && entry.value === raw)) {
                    // The v1 projector applies the privacy category mapping
                    // once. Return the validated canonical value here so the
                    // projector does not try to anonymize an already-anonymous
                    // category a second time.
                    if (mapKnownCategory(raw) === undefined) throw new TypeError('Assessment category is not in the active privacy map')
                    return raw
                  }
                  return undefined
                },
              },
            ).assessment_results
            return {
              ...input,
              records: {
                ...input.records,
                ...(contextResults === undefined ? {} : { assessment_results: contextResults }),
              },
            }
          })
        } catch {
          return json({ error: 'Recorded assessment values or dates do not match the active grading system.' }, 409, 'assessment_context_invalid')
        }
      }
    }
    setRequestStage(trace, 'database_quota')
    const reservation = await reserveCustomServiceUsage(adminClient as unknown as CustomUsageClient, {
      actorId: caller.user.id,
      classRecordId: body.class_id,
      model,
      requestCount: body.inputs.length,
    })
    if (reservation.status === 'unavailable') return json({ error: 'AI usage limits could not be checked; the service request was not sent' }, 503)
    if (reservation.status === 'limit') return json({ error: 'The custom AI service has reached its monthly request limit.' }, 429)

    let workerStatus: AIServiceProbe
    let workerResults: Record<string, unknown>[]
    let wireAssessmentInstances: typeof safeAssessmentInstances = safeAssessmentInstances
    let wireInputs: typeof safeInputs = safeInputs
    try {
      if (!probedWorkerStatus) {
        trace.phase = 'status'
        setRequestStage(trace, 'provider_status')
        workerStatus = await connector.probe()
      } else workerStatus = probedWorkerStatus
      if (!workerStatus.ready || !workerStatus.model_version) {
        trace.failureCode = 'provider_unavailable'
        return json({ error: 'The selected custom AI service is not ready' }, 503, trace.failureCode)
      }
      const useAssessmentConditioning = outputFields.has('assessment_score_predictions')
        && workerStatus.capabilities.assessment_instance_conditioning === true
      if (useAssessmentConditioning && (!conditionedInputs || !conditionedInstances)) throw new Error('Assessment context was not prepared')
      wireAssessmentInstances = useAssessmentConditioning ? conditionedInstances! : safeAssessmentInstances
      wireInputs = useAssessmentConditioning ? conditionedInputs! : safeInputs
      trace.phase = 'prediction'
      setRequestStage(trace, 'provider')
      const requests = wireInputs.map((input) => ({
        record_id: input.record_ref,
        grading_system: safeGrading,
        evaluation_criteria: safeEvaluation,
        task_contract: {
          allowed_outputs: [...outputFields],
          assessment_predictions: outputFields.has('assessment_score_predictions')
            ? 'Return assessment_predictions using only request assessment_ref values that have no recorded result for this student. Never forecast a scored instance. Include every required unscored instance. Use numeric_value with exact maximum for numeric scoring, or categorical_value from the anonymized allowed mapping for categorical scoring.'
            : undefined,
          ...(incompleteAssessmentInventory ? { assessment_inventory: 'partial' } : {}),
          evaluation_scores: outputFields.has('evaluation_scores')
            ? 'Return only active AI-generated factor references and values matching each factor type, range, and category.'
            : undefined,
        },
        evaluation_values: input.factor_values,
        student_records: input.records,
        ...(inputFeatures.has('assessment_instance_details') ? { assessment_instances: wireAssessmentInstances } : {}),
      }))
      workerResults = await connector.predictBatch(requests)
    } catch (error) {
      return safeCustomProviderFailure(error, trace)
    }
    if (workerResults.length !== safeInputs.length) {
      trace.failureCode = 'invalid_response'
      return json({ error: 'The configured prediction provider returned an incomplete response' }, 502, trace.failureCode)
    }
    const predictions = []
    for (let index = 0; index < body.inputs.length; index++) {
      const result: any = workerResults[index]
      const expectedRef = safeInputs[index].record_ref
      const echoedRef = result.record_id ?? result.record_ref
      if (typeof echoedRef !== 'string' || echoedRef !== expectedRef || (result.record_id != null && result.record_id !== expectedRef) || (result.record_ref != null && result.record_ref !== expectedRef)) {
        trace.failureCode = 'invalid_response'
        return json({ error: 'The configured prediction provider returned a mismatched anonymous record reference' }, 502, trace.failureCode)
      }
      if (Object.prototype.hasOwnProperty.call(result, 'ai_risk_level') || Object.prototype.hasOwnProperty.call(result, 'risk_level')) {
        result.ai_risk_level = restoreSchemaCategory(result.ai_risk_level ?? result.risk_level, schemaPrivacyMap)
      }
      result.trend = restoreSchemaCategory(result.trend, schemaPrivacyMap)
      const validationError = validatePrediction(result, evaluationCriteria, 'anonymized_schema_context', outputFields, schemaPrivacyMap)
      if (validationError) {
        trace.failureCode = 'invalid_response'
        return json({ error: `The configured prediction provider returned an invalid prediction: ${validationError}` }, 502, trace.failureCode)
      }
      const existingRefs = new Set<string>((((wireInputs[index].records as any)?.assessment_results ?? []).filter((item: any) => item?.score !== undefined || item?.percentage !== undefined || item?.categorical_value !== undefined || item?.value !== undefined).map((item: any) => String(item.assessment_ref))) as string[])
      const assessmentValidation = validateAssessmentPredictions(result.assessment_predictions, wireAssessmentInstances as Record<string, any>[], outputFields, schemaPrivacyMap, existingRefs)
      if (assessmentValidation.error) {
        trace.failureCode = 'invalid_response'
        return json({ error: `The configured prediction provider returned an invalid prediction: ${assessmentValidation.error}` }, 502, trace.failureCode)
      }
      predictions.push({
        enrollment_id: body.inputs[safeInputs[index].original_index].enrollment_id,
        predicted_standing: result.predicted_standing,
        risk_probability: result.risk_probability ?? null,
        ai_risk_level: typeof result.ai_risk_level === 'string' ? result.ai_risk_level : typeof result.risk_level === 'string' ? result.risk_level : null,
        trend: result.trend,
        factors: result.factors ?? [],
        evaluation_scores: result.evaluation_scores ?? {},
        assessment_predictions: assessmentValidation.values.map((prediction) => ({ assessment_id: assessmentIdsByRef.get(String(prediction.assessment_ref)), result: prediction.result, confidence: prediction.confidence, evidence: prediction.evidence })),
      })
    }
    const modelVersion = workerStatus.model_version
    let runId: string
    setRequestStage(trace, 'prediction_validation')
    setRequestStage(trace, 'database_persistence')
    try { runId = await saveRun('custom', model, modelVersion, 'anonymized_schema_context', predictions) }
    catch (error) { return json({ error: error instanceof Error ? error.message : 'Prediction run could not be saved' }, 500) }
    setRequestStage(trace, 'database_usage')
    if (!await finalizeCustomServiceUsage(adminClient as unknown as CustomUsageClient, reservation.id)) return json({ error: 'The prediction run was saved, but custom-service usage could not be finalized. Contact an administrator before retrying.', run_id: runId }, 503)
    return json({ run_id: runId, provider: 'custom', model, model_version: modelVersion, data_basis: 'anonymized_schema_context', advisory_only: true, predictions })
  }

  const openAiSelected = ['openai', 'open ai'].includes(configuredProvider)
  const geminiSelected = ['gemini', 'google', 'google gemini'].includes(configuredProvider)
  if (!openAiSelected && !geminiSelected) return json({ error: `Unsupported AI provider in the applied evaluation criteria: ${aiConfig.provider}` }, 409)
  const selectedProvider = openAiSelected ? 'openai' : 'gemini'
  const { data: resolvedCredentials, error: credentialError } = await adminClient.rpc('ai_provider_resolve_key', { p_class_record_id: body.class_id, p_provider: selectedProvider })
  if (credentialError) return json({ error: 'Provider credentials could not be securely resolved' }, 503)
  const credential = Array.isArray(resolvedCredentials) ? resolvedCredentials[0] : resolvedCredentials
  const fallbackKey = openAiSelected ? Deno.env.get('OPENAI_API_KEY') : Deno.env.get('GEMINI_API_KEY')
  const apiKey = credential?.api_key || fallbackKey
  if (!apiKey) return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} has no configured system or department API key` }, 503)
  const model = String(credential?.model || aiConfig.modelName || (openAiSelected ? Deno.env.get('OPENAI_MODEL') : Deno.env.get('GEMINI_MODEL')) || (openAiSelected ? 'gpt-4.1-mini' : 'gemini-3.8-flash')).trim()
  const usageScope = credential?.scope_type ?? 'system'
  const usageScopeId = credential?.scope_id ?? null
  let requestLimit = credential?.monthly_request_limit ?? null
  let tokenLimit = credential?.monthly_token_limit ?? null
  if (usageScope === 'system') {
    const { data: limitSettings, error: limitError } = await adminClient.from('system_settings').select('key,value').in('key', ['ai.usage.monthly_request_limit', 'ai.usage.monthly_token_limit'])
    if (limitError) return json({ error: 'System AI usage limits could not be loaded' }, 503)
    const limitMap = new Map((limitSettings ?? []).map((entry: any) => [entry.key, entry.value]))
    const parseLimit = (value: unknown) => { const parsed = Number(value); return value == null || value === '' || !Number.isFinite(parsed) || parsed < 0 ? null : parsed }
    requestLimit = parseLimit(limitMap.get('ai.usage.monthly_request_limit'))
    tokenLimit = parseLimit(limitMap.get('ai.usage.monthly_token_limit'))
  }
  const aiRiskFactor = outputFields.has('risk_level') ? evaluationCriteria.factors.find((factor: any) => factor.source === 'ai_risk_level' && factor.categories?.length) : undefined
  const trendFactor = evaluationCriteria.factors.find((factor: any) => (factor.source === 'trend' || factor.source === 'recent_trend') && factor.categories?.length)
  const supportedTrends = ['improving', 'stable', 'declining']
  if (trendFactor?.categories?.some((category: string) => !supportedTrends.includes(category))) return json({ error: 'The applied evaluation system uses a trend category unsupported by the current prediction task.' }, 409)
  const safeAiRiskFactor = (safeEvaluation as any)?.factors?.find((factor: any) => factor.source === 'ai_risk_level')
  const safeTrendFactor = (safeEvaluation as any)?.factors?.find((factor: any) => (factor.source === 'trend' || factor.source === 'recent_trend') && factor.categories?.length)
  const properties: Record<string, unknown> = {
    record_ref: { type: 'STRING' },
    predicted_standing: { type: 'NUMBER', description: 'Estimated future final percentage on the grading system scale, from 0 to 100.' },
    ...(outputFields.has('risk_probability') ? { risk_probability: { type: 'NUMBER', description: 'A numeric value from 0 to 1 within the active evaluation-factor range.' } } : {}),
    trend: { type: 'STRING', enum: safeTrendFactor?.categories ?? supportedTrends },
    ...(outputFields.has('factors') ? { factors: { type: 'ARRAY', items: { type: 'STRING' } } } : {}),
  }
  const required = ['record_ref', 'predicted_standing', 'trend']
  if (outputFields.has('risk_probability')) required.push('risk_probability')
  if (outputFields.has('factors')) required.push('factors')
  if (aiRiskFactor) {
    properties.ai_risk_level = { type: 'STRING', enum: safeAiRiskFactor?.categories ?? [] }
    if (aiRiskFactor.required || aiRiskFactor.missingValuePolicy === 'unavailable') required.push('ai_risk_level')
  }
  if (outputFields.has('evaluation_scores')) {
    const fixedSources = new Set(['predicted_standing', 'risk_probability', 'model_confidence', 'prediction_available', 'trend', 'recent_trend', 'ai_risk_level', 'prediction_age_hours', 'ai_factor_count', 'data_basis'])
    const scoreProperties: Record<string, unknown> = {}
    const requiredScores: string[] = []
    for (const factor of ((safeEvaluation as any)?.factors ?? []) as any[]) {
      const sourceFactor = evaluationCriteria.factors.find((item: any) => schemaPrivacyMap.ids.get(item.id) === factor.id)
      if (!sourceFactor || fixedSources.has(factor.source) || (sourceFactor.aiGenerated !== true && sourceFactor.origin !== 'ai_prediction')) continue
      const property = factor.valueType === 'category'
        ? { type: 'STRING', ...(factor.categories?.length ? { enum: factor.categories } : {}) }
        : factor.valueType === 'boolean'
          ? { type: 'BOOLEAN' }
          : factor.valueType === 'number_array'
            ? { type: 'ARRAY', items: { type: 'NUMBER' } }
            : { type: 'NUMBER' }
      scoreProperties[factor.id] = property
      if (sourceFactor.required || sourceFactor.missingValuePolicy === 'unavailable') requiredScores.push(factor.id)
    }
    properties.evaluation_scores = { type: 'OBJECT', properties: scoreProperties, ...(requiredScores.length ? { required: requiredScores } : {}) }
    required.push('evaluation_scores')
  }
  if (outputFields.has('assessment_score_predictions')) {
    properties.assessment_predictions = {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: {
        assessment_ref: { type: 'STRING', enum: safeAssessmentInstances.map((instance) => instance.assessment_ref as string) },
        kind: { type: 'STRING', enum: ['numeric', 'categorical'] },
        numeric_value: { type: 'NUMBER' },
        categorical_value: { type: 'STRING' },
        maximum: { type: 'NUMBER' },
        confidence: { type: 'NUMBER' },
        evidence: { type: 'ARRAY', items: { type: 'STRING' } },
      }, required: ['assessment_ref', 'kind'] },
    }
    required.push('assessment_predictions')
  }
  const prompt = [
    'You are an advisory academic forecasting assistant. Use only the provided student records and the two applied schema representations.',
    'The grading-system representation defines the grade hierarchy, assessment scoring, aggregation, period strategy, final-result source, and percentage-to-point conversion. Interpret current results through those definitions; do not assume fixed periods or component names.',
    'The evaluation-criteria representation defines the available factors, their units and aggregation, risk levels, priorities, and rule conditions. Use those definitions to explain relevant evidence. Do not replace or reinterpret their rule thresholds.',
    'The application applies the evaluation rules deterministically after this forecast. Do not assign low/medium/high using fixed cutoffs. Only provide ai_risk_level when requested by an AI risk factor, and then choose only from that factor’s allowed categories.',
    `Return only the fields permitted by ai.outputFields (${[...outputFields].join(', ')}). For this task, return one result per record_ref with predicted_standing from 0 to 100 within its active factor range, trend selected from the supplied allowed values${outputFields.has('risk_probability') ? ', and risk_probability from 0 to 1 within its active factor range' : ''}${outputFields.has('risk_level') ? ', and ai_risk_level selected from its supplied category references' : ''}${outputFields.has('evaluation_scores') ? '. evaluation_scores must use only the supplied anonymous AI factor references and each value must satisfy its declared type, range, or category' : ''}${outputFields.has('assessment_score_predictions') ? '. assessment_predictions must use the supplied assessment_ref values only; for numeric results return kind=numeric, numeric_value and the exact maximum; for categorical results return kind=categorical and categorical_value from the active mapping' : ''}. Add factors only when permitted. Do not invent evidence or treat missing records as zero unless the grading schema says so.`,
    'Inputs are shuffled and contain only anonymized numeric evidence. Never infer or request any student, class, subject, or assessment identity. Refer to records and factors only by their opaque reference or generic factor number.',
    'When assessment_predictions are enabled, predict only instances with no recorded result for that specific record_ref. Never return a forecast for a scored instance. Return one valid result for every required unscored instance.',
    ...(incompleteAssessmentInventory ? ['This request contains a partial inventory of currently existing assessments. Apply type, domain, reference, and maximum-count constraints, but do not reject or infer missing future instances from minimum-count constraints. Only forecast the supplied unscored instances.'] : []),
    'Risk probability is heuristic and unvalidated. Factors must cite concrete schema-defined inputs and values. These results are advisory only, never official grades or decisions.',
    serializedInput,
  ].join('\n\n')
  const responseSchema = { type: 'ARRAY', items: { type: 'OBJECT', properties, required } }
  const estimatedOutputTokens = Math.min(30_000, body.inputs.length * (256 + (outputFields.has('assessment_score_predictions') ? safeAssessmentInstances.length * 64 : 0)))
  const estimatedTokens = Math.ceil(prompt.length / 4) + estimatedOutputTokens
  setRequestStage(trace, 'database_quota')
  const { data: usageReservation, error: reservationError } = await adminClient.rpc('ai_provider_reserve_usage', {
    p_actor_id: caller.user.id, p_class_record_id: body.class_id, p_scope_type: usageScope, p_scope_id: usageScopeId,
    p_provider: selectedProvider, p_model: model, p_feature: 'evaluation_and_assessment_prediction',
    p_monthly_request_limit: requestLimit, p_monthly_token_limit: tokenLimit, p_reserved_tokens: estimatedTokens,
  })
  if (reservationError) return json({ error: 'AI usage limits could not be checked; the provider request was not sent' }, 503)
  if (!usageReservation) return json({ error: 'This provider key has reached a monthly request or token limit.' }, 429)
  // Each invocation sends one fresh, stateless request. No provider thread,
  // conversation, prompt cache, or cross-user context identifier is reused.
  trace.provider = openAiSelected ? 'openai' : 'gemini'
  setRequestStage(trace, 'provider')
  let response: Response
  const timeoutMs = Math.min(60_000, Math.max(1, trace.deadlineAt - Date.now()))
  const providerTimeout = AbortSignal.timeout(timeoutMs)
  const providerSignal = AbortSignal.any([trace.controller.signal, providerTimeout])
  try {
    const providerFetch = requestBoundFetch(trace)
    response = openAiSelected
    ? await (async () => {
      return await providerFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: providerTimeout,
        body: JSON.stringify({
          model,
          temperature: 0,
          max_completion_tokens: 30000,
          messages: [
            { role: 'system', content: 'Return only the requested advisory predictions. Do not identify students or infer identities. Follow the active grading and evaluation schemas.' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'apms_advisory_predictions', strict: true, schema: openAiStrictSchema(responseSchema) } },
        }),
      })
    })()
    : await (async () => {
      return await providerFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        signal: providerTimeout,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Return only valid JSON matching the requested response schema.' }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema },
        }),
      })
    })()
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    trace.failureCode = timedOut ? 'provider_timeout' : 'provider_connection_failed'
    return json({ error: timedOut ? 'The prediction provider timed out' : 'The prediction provider could not be reached' }, timedOut ? 504 : 502, trace.failureCode)
  }
  if (!response) return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} API key is not configured` }, 503)
  let responseText = ''
  let responseTooLarge = false
  let responseBodyTimedOut = false
  try { responseText = await withinRequestDeadline(trace, readBoundedResponseText(response, PROVIDER_RESPONSE_LIMIT_BYTES, providerSignal)) }
  catch (error) {
    if (error instanceof RequestDeadlineError) throw error
    if ((error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) || providerTimeout.aborted || trace.controller.signal.aborted) {
      if (trace.controller.signal.aborted) throw new RequestDeadlineError()
      responseBodyTimedOut = true
    } else responseTooLarge = error instanceof BoundedResponseError
  }
  let usagePayload: any = null
  try { if (responseText) usagePayload = JSON.parse(responseText) } catch { /* Provider error bodies may not be JSON. */ }
  const usageInputTokens = Number(usagePayload?.usage?.prompt_tokens ?? usagePayload?.usageMetadata?.promptTokenCount ?? usagePayload?.usage?.input_tokens ?? 0)
  const usageOutputTokens = Number(usagePayload?.usage?.completion_tokens ?? usagePayload?.usageMetadata?.candidatesTokenCount ?? usagePayload?.usage?.output_tokens ?? 0)
  const recordedInputTokens = Number.isSafeInteger(usageInputTokens) && usageInputTokens > 0 ? usageInputTokens : estimatedTokens
  setRequestStage(trace, 'database_usage')
  const { error: usageWriteError } = await adminClient.from('ai_model_usage').update({
    input_tokens: recordedInputTokens,
    output_tokens: Number.isSafeInteger(usageOutputTokens) && usageOutputTokens >= 0 ? usageOutputTokens : 0,
    succeeded: response.ok && !responseBodyTimedOut && !responseTooLarge,
  }).eq('id', usageReservation)
  if (usageWriteError) return json({ error: 'The provider ran, but usage could not be recorded. Contact an administrator before retrying.' }, 503)
  if (responseBodyTimedOut) {
    trace.failureCode = 'provider_timeout'
    return json({ error: 'The prediction provider response timed out' }, 504, trace.failureCode)
  }
  if (responseTooLarge) {
    trace.failureCode = 'invalid_response'
    return json({ error: 'The prediction provider returned an oversized response' }, 502, trace.failureCode)
  }
  if (!response.ok) {
    trace.upstreamStatus = response.status
    trace.failureCode = response.status === 401 || response.status === 403
      ? 'provider_authentication_failed'
      : response.status === 422
        ? 'provider_request_rejected'
        : response.status === 429
          ? 'provider_busy'
          : 'provider_unavailable'
    return json({ error: 'The prediction provider returned an error response', upstream_status: response.status }, 502, trace.failureCode)
  }
  setRequestStage(trace, 'prediction_validation')
  let rawResults: any
  try {
    const payload = usagePayload
    if (openAiSelected && payload?.choices?.[0]?.message?.refusal) return json({ error: 'OpenAI declined the prediction request' }, 502)
    const parsedOpenAiContent = openAiSelected ? parseJson(payload?.choices?.[0]?.message?.content ?? '') : null
    rawResults = openAiSelected
      ? (isObjectRecord(parsedOpenAiContent) ? parsedOpenAiContent.predictions : undefined)
      : parseJson(readGeminiText(payload))
  } catch { return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} returned an invalid prediction response` }, 502) }
  if (!Array.isArray(rawResults) || rawResults.length !== body.inputs.length) return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} returned an incomplete prediction response` }, 502)
  const safeByRef = new Map(safeInputs.map((input) => [input.record_ref, input]))
  const predictionByIndex = new Map<number, any>()
  for (const result of rawResults) {
    const safeInput = safeByRef.get(result?.record_ref)
    if (!safeInput || predictionByIndex.has(safeInput.original_index)) return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} returned an invalid anonymous record reference` }, 502)
    predictionByIndex.set(safeInput.original_index, result)
  }
  if (predictionByIndex.size !== body.inputs.length) return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} returned an incomplete prediction response` }, 502)
  const predictions: any[] = []
  for (let index = 0; index < body.inputs.length; index++) {
    const input = body.inputs[index]
    const result = predictionByIndex.get(index)
    result.trend = restoreSchemaCategory(result.trend, schemaPrivacyMap)
    if (Object.prototype.hasOwnProperty.call(result, 'ai_risk_level') || Object.prototype.hasOwnProperty.call(result, 'risk_level')) {
      result.ai_risk_level = restoreSchemaCategory(result.ai_risk_level ?? result.risk_level, schemaPrivacyMap)
    }
    const validationError = validatePrediction(result, evaluationCriteria, 'applied_grading_and_evaluation_schemas', outputFields, schemaPrivacyMap)
    if (validationError) return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} returned an invalid prediction: ${validationError}` }, 502)
    const safeInput = safeByRef.get(result.record_ref)
    const existingRefs = new Set<string>((((safeInput?.records as any)?.assessment_results ?? []).filter((item: any) => item?.score !== undefined || item?.percentage !== undefined || item?.categorical_value !== undefined).map((item: any) => String(item.assessment_ref))) as string[])
    const assessmentValidation = validateAssessmentPredictions(result.assessment_predictions, safeAssessmentInstances as Record<string, any>[], outputFields, schemaPrivacyMap, existingRefs)
    if (assessmentValidation.error) return json({ error: `${openAiSelected ? 'OpenAI' : 'Gemini'} returned an invalid prediction: ${assessmentValidation.error}` }, 502)
    predictions.push({
      enrollment_id: input.enrollment_id,
      predicted_standing: result.predicted_standing,
      risk_probability: result.risk_probability ?? null,
      ai_risk_level: typeof result.ai_risk_level === 'string' ? result.ai_risk_level : null,
      trend: result.trend,
      factors: result.factors ?? [],
      evaluation_scores: result.evaluation_scores ?? {},
      assessment_predictions: assessmentValidation.values.map((prediction) => ({ assessment_id: assessmentIdsByRef.get(String(prediction.assessment_ref)), result: prediction.result, confidence: prediction.confidence, evidence: prediction.evidence })),
    })
  }
  const provider = openAiSelected ? 'openai' : 'gemini'
  const modelVersion = String(aiConfig.modelVersion || `${model}-schema-context-v4`)
  let runId: string
  setRequestStage(trace, 'database_persistence')
  try { runId = await saveRun(provider, model, modelVersion, 'applied_grading_and_evaluation_schemas', predictions) }
  catch (error) { return json({ error: error instanceof Error ? error.message : 'Prediction run could not be saved' }, 500) }
  return json({ run_id: runId, provider, model, model_version: modelVersion, data_basis: 'applied_grading_and_evaluation_schemas', advisory_only: true, predictions })
}

Deno.serve(async (request) => {
  const trace = createRequestTrace()
  if (request.method === 'OPTIONS') {
    trace.status = 200
    return addRequestTrace(new Response('ok', { headers: corsHeaders }), trace.id)
  }
  let response: Response
  try {
    setRequestStage(trace, 'request')
    response = await withinRequestDeadline(trace, handlePredictionRequest(request, trace))
  } catch (error) {
    const timedOut = error instanceof RequestDeadlineError || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    const timeoutCode = trace.stage === 'provider' || trace.stage === 'provider_status'
      ? 'provider_timeout'
      : trace.stage === 'authentication'
        ? 'authentication_timeout'
        : trace.stage.startsWith('database_')
          ? 'database_timeout'
          : 'request_timeout'
    const timeoutMessage = timeoutCode === 'provider_timeout'
      ? 'The prediction provider timed out'
      : timeoutCode === 'authentication_timeout'
        ? 'Authentication timed out'
        : timeoutCode === 'database_timeout'
          ? 'A required database operation timed out'
          : 'The prediction request timed out'
    response = json(
      { error: timedOut ? timeoutMessage : 'The prediction request could not be completed' },
      timedOut ? 504 : 500,
      timedOut ? timeoutCode : 'internal_error',
    )
  }
  trace.status = response.status
  const traced = addRequestTrace(response, trace.id)
  logRequestTrace(trace)
  return traced
})
