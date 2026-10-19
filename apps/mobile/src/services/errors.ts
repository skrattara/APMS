const showErrorDetails = process.env.EXPO_PUBLIC_APMS_SHOW_ERROR_DETAILS === 'true';

/** Return technical error details only when the public opt-in flag is enabled. */
export function getErrorMessage(error: unknown, fallback: string): string {
  const detail = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  const deadline = detail.match(/Grade encoding is closed for ([^;]+); the deadline was (.+)/i);
  if (deadline) {
    const scope = deadline[1].trim().toLowerCase();
    const date = deadline[2].match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const scopeLabel = scope === 'overall'
      ? 'overall'
      : /^p\d+$/.test(scope)
        ? `Period ${scope.slice(1)}`
        : scope;
    const dateLabel = date && !Number.isNaN(new Date(`${date}T12:00:00`).getTime())
      ? new Date(`${date}T12:00:00`).toLocaleDateString()
      : deadline[2].trim();
    return `The ${scopeLabel} grade encoding deadline (${dateLabel}) has passed, so this grade change cannot be saved.`;
  }
  if (!showErrorDetails) return fallback;
  if (detail.trim()) return detail;
  return fallback;
}
