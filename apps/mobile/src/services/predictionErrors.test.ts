import { describe, expect, it } from 'vitest';

import { formatForecastError, forecastRequestError } from './predictionErrors';

describe('assessment-context rollout error', () => {
  it('maps only the exact allowlisted code to upgrade guidance', () => {
    const error = forecastRequestError({
      status: 409,
      headers: { get: (name: string) => name.toLowerCase() === 'x-apms-error-code' ? 'assessment_context_unsupported' : null },
    });

    expect(formatForecastError(error)).toContain('upgrade the model artifact');
    expect(formatForecastError(error)).toContain('turn off Assessment score predictions');
  });

  it('maps validated assessment-data failures to nontechnical guidance', () => {
    const error = forecastRequestError({
      status: 409,
      headers: { get: (name: string) => name.toLowerCase() === 'x-apms-error-code' ? 'assessment_context_invalid' : null },
    });

    expect(formatForecastError(error)).toContain('recorded assessment values or dates');
    expect(formatForecastError(error)).not.toContain('observed_day');
  });

  it('never exposes a forged or arbitrary provider error header', () => {
    const secret = 'private-provider-body-and-token';
    const error = forecastRequestError({
      status: 409,
      headers: { get: () => `${secret} assessment_context_unsupported` },
      body: secret,
    });

    expect(formatForecastError(error)).not.toContain(secret);
    expect(formatForecastError(error)).not.toContain('upgrade the model artifact');
    expect(formatForecastError(error)).toContain('HTTP 409');
  });
});
