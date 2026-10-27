/** Safe, user-facing forecast failures. Only bounded, server-sanitized provider diagnostics may be shown. */
export type ForecastErrorCode =
  | 'no_eligible_students'
  | 'invalid_grading'
  | 'invalid_criteria'
  | 'request_status'
  | 'partial_inventory_unsupported'
  | 'assessment_context_unsupported'
  | 'assessment_context_invalid'
  | 'assessment_count_constraint'
  | 'applied_schema_changed'
  | 'request_too_large_local'
  | 'request_too_large'
  | 'provider_timeout'
  | 'request_timeout'
  | 'provider_unavailable'
  | 'provider_authentication_failed'
  | 'provider_request_rejected'
  | 'provider_busy'
  | 'provider_connection_failed'
  | 'invalid_response'
  | 'network_unconfirmed'
  | 'saved_response_invalid'
  | 'unexpected';

export class SafeForecastError extends Error {
  readonly name = 'SafeForecastError';

  constructor(readonly code: ForecastErrorCode, readonly status?: number, readonly providerMessage?: string) {
    super(code);
  }
}

/** The gateway returned a saved-run ID, but this client could not validate its display payload. */
export class SavedForecastResponseError extends Error {
  readonly code = 'saved_response_invalid' as const;
  readonly name = 'SavedForecastResponseError';

  constructor(readonly savedRunId: string) {
    super('A prediction run was saved but its response could not be validated locally.');
  }
}

export function isSavedForecastResponseError(error: unknown): error is SavedForecastResponseError {
  return error instanceof SavedForecastResponseError;
}

export function forecastError(code: Exclude<ForecastErrorCode, 'request_status' | 'network_unconfirmed' | 'unexpected'>): SafeForecastError {
  return new SafeForecastError(code);
}

function safeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const message = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted API key]')
    .replace(/\bsk-[0-9A-Za-z_-]{20,}/g, '[redacted API key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .trim()
    .slice(0, 500);
  return message || undefined;
}

/** Converts allowlisted response metadata and a bounded provider diagnostic to a safe error. */
export function forecastRequestError(context: unknown, providerMessage?: unknown): SafeForecastError {
  if (context && typeof context === 'object') {
    const status = (context as { status?: unknown }).status;
    const headers = (context as { headers?: { get?: (name: string) => string | null } }).headers;
    const rawCode = headers && typeof headers.get === 'function'
      ? headers.get('X-APMS-Error-Code') ?? headers.get('x-apms-error-code')
      : null;
    const allowedCodes: ForecastErrorCode[] = [
      'partial_inventory_unsupported', 'assessment_count_constraint', 'applied_schema_changed',
      'assessment_context_unsupported',
      'assessment_context_invalid',
      'request_too_large', 'provider_timeout', 'request_timeout', 'provider_unavailable',
      'provider_authentication_failed', 'provider_request_rejected', 'provider_busy',
      'provider_connection_failed', 'invalid_response',
    ];
    const code = typeof rawCode === 'string' && allowedCodes.includes(rawCode as ForecastErrorCode)
      ? rawCode as ForecastErrorCode
      : undefined;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
      return new SafeForecastError(code ?? 'request_status', status, safeProviderMessage(providerMessage));
    }
  }
  return new SafeForecastError('network_unconfirmed');
}

const responseMessages: Record<number, string> = {
  401: 'Your sign-in may have expired. Sign in again, then check saved forecasts before retrying.',
  403: 'Your account or AI settings do not allow this request. Ask an administrator to review access and settings.',
  409: 'The active grading criteria or model setup was rejected. Ask an administrator to review the configuration.',
  413: 'This forecast request is too large. Select a smaller class or ask an administrator about the service request limit.',
  429: 'The forecast service is busy or the monthly limit has been reached. Check saved forecasts before retrying later.',
  502: 'The forecast provider did not complete the request. Check saved forecasts before retrying.',
  503: 'The forecast service is unavailable or not fully configured. Ask an administrator to check its status.',
  504: 'The forecast request timed out. Check saved forecasts before retrying.',
};

