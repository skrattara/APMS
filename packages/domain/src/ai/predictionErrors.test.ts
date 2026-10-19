import { describe, expect, it } from 'vitest';
import {
  forecastError,
  forecastRequestError,
  formatForecastError,
  SavedForecastResponseError,
} from '../../../../apps/mobile/src/services/predictionErrors';

describe('safe forecast errors', () => {
  it('identifies a valid saved run whose client response could not be verified', () => {
    const error = new SavedForecastResponseError('b8b7f36e-4346-4be0-bd32-1df42dd2d643');
    const message = formatForecastError(error);
    expect(message).toContain('forecast run was saved');
    expect(message).toContain('Refresh saved predictions');
    expect(message).not.toContain(error.savedRunId);
  });

  it('explains the local no-eligible-students precondition', () => {
    expect(formatForecastError(forecastError('no_eligible_students')))
      .toContain('enable Recent scores to forecast before a final standing is available');
  });

  it.each([
    [401, 'Sign in again'],
    [403, 'do not allow this request'],
    [409, 'grading or model setup'],
    [413, 'smaller class'],
    [429, 'monthly limit'],
    [502, 'provider did not complete'],
    [503, 'service is unavailable'],
    [504, 'timed out'],
  ])('maps HTTP %i to fixed guidance', (status, expected) => {
    const message = formatForecastError(forecastRequestError({ status }));
    expect(message).toContain(expected);
    expect(message).toContain(`HTTP ${status}`);
  });

  it('uses allowlisted machine codes without reading a response body', () => {
    expect(formatForecastError(forecastRequestError({
      status: 409,
      headers: { get: () => 'partial_inventory_unsupported' },
      json: async () => ({ error: 'private details' }),
    }))).toContain('Update the model service');
    expect(formatForecastError(forecastRequestError({
      status: 409,
      headers: { get: () => 'assessment_count_constraint' },
    }))).toContain('count limit');
    expect(formatForecastError(forecastRequestError({
      status: 409,
      headers: { get: () => 'unrecognized' },
    }))).toContain('grading or model setup');
  });

  it('maps bounded provider request codes to fixed guidance', () => {
    for (const [code, expected] of [
      ['request_too_large', 'service size limit'],
      ['provider_timeout', 'timed out'],
      ['request_timeout', 'timed out'],
      ['provider_unavailable', 'temporarily unavailable'],
      ['invalid_response', 'could not be verified'],
    ] as const) {
      const status = code === 'request_too_large' ? 413 : code.endsWith('timeout') ? 504 : 502;
      expect(formatForecastError(forecastRequestError({ status, headers: { get: () => code } }))).toContain(expected);
    }
  });

  it('maps provider-specific failures to safe guidance without exposing provider text', () => {
    const expected = [
      ['provider_authentication_failed', 'verify the provider credentials'],
      ['provider_request_rejected', 'review service compatibility and logs'],
      ['provider_busy', 'will not retry automatically'],
      ['provider_connection_failed', 'could not connect to its provider'],
    ] as const;
    for (const [code, phrase] of expected) {
      const message = formatForecastError(forecastRequestError({
        status: 502,
        headers: { get: () => code },
        json: async () => ({ error: 'private provider response' }),
      }));
      expect(message).toContain(phrase);
      expect(message).not.toContain('private provider response');
    }
  });

  it('never displays hostile backend text or arbitrary Error.message values', () => {
    const response = { status: 503, json: async () => ({ error: 'secret bearer token and student name' }) };
    const safe = formatForecastError(forecastRequestError(response));
    expect(safe).toContain('service is unavailable');
    expect(safe).not.toContain('secret');
    expect(formatForecastError(new Error('private response payload'))).not.toContain('private response payload');
  });

  it('treats missing or malformed status metadata as an unconfirmed network failure', () => {
    expect(formatForecastError(forecastRequestError(undefined))).toContain('did not confirm whether the forecast was saved');
    expect(formatForecastError(forecastRequestError({ status: '503' }))).toContain('did not confirm whether the forecast was saved');
  });
});
