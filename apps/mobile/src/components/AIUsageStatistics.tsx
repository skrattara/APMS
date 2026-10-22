import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { Role } from '@apms/domain';

import { Button, Card, DataTable, DateField, MetricCard, PageState, RefreshIndicator, SelectField } from '@/components/ui';
import { supabase } from '@/services/supabase';
import { colors } from '@/theme/tokens';

type UsageGroup = {
  provider: string;
  model: string;
  feature: string;
  requests: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
};
type UsageSummary = {
  requests: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  byModel: UsageGroup[];
};
type UsageSnapshot = {
  month: string;
  personal: UsageSummary;
  department: { name: string; usage: UsageSummary } | null;
};
type SystemUsageRecord = { createdAt: string; user: string; email: string; provider: string; model: string; feature: string; usageUnits: number; succeeded: boolean; inputTokens: number; outputTokens: number };
type SystemUsageSnapshot = {
  from: string;
  to: string;
  summary: UsageSummary;
  daily: Array<{ day: string; requests: number }>;
  providers: string[];
  models: string[];
  features: string[];
  users: Array<{ id: string; label: string }>;
  records: SystemUsageRecord[];
  totalRecords: number;
  page: number;
  pageSize: number;
};
type SystemUsageFilters = { from: string; to: string; userId: string; provider: string; model: string; feature: string; page: number; pageSize: number };

const LazyVisualizationPanel = lazy(() => import('@/components/charts/VisualizationPanel').then((module) => ({ default: module.VisualizationPanel })));

const emptyUsage = (): UsageSummary => ({ requests: 0, succeeded: 0, failed: 0, inputTokens: 0, outputTokens: 0, byModel: [] });
const number = (value: number) => value.toLocaleString();

function Summary({ title, usage }: { title: string; usage: UsageSummary }) {
  const rows = usage.byModel.map((row) => [row.provider, row.model, row.feature.replaceAll('_', ' '), number(row.requests), number(row.succeeded), number(row.failed), number(row.inputTokens), number(row.outputTokens)]);
  return <View style={{ gap: 12 }}>
    <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>{title}</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      <MetricCard label="Usage units" value={number(usage.requests)} />
      <MetricCard label="Successful" value={number(usage.succeeded)} tone="success" />
      <MetricCard label="Unsuccessful" value={number(usage.failed)} tone={usage.failed ? 'warning' : 'success'} />
      <MetricCard label="Input tokens" value={number(usage.inputTokens)} tone="info" />
      <MetricCard label="Output tokens" value={number(usage.outputTokens)} tone="info" />
    </View>
    {rows.length
      ? <DataTable columns={['Provider', 'Model', 'Feature', 'Usage units', 'Successful', 'Unsuccessful', 'Input tokens', 'Output tokens']} rows={rows} />
      : <Text style={{ color: colors.textMuted, fontSize: 12 }}>No third-party model usage was recorded this month.</Text>}
  </View>;
}

