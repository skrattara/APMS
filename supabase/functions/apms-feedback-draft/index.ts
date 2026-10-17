import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import { anonymizeAcademicData, anonymizeEvaluationFactorRows, anonymizeSchema, opaqueRecordRef } from '../_shared/aiPrivacy.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
})

function readGeminiText(payload: any): string {
  return payload?.candidates?.[0]?.content?.parts
    ?.filter((part: any) => typeof part?.text === 'string')
    ?.map((part: any) => part.text)
    ?.join('') ?? ''
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

  let body: { class_id?: string; enrollment_id?: string; records?: Record<string, unknown> }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const appliedGrading = (body.records as any)?.applied_grading_system?.definition
  const appliedEvaluation = (body.records as any)?.applied_evaluation_criteria?.definition
  if (!body.class_id || !body.enrollment_id || !body.records || typeof body.records !== 'object') {
    return json({ error: 'Class and record context are required' }, 400)
  }
  if (!appliedGrading || !Array.isArray(appliedGrading.components) || !appliedGrading.finalResult) {
    return json({ error: 'The applied grading-system schema representation is missing or invalid' }, 400)
  }
  if (!appliedEvaluation || !Array.isArray(appliedEvaluation.factors) || !Array.isArray(appliedEvaluation.levels)) {
    return json({ error: 'The applied evaluation-criteria schema representation is missing or invalid' }, 400)
  }
  const { error: permissionError } = await userClient.rpc('faculty_assert_ai_access', { p_class_record_id: body.class_id, p_feature: 'feedback_draft' })
  if (permissionError) return json({ error: 'You are not authorized to generate feedback for this class' }, 403)
  const { data: classRecord } = await userClient.from('class_records').select('id').eq('id', body.class_id).eq('status', 'active').maybeSingle()
  if (!classRecord) return json({ error: 'You do not have access to this class' }, 403)
  const { data: enrollment } = await userClient.from('enrollments').select('id').eq('id', body.enrollment_id).eq('class_record_id', body.class_id).eq('status', 'active').maybeSingle()
  if (!enrollment) return json({ error: 'Student is not enrolled in this class' }, 403)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) return json({ error: 'AI privacy controls are unavailable' }, 503)
  const adminClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', serviceKey, { auth: { persistSession: false } })
  const { data: settingRows, error: settingsError } = await adminClient.from('system_settings').select('key,value').in('key', ['ai.enabled', 'ai.assessment_data.enabled', 'ai.attendance_data.enabled'])
  if (settingsError) return json({ error: 'AI privacy controls are unavailable' }, 503)
  const settings = new Map((settingRows ?? []).map((row: any) => [row.key, row.value]))
  const enabled = (key: string) => settings.get(key) === true || settings.get(key) === 'true'
  if (!enabled('ai.enabled')) return json({ error: 'AI features are disabled by the System Administrator' }, 403)

  const allowAssessmentData = enabled('ai.assessment_data.enabled')
  const allowAttendance = enabled('ai.attendance_data.enabled')
  if (!allowAssessmentData && !allowAttendance) return json({ error: 'AI feedback drafts require System Admin approval to share anonymous assessment or attendance data' }, 403)
  const gradeContext = (body.records.grades ?? {}) as Record<string, unknown>
  const rawAssessments = Array.isArray(body.records.assessments) ? body.records.assessments : []
  const factorContext = (body.records.evaluation as any)?.factors
  const safeRecords = anonymizeAcademicData({
    current_standing: gradeContext.final_percentage,
    point_grade: gradeContext.point_grade,
    missing_assessment_count: body.records.missing_assessment_results,
    attendance_rate: body.records.attendance_percentage,
    assessment_results: rawAssessments.map((item: any) => ({ score: item?.raw_score, maximum_score: item?.maximum_score, mapped_percentage: item?.mapped_percentage })),
  }, allowAssessmentData, allowAttendance)
  const safeProviderData = {
    record_ref: opaqueRecordRef(),
    grading_system: anonymizeSchema(appliedGrading),
    evaluation_criteria: anonymizeSchema(appliedEvaluation),
    academic_data: safeRecords,
    factor_values: anonymizeEvaluationFactorRows(factorContext, allowAssessmentData, allowAttendance),
  }
  const recordsJson = JSON.stringify(safeProviderData)
  if (recordsJson.length > 24000) return json({ error: 'Student context is too large to generate a draft' }, 413)

  const { data: resolvedCredentials, error: credentialError } = await adminClient.rpc('ai_provider_resolve_key', { p_class_record_id: body.class_id, p_provider: 'gemini' })
  if (credentialError) return json({ error: 'Gemini credentials could not be securely resolved' }, 503)
  const credential = Array.isArray(resolvedCredentials) ? resolvedCredentials[0] : resolvedCredentials
  const geminiKey = credential?.api_key || Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) return json({ error: 'Gemini has no configured system or department API key' }, 503)
  const model = credential?.model || Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite'
  const prompt = [
    'Write a concise, supportive draft of academic feedback using only the supplied anonymous numeric evidence and schema structure. Do not ask for or infer a student name or identifying details.',
    'Use the applied grading-system and evaluation-criteria schema representations to explain how the reported results and risk factors should be understood. Follow the grading formula, scoring mappings, aggregation and period strategy from the grading definition. Explain evaluation factors and rule matches according to the evaluation definition.',
    'Mention concrete strengths, concerns, and one or two practical next steps only when supported by the records.',
    'Do not invent grades, thresholds, causes, or missing information. State when evidence is unavailable.',
    'Do not make a disciplinary decision or claim this is an official SIS grade. The instructor will review and edit this draft before publishing.',
    recordsJson,
  ].join('\n\n')
  const usageScope = credential?.scope_type ?? 'system'
  const usageScopeId = credential?.scope_id ?? null
  let requestLimit = credential?.monthly_request_limit ?? null
  let tokenLimit = credential?.monthly_token_limit ?? null
  if (usageScope === 'system') {
    const { data: limits, error: limitError } = await adminClient.from('system_settings').select('key,value').in('key', ['ai.usage.monthly_request_limit', 'ai.usage.monthly_token_limit'])
    if (limitError) return json({ error: 'System AI usage limits could not be loaded' }, 503)
    const limitMap = new Map((limits ?? []).map((row: any) => [row.key, row.value]))
    const parseLimit = (value: unknown) => { const parsed = Number(value); return value == null || value === '' || !Number.isFinite(parsed) || parsed < 0 ? null : parsed }
    requestLimit = parseLimit(limitMap.get('ai.usage.monthly_request_limit'))
    tokenLimit = parseLimit(limitMap.get('ai.usage.monthly_token_limit'))
  }
  const reservedTokens = Math.ceil(prompt.length / 4) + 1024
  const { data: usageReservation, error: reservationError } = await adminClient.rpc('ai_provider_reserve_usage', {
    p_actor_id: caller.user.id, p_class_record_id: body.class_id, p_scope_type: usageScope, p_scope_id: usageScopeId,
    p_provider: 'gemini', p_model: model, p_feature: 'feedback_draft',
    p_monthly_request_limit: requestLimit, p_monthly_token_limit: tokenLimit, p_reserved_tokens: reservedTokens,
  })
  if (reservationError) return json({ error: 'AI usage limits could not be checked; the provider request was not sent' }, 503)
  if (!usageReservation) return json({ error: 'This Gemini key has reached a monthly request or token limit.' }, 429)
  // This draft is a one-shot request for this authorized caller. No provider
  // conversation, prompt cache, or context identifier is reused across users.
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'Return valid JSON with one string property named body. Do not include markdown.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { body: { type: 'STRING' } }, required: ['body'] },
      },
    }),
  })
  let usagePayload: any = null
  try { usagePayload = await response.clone().json() } catch { /* Error responses can be non-JSON. */ }
  const inputTokens = Number(usagePayload?.usageMetadata?.promptTokenCount ?? 0)
  const outputTokens = Number(usagePayload?.usageMetadata?.candidatesTokenCount ?? 0)
  const { error: usageError } = await adminClient.from('ai_model_usage').update({
    input_tokens: Number.isSafeInteger(inputTokens) && inputTokens > 0 ? inputTokens : reservedTokens,
    output_tokens: Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
    succeeded: response.ok,
  }).eq('id', usageReservation)
  if (usageError) return json({ error: 'Gemini ran, but usage could not be recorded. Contact an administrator before retrying.' }, 503)
  if (!response.ok) {
    await response.text()
    console.error('Gemini feedback draft failed', response.status)
    return json({ error: `Gemini feedback generation failed (${response.status})` }, 502)
  }
  let payload: any
  try { payload = await response.json() } catch { return json({ error: 'Gemini returned an invalid response' }, 502) }
  let generated: any
  try { generated = JSON.parse(readGeminiText(payload)) } catch { return json({ error: 'Gemini returned an invalid feedback draft' }, 502) }
  if (typeof generated?.body !== 'string' || !generated.body.trim()) return json({ error: 'Gemini returned an empty feedback draft' }, 502)
  return json({ body: generated.body.trim(), model_version: model, advisory_only: true })
})
