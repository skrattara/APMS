import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
const providers = new Set(['openai', 'gemini'])

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!service) return json({ error: 'AI credential storage is unavailable' }, 503)
  const userClient = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } })
  const { data: auth, error: authError } = await userClient.auth.getUser(authorization.slice(7))
  if (authError || !auth.user) return json({ error: 'Invalid session' }, 401)
  const admin = createClient(url, service, { auth: { persistSession: false } })
  const now = new Date().toISOString()
  const [{ data: profile, error: profileError }, { data: assignments, error: assignmentsError }] = await Promise.all([
    admin.from('profiles').select('id,status').eq('id', auth.user.id).maybeSingle(),
    admin.from('user_roles').select('scope_type,scope_id,roles!inner(key)').eq('user_id', auth.user.id).lte('valid_from', now).or(`valid_until.is.null,valid_until.gt.${now}`),
  ])
  if (profileError || !profile || profile.status !== 'active') return json({ error: 'Active account required' }, 403)
  if (assignmentsError) return json({ error: 'Your account scopes could not be verified' }, 503)
  const departments = [...new Set((assignments ?? []).filter((row: any) => row.roles?.key === 'academic_admin' && row.scope_type === 'department' && row.scope_id).map((row: any) => row.scope_id as string))]
  const isSystemAdmin = (assignments ?? []).some((row: any) => row.roles?.key === 'system_admin' && row.scope_type === 'global')
  const thisMonth = new Date(); thisMonth.setUTCDate(1); thisMonth.setUTCHours(0, 0, 0, 0)

  if (request.method === 'GET') {
    if (!isSystemAdmin && departments.length === 0) return json({ error: 'AI provider settings are available to Academic Admins for their departments.' }, 403)
    const visibleScopes = departments.map((scope_id: string) => ({ scope_type: 'department', scope_id }))
    const { data: departmentRows } = departments.length ? await admin.from('departments').select('id,name,code').in('id', departments) : { data: [] as any[] }
    const departmentLabels = new Map((departmentRows ?? []).map((row: any) => [row.id, `${row.code ? `${row.code} · ` : ''}${row.name}`]))
    const { data: credentials, error } = departments.length
      ? await admin.from('ai_provider_credentials').select('scope_type,scope_id,provider,model,monthly_request_limit,monthly_token_limit,updated_at,enabled').eq('scope_type', 'department').in('scope_id', departments)
      : { data: [] as any[], error: null }
    if (error) return json({ error: 'Provider settings could not be loaded' }, 503)
    const { data: departmentUsage, error: departmentUsageError } = departments.length
      ? await admin.rpc('ai_provider_usage_summary', { p_scope_type: 'department', p_scope_ids: departments, p_since: thisMonth.toISOString() })
      : { data: [], error: null }
    if (departmentUsageError) return json({ error: 'Department provider usage could not be loaded' }, 503)
    const { data: globalSettings } = isSystemAdmin ? await admin.from('system_settings').select('key,value').in('key', ['ai.usage.monthly_request_limit', 'ai.usage.monthly_token_limit']) : { data: [] as any[] }
    let systemUsage = { requests: 0, inputTokens: 0, outputTokens: 0 }
    let systemUsageByModel: any[] = []
    let adminUsage: any = null
    let adminUsageByScope: any[] = []
    if (isSystemAdmin) {
      const { data: rows, error: systemUsageError } = await admin.rpc('ai_provider_usage_summary', { p_scope_type: 'system', p_scope_ids: [], p_since: thisMonth.toISOString() })
      if (systemUsageError) return json({ error: 'System provider usage could not be loaded' }, 503)
      systemUsageByModel = rows ?? []
      systemUsage = (rows ?? []).reduce((sum: any, row: any) => { sum.requests += Number(row.requests ?? 0); sum.inputTokens += Number(row.input_tokens ?? 0); sum.outputTokens += Number(row.output_tokens ?? 0); return sum }, systemUsage)
      const { data: allRows, error: allUsageError } = await admin.rpc('ai_provider_usage_summary', { p_scope_type: 'all', p_scope_ids: [], p_since: thisMonth.toISOString() })
      if (allUsageError) return json({ error: 'All-provider usage could not be loaded' }, 503)
      adminUsageByScope = allRows ?? []
      adminUsage = adminUsageByScope.reduce((sum: any, row: any) => { sum.requests += Number(row.requests ?? 0); sum.inputTokens += Number(row.input_tokens ?? 0); sum.outputTokens += Number(row.output_tokens ?? 0); return sum }, { requests: 0, inputTokens: 0, outputTokens: 0 })
    }
    return json({
      scopes: visibleScopes.map((item) => ({ ...item, label: departmentLabels.get(item.scope_id) ?? 'Authorized department' })),
      credentials: (credentials ?? []).map((row: any) => ({ ...row, configured: true, keyHint: '••••••••' })),
      usage: (departmentUsage ?? []).reduce((sum: any, row: any) => {
        sum.requests += Number(row.requests ?? 0); sum.inputTokens += Number(row.input_tokens ?? 0); sum.outputTokens += Number(row.output_tokens ?? 0)
        return sum
      }, { requests: 0, inputTokens: 0, outputTokens: 0 }),
      usageByModel: departmentUsage ?? [],
      globalLimits: Object.fromEntries((globalSettings ?? []).map((item: any) => [item.key, item.value])),
      canManageDepartment: departments.length > 0,
      canManageSystem: isSystemAdmin,
      systemUsage,
      systemUsageByModel,
      adminUsage,
      adminUsageByScope,
      systemProviders: isSystemAdmin ? {
        openai: { configured: !!Deno.env.get('OPENAI_API_KEY'), model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4.1-mini' },
        gemini: { configured: !!Deno.env.get('GEMINI_API_KEY'), model: Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash' },
      } : undefined,
    })
  }

  let body: any
  try { body = await request.json() } catch { return json({ error: 'Invalid JSON body' }, 400) }
  const scopeType = body.scopeType
  const scopeId = body.scopeId
  const provider = String(body.provider ?? '').toLowerCase()
  if (!providers.has(provider)) return json({ error: 'Choose OpenAI or Gemini' }, 400)
  if (scopeType !== 'department') return json({ error: 'Only department-provided credentials can be managed here.' }, 400)
  if (!departments.includes(scopeId)) return json({ error: 'Department credential management requires an Academic Admin assignment in that department' }, 403)

  if (request.method === 'DELETE') {
    const { error } = await admin.rpc('ai_provider_delete_credential', { p_scope_type: scopeType, p_scope_id: scopeId, p_provider: provider })
    return error ? json({ error: 'Provider key could not be removed' }, 500) : json({ ok: true })
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (apiKey && (apiKey.length < 12 || apiKey.length > 500)) return json({ error: 'Enter a valid provider API key (12–500 characters).' }, 400)
  const requestLimit = body.monthlyRequestLimit === '' || body.monthlyRequestLimit == null ? null : Number(body.monthlyRequestLimit)
  const tokenLimit = body.monthlyTokenLimit === '' || body.monthlyTokenLimit == null ? null : Number(body.monthlyTokenLimit)
  if ((requestLimit !== null && (!Number.isSafeInteger(requestLimit) || requestLimit < 0)) || (tokenLimit !== null && (!Number.isSafeInteger(tokenLimit) || tokenLimit < 0))) return json({ error: 'Monthly limits must be non-negative whole numbers, or blank for unlimited.' }, 400)
  if (!apiKey) {
    const { data: existing } = await admin.from('ai_provider_credentials').select('id').eq('scope_type', 'department').eq('scope_id', scopeId).eq('provider', provider).eq('enabled', true).maybeSingle()
    if (!existing) return json({ error: 'Enter an API key to configure this provider.' }, 400)
    const { error } = await admin.rpc('ai_provider_update_credential_limits', {
      p_scope_type: scopeType, p_scope_id: scopeId, p_provider: provider, p_model: typeof body.model === 'string' ? body.model.slice(0, 120) : null,
      p_monthly_request_limit: requestLimit, p_monthly_token_limit: tokenLimit, p_updated_by: auth.user.id,
    })
    return error ? json({ error: 'Provider limits could not be saved.' }, 500) : json({ ok: true, message: 'Provider settings saved.' })
  }
  const { error } = await admin.rpc('ai_provider_store_credential', {
    p_scope_type: scopeType, p_scope_id: scopeId, p_provider: provider, p_api_key: apiKey,
    p_model: typeof body.model === 'string' ? body.model.slice(0, 120) : null,
    p_monthly_request_limit: requestLimit, p_monthly_token_limit: tokenLimit, p_updated_by: auth.user.id,
  })
  return error ? json({ error: 'Provider key could not be saved. Check that Supabase Vault is available.' }, 500) : json({ ok: true, message: 'Provider key saved securely.' })
})