/** Maps controlled failures to fixed copy; unknown Error.message values stay private. */
export function formatForecastError(error: unknown): string {
  if (error instanceof SavedForecastResponseError) {
    return 'The forecast run was saved, but this screen could not verify the results. Refresh saved predictions before deciding whether to retry.';
  }
  if (!(error instanceof SafeForecastError)) {
    return 'The forecast result could not be confirmed. Check saved predictions before retrying; student records remain available.';
  }
  const withProviderMessage = (message: string) => error.providerMessage
    ? `${message}\nProvider response: ${error.providerMessage}`
    : message;
  switch (error.code) {
    case 'no_eligible_students':
      return 'No students have usable scores in the enabled AI inputs. Save assessment scores and enable Recent scores to forecast before a final standing is available. Current-standing-only inputs need a calculable current standing.';
    case 'invalid_grading':
      return 'The applied grading system is invalid. Fix it before running forecasts.';
    case 'invalid_criteria':
      return 'The applied evaluation criteria are invalid. Fix them before running forecasts.';
    case 'network_unconfirmed':
      return 'The service did not confirm whether the forecast was saved. Check saved predictions before retrying; student records remain available.';
    case 'request_status':
      if (error.status === 409) return 'The forecast request did not match the active grading or model setup. Ask an administrator to review the settings. (HTTP 409)';
      return withProviderMessage(responseMessages[error.status ?? -1]
        ? `${responseMessages[error.status ?? -1]} (HTTP ${error.status})`
        : `The forecast request failed (HTTP ${error.status}). Check saved predictions before retrying.`);
    case 'partial_inventory_unsupported':
      return 'This model runtime does not support forecasting from the assessments currently recorded. Update the model service, or turn off Assessment score predictions to run standing and risk forecasts using Recent scores.';
    case 'assessment_context_unsupported':
      return 'The active model artifact does not support assessment-specific score forecasts. Ask an administrator to upgrade the model artifact, or turn off Assessment score predictions to continue with standing and risk forecasts.';
    case 'assessment_context_invalid':
      return 'Some recorded assessment values or dates do not match the active grading system. Review the class assessment records and grading setup before trying again.';
    case 'assessment_count_constraint':
      return 'The recorded assessments exceed an active grading-system count limit. Ask an administrator to review the assessment setup.';
    case 'applied_schema_changed':
      return 'The grading or evaluation criteria changed. Refresh the class and try again.';
    case 'request_too_large_local':
      return 'One forecast request is too large for the service limit. Ask an administrator to review the class schema or service request limit.';
    case 'request_too_large':
      return 'The forecast request exceeds the service size limit. Try a smaller class or ask an administrator to review the request limit.';
    case 'provider_timeout':
    case 'request_timeout':
      return 'The forecast service timed out. Check saved predictions before retrying.';
    case 'provider_unavailable':
      return withProviderMessage('The forecast provider is temporarily unavailable. Check saved predictions before retrying.');
    case 'provider_authentication_failed':
      return withProviderMessage('The forecast provider could not authenticate. Check saved predictions, then ask an administrator to verify the provider credentials.');
    case 'provider_request_rejected':
      return withProviderMessage('The forecast provider rejected the request. Check saved predictions, then ask an administrator to review service compatibility and logs.');
    case 'provider_busy':
      return withProviderMessage('The forecast provider is busy. Check saved predictions before deciding whether to try again later; the app will not retry automatically.');
    case 'provider_connection_failed':
      return withProviderMessage('The forecast service could not connect to its provider. Check saved predictions before trying again later.');
    case 'invalid_response':
      return 'The forecast provider returned a response that could not be verified. Check saved predictions before retrying.';
    default:
      return 'The forecast result could not be confirmed. Check saved predictions before retrying; student records remain available.';
  }
}
