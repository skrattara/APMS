import { describe, expect, it } from 'vitest'
import { anonymizeAcademicData, buildAssessmentTemporalContext } from './aiPrivacy'

const cutoff = Date.parse('2026-10-20T00:00:00.000Z')

describe('privacy-safe assessment timeline', () => {
  it('uses dense distinct-date sequence ranks and preserves date ties', () => {
    const rows = [
      { id: 'opaque-b', assessment_date: '2026-10-18', due_at: '2026-10-21T12:00:00Z' },
      { id: 'opaque-a', assessment_date: '2026-10-18', due_at: null },
      { id: 'opaque-c', assessment_date: '2026-10-20' },
    ]
    const context = buildAssessmentTemporalContext(rows, cutoff)
    expect(context.get('opaque-a')?.sequence).toBe(context.get('opaque-b')?.sequence)
    expect(context.get('opaque-c')?.sequence).toBeGreaterThan(context.get('opaque-a')!.sequence)
    expect(context.get('opaque-b')).toMatchObject({ relative_day: -2, due_in_days: 1.5 })
    expect(context.get('opaque-a')).toMatchObject({ relative_day: -2 })
    expect(context.get('opaque-c')).toMatchObject({ relative_day: 0 })
    expect(JSON.stringify([...context.values()])).not.toMatch(/opaque-|2026-10-/)
  })

  it('does not depend on request row order and leaves undated instances tied without time features', () => {
    const rows = [
      { id: 'first', assessment_date: '2026-10-17' },
      { id: 'second', assessment_date: '2026-10-19', due_at: '2127-01-01T00:00:00Z' },
      { id: 'undated-a', assessment_date: null },
      { id: 'undated-b', assessment_date: null },
    ]
    const forward = buildAssessmentTemporalContext(rows, cutoff)
    const reverse = buildAssessmentTemporalContext([...rows].reverse(), cutoff)
    expect(forward.get('first')).toEqual(reverse.get('first'))
    expect(forward.get('second')).toEqual(reverse.get('second'))
    expect(forward.get('first')).not.toHaveProperty('due_in_days')
    expect(forward.get('second')).not.toHaveProperty('due_in_days')
    expect(forward.get('undated-a')).toEqual({ sequence: 0 })
    expect(forward.get('undated-b')).toEqual({ sequence: 0 })
    expect(forward.get('first')?.sequence).toBe(1)
  })

  it('rejects invalid canonical dates and duplicate private lookup identifiers', () => {
    expect(() => buildAssessmentTemporalContext([{ id: 'x', assessment_date: 'unknown' }], cutoff)).toThrow(/invalid assessment date/)
    expect(() => buildAssessmentTemporalContext([
      { id: 'x', assessment_date: '2026-10-18' },
      { id: 'x', assessment_date: '2026-10-19' },
    ], cutoff)).toThrow(/duplicate assessment identifiers/)
  })

  it('projects versioned observed values through opaque refs without forwarding dates or private fields', () => {
    const data = anonymizeAcademicData({
      assessment_results: [
        { assessment_id: 'raw-numeric-id', score: 75, maximum_score: 100, updated_at: '2026-10-19T00:00:00Z', title: 'Private quiz title' },
        { assessmentRef: 'raw-category-id', categorical_value: 'Excellent', maximum: 10, title: 'Private quiz title', email: 'private@example.test' },
      ],
    }, true, false, (value) => value === 'Excellent' ? 'category_safe' : undefined,
    (value) => value === 'raw-numeric-id' ? 'assessment_safe_1' : value === 'raw-category-id' ? 'assessment_safe_2' : undefined,
    undefined,
    { version: 1, cutoffMs: cutoff, undatedAssessmentIds: new Set(['raw-category-id']) })

    expect(data.assessment_results).toEqual([
      { assessment_ref: 'assessment_safe_1', value: 75, observed_day: -1 },
      { assessment_ref: 'assessment_safe_2', value: 'category_safe', observed_day: null },
    ])
    const serialized = JSON.stringify(data)
    expect(serialized).not.toContain('raw-')
    expect(serialized).not.toContain('Excellent')
    expect(serialized).not.toContain('2026-10-')
    expect(serialized).not.toContain('Private quiz title')
    expect(serialized).not.toContain('private@example.test')
  })

  it('rejects future observations and result rows without a valid score or reference', () => {
    const opts = { version: 1 as const, cutoffMs: cutoff }
    const mapRef = (value: string) => value === 'raw-id' ? 'assessment_safe' : undefined
    expect(() => anonymizeAcademicData({ assessment_results: [
      { assessment_id: 'raw-id', score: 50, maximum_score: 100, updated_at: '2026-10-21T00:00:00Z' },
    ] }, true, false, undefined, mapRef, undefined, opts)).toThrow(/after the request cutoff/)
    expect(anonymizeAcademicData({ assessment_results: [
      { assessment_id: 'raw-id' },
    ] }, true, false, undefined, mapRef, undefined, opts)).toEqual({ assessment_results: [] })
    expect(() => anonymizeAcademicData({ assessment_results: [
      { score: 50, maximum_score: 100 },
    ] }, true, false, undefined, mapRef, undefined, opts)).toThrow(/no valid reference/)
  })
})
