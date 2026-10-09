import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

  let body: { class_id?: string; enrollment_id?: string; student_name?: string; records?: Record<string, unknown> }
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const appliedGrading = (body.records as any)?.applied_grading_system?.definition
  const appliedEvaluation = (body.records as any)?.applied_evaluation_criteria?.definition
  if (!body.class_id || !body.enrollment_id || !body.student_name || !body.records || typeof body.records !== 'object') {
    return json({ error: 'Class, student, and record context are required' }, 400)
  }
  if (!appliedGrading || !Array.isArray(appliedGrading.components) || !appliedGrading.finalResult) {
    return json({ error: 'The applied grading-system schema representation is missing or invalid' }, 400)
  }
  if (!appliedEvaluation || !Array.isArray(appliedEvaluation.factors) || !Array.isArray(appliedEvaluation.levels)) {
    return json({ error: 'The applied evaluation-criteria schema representation is missing or invalid' }, 400)
  }
  const { data: classRecord } = await userClient.from('class_records').select('id').eq('id', body.class_id).eq('status', 'active').maybeSingle()
  if (!classRecord) return json({ error: 'You do not have access to this class' }, 403)
  const { data: enrollment } = await userClient.from('enrollments').select('id').eq('id', body.enrollment_id).eq('class_record_id', body.class_id).eq('status', 'active').maybeSingle()
  if (!enrollment) return json({ error: 'Student is not enrolled in this class' }, 403)
  const recordsJson = JSON.stringify(body.records)
  if (recordsJson.length > 24000) return json({ error: 'Student context is too large to generate a draft' }, 413)

  const geminiKey = Deno.env.get('GEMINI_API_KEY')
  if (!geminiKey) return json({ error: 'Gemini API key is not configured' }, 503)
  const model = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash-lite'
  const prompt = [
    'Write a concise, supportive draft of academic feedback for a student using only the supplied records.',
    'Use the applied grading-system and evaluation-criteria schema representations to explain how the reported results and risk factors should be understood. Follow the grading formula, scoring mappings, aggregation and period strategy from the grading definition. Explain evaluation factors and rule matches according to the evaluation definition.',
    'Mention concrete strengths, concerns, and one or two practical next steps only when supported by the records.',
    'Do not invent grades, thresholds, causes, or missing information. State when evidence is unavailable.',
    'Do not make a disciplinary decision or claim this is an official SIS grade. The instructor will review and edit this draft before publishing.',
    `Address the student as ${body.student_name}.`,
    recordsJson,
  ].join('\n\n')
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
  if (!response.ok) {
    const providerBody = await response.text()
    console.error('Gemini feedback draft failed', response.status, providerBody.slice(0, 500))
    let message = `provider status ${response.status}`
    try { message = JSON.parse(providerBody)?.error?.message ?? message } catch { /* Keep generic provider status. */ }
    return json({ error: `Gemini feedback generation failed: ${message.slice(0, 240)}` }, 502)
  }
  let payload: any
  try { payload = await response.json() } catch { return json({ error: 'Gemini returned an invalid response' }, 502) }
  let generated: any
  try { generated = JSON.parse(readGeminiText(payload)) } catch { return json({ error: 'Gemini returned an invalid feedback draft' }, 502) }
  if (typeof generated?.body !== 'string' || !generated.body.trim()) return json({ error: 'Gemini returned an empty feedback draft' }, 502)
  return json({ body: generated.body.trim(), model_version: model, advisory_only: true })
})
