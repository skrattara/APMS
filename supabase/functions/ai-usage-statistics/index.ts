import { createClient } from 'npm:@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
})

type UsageRow = {
  id?: string
  actor_id?: string | null
  class_record_id?: string | null
  provider: string
  model: string
  feature: string
  request_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  succeeded: boolean
  created_at?: string
}
type UsageGroup = { provider: string; model: string; feature: string; requests: number; succeeded: number; failed: number; inputTokens: number; outputTokens: number }
type UsageSummary = { requests: number; succeeded: number; failed: number; inputTokens: number; outputTokens: number; byModel: UsageGroup[] }
type UsageAccumulator = { totals: UsageSummary; groups: Map<string, UsageGroup>; daily: Map<string, number> }
const emptyAccumulator = (): UsageAccumulator => ({
  totals: { requests: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, byModel: [] },
  groups: new Map(),
  daily: new Map(),
})

function accumulate(target: UsageAccumulator, rows: UsageRow[]) {
  for (const row of rows) {
    const requests = Number(row.request_count ?? 0)
    const succeeded = row.succeeded ? requests : 0
    const failed = row.succeeded ? 0 : requests
    const inputTokens = Number(row.input_tokens ?? 0)
    const outputTokens = Number(row.output_tokens ?? 0)
    target.totals.requests += requests
    target.totals.succeeded += succeeded
    target.totals.failed += failed
    target.totals.inputTokens += inputTokens
    target.totals.outputTokens += outputTokens
    if (row.created_at) {
      const day = row.created_at.slice(0, 10)
      target.daily.set(day, (target.daily.get(day) ?? 0) + requests)
    }
    const key = `${row.provider}\u0000${row.model}\u0000${row.feature}`
    const group = target.groups.get(key) ?? { provider: row.provider, model: row.model, feature: row.feature, requests: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0 }
    group.requests += requests
    group.succeeded += succeeded
    group.failed += failed
    group.inputTokens += inputTokens
    group.outputTokens += outputTokens
    target.groups.set(key, group)
  }
}

async function readPages(queryForRange: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: { message: string } | null }>, target: UsageAccumulator) {
  const pageSize = 1000
  const maximumRows = 100_000
  for (let from = 0; from < maximumRows; from += pageSize) {
    const { data, error } = await queryForRange(from, from + pageSize - 1)
    if (error) return false
    const rows = (data ?? []) as UsageRow[]
    accumulate(target, rows)
    if (rows.length < pageSize) return true
  }
  return false
}

function finish(target: UsageAccumulator): UsageSummary {
  target.totals.byModel = [...target.groups.values()].sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  return target.totals
}

