const showErrorDetails = process.env.EXPO_PUBLIC_APMS_SHOW_ERROR_DETAILS === 'true';

/** Return technical error details only when the public opt-in flag is enabled. */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (!showErrorDetails) return fallback;
  const detail = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  if (detail.trim()) return detail;
  return fallback;
}
