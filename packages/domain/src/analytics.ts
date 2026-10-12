export type AnalyticsRow = Record<string, unknown>;
export type Aggregation = 'count' | 'sum' | 'average' | 'minimum' | 'maximum';
export type AnalyticsFilterOperator = 'equals' | 'not_equals' | 'contains' | 'less_than' | 'less_than_or_equal' | 'greater_than' | 'greater_than_or_equal';
export type AnalyticsFilter = { field: string; operator: AnalyticsFilterOperator; value: string | number };

export function filterRows<T extends AnalyticsRow>(rows: readonly T[], filters: readonly AnalyticsFilter[]): T[] {
  if (!filters.length) return [...rows];
  return rows.filter((row) => filters.every(({ field, operator, value }) => {
    const actual = row[field];
    if (operator === 'equals') return String(actual ?? '') === String(value);
    if (operator === 'not_equals') return String(actual ?? '') !== String(value);
    if (operator === 'contains') return String(actual ?? '').toLocaleLowerCase().includes(String(value).toLocaleLowerCase());
    const left = numeric(actual);
    const right = numeric(value);
    if (left === null || right === null) return false;
    if (operator === 'less_than') return left < right;
    if (operator === 'less_than_or_equal') return left <= right;
    if (operator === 'greater_than') return left > right;
    return left >= right;
  }));
}

export function sortRows<T extends AnalyticsRow>(rows: readonly T[], field: string, direction: 'ascending' | 'descending' = 'ascending'): T[] {
  const sign = direction === 'ascending' ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left[field]; const b = right[field];
    const numericA = numeric(a); const numericB = numeric(b);
    if (numericA !== null && numericB !== null) return (numericA - numericB) * sign;
    const dateA = a == null ? NaN : new Date(String(a)).getTime();
    const dateB = b == null ? NaN : new Date(String(b)).getTime();
    if (Number.isFinite(dateA) && Number.isFinite(dateB)) return (dateA - dateB) * sign;
    return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function groupRows<T extends AnalyticsRow>(rows: readonly T[], field: string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = String(row[field] ?? 'Unspecified');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

export function aggregateRows<T extends AnalyticsRow>(rows: readonly T[], operation: Aggregation, field?: string): number {
  if (operation === 'count') return rows.length;
  const values = rows.map((row) => numeric(row[field ?? ''])).filter((value): value is number => value !== null);
  if (!values.length) return 0;
  if (operation === 'sum') return values.reduce((total, value) => total + value, 0);
  if (operation === 'average') return values.reduce((total, value) => total + value, 0) / values.length;
  return values.reduce((result, value) => operation === 'minimum' ? Math.min(result, value) : Math.max(result, value), values[0]);
}

export function pivotRows<T extends AnalyticsRow>(
  rows: readonly T[],
  rowField: string,
  columnField: string,
  operation: Aggregation,
  valueField?: string,
  limits: { maxRows?: number; maxColumns?: number } = {},
) {
  const rowCounts = new Map<string, number>();
  const columnCounts = new Map<string, number>();
  for (const row of rows) {
    const rowKey = String(row[rowField] ?? 'Unspecified');
    const columnKey = String(row[columnField] ?? 'Unspecified');
    rowCounts.set(rowKey, (rowCounts.get(rowKey) ?? 0) + 1);
    columnCounts.set(columnKey, (columnCounts.get(columnKey) ?? 0) + 1);
  }
  const ranked = (counts: Map<string, number>, limit?: number) => [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key]) => key);
  const rowKeys = ranked(rowCounts, limits.maxRows);
  const columnKeys = ranked(columnCounts, limits.maxColumns);
  const selectedRows = new Set(rowKeys);
  const selectedColumns = new Set(columnKeys);
  const cells = new Map<string, Map<string, { count: number; numericCount: number; sum: number; minimum: number; maximum: number }>>();
  for (const row of rows) {
    const rowKey = String(row[rowField] ?? 'Unspecified');
    const columnKey = String(row[columnField] ?? 'Unspecified');
    if (!selectedRows.has(rowKey) || !selectedColumns.has(columnKey)) continue;
    const rowCells = cells.get(rowKey) ?? new Map();
    const cell = rowCells.get(columnKey) ?? { count: 0, numericCount: 0, sum: 0, minimum: Infinity, maximum: -Infinity };
    cell.count += 1;
    const value = operation === 'count' ? null : numeric(row[valueField ?? '']);
    if (value !== null) {
      cell.numericCount += 1;
      cell.sum += value;
      cell.minimum = Math.min(cell.minimum, value);
      cell.maximum = Math.max(cell.maximum, value);
    }
    rowCells.set(columnKey, cell);
    cells.set(rowKey, rowCells);
  }
  const aggregate = (cell: { count: number; numericCount: number; sum: number; minimum: number; maximum: number } | undefined) => {
    if (operation === 'count') return cell?.count ?? 0;
    if (!cell?.numericCount) return 0;
    if (operation === 'sum') return cell.sum;
    if (operation === 'average') return cell.sum / cell.numericCount;
    return operation === 'minimum' ? cell.minimum : cell.maximum;
  };
  return rowKeys.map((label) => ({
    label,
    values: Object.fromEntries(columnKeys.map((column) => [column, aggregate(cells.get(label)?.get(column))])),
  }));
}

export function drilldownRows<T extends AnalyticsRow>(rows: readonly T[], field: string, value: string): T[] {
  return rows.filter((row) => String(row[field] ?? 'Unspecified') === value);
}