export function AIUsageStatistics({ role, demoMode }: { role: Role; demoMode: boolean }) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [systemSnapshot, setSystemSnapshot] = useState<SystemUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [systemFilters, setSystemFilters] = useState<SystemUsageFilters>(() => {
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    return { from: monthStart.toISOString().slice(0, 10), to: today, userId: 'all', provider: 'all', model: 'all', feature: 'all', page: 0, pageSize: 25 };
  });
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    if (demoMode) return () => { active = false; };
    if (!supabase) {
      setError('Connect APMS to load AI usage statistics.');
      return () => { active = false; };
    }
    setLoading(true);
    setError(null);
    const request = role === 'system_admin'
      ? supabase.functions.invoke('ai-usage-statistics', { method: 'POST', body: systemFilters })
      : supabase.functions.invoke('ai-usage-statistics', { method: 'GET' });
    void request
      .then(({ data, error: invokeError }) => {
        if (!active) return;
        if (invokeError || data?.error) throw new Error(data?.error ?? invokeError?.message ?? 'Usage statistics could not be loaded.');
        if (role === 'system_admin') setSystemSnapshot(data as SystemUsageSnapshot);
        else setSnapshot(data as UsageSnapshot);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Usage statistics could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [demoMode, refreshKey, role, systemFilters]);

  if (demoMode) return <PageState kind="empty" title="AI usage unavailable in sample mode" message="Sign in to a connected APMS account to view your usage statistics." />;
  if (loading && !(role === 'system_admin' ? systemSnapshot : snapshot)) return <PageState kind="loading" title="Loading AI usage" message="Preparing your third-party model usage statistics." />;
  if (error && !(role === 'system_admin' ? systemSnapshot : snapshot)) return <PageState kind="error" title="AI usage could not be loaded" message={error} action={<Button label="Retry" onPress={refresh} />} />;

  if (role === 'system_admin') {
    const detail = systemSnapshot;
    const filters = systemFilters;
    const setRange = (key: 'from' | 'to', value: string) => setSystemFilters((current) => ({ ...current, [key]: value, page: 0 }));
    const setSelect = (key: 'userId' | 'provider' | 'model' | 'feature', value: string) => setSystemFilters((current) => ({ ...current, [key]: value, page: 0 }));
    const summary = detail?.summary ?? emptyUsage();
    const providerTotals = (summary.byModel ?? []).reduce<Record<string, number>>((totals, row) => { totals[row.provider] = (totals[row.provider] ?? 0) + row.requests; return totals; }, {});
    const modelTotals = (summary.byModel ?? []).reduce<Record<string, number>>((totals, row) => { totals[row.model] = (totals[row.model] ?? 0) + row.requests; return totals; }, {});
    const dailySeries = (detail?.daily ?? []).map((row) => ({ label: row.day.slice(5), value: row.requests, timestamp: row.day }));
    const providerSeries = Object.entries(providerTotals).map(([label, value]) => ({ label, value }));
    const modelSeries = Object.entries(modelTotals).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value }));
    const recordRows = (detail?.records ?? []).map((row) => [new Date(row.createdAt).toLocaleString(), row.user, row.email, row.provider, row.model, row.feature.replaceAll('_', ' '), number(row.usageUnits), row.succeeded ? 'Successful' : 'Unsuccessful', number(row.inputTokens), number(row.outputTokens)]);
    const pageCount = detail ? Math.max(1, Math.ceil(detail.totalRecords / detail.pageSize)) : 1;
    return <View style={{ gap: 16 }}>
      <RefreshIndicator visible={loading} />
      <Card style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 20, fontWeight: '700' }}>System AI usage</Text>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>Filter provider activity, inspect individual calls, and compare model usage. User names and email addresses are visible only to System Admins.</Text>
          </View>
          <Button label="Refresh" variant="secondary" loading={loading} onPress={refresh} />
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <DateField label="From" value={filters.from} onChange={(value) => setRange('from', value)} containerStyle={{ flex: 1, minWidth: 170 }} />
          <DateField label="To" value={filters.to} onChange={(value) => setRange('to', value)} containerStyle={{ flex: 1, minWidth: 170 }} />
          <SelectField label="User" value={filters.userId} options={[{ label: 'All users', value: 'all' }, ...(detail?.users ?? []).map((user) => ({ label: user.label, value: user.id }))]} onChange={(value) => setSelect('userId', value)} searchable containerStyle={{ flex: 1, minWidth: 200 }} />
          <SelectField label="Provider" value={filters.provider} options={[{ label: 'All providers', value: 'all' }, ...(detail?.providers ?? []).map((value) => ({ label: value, value }))]} onChange={(value) => setSelect('provider', value)} searchable containerStyle={{ flex: 1, minWidth: 160 }} />
          <SelectField label="Model" value={filters.model} options={[{ label: 'All models', value: 'all' }, ...(detail?.models ?? []).map((value) => ({ label: value, value }))]} onChange={(value) => setSelect('model', value)} searchable containerStyle={{ flex: 1, minWidth: 180 }} />
          <SelectField label="Feature" value={filters.feature} options={[{ label: 'All features', value: 'all' }, ...(detail?.features ?? []).map((value) => ({ label: value.replaceAll('_', ' '), value }))]} onChange={(value) => setSelect('feature', value)} searchable containerStyle={{ flex: 1, minWidth: 180 }} />
        </View>
        {error ? <Text style={{ color: colors.danger, fontSize: 12 }}>{error}</Text> : null}
      </Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <MetricCard label="Usage units" value={number(summary.requests)} />
        <MetricCard label="Successful" value={number(summary.succeeded)} tone="success" />
        <MetricCard label="Unsuccessful" value={number(summary.failed)} tone={summary.failed ? 'warning' : 'success'} />
        <MetricCard label="Input tokens" value={number(summary.inputTokens)} tone="info" />
        <MetricCard label="Output tokens" value={number(summary.outputTokens)} tone="info" />
      </View>
      <Suspense fallback={<Card><Text style={{ color: colors.textMuted }}>Preparing usage graphs…</Text></Card>}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
          <LazyVisualizationPanel title="Usage by day" description="Provider usage units recorded each day in the selected date range." data={dailySeries} type="line" />
          <LazyVisualizationPanel title="Usage by provider" description="Usage units grouped by third-party provider." data={providerSeries} type="pie" />
          <LazyVisualizationPanel title="Top models" description="Highest usage models in the selected range." data={modelSeries} type="bar" />
        </View>
      </Suspense>
      <Card style={{ gap: 10 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>Individual usage records</Text>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>{number(detail?.totalRecords ?? 0)} records match these filters.</Text>
        {recordRows.length ? <DataTable columns={['Time', 'User', 'Email', 'Provider', 'Model', 'Feature', 'Usage units', 'Outcome', 'Input tokens', 'Output tokens']} rows={recordRows} /> : <Text style={{ color: colors.textMuted, fontSize: 12 }}>No usage records match the selected filters.</Text>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
          <SelectField label="Rows per page" value={String(filters.pageSize)} options={[25, 50, 100].map((value) => ({ label: String(value), value: String(value) }))} onChange={(value) => setSystemFilters((current) => ({ ...current, pageSize: Number(value), page: 0 }))} containerStyle={{ width: 150 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>Page {detail ? detail.page + 1 : 1} of {pageCount}</Text>
            <Button label="Previous" variant="secondary" disabled={!detail || detail.page <= 0 || loading} onPress={() => setSystemFilters((current) => ({ ...current, page: Math.max(0, current.page - 1) }))} />
            <Button label="Next" variant="secondary" disabled={!detail || detail.page + 1 >= pageCount || loading} onPress={() => setSystemFilters((current) => ({ ...current, page: current.page + 1 }))} />
          </View>
        </View>
      </Card>
    </View>;
  }

  return <View style={{ gap: 16 }}>
    <RefreshIndicator visible={loading} />
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 20, fontWeight: '700' }}>Third-party AI usage</Text>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>Usage for {snapshot?.month ?? 'this month'}. Failed attempts are included; usage units reflect each provider’s metering.</Text>
        </View>
        <Button label="Refresh" variant="secondary" loading={loading} onPress={refresh} />
      </View>
      {error ? <Text style={{ color: colors.danger, fontSize: 12 }}>{error}</Text> : null}
      <Summary title="Your usage" usage={snapshot?.personal ?? emptyUsage()} />
    </Card>
    {role === 'academic_admin' && snapshot?.department ? <Card style={{ gap: 12 }}>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>Department totals include usage from its class records across department and system provider keys. Individual users and student records are not shown.</Text>
      <Summary title={`${snapshot.department.name} usage`} usage={snapshot.department.usage} />
    </Card> : null}
  </View>;
}
