import { createClient } from 'npm:@supabase/supabase-js@2.57.4'
import {
  aiServiceConfigurationFromEnvironment,
  createAIServiceStatusHandler,
  type AIServiceConfiguration,
} from '../_shared/aiService.ts'

function readConfiguration() {
  const model = Deno.env.get('APMS_AI_SERVICE_MODEL')
  try {
    return {
      value: aiServiceConfigurationFromEnvironment((name) => Deno.env.get(name)),
      valid: true,
      model,
    }
  } catch {
    // Expose only that configuration needs attention, never the URL or secret.
    return {
      value: aiServiceConfigurationFromEnvironment(() => undefined) as AIServiceConfiguration,
      valid: false,
      model,
    }
  }
}

const statusHandler = createAIServiceStatusHandler({
  authorize: async (request) => {
    const authorization = request.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) return { allowed: false, status: 401, error: 'Authentication required' }
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !anonKey || !serviceKey) return { allowed: false, status: 503, error: 'AI service settings are unavailable' }
    const userClient = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authorization } },
    })
    const { data: auth, error: authError } = await userClient.auth.getUser(authorization.slice(7))
    if (authError || !auth.user) return { allowed: false, status: 401, error: 'Invalid session' }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
    const now = new Date().toISOString()
    const [{ data: profile, error: profileError }, { data: assignments, error: assignmentsError }] = await Promise.all([
      admin.from('profiles').select('id,status').eq('id', auth.user.id).maybeSingle(),
      admin.from('user_roles').select('scope_type,scope_id,roles!inner(key)')
        .eq('user_id', auth.user.id).lte('valid_from', now)
        .or(`valid_until.is.null,valid_until.gt.${now}`),
    ])
    if (profileError || !profile || profile.status !== 'active') return { allowed: false, status: 403, error: 'Active account required' }
    if (assignmentsError) return { allowed: false, status: 503, error: 'Your account permissions could not be verified' }
    const isSystemAdmin = (assignments ?? []).some((row: any) =>
      row.roles?.key === 'system_admin' && row.scope_type === 'global'
    )
    if (!isSystemAdmin) return { allowed: false, status: 403, error: 'System Administrator access is required' }
    return { allowed: true }
  },
  configuration: readConfiguration,
  privacySettings: async () => {
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) throw new Error('unavailable')
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
    const { data: rows, error } = await admin.from('system_settings').select('key,value')
      .in('key', ['ai.enabled', 'ai.assessment_data.enabled', 'ai.attendance_data.enabled'])
    if (error) throw new Error('unavailable')
    const settings = new Map((rows ?? []).map((row: any) => [row.key, row.value]))
    const enabled = (key: string) => settings.get(key) === true || settings.get(key) === 'true'
    return {
      ai_enabled: enabled('ai.enabled'),
      assessment_data_enabled: enabled('ai.assessment_data.enabled'),
      attendance_data_enabled: enabled('ai.attendance_data.enabled'),
    }
  },
})

Deno.serve(statusHandler)
