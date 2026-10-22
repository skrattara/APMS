import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Scenario = {
  conditioning: boolean
  partial?: boolean
  assessmentType?: 'lp' | 'soc'
  score?: number | string
  includeUnscoredFrontendRow?: boolean
  categoricalInScore?: boolean
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const originalFetch = globalThis.fetch
const originalDeno = (globalThis as typeof globalThis & { Deno?: unknown }).Deno
const require = createRequire(import.meta.url)
const gradingTemplate = JSON.parse(readFileSync(resolve(repoRoot, 'supabase/functions/_shared/defaultGradingSystem.json'), 'utf8'))
const evaluationTemplate = JSON.parse(readFileSync(resolve(repoRoot, 'supabase/functions/_shared/defaultEvaluationSystem.json'), 'utf8'))

describe('assessment-context prediction gateway', () => {
  let handler: (request: Request) => Promise<Response>
  let scenario: Scenario
  let counters: { probe: number; reserve: number; infer: number; save: number }
  let sentBody: Record<string, any> | null
  const assessmentIds = [
    '33333333-3333-4333-8333-333333333331',
    '33333333-3333-4333-8333-333333333332',
  ]
  const enrollmentId = '22222222-2222-4222-8222-222222222222'
  const classId = '11111111-1111-4111-8111-111111111111'
  const modelVersionId = '44444444-4444-4444-8444-444444444444'
  const artifactId = 'a'.repeat(64)

  beforeEach(() => {
    // Only freeze Date: request deadline timers still run normally, while
    // relative-day expectations do not depend on the day this suite is run.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'))
  })

  afterEach(() => { vi.useRealTimers() })

  beforeAll(async () => {
    const grading = structuredClone(gradingTemplate)
    const evaluation = structuredClone(evaluationTemplate)
    evaluation.ai.provider = 'custom'
    evaluation.ai.inputFeatures = ['recent_scores', 'assessment_results', 'assessment_instance_details']
    evaluation.ai.outputFields = ['predicted_standing', 'trend', 'assessment_score_predictions']
    const environment: Record<string, string> = {
      SUPABASE_URL: 'https://database.example.test',
      SUPABASE_ANON_KEY: 'fixture-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-admin',
      APMS_AI_SERVICE_URL: 'https://ai.example.test',
      APMS_AI_SERVICE_API_KEY: 'fixture-only-service-token',
    }

    const getAssessments = () => assessmentIds.map((id, index) => {
      const assessmentType = scenario?.assessmentType ?? 'lp'
      return {
        id,
        type: assessmentType,
        component_key: assessmentType,
        grading_type_id: assessmentType,
        maximum_score: assessmentType === 'soc' ? 100 : 3,
        grading_group_id: 'm1',
        grading_period_id: 'p1',
        grading_instance_weight: null,
        optional: false,
        assessment_date: index === 0 ? '2026-10-10' : '2026-10-20',
        due_at: index === 0 ? '2026-10-11T00:00:00.000Z' : null,
      }
    })

    function query(table: string) {
      let single = false
      let updating = false
      const q: Record<string, any> = {}
      for (const method of ['select', 'eq', 'neq', 'in', 'order', 'limit']) q[method] = () => q
      q.update = () => { updating = true; return q }
      q.maybeSingle = () => { single = true; return q }
      q.then = (resolveResult: (value: unknown) => unknown, rejectResult: (reason: unknown) => unknown) => {
        let data: unknown
        switch (table) {
          case 'criteria_sets': data = { grading_system_definition: grading }; break
          case 'class_records': data = { id: classId, department_id: 'department-fixture' }; break
          case 'enrollments': data = [{ id: enrollmentId }]; break
          case 'faculty_class_evaluation_systems': data = { definition: evaluation }; break
          case 'class_evaluation_criteria': case 'evaluation_systems': data = null; break
          case 'system_settings':
            data = ['ai.enabled', 'ai.assessment_data.enabled', 'ai.attendance_data.enabled'].map((key) => ({ key, value: true }))
            break
          case 'assessments': data = getAssessments(); break
          case 'model_versions': data = updating ? { id: modelVersionId } : null; break
          case 'prediction_runs': case 'ai_model_usage': data = null; break
          default: throw new Error(`Unexpected mocked table: ${table}`)
        }
        if (!single && data && !Array.isArray(data)) data = [data]
        return Promise.resolve({ data, error: null }).then(resolveResult, rejectResult)
      }
      return q
    }

    const client = {
      auth: { getUser: async () => ({ data: { user: { id: 'fixture-faculty' } }, error: null }) },
      from: query,
      rpc: async (name: string) => {
        if (name === 'faculty_assert_ai_access') return { error: null }
        if (name === 'ai_custom_reserve_usage') { counters.reserve++; return { data: 'reservation-fixture', error: null } }
        if (name === 'faculty_save_prediction_run') { counters.save++; return { data: 'run-fixture', error: null } }
        throw new Error(`Unexpected mocked RPC: ${name}`)
      },
    }
    ;(globalThis as any).Deno = {
      env: { get: (key: string) => environment[key] },
      serve: (value: typeof handler) => { handler = value },
    }
    ;(globalThis as any).__mockCreateClient = () => client
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      let value: Record<string, any>
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (url === 'https://ai.example.test/v1/status') {
        counters.probe++
        value = {
          ready: true,
          model_version: 'fixture-model-v1',
          artifact_id: artifactId,
          synthetic_demo: true,
          capabilities: {
            v1_predictions: true,
            v2_forecasts: true,
            partial_assessment_inventory: scenario.partial === true,
            assessment_instance_conditioning: scenario.conditioning,
          },
        }
      } else if (url === 'https://ai.example.test/v1/predictions') {
        counters.infer++
        const requestBody = JSON.parse(String(init?.body)) as Record<string, any>
        sentBody = requestBody
        const scored = new Set((requestBody.student_records?.assessment_results ?? []).map((row: any) => row.assessment_ref))
        const target = requestBody.assessment_instances.find((instance: any) => !scored.has(instance.assessment_ref))
        const trendFactor = requestBody.evaluation_criteria.factors.find((factor: any) => factor.source === 'trend')
        const prediction = target.scoring.mode === 'value_mapping'
          ? { assessment_ref: target.assessment_ref, kind: 'categorical', categorical_value: target.scoring.mapping[0].value }
          : { assessment_ref: target.assessment_ref, kind: 'numeric', numeric_value: 2, maximum: target.maximum_score }
        value = {
          record_id: requestBody.record_id,
          predicted_standing: 75,
          trend: trendFactor.categories[0],
          assessment_predictions: [prediction],
        }
        headers.set('X-APMS-Artifact-ID', artifactId)
        headers.set('X-APMS-Model-Version', 'fixture-model-v1')
      } else throw new Error(`Unmocked request blocked: ${url}`)
      return new Response(JSON.stringify(value), { status: 200, headers })
    }) as typeof fetch

    const bundled = await build({
      entryPoints: [resolve(repoRoot, 'supabase/functions/apms-predictions/index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      logLevel: 'silent',
      plugins: [{ name: 'mock-supabase-sdk', setup(buildApi) {
        buildApi.onResolve({ filter: /^npm:/ }, (args) => ({ path: args.path, namespace: 'mock-supabase' }))
        buildApi.onLoad({ filter: /.*/, namespace: 'mock-supabase' }, () => ({
          contents: 'export const createClient = (...args) => globalThis.__mockCreateClient(...args);',
          loader: 'js',
        }))
      } }],
    })
    const module = { exports: {} as Record<string, unknown> }
    new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
    if (originalDeno === undefined) delete (globalThis as any).Deno
    else (globalThis as any).Deno = originalDeno
    delete (globalThis as any).__mockCreateClient
  })

  async function invoke(nextScenario: Scenario) {
    scenario = nextScenario
    counters = { probe: 0, reserve: 0, infer: 0, save: 0 }
    sentBody = null
    const grading = structuredClone(gradingTemplate)
    const evaluation = structuredClone(evaluationTemplate)
    evaluation.ai.provider = 'custom'
    evaluation.ai.inputFeatures = ['recent_scores', 'assessment_results', 'assessment_instance_details']
    evaluation.ai.outputFields = ['predicted_standing', 'trend', 'assessment_score_predictions']
    const body = {
      class_id: classId,
      grading_system: grading,
      evaluation_criteria: evaluation,
      inputs: [{
        enrollment_id: enrollmentId,
        evaluated_risk_level: 'unavailable',
        evaluation_values: { current_standing: null },
        records: {
          current_standing: null,
          recent_scores: [80],
          assessment_results: [
            scenario.assessmentType === 'soc'
              ? scenario.categoricalInScore
                ? { assessment_id: assessmentIds[0], score: scenario.score ?? 'A' }
                : { assessment_id: assessmentIds[0], categorical_value: scenario.score ?? 'A' }
              : { assessment_id: assessmentIds[0], score: scenario.score ?? 1 },
            ...(scenario.includeUnscoredFrontendRow
              ? [{ assessmentRef: assessmentIds[1], score: null, percentage: null, maximum: 3 }]
              : []),
          ],
        },
      }],
    }
    return await handler(new Request('https://edge.example.test/apms-predictions', {
      method: 'POST',
      headers: { Authorization: 'Bearer fixture-session', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }))
  }

  it('rejects assessment outputs from a ready legacy artifact before quota, inference, or persistence', async () => {
    const response = await invoke({ conditioning: false, partial: true })
    expect(response.status).toBe(409)
    expect(response.headers.get('X-APMS-Error-Code')).toBe('assessment_context_unsupported')
    expect((await response.json()).code).toBe('assessment_context_unsupported')
    expect(counters).toEqual({ probe: 1, reserve: 0, infer: 0, save: 0 })
  })

  it('sends privacy-projected, reference-bound v1 context and restores only validated forecasts', async () => {
    const response = await invoke({ conditioning: true, partial: true, includeUnscoredFrontendRow: true })
    expect(response.status, `${JSON.stringify(await response.clone().json())} counts=${JSON.stringify(counters)}`).toBe(200)
    const wire = sentBody!
    expect(wire.assessment_instances).toHaveLength(2)
    expect(wire.assessment_instances.map((row: any) => row.sequence)).toEqual([1, 2])
    expect(wire.assessment_instances[0].relative_day).toBeLessThan(-10)
    expect(wire.assessment_instances[0].relative_day).toBeGreaterThan(-11)
    expect(wire.assessment_instances[0].due_in_days).toBeLessThan(-9)
    expect(wire.assessment_instances[0].due_in_days).toBeGreaterThan(-10)
    expect(JSON.stringify(wire)).not.toContain(assessmentIds[0])
    expect(JSON.stringify(wire)).not.toContain('2026-10-10')
    expect(wire.student_records.assessment_results).toEqual([{
      assessment_ref: wire.assessment_instances[0].assessment_ref,
      value: 1,
      observed_day: 0,
    }])
    expect(wire.student_records.assessment_results[0].assessment_ref).not.toBe(wire.assessment_instances[1].assessment_ref)
    expect(counters).toEqual({ probe: 1, reserve: 1, infer: 1, save: 1 })
    const body = await response.json()
    expect(body.predictions[0].assessment_predictions).toEqual([{
      assessment_id: assessmentIds[1],
      result: { kind: 'numeric', value: 2, maximum: 3 },
    }])
  })

  it('keeps mapped zero scores and anonymizes canonical categorical values exactly once', async () => {
    const zeroResponse = await invoke({ conditioning: true, partial: true, assessmentType: 'lp', score: 0 })
    expect(zeroResponse.status).toBe(200)
    const zeroWire = sentBody!
    expect(zeroWire.student_records.assessment_results).toEqual([{
      assessment_ref: zeroWire.assessment_instances[0].assessment_ref,
      value: 0,
      observed_day: 0,
    }])

    const categoryResponse = await invoke({ conditioning: true, partial: true, assessmentType: 'soc', score: 'A', categoricalInScore: true })
    expect(categoryResponse.status).toBe(200)
    const categoryWire = sentBody!
    const mappedValue = categoryWire.student_records.assessment_results[0].value
    expect(typeof mappedValue).toBe('string')
    expect(mappedValue).not.toBe('A')
    expect(categoryWire.assessment_instances[0].scoring.mapping.map((item: any) => item.value)).toContain(mappedValue)
    expect(categoryWire.student_records.assessment_results).toEqual([{
      assessment_ref: categoryWire.assessment_instances[0].assessment_ref,
      value: mappedValue,
      observed_day: 0,
    }])
    const result = await categoryResponse.json()
    expect(result.predictions[0].assessment_predictions[0].assessment_id).toBe(assessmentIds[1])

    const invalidCategoryResponse = await invoke({ conditioning: true, partial: true, assessmentType: 'soc', score: 'NOT_A_SCHEMA_CATEGORY' })
    expect(invalidCategoryResponse.status).toBe(409)
    expect(invalidCategoryResponse.headers.get('X-APMS-Error-Code')).toBe('assessment_context_invalid')
    expect(counters).toEqual({ probe: 1, reserve: 0, infer: 0, save: 0 })
  })
})
