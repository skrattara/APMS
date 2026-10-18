import { describe, expect, it, vi } from 'vitest';
import { formatForecastError } from '../../../../apps/mobile/src/services/predictionErrors';
import { planPredictionRequestBatches, predictionBatchItemLimit } from '../../../../apps/mobile/src/services/predictionBatching';

describe('forecast request batching', () => {
  it('measures complete JSON bodies in UTF-8 bytes and preserves every item in order', () => {
    const base = { class_id: 'c', grading_system: { title: '評分規則'.repeat(12) }, evaluation_criteria: { version: 2 } };
    const records = [{ value: '學生✓' }, { value: 'é🧪' }, { value: 'third' }];
    const sampleLength = new TextEncoder().encode(JSON.stringify({ ...base, inputs: [records[0]] })).length;
    const batches = planPredictionRequestBatches(base, records, {
      maxBytes: sampleLength + 5,
      maxItems: 10,
      encodeItem: (item) => item,
    });

    expect(batches.length).toBe(3);
    expect(batches.flatMap((batch) => batch.items)).toEqual(records);
    for (const batch of batches) {
      expect(batch.byteLength).toBe(new TextEncoder().encode(JSON.stringify(batch.body)).length);
      expect(batch.byteLength).toBeLessThanOrEqual(sampleLength + 5);
      expect(batch.body.grading_system).toEqual(base.grading_system);
    }
  });

  it('uses a conservative 10-record working cap for every provider', () => {
    expect(predictionBatchItemLimit('Gemini')).toBe(10);
    expect(predictionBatchItemLimit('OpenAI')).toBe(10);
    expect(predictionBatchItemLimit('APMS custom')).toBe(10);
    expect(predictionBatchItemLimit(undefined)).toBe(10);
  });

  it('rejects a single oversized record during full-plan preflight before any request can be sent', () => {
    const invoke = vi.fn();
    const base = { class_id: 'c', grading_system: { schema: 's'.repeat(100) } };
    expect(() => {
      const batches = planPredictionRequestBatches(base, [{ id: 'small' }, { id: 'oversized', content: 'x'.repeat(500) }], {
        maxBytes: 200,
        maxItems: 10,
        encodeItem: (item) => item,
      });
      for (const batch of batches) invoke(batch);
    }).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('gives fixed, private guidance when the request cannot fit even as one student', () => {
    try {
      planPredictionRequestBatches({ schema: 'x'.repeat(50) }, [{ record: 'y'.repeat(500) }], {
        maxBytes: 100,
        encodeItem: (item) => item,
      });
    } catch (error) {
      expect(formatForecastError(error)).toContain('One forecast request is too large');
      expect(formatForecastError(error)).not.toContain('y'.repeat(50));
      return;
    }
    throw new Error('Expected request preflight to reject an oversized input.');
  });
});
