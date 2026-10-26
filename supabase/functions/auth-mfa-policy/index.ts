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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication is required.' }, 401)

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const callerClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  if (callerError || !callerData.user) return json({ error: 'Your session is invalid or has expired.' }, 401)

  const [profileResult, assignmentResult, settingsResult] = await Promise.all([
    admin.from('profiles').select('status').eq('id', callerData.user.id).maybeSingle(),
    admin.from('user_roles').select('scope_type,scope_id,roles!inner(key)').eq('user_id', callerData.user.id),
    admin.from('system_settings').select('key,value').in('key', ['security.mfa_required', 'security.mfa_required_roles', 'security.mfa_required_departments']),
  ])
  if (profileResult.error || assignmentResult.error || settingsResult.error) return json({ error: 'The sign-in security policy could not be checked.' }, 500)
  if (profileResult.data?.status !== 'active' || !assignmentResult.data?.length) return json({ error: 'This account is inactive or has no APMS role.' }, 403)

  const settings = new Map((settingsResult.data ?? []).map((row) => [row.key, row.value]))
  const asStringArray = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  const required = settings.get('security.mfa_required') === true
    || assignmentResult.data.some((assignment) => {
      const roleKey = (assignment.roles as unknown as { key: string }).key
      return asStringArray(settings.get('security.mfa_required_roles')).includes(roleKey)
        || (assignment.scope_type === 'department' && assignment.scope_id != null && asStringArray(settings.get('security.mfa_required_departments')).includes(assignment.scope_id))
    })
  return json({ required })
})
