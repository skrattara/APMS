import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Card, DataTable } from '@/components/ui';
import { supabase } from '@/services/supabase';
import { colors } from '@/theme/tokens';

type ServiceConfiguration = {
  configured: boolean;
  model: string | null;
  transport: string | null;
  cloudflare_access_configured: boolean;
  request_privacy: {
    ai_enabled: boolean;
    assessment_data_enabled: boolean;
    attendance_data_enabled: boolean;
  };
};

type ProbeResult = {
  reachable: boolean;
  ready: boolean;
  model_version: string | null;
  artifact_id: string | null;
  device: string | null;
  synthetic_demo: boolean;
  institutionally_validated: boolean;
  capabilities: { v1_predictions: boolean; v2_forecasts: boolean; assessment_instance_conditioning?: boolean };
  latency_ms: number | null;
  artifact_source?: 'local' | 'supabase_storage' | 'unavailable' | null;
  manifest_sha256?: string | null;
};

function isServiceConfiguration(value: unknown): value is ServiceConfiguration {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<ServiceConfiguration>;
  const privacy = config.request_privacy;
  return typeof config.configured === 'boolean'
    && (typeof config.model === 'string' || config.model === null)
    && (typeof config.transport === 'string' || config.transport === null)
    && typeof config.cloudflare_access_configured === 'boolean'
    && !!privacy
    && typeof privacy.ai_enabled === 'boolean'
    && typeof privacy.assessment_data_enabled === 'boolean'
    && typeof privacy.attendance_data_enabled === 'boolean';
}

function isProbeResult(value: unknown): value is ProbeResult {
  if (!value || typeof value !== 'object') return false;
  const probe = value as Partial<ProbeResult>;
  const capabilities = probe.capabilities;
  return typeof probe.reachable === 'boolean'
    && typeof probe.ready === 'boolean'
    && (typeof probe.model_version === 'string' || probe.model_version === null)
    && (typeof probe.artifact_id === 'string' || probe.artifact_id === null)
    && (typeof probe.device === 'string' || probe.device === null)
    && typeof probe.synthetic_demo === 'boolean'
    && typeof probe.institutionally_validated === 'boolean'
    && (probe.artifact_source === undefined || probe.artifact_source === null || ['local', 'supabase_storage', 'unavailable'].includes(probe.artifact_source))
    && (probe.manifest_sha256 === undefined || probe.manifest_sha256 === null || /^[a-f0-9]{64}$/i.test(probe.manifest_sha256))
    && !!capabilities
    && typeof capabilities.v1_predictions === 'boolean'
    && typeof capabilities.v2_forecasts === 'boolean'
    && (capabilities.assessment_instance_conditioning === undefined || typeof capabilities.assessment_instance_conditioning === 'boolean')
    && (typeof probe.latency_ms === 'number' || probe.latency_ms === null);
}

function yesNo(value: boolean) { return value ? 'On' : 'Off'; }
function transportLabel(value: string | null) {
  if (value === 'https') return 'Secure HTTPS';
  if (value === 'http_insecure') return 'Loopback HTTP (local only)';
  return 'Not configured';
}

