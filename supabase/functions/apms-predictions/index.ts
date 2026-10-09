import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type PredictionInput = {
  enrollment_id: string
  evaluation_values: Record<string, unknown>
  records: Record<string, unknown>
}

type RequestBody = {
  class_id: string
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
  if (!body.grading_system || !Array.isArray(body.grading_system.components) || !body.grading_system.finalResult) return json({ error: 'A valid applied grading-system representation is required' }, 400)
  if (!body.evaluation_criteria || !Array.isArray(body.evaluation_criteria.factors) || !Array.isArray(body.evaluation_criteria.levels)) return json({ error: 'A valid applied evaluation-criteria representation is required' }, 400)
  if (body.inputs.some((item) => !item.enrollment_id || !item.evaluation_values || !item.records)) return json({ error: 'Each prediction needs schema-derived factor values and student record context' }, 400)

  // RLS confirms class access; this second check prevents requesting predictions for another class's enrollment.
  const { data: classRecord, error: classError } = await userClient.from('class_records').select('id').eq('id', body.class_id).eq('status', 'active').maybeSingle()
  if (classError || !classRecord) return json({ error: 'You do not have access to this class' }, 403)
  const enrollmentIds = [...new Set(body.inputs.map((input) => input.enrollment_id))]
  const { data: enrollments, error: enrollmentError } = await userClient.from('enrollments').select('id').eq('class_record_id', body.class_id).eq('status', 'active').in('id', enrollmentIds)
  if (enrollmentError || (enrollments?.length ?? 0) !== enrollmentIds.length) return json({ error: 'One or more students are outside this class' }, 403)

  const serializedInput = JSON.stringify({ grading_system: body.grading_system, evaluation_criteria: body.evaluation_criteria, inputs: body.inputs.map((input, index) => ({ record_id: `student_${index + 1}`, factor_values: input.evaluation_values, records: input.records })) })
  if (serializedInput.length > 700_000) return json({ error: 'The applied schemas and student data exceed the prediction request limit' }, 413)
  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) return json({ error: 'Gemini API key is not configured' }, 503)

  const model = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite'
  const aiRiskFactor = body.evaluation_criteria.factors.find((factor: any) => factor.source === 'ai_risk_level')
  const properties: Record<string, unknown> = {
    predicted_standing: { type: 'NUMBER', description: 'Estimated future final percentage on the grading system scale, from 0 to 100.' },
    risk_probability: { type: 'NUMBER', description: 'Heuristic probability from 0 to 1, not calibrated and only an input when the evaluation schema uses it.' },
    trend: { type: 'STRING', enum: ['improving', 'stable', 'declining'] },
    factors: { type: 'ARRAY', items: { type: 'STRING' } },
  }
  const required = ['predicted_standing', 'risk_probability', 'trend', 'factors']
  if (aiRiskFactor) {
    const categories = Array.isArray(aiRiskFactor.categories) && aiRiskFactor.categories.length ? aiRiskFactor.categories : ['low', 'medium', 'high']
    properties.ai_risk_level = { type: 'STRING', enum: categories }
    required.push('ai_risk_level')
  }
  const prompt = [
    'You are an advisory academic forecasting assistant. Use only the provided student records and the two applied schema representations.',
    'The grading-system representation defines the grade hierarchy, assessment scoring, aggregation, period strategy, final-result source, and percentage-to-point conversion. Interpret current results through those definitions; do not assume fixed periods or component names.',
    'The evaluation-criteria representation defines the available factors, their units and aggregation, risk levels, priorities, and rule conditions. Use those definitions to explain relevant evidence. Do not replace or reinterpret their rule thresholds.',
    'The application applies the evaluation rules deterministically after this forecast. Do not assign low/medium/high using fixed cutoffs. Only provide ai_risk_level when requested by an AI risk factor, and then choose only from that factor’s allowed categories.',
    'Return one result per student record in the same order. Estimate predicted_standing from the currently available grading evidence; return 0–100. Mark uncertainty in the factors list. Do not invent evidence or treat missing records as zero unless the schema says so.',
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
    const detail = await response.text()
    console.error('Gemini request failed', response.status, detail.slice(0, 500))
    let providerMessage = `provider status ${response.status}`
    try { providerMessage = JSON.parse(detail)?.error?.message ?? providerMessage } catch { /* Use the generic provider status. */ }
    return json({ error: `Gemini prediction request failed: ${providerMessage.slice(0, 300)}` }, 502)
  }
  let rawResults: any
  try { rawResults = parseJson(readGeminiText(await response.json())) } catch { return json({ error: 'Gemini returned an invalid prediction response' }, 502) }
  if (!Array.isArray(rawResults) || rawResults.length !== body.inputs.length) return json({ error: 'Gemini returned an incomplete prediction response' }, 502)

  const predictions = rawResults.map((result: any, index: number) => ({
    enrollment_id: body.inputs[index].enrollment_id,
    predicted_standing: Number.isFinite(Number(result.predicted_standing)) ? Math.min(100, Math.max(0, Number(result.predicted_standing))) : Number(body.inputs[index].records.current_standing ?? 0),
    risk_probability: Number.isFinite(Number(result.risk_probability)) ? Math.min(1, Math.max(0, Number(result.risk_probability))) : null,
    ai_risk_level: typeof result.ai_risk_level === 'string' ? result.ai_risk_level : null,
    trend: ['improving', 'stable', 'declining'].includes(result.trend) ? result.trend : 'stable',
    factors: Array.isArray(result.factors) ? result.factors.filter((factor: unknown) => typeof factor === 'string').slice(0, 8) : [],
  }))
  return json({ model_version: `${model}-schema-context-v2`, data_basis: 'applied_grading_and_evaluation_schemas', advisory_only: true, predictions })
})
