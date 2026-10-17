/**
 * Format the recognized 05-XXXX-XXXXXX student ID when it is complete.
 * Other institutional ID formats are returned unchanged.
 */
export function formatStudentId(value: string | null | undefined): string {
  const raw = value ?? '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 12 || !digits.startsWith('05')) return raw;
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
}

/** Adds separators as a recognized 05-prefixed ID is typed, without validating it. */
export function formatStudentIdInput(value: string): string {
  const unseparated = value.replace(/[\s-]/g, '');
  if (!/^05\d*$/.test(unseparated) || unseparated.length > 12) return value;
  if (unseparated.length <= 2) return unseparated;
  return `${unseparated.slice(0, 2)}-${unseparated.slice(2, 6)}${unseparated.length > 6 ? `-${unseparated.slice(6)}` : ''}`;
}

/** Compare IDs independent of the display separators added by APMS. */
export function normalizeStudentId(value: string | null | undefined): string {
  // Ignore ASCII and Unicode dash punctuation, along with spacing, so copied
  // IDs compare the same whether users type the displayed separators or not.
  return (value ?? '').replace(/[\s\p{Dash_Punctuation}]/gu, '').toLocaleLowerCase();
}

/** Validation is an administrator-controlled system policy and defaults off. */
export const STUDENT_ID_VALIDATION_SETTING = 'student_id.validation_enabled';

export function isValidStudentId(value: string | null | undefined): boolean {
  const raw = (value ?? '').trim();
  return /^\d{12}$/.test(raw) || /^05-\d{4}-\d{6}$/.test(raw);
}