export function AIServiceSettings() {
  const [configuration, setConfiguration] = useState<ServiceConfiguration | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [probeFailed, setProbeFailed] = useState(false);
  const mounted = useRef(false);

  const loadConfiguration = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    setConfiguration(null);
    setProbe(null);
    setProbeFailed(false);
    try {
      if (!supabase) throw new Error('Unavailable');
      const { data, error } = await supabase.functions.invoke('ai-service-status', { method: 'GET' });
      if (error || data?.error || !isServiceConfiguration(data)) throw new Error('Unavailable');
      if (mounted.current) setConfiguration(data);
    } catch {
      if (mounted.current) setLoadFailed(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadConfiguration();
    return () => { mounted.current = false; };
  }, [loadConfiguration]);

  const checkConnection = async () => {
    if (!supabase || !configuration?.configured || probing) return;
    setProbing(true);
    setProbe(null);
    setProbeFailed(false);
    try {
      const { data, error } = await supabase.functions.invoke('ai-service-status', { method: 'POST', body: {} });
      if (error || data?.error || !isProbeResult(data?.probe)) throw new Error('Unavailable');
      if (mounted.current) setProbe(data.probe);
    } catch {
      if (mounted.current) setProbeFailed(true);
    } finally {
      if (mounted.current) setProbing(false);
    }
  };

  const privacy = configuration?.request_privacy;
  const readyLabel = !probe ? 'Not checked' : probe.reachable && probe.ready ? 'Ready' : probe.reachable ? 'Not ready' : 'Unreachable';
  const rows: string[][] = configuration ? [
    ['Service configured', configuration.configured ? 'Yes' : 'No'],
    ['Configured model', configuration.model || 'Service default'],
    ['Connection type', transportLabel(configuration.transport)],
    ['Cloudflare Access credentials', configuration.cloudflare_access_configured ? 'Configured' : 'Not configured'],
    ['Service readiness', readyLabel],
    ['Model version', probe?.model_version || 'Not checked'],
    ['Artifact', probe?.artifact_id || 'Not checked'],
    ['Artifact source', probe?.artifact_source === 'supabase_storage' ? 'Supabase Storage' : probe?.artifact_source === 'local' ? 'Local artifact package' : probe?.artifact_source === 'unavailable' ? 'Unavailable' : 'Not reported'],
    ['Pinned manifest SHA-256', probe?.manifest_sha256 ? `${probe.manifest_sha256.slice(0, 16)}…` : 'Not reported'],
    ['Inference device', probe?.device || 'Not checked'],
    ['Synthetic demonstration mode', probe ? yesNo(probe.synthetic_demo) : 'Not checked'],
    ['Institutionally validated', probe ? yesNo(probe.institutionally_validated) : 'Not checked'],
    ['Response time', probe?.latency_ms == null ? 'Not checked' : `${Math.round(probe.latency_ms)} ms`],
    ['Gateway predictions route', probe ? yesNo(probe.capabilities.v1_predictions) : 'Not checked'],
    ['Typed forecasts route', probe ? yesNo(probe.capabilities.v2_forecasts) : 'Not checked'],
    ['Assessment-specific forecast support', probe?.capabilities.assessment_instance_conditioning === undefined ? 'Not reported' : yesNo(probe.capabilities.assessment_instance_conditioning)],
  ] : [];

  return <Card style={{ gap: 12 }}>
    <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>APMS forecasting service</Text>
    <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
      This service is configured by administrators through Supabase Edge Function Secrets. APMS keeps the service address and credentials on the server; this screen never displays them. Use “Check connection” to explicitly test the configured service. Forecasts are advisory only: APMS grading and evaluation rules remain authoritative. The global AI and data-sharing switches above still control whether APMS may send approved context.
    </Text>
    {loading ? <Text accessibilityRole="text" style={{ color: colors.textMuted }}>Loading service configuration…</Text> : null}
    {loadFailed ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>Service configuration could not be loaded. Retry to fetch the secret-free status.</Text> : null}
    {configuration ? <>
      <DataTable columns={['Setting', 'Status']} rows={rows} />
      <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
        Global AI: {yesNo(privacy?.ai_enabled ?? false)} · Assessment data: {yesNo(privacy?.assessment_data_enabled ?? false)} · Attendance data: {yesNo(privacy?.attendance_data_enabled ?? false)}. These privacy settings remain authoritative even when the service is ready.
      </Text>
    </> : null}
    {probeFailed ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>Connection check failed. Confirm the Edge Function and server-side service configuration, then try again.</Text> : null}
    {probe && (!probe.reachable || !probe.ready) ? <Text accessibilityRole="alert" style={{ color: colors.warning }}>The service did not report ready. Advisory forecasts remain unavailable until the worker passes its readiness check.</Text> : null}
    {probe?.synthetic_demo ? <Text style={{ color: colors.warning, fontSize: 12, lineHeight: 18 }}>The configured artifact is a synthetic demonstration. It is not institutionally validated and must not be treated as student-level evidence.</Text> : null}
    {probe && !probe.institutionally_validated ? <Text style={{ color: colors.warning, fontSize: 12, lineHeight: 18 }}>Institutional validation is not recorded for this service. Outputs remain advisory and require educator review.</Text> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Button label="Refresh configuration" variant="secondary" loading={loading} disabled={loading || probing} onPress={() => void loadConfiguration()} />
      <Button label="Check connection" loading={probing} disabled={loading || probing || !configuration?.configured} onPress={() => void checkConnection()} />
    </View>
  </Card>;
}