const usageColumns = 'id,actor_id,class_record_id,provider,model,feature,request_count,input_tokens,output_tokens,succeeded,created_at'
const isDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function systemAdminUsage(admin: ReturnType<typeof createClient>, rawFilters: any) {
  const today = new Date().toISOString().slice(0, 10)
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const from = isDate(rawFilters?.from) ? rawFilters.from : monthStart.toISOString().slice(0, 10)
  const to = isDate(rawFilters?.to) ? rawFilters.to : today
  if (from > to) return json({ error: 'The start date must be on or before the end date.' }, 400)
  const page = Number.isSafeInteger(Number(rawFilters?.page)) ? Math.max(0, Math.min(100_000, Number(rawFilters.page))) : 0
  const pageSize = [25, 50, 100].includes(Number(rawFilters?.pageSize)) ? Number(rawFilters.pageSize) : 25
  const selectedUser = typeof rawFilters?.userId === 'string' && rawFilters.userId !== 'all' ? rawFilters.userId : null
  const systemOnly = selectedUser === 'system'
  const userId = selectedUser && !systemOnly ? selectedUser : null
  const provider = typeof rawFilters?.provider === 'string' && rawFilters.provider !== 'all' ? rawFilters.provider : null
  const model = typeof rawFilters?.model === 'string' && rawFilters.model !== 'all' ? rawFilters.model : null
  const feature = typeof rawFilters?.feature === 'string' && rawFilters.feature !== 'all' ? rawFilters.feature : null
  const since = `${from}T00:00:00.000Z`
  const until = `${to}T23:59:59.999Z`
  const summary = emptyAccumulator()
  const providers = new Set<string>()
  const models = new Set<string>()
  const features = new Set<string>()
  const actors = new Set<string>()
  if (userId) actors.add(userId)
  let hasSystemActor = false
  const maxRows = 100_000
  const pageSizeRead = 1000
  let totalScanned = 0
  for (let offset = 0; offset < maxRows; offset += pageSizeRead) {
    const { data, error } = await admin.from('ai_model_usage').select(usageColumns)
      .gte('created_at', since).lte('created_at', until).order('created_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + pageSizeRead - 1)
    if (error) return json({ error: 'System-wide AI usage could not be loaded' }, 503)
    const rows = (data ?? []) as UsageRow[]
    totalScanned += rows.length
    for (const row of rows) {
      providers.add(row.provider)
      models.add(row.model)
      features.add(row.feature)
      if (row.actor_id) actors.add(row.actor_id)
      else hasSystemActor = true
      if (userId && row.actor_id !== userId) continue
      if (systemOnly && row.actor_id != null) continue
      if (provider && row.provider !== provider) continue
      if (model && row.model !== model) continue
      if (feature && row.feature !== feature) continue
      accumulate(summary, [row])
    }
    if (rows.length < pageSizeRead) break
    if (offset + pageSizeRead >= maxRows) return json({ error: 'This date range contains too many records to summarize. Narrow the range and try again.' }, 413)
  }
  const userOptions: Array<{ id: string; label: string }> = []
  const actorIds = [...actors]
  for (let offset = 0; offset < actorIds.length; offset += 100) {
    const { data: profiles, error } = await admin.from('profiles').select('id,first_name,last_name,email').in('id', actorIds.slice(offset, offset + 100))
    if (error) return json({ error: 'System Admin user filters could not be loaded' }, 503)
    for (const profile of profiles ?? []) {
      const name = `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim()
      userOptions.push({ id: profile.id, label: name ? `${name} · ${profile.email}` : profile.email })
    }
  }
  if (hasSystemActor || systemOnly) userOptions.push({ id: 'system', label: 'System process' })
  userOptions.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))

  let recordQuery = admin.from('ai_model_usage').select(usageColumns, { count: 'exact' })
    .gte('created_at', since).lte('created_at', until).order('created_at', { ascending: false }).order('id', { ascending: false })
  if (userId) recordQuery = recordQuery.eq('actor_id', userId)
  else if (systemOnly) recordQuery = recordQuery.is('actor_id', null)
  if (provider) recordQuery = recordQuery.eq('provider', provider)
  if (model) recordQuery = recordQuery.eq('model', model)
  if (feature) recordQuery = recordQuery.eq('feature', feature)
  const { data: records, count, error: recordError } = await recordQuery.range(page * pageSize, (page + 1) * pageSize - 1)
  if (recordError) return json({ error: 'Individual AI usage records could not be loaded' }, 503)
  const rowActors = [...new Set((records ?? []).map((row: any) => row.actor_id).filter((id: unknown): id is string => typeof id === 'string'))]
  const actorProfiles = new Map<string, { name: string; email: string }>()
  for (let offset = 0; offset < rowActors.length; offset += 100) {
    const { data: profiles, error } = await admin.from('profiles').select('id,first_name,last_name,email').in('id', rowActors.slice(offset, offset + 100))
    if (error) return json({ error: 'Individual usage record users could not be loaded' }, 503)
    for (const profile of profiles ?? []) actorProfiles.set(profile.id, { name: `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim(), email: profile.email })
  }
  const detailedRecords = (records ?? []).map((row: any) => ({
    createdAt: row.created_at,
    user: row.actor_id ? actorProfiles.get(row.actor_id)?.name || actorProfiles.get(row.actor_id)?.email || 'Former account' : 'System process',
    email: row.actor_id ? actorProfiles.get(row.actor_id)?.email ?? '' : '',
    provider: row.provider,
    model: row.model,
    feature: row.feature,
    usageUnits: Number(row.request_count ?? 0),
    succeeded: Boolean(row.succeeded),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
  }))
  return json({
    from,
    to,
    totalScanned,
    summary: finish(summary),
    daily: [...summary.daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, requests]) => ({ day, requests })),
    providers: [...providers].sort(),
    models: [...models].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
    features: [...features].sort(),
    users: userOptions,
    records: detailedRecords,
    totalRecords: count ?? 0,
    page,
    pageSize,
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405)
  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) return json({ error: 'AI usage statistics are unavailable' }, 503)
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const { data: auth, error: authError } = await userClient.auth.getUser(authorization.slice(7))
  if (authError || !auth.user) return json({ error: 'Invalid session' }, 401)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const now = new Date().toISOString()
  const [{ data: profile, error: profileError }, { data: assignments, error: assignmentError }] = await Promise.all([
    admin.from('profiles').select('id,status').eq('id', auth.user.id).maybeSingle(),
    admin.from('user_roles').select('scope_type,scope_id,roles!inner(key)').eq('user_id', auth.user.id).lte('valid_from', now).or(`valid_until.is.null,valid_until.gt.${now}`),
  ])
  if (profileError || !profile || profile.status !== 'active') return json({ error: 'Active account required' }, 403)
  if (assignmentError) return json({ error: 'Your account role could not be verified' }, 503)
  const roles = new Set((assignments ?? []).map((row: any) => row.roles?.key).filter((key: unknown) => typeof key === 'string'))
  const academicAdminDepartments = [...new Set((assignments ?? [])
    .filter((row: any) => row.roles?.key === 'academic_admin' && row.scope_type === 'department' && row.scope_id)
    .map((row: any) => row.scope_id as string))]
  if (![...roles].some((role) => ['faculty', 'academic_admin', 'system_admin'].includes(role))) return json({ error: 'AI usage statistics are not available for this account' }, 403)
  if (roles.has('academic_admin') && !academicAdminDepartments.length) return json({ error: 'No authorized department scope is assigned' }, 403)

  if (request.method === 'POST') {
    if (!roles.has('system_admin') || !(assignments ?? []).some((row: any) => row.roles?.key === 'system_admin' && row.scope_type === 'global')) return json({ error: 'Detailed system-wide usage is restricted to System Admins' }, 403)
    let filters: any
    try { filters = await request.json() } catch { return json({ error: 'Invalid filter request' }, 400) }
    return await systemAdminUsage(admin, filters)
  }

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const since = monthStart.toISOString()
  const selectColumns = usageColumns
  const personal = emptyAccumulator()
  const personalRead = await readPages(
    (from, to) => admin.from('ai_model_usage').select(selectColumns).eq('actor_id', auth.user.id).gte('created_at', since).order('created_at', { ascending: true }).range(from, to),
    personal,
  )
  if (!personalRead) return json({ error: 'Your AI usage statistics could not be fully loaded' }, 503)

  let department: { name: string; usage: UsageSummary } | null = null
  if (roles.has('academic_admin')) {
    const [{ data: classes, error: classesError }, { data: departments, error: departmentsError }] = await Promise.all([
      admin.from('class_records').select('id').in('department_id', academicAdminDepartments),
      admin.from('departments').select('id,name,code').in('id', academicAdminDepartments),
    ])
    if (classesError || departmentsError) return json({ error: 'Department usage scope could not be loaded' }, 503)
    const classIds = [...new Set((classes ?? []).map((row: any) => row.id as string))]
    const departmentUsage = emptyAccumulator()
    for (let offset = 0; offset < classIds.length; offset += 80) {
      const classChunk = classIds.slice(offset, offset + 80)
      const complete = await readPages(
        (from, to) => admin.from('ai_model_usage').select(selectColumns).in('class_record_id', classChunk).gte('created_at', since).order('created_at', { ascending: true }).range(from, to),
        departmentUsage,
      )
      if (!complete) return json({ error: 'Department AI usage statistics could not be fully loaded' }, 503)
    }
    const names = (departments ?? []).map((row: any) => `${row.code ? `${row.code} · ` : ''}${row.name}`)
    department = { name: names.join(', ') || 'Authorized department', usage: finish(departmentUsage) }
  }

  return json({
    month: new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthStart),
    personal: finish(personal),
    department,
  })
})
