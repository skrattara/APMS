import { describe, expect, it } from 'vitest'
import { persistableAIScores } from '../../../../supabase/functions/_shared/persistableAIScores'

const aiFactor = {
  id: 'risk-factor-original-id',
  source: 'ai_risk_level',
  aiGenerated: true,
  categories: ['low', 'medium', 'high'],
}

describe('persistable AI evaluation scores', () => {
  it('stores a validated model category under the original AI factor ID without changing other scores', () => {
    const originalScores = { attendance: 0.8 }
    const prediction = { evaluation_scores: originalScores, ai_risk_level: 'medium' }
    const result = persistableAIScores(prediction, [aiFactor], new Set(['risk_level']))

    expect(result).toEqual({ attendance: 0.8, 'risk-factor-original-id': 'medium' })
    expect(originalScores).toEqual({ attendance: 0.8 })
    expect(prediction).toEqual({ evaluation_scores: originalScores, ai_risk_level: 'medium' })
  })

  it('never copies a deterministic/manual level or an invalid category into model-owned scores', () => {
    expect(persistableAIScores(
      { evaluation_scores: {}, ai_risk_level: 'manual-level' },
      [aiFactor],
      new Set(['risk_level']),
    )).toEqual({})

    expect(persistableAIScores(
      { evaluation_scores: {}, ai_risk_level: 'medium' },
      [{ ...aiFactor, aiGenerated: false, origin: undefined }],
      new Set(['risk_level']),
    )).toEqual({})
  })

  it('respects the output allowlist and leaves the API prediction object untouched', () => {
    const prediction = { evaluation_scores: { other: true }, ai_risk_level: 'high' }
    const result = persistableAIScores(prediction, [aiFactor], new Set())
    expect(result).toEqual({ other: true })
    expect(prediction).toEqual({ evaluation_scores: { other: true }, ai_risk_level: 'high' })
  })
})
