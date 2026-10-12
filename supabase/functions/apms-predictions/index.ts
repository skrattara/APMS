import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { anonymizeAcademicData, anonymizeEvaluationValues, anonymizeSchemaRepresentation, opaqueRecordRef, restoreSchemaCategory, shuffleForProvider } from '../_shared/aiPrivacy.ts'
import defaultGradingSystem from '../_shared/defaultGradingSystem.json' with { type: 'json' }
import defaultEvaluationSystem from '../_shared/defaultEvaluationSystem.json' with { type: 'json' }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

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

function validatePrediction(result: any, evaluation: Record<string, any>, dataBasis: string, outputFields: Set<string>, privacyMap: { ids: Map<string, string>; categories: Map<string, string }) {
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
    model_confidence: result.risk_probability ?? null,
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

function decodeAndValidateEvaluationScores(raw: unknown, evaluation: Record<string, any>, result: any, outputFields: Set<string>, privacyMap: { ids: Map<string, string>; categories: Map<string, string }) {
  const empty = { values: {} as Record<string, unknown>, error: null as string | null }
  if (!outputFields.has('evaluation_scores')) return raw == null ? empty : { ...empty, error: 'Evaluation scores are not an allowed output for the applied evaluation criteria.' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...empty, error: 'Evaluation scores must be an object keyed by applied factor reference.' }
  const sourcesWithBuiltInOutput = new Set(['predicted_standing', ...(outputFields.has('risk_probability') ? ['risk_probability', 'model_confidence'] : []), 'trend', 'recent_trend', ...(outputFields.has('risk_level') ? ['ai_risk_level'] : []), 'prediction_available', 'prediction_age_hours', ...(outputFields.has('factors') ? ['ai_factor_count'] : [])])
  const values = raw as Record<string, unknown>
  const accepted: Record<string, unknown> = {}
  const originalId = new Map([...privacyMap.ids.entries()].map(([original, safe]) => [safe, original]))
  for (const [safeFactorId, encoded] of Object.entries(values)) {
    const factorId = originalId.get(safeFactorId)
    const factor = (evaluation.factors as any[]).find((item) => item.id === factorId)
    if (!factor || (factor.aiGenerated !== true && factor.origin !== 'ai_prediction')) return { ...empty, error: 'Evaluation scores may only contain active AI-generated factor references.' }
    if (sourcesWithBuiltInOutput.has(factor.source)) return { ...empty, error: `The factor ${factor.source} is already provided by the prediction fields and cannot be overridden.` }
    let value = encoded
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

function validateAssessmentPredictions(raw: unknown, instances: Record<string, any>[], outputFields: Set<string>, privacyMap: { ids: Map<string, string>; categories: Map<string, string }) {
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
    seen.add(ref)
    const scoring = instance.scoring
    const result = prediction.result ?? (prediction.kind === 'numeric'
      ? { kind: 'numeric', value: prediction.numeric_value, maximum: prediction.maximum }
      : prediction.kind === 'categorical'
        ? { kind: 'categorical', value: prediction.categorical_value }
        : null)
    if (result && !prediction.result) prediction.result = result
    if (!result || typeof result !== 'object') return { ...empty, error: `Assessment ${ref} has no valid result.` }
    if (prediction.result && (prediction.kind != null || prediction.numeric_value != null || prediction.categorical_value != null || prediction.maximum != null)) return { ...empty, error: `Assessment ${ref} mixes result encodings.` }
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
    values.push(prediction)
  }
  for (const instance of instances) if (!instance.optional && !seen.has(instance.assessment_ref)) return { ...empty, error: `A result prediction is missing for required assessment ${instance.assessment_ref}.` }
  return { values, error: null }
}

function validateAssessmentInstanceCounts(grading: Record<string, any>, instances: Record<string, any>[], mapRef: (value: string) => string | undefined) {
  for (const component of grading.components ?? []) {
    const definition = component.assessmentDefinition
    if (!definition?.count) continue
    const typeRef = mapRef(definition.typeId)
    const matching = instances.filter((instance) => instance.assessment_type_ref === typeRef)
    const violates = (scope: any[]) => (definition.count.min != null && scope.length < definition.count.min) || (definition.count.max != null && scope.length > definition.count.max)
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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

  const token = authorization.slice('Bearer '.length)
  const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const { data: caller, error: callerError } = await userClient.auth.getUser(token)
  if (callerError || !caller.user) return json({ error: 'Invalid session' }, 401)

  let body: RequestBody
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  if (!body.class_id || !Array.isArray(body.inputs) || !body.inputs.length) return json({ error: 'Class and at least one student record are required' }, 400)
  if (body.inputs.length > 100) return json({ error: 'A maximum of 100 students can be predicted per request' }, 400)
  if (body.inputs.some((item) => !item.enrollment_id || !item.evaluation_values || !item.records)) return json({ error: 'Each prediction needs schema-derived factor values and student record context' }, 400)

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
  const adminClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey, { auth: { persistSession: false } })
  let applied: { grading: Record<string, any>; evaluation: Record<string, any> }
  try { applied = await loadAppliedDefinitions(adminClient, userClient, body.class_id, caller.user.id) }
  catch (error) { return json({ error: error instanceof Error ? error.message : 'Applied class schemas could not be resolved' }, 409) }
  if (stableJson(body.grading_system) !== stableJson(applied.grading) || stableJson(body.evaluation_criteria) !== stableJson(applied.evaluation)) {
    return json({ error: 'The applied grading or evaluation schema changed. Refresh the class and try again.' }, 409)
  }
  const gradingSystem = applied.grading
  const evaluationCriteria = applied.evaluation
  const allowedSeverity = new Set(['low', 'medium', 'high', 'unavailable', ...evaluationCriteria.levels.map((level: any) => level.severity)])
  if (body.inputs.some((item) => !allowedSeverity.has(String(item.evaluated_risk_level)))) return json({ error: 'A supplied evaluation result does not match the applied evaluation criteria.' }, 400)
  const aiConfig = evaluationCriteria.ai
  if (!aiConfig || aiConfig.enabled !== true) return json({ error: 'AI prediction is disabled in the applied evaluation criteria' }, 403)
  const supportedScenarios = aiConfig.supportedScenarios ?? []
  if (!supportedScenarios.includes('stable')) return json({ error: 'The applied evaluation criteria do not allow the current prediction scenario' }, 409)
  const inputFeatures = new Set(aiConfig.inputFeatures ?? [])
  const outputFields = new Set(aiConfig.outputFields ?? [])
  if (!inputFeatures.size || !outputFields.has('predicted_standing') || !outputFields.has('trend')) return json({ error: 'The applied evaluation criteria do not define the inputs and outputs required for this prediction task' }, 409)
  if (inputFeatures.has('assessment_results') && !inputFeatures.has('assessment_instance_details')) return json({ error: 'The applied evaluation criteria must include assessment instance details whenever assessment results are shared' }, 409)
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
      grading_system: gradingSystem,
      evaluation_criteria: evaluationCriteria,
      inputs: body.inputs,
      advisory_only: true,
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
          evaluation_scores: prediction.evaluation_scores,
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
  let safeAssessmentInstances: Record<string, unknown>[] = []
  if (inputFeatures.has('assessment_results') || inputFeatures.has('assessment_instance_details')) {
    const { data: assessmentRows, error: assessmentError } = await adminClient.from('assessments')
      .select('id,type,component_key,maximum_score,grading_type_id,grading_group_id,grading_period_id,grading_instance_weight,optional')
      .eq('class_record_id', body.class_id).neq('status', 'archived')
    if (assessmentError) return json({ error: 'Assessment instance context could not be verified' }, 503)
    const builtinAliases: Record<string, string> = { start_of_class: 'soc', lets_practice: 'lp', reflection: 'tb', wrap_up_quiz: 'wuq', project_checkin: 'cig', final_project: 'fo', 'start of class': 'soc', "let's practice": 'lp', reflection_work: 'tb', 'wrap-up quiz': 'wuq', project: 'fo', soc: 'soc', lp: 'lp', tb: 'tb', wuq: 'wuq', cig: 'cig', fo: 'fo' }
    const resolveType = (value: unknown) => typeof value === 'string' ? value : ''
    const resolveDefinition = (row: any) => {
      const candidates = [row.grading_type_id, row.component_key, row.type].map(resolveType)
      return gradingSystem.components.find((component: any) => candidates.some((candidate) => candidate && (component.assessmentDefinition?.typeId === candidate || (builtinAliases[candidate.toLowerCase()] ?? candidate.toLowerCase()) === (builtinAliases[component.assessmentDefinition?.typeId?.toLowerCase()] ?? component.assessmentDefinition?.typeId?.toLowerCase())))
    }
    for (const row of assessmentRows ?? []) {
      const component = resolveDefinition(row)
      const maximum = Number(row.maximum_score)
      if (!component?.assessmentDefinition || !Number.isFinite(maximum) || maximum <= 0 || maximum > 100000) return json({ error: 'An assessment instance does not conform to the active grading-system definition' }, 409)
      const assessmentRef = opaqueRecordRef().replace(/^record_/, 'assessment_')
      assessmentRefs.set(row.id, assessmentRef)
      assessmentIdsByRef.set(assessmentRef, row.id)
      if (!inputFeatures.has('assessment_instance_details') && !inputFeatures.has('assessment_results')) continue
      const scoring = component.assessmentDefinition.scoring
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
  if (outputFields.has('assessment_score_predictions') && !inputFeatures.has('assessment_instance_details')) return json({ error: 'Assessment score predictions require the applied criteria to include assessment instance details as an AI input.' }, 409)
  if (outputFields.has('assessment_score_predictions') && !allowAssessmentData) return json({ error: 'Assessment score predictions require System Admin approval to share anonymous assessment data.' }, 403)
  if (outputFields.has('assessment_score_predictions') && safeAssessmentInstances.length === 0) return json({ error: 'Assessment score predictions require at least one active assessment instance.' }, 409)
  if (outputFields.has('assessment_score_predictions')) {
    const countError = validateAssessmentInstanceCounts(gradingSystem, safeAssessmentInstances as Record<string, any>[], mapKnownStructuralRef)
    if (countError) return json({ error: countError }, 409)
  }
  const serializedInput = JSON.stringify(providerInput)
  if (serializedInput.length > 700_000) return json({ error: 'The applied schemas and student data exceed the prediction request limit' }, 413)

  const customModelUrl = Deno.env.get('APMS_AI_SERVICE_URL')
  if (customModelUrl) {
    const customKey = Deno.env.get('APMS_AI_SERVICE_API_KEY')
    if (!customKey) return json({ error: 'The configured prediction provider is missing its server-side API key' }, 503)
    const predictions = []
    for (let index = 0; index < body.inputs.length; index++) {
      const response = await fetch(`${customModelUrl.replace(/\/$/, '')}/v1/predictions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(customKey ? { Authorization: `Bearer ${customKey}` } : {}) },
        body: JSON.stringify({
          record_id: safeInputs[index].record_ref,
          grading_system: safeGrading,
          evaluation_criteria: safeEvaluation,
          task_contract: {
            allowed_outputs: [...outputFields],
            assessment_predictions: outputFields.has('assessment_score_predictions')
              ? 'Return assessment_predictions using only request assessment_ref values. Use numeric_value with exact maximum for numeric scoring, or categorical_value from the anonymized allowed mapping for categorical scoring.'
              : undefined,
            evaluation_scores: outputFields.has('evaluation_scores')
              ? 'Return only active AI-generated factor references and values matching each factor type, range, and category.'
              : undefined,
          },
          evaluation_values: safeInputs[index].factor_values,
          student_records: safeInputs[index].records,
          ...(inputFeatures.has('assessment_instance_details') ? { assessment_instances: safeAssessmentInstances } : {}),
        }),
      })
      if (!response.ok) return json({ error: 'The configured prediction provider rejected the request' }, 502)
      let result: any
      try { result = await response.json() } catch { return json({ error: 'The configured prediction provider returned an invalid response' }, 502) }
      if ((result.record_id != null && result.record_id !== safeInputs[index].record_ref) || (result.record_ref != null && result.record_ref !== safeInputs[index].record_ref)) return json({ error: 'The configured prediction provider returned a mismatched anonymous record reference' }, 502)
      result.ai_risk_level = restoreSchemaCategory(result.ai_risk_level ?? result.risk_level, schemaPrivacyMap)
      result.trend = restoreSchemaCategory(result.trend, schemaPrivacyMap)
      const validationError = validatePrediction(result, evaluationCriteria, 'anonymized_schema_context', outputFields, schemaPrivacyMap)
      if (validationError) return json({ error: `The configured prediction provider returned an invalid prediction: ${validationError}` }, 502)
      const assessmentValidation = validateAssessmentPredictions(result.assessment_predictions, safeAssessmentInstances as Record<string, any>[], outputFields, schemaPrivacyMap)
      if (assessmentValidation.error) return json({ error: `The configured prediction provider returned an invalid prediction: ${assessmentValidation.error}` }, 502)
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
    const model = Deno.env.get('APMS_AI_SERVICE_MODEL') ?? 'custom-model'
    const modelVersion = Deno.env.get('APMS_AI_SERVICE_MODEL_VERSION') ?? model
    let runId: string
    try { runId = await saveRun('custom', model, modelVersion, 'anonymized_schema_context', predictions) }
    catch (error) { return json({ error: error instanceof Error ? error.message : 'Prediction run could not be saved' }, 500) }
    return json({ run_id: runId, provider: 'custom', model, model_version: modelVersion, data_basis: 'anonymized_schema_context', advisory_only: true, predictions })
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) return json({ error: 'Gemini API key is not configured' }, 503)

  const model = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite'
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
    'Risk probability is heuristic and unvalidated. Factors must cite concrete schema-defined inputs and values. These results are advisory only, never official grades or decisions.',
    serializedInput,
  ].join('\n\n')
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'Return only valid JSON matching the requested response schema.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: { type: 'ARRAY', items: { type: 'OBJECT', properties, required } },
      },
    }),
  })
  if (!response.ok) {
    await response.text()
    console.error('Gemini prediction request failed', response.status)
    return json({ error: `Gemini prediction request failed (${response.status})` }, 502)
  }
  let rawResults: any
  try { rawResults = parseJson(readGeminiText(await response.json())) } catch { return json({ error: 'Gemini returned an invalid prediction response' }, 502) }
  if (!Array.isArray(rawResults) || rawResults.length !== body.inputs.length) return json({ error: 'Gemini returned an incomplete prediction response' }, 502)
  const safeByRef = new Map(safeInputs.map((input) => [input.record_ref, input]))
  const predictionByIndex = new Map<number, any>()
  for (const result of rawResults) {
    const safeInput = safeByRef.get(result?.record_ref)
    if (!safeInput || predictionByIndex.has(safeInput.original_index)) return json({ error: 'Gemini returned an invalid anonymous record reference' }, 502)
    predictionByIndex.set(safeInput.original_index, result)
  }
  if (predictionByIndex.size !== body.inputs.length) return json({ error: 'Gemini returned an incomplete prediction response' }, 502)
  const predictions: any[] = []
  for (let index = 0; index < body.inputs.length; index++) {
    const input = body.inputs[index]
    const result = predictionByIndex.get(index)
    result.trend = restoreSchemaCategory(result.trend, schemaPrivacyMap)
    result.ai_risk_level = restoreSchemaCategory(result.ai_risk_level ?? result.risk_level, schemaPrivacyMap)
    const validationError = validatePrediction(result, evaluationCriteria, 'applied_grading_and_evaluation_schemas', outputFields, schemaPrivacyMap)
    if (validationError) return json({ error: `Gemini returned an invalid prediction: ${validationError}` }, 502)
    const assessmentValidation = validateAssessmentPredictions(result.assessment_predictions, safeAssessmentInstances as Record<string, any>[], outputFields, schemaPrivacyMap)
    if (assessmentValidation.error) return json({ error: `Gemini returned an invalid prediction: ${assessmentValidation.error}` }, 502)
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
  const modelVersion = `${model}-schema-context-v3`
  let runId: string
  try { runId = await saveRun('gemini', model, modelVersion, 'applied_grading_and_evaluation_schemas', predictions) }
  catch (error) { return json({ error: error instanceof Error ? error.message : 'Prediction run could not be saved' }, 500) }
  return json({ run_id: runId, provider: 'gemini', model, model_version: modelVersion, data_basis: 'applied_grading_and_evaluation_schemas', advisory_only: true, predictions })
})
