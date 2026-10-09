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

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] ?? character))

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return json({ error: 'Email delivery is not configured. Set RESEND_API_KEY in Supabase Function Secrets.' }, 503)

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await userClient.auth.getUser(token)
  if (authError || !authData.user) return json({ error: 'Invalid session' }, 401)
  if (!serviceKey) return json({ error: 'Email delivery configuration is unavailable. Contact a System Admin.' }, 503)
  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const { data: senderSetting, error: senderError } = await adminClient.from('system_settings')
    .select('key,value').in('key', ['FEEDBACK_FROM_EMAIL', 'FEEDBACK_FROM_NAME'])
  const senderSettings = new Map((senderSetting ?? []).map((row: { key: string; value: unknown }) => [row.key, row.value]))
  const senderEmailValue = senderSettings.get('FEEDBACK_FROM_EMAIL')
  const senderNameValue = senderSettings.get('FEEDBACK_FROM_NAME')
  const senderEmail = typeof senderEmailValue === 'string' ? senderEmailValue.trim() : ''
  const senderName = typeof senderNameValue === 'string' && senderNameValue.trim() ? senderNameValue.trim() : 'APMS Feedback'
  if (senderError || !senderEmail) return json({ error: 'Feedback sender email is not configured. A System Admin must set FEEDBACK_FROM_EMAIL.' }, 503)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) return json({ error: 'The configured feedback sender email is invalid. Ask a System Admin to correct it.' }, 503)
  if (/[\r\n<>]/.test(senderName)) return json({ error: 'The configured feedback sender name is invalid. Ask a System Admin to correct it.' }, 503)
  const safeSenderName = senderName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const from = `"${safeSenderName}" <${senderEmail}>`

  let input: { enrollment_id?: string; body?: string; category?: string; feedback_id?: string | null }
  try { input = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const enrollmentId = input.enrollment_id?.trim()
  const feedbackBody = input.body?.trim()
  if (!enrollmentId || !feedbackBody) return json({ error: 'Student enrollment and feedback message are required' }, 400)
  if (feedbackBody.length > 12000) return json({ error: 'Feedback message exceeds the 12,000-character limit' }, 400)

  const { data: enrollment, error: enrollmentError } = await userClient
    .from('enrollments').select('id,student_id').eq('id', enrollmentId).eq('status', 'active').maybeSingle()
  if (enrollmentError || !enrollment) return json({ error: 'Student enrollment is not accessible' }, 403)
  const { data: student, error: studentError } = await userClient
    .from('students').select('email,first_name,last_name').eq('id', enrollment.student_id).maybeSingle()
  if (studentError || !student?.email?.trim()) return json({ error: 'The student does not have a registered email address' }, 422)

  // Save the message as a private draft first. This invokes the normal scoped
  // authorization path before any external email is sent.
  const { data: feedbackId, error: draftError } = await userClient.rpc('faculty_upsert_feedback', {
    p_feedback_id: input.feedback_id ?? null,
    p_enrollment_id: enrollmentId,
    p_body: feedbackBody,
    p_category: input.category ?? 'custom',
    p_status: 'draft',
  })
  if (draftError || typeof feedbackId !== 'string') return json({ error: draftError?.message ?? 'Feedback could not be saved as a draft' }, 403)

  const recordAttempt = async (status: 'sent' | 'failed', providerReference: string | null, safeError: string | null) => {
    const { error } = await adminClient.from('delivery_attempts').insert({
      feedback_id: feedbackId,
      channel: 'email',
      provider_reference: providerReference,
      status,
      safe_error: safeError,
      completed_at: new Date().toISOString(),
    })
    if (error) console.error('Could not record feedback email delivery attempt', error.message)
  }

  const name = `${student.first_name ?? ''} ${student.last_name ?? ''}`.trim() || 'Student'
  const plainText = `Hello ${name},\n\n${feedbackBody}\n\nThis feedback was sent by your instructor through APMS.`
  const html = `<p>Hello ${escapeHtml(name)},</p>${feedbackBody.split(/\r?\n/).map((line) => line ? `<p>${escapeHtml(line)}</p>` : '<br>').join('')}<p>This feedback was sent by your instructor through APMS.</p>`
  let providerReference: string | null = null
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(feedbackBody))
    const bodyFingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `feedback/${feedbackId}/${bodyFingerprint}` },
      body: JSON.stringify({
        from,
        to: [student.email.trim()],
        subject: 'Feedback from your instructor',
        text: plainText,
        html,
        ...(authData.user.email ? { reply_to: authData.user.email } : {}),
      }),
    })
    const responseBody = await response.json().catch(() => ({}))
    if (!response.ok) {
      const detail = typeof responseBody?.message === 'string' ? responseBody.message : 'Email provider rejected the message'
      await recordAttempt('failed', null, detail.slice(0, 500))
      return json({ error: `Email could not be sent: ${detail.slice(0, 220)}` }, 502)
    }
    providerReference = typeof responseBody?.id === 'string' ? responseBody.id : null
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'Email provider request failed'
    await recordAttempt('failed', null, detail.slice(0, 500))
    return json({ error: 'Email provider could not be reached. The feedback remains saved as a draft.' }, 502)
  }

  // Only mark feedback published after the provider accepts the email.
  const { error: publishError } = await userClient.rpc('faculty_upsert_feedback', {
    p_feedback_id: feedbackId,
    p_enrollment_id: enrollmentId,
    p_body: feedbackBody,
    p_category: input.category ?? 'custom',
    p_status: 'published',
  })
  if (publishError) {
    // The email has already been accepted. Reconcile the record only if it is
    // still this caller's draft for this same enrollment.
    const { error } = await adminClient.from('feedback_records').update({ status: 'published', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', feedbackId).eq('enrollment_id', enrollmentId).eq('author_id', authData.user.id).in('status', ['draft', 'ready'])
    if (error) console.error('Feedback email sent but publication reconciliation failed', error.message)
  }

  await recordAttempt('sent', providerReference, null)
  return json({ feedback_id: feedbackId, recipient: student.email.trim(), provider_reference: providerReference })
})
