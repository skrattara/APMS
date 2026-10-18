import { forecastError } from './predictionErrors';

export type PredictionRequestBatch<T> = { items: T[]; body: Record<string, unknown>; byteLength: number };

export type PredictionBatchLimits<T = unknown> = {
  maxBytes?: number;
  maxItems?: number;
  encodeItem: (item: T, index: number) => unknown;
};

/** Keep every provider to 10 records per invocation; the gateway's 100-record cap is a hard ceiling, not a safe working size. */
export function predictionBatchItemLimit(_provider: unknown): number {
  return 10;
}

function utf8ByteLength(value: string): number {
  // encodeURIComponent is available in React Native and counts UTF-8 bytes
  // after removing the two extra hex characters from each escaped byte.
  const encoded = encodeURIComponent(value);
  const escapedBytes = encoded.match(/%[0-9A-F]{2}/gi)?.length ?? 0;
  return encoded.length - escapedBytes * 2;
}

/**
 * Plans every exact serialized gateway body before the caller sends the first
 * request. Oversized single records reject the whole plan; no item is dropped.
 */
export function planPredictionRequestBatches<T>(
  baseBody: Record<string, unknown>,
  items: readonly T[],
  limits: PredictionBatchLimits<T>,
): PredictionRequestBatch<T>[] {
  const maxBytes = limits.maxBytes ?? 900_000;
  const maxItems = limits.maxItems ?? 100;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError('Prediction batch limits must be positive integers.');
  }
  if (!items.length) return [];

  const result: PredictionRequestBatch<T>[] = [];
  let currentItems: T[] = [];
  let currentEncoded: unknown[] = [];
  const measure = (encoded: unknown[]) => {
    const body = { ...baseBody, inputs: encoded };
    const serialized = JSON.stringify(body);
    if (serialized === undefined) throw new TypeError('Prediction request body could not be serialized.');
    return { body, byteLength: utf8ByteLength(serialized) };
  };

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const encoded = limits.encodeItem(item, index);
    const candidate = [...currentEncoded, encoded];
    const measured = measure(candidate);
    if (measured.byteLength > maxBytes || currentItems.length >= maxItems) {
      if (!currentItems.length) throw forecastError('request_too_large_local');
      const finalized = measure(currentEncoded);
      result.push({ items: currentItems, body: finalized.body, byteLength: finalized.byteLength });
      currentItems = [];
      currentEncoded = [];
      const single = measure([encoded]);
      if (single.byteLength > maxBytes) throw forecastError('request_too_large_local');
      currentItems.push(item);
      currentEncoded.push(encoded);
    } else {
      currentItems.push(item);
      currentEncoded.push(encoded);
    }
  }

  if (currentItems.length) {
    const measured = measure(currentEncoded);
    result.push({ items: currentItems, body: measured.body, byteLength: measured.byteLength });
  }
  return result;
}
