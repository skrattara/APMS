import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { Button, Card, DataTable, Field, SelectField } from '@/components/ui';
import { supabase } from '@/services/supabase';
import { colors } from '@/theme/tokens';

type Scope = { scope_type: 'department'; scope_id: string; label?: string };
type Credential = { scope_type: string; scope_id: string; provider: string; model: string | null; monthly_request_limit: number | null; monthly_token_limit: number | null; configured: boolean; keyHint: string; updated_at: string };
type Snapshot = { scopes: Scope[]; credentials: Credential[]; usage: { requests: number; inputTokens: number; outputTokens: number }; usageByModel?: Array<{ scope_type: string; scope_id: string | null; provider: string; model: string; requests: number; input_tokens: number; output_tokens: number }>; canManageDepartment: boolean };

export function AIProviderSettings({ onMessage }: { onMessage: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scope] = useState<'department'>('department');
  const [scopeId, setScopeId] = useState('');
  const [provider, setProvider] = useState('gemini');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [requestLimit, setRequestLimit] = useState('');
  const [tokenLimit, setTokenLimit] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.functions.invoke('ai-provider-settings', { method: 'GET' });
    if (error || data?.error) { onMessage(data?.error ?? 'AI provider settings could not be loaded.'); return; }
    const result = data as Snapshot;
    setSnapshot(result);
    const departmentScope = result.scopes[0];
    if (departmentScope && !result.scopes.some((item) => item.scope_id === scopeId)) setScopeId(departmentScope.scope_id);
  }, [onMessage, scopeId]);
  useEffect(() => { void load(); }, [load]);
  const visibleScopes = useMemo(() => snapshot?.scopes ?? [], [snapshot]);
  const activeScope = visibleScopes.find((item) => item.scope_id === scopeId);
  const existing = snapshot?.credentials.find((item) => item.scope_type === scope && item.scope_id === activeScope?.scope_id && item.provider === provider);
  useEffect(() => {
    setApiKey(''); setModel(existing?.model ?? '');
    setRequestLimit(existing?.monthly_request_limit == null ? '' : String(existing.monthly_request_limit));
    setTokenLimit(existing?.monthly_token_limit == null ? '' : String(existing.monthly_token_limit));
  }, [existing?.scope_id, existing?.provider, existing?.updated_at]);
  const save = async () => {
    if (!supabase || !activeScope) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke('ai-provider-settings', { body: { scopeType: scope, scopeId: activeScope.scope_id, provider, apiKey, model, monthlyRequestLimit: requestLimit, monthlyTokenLimit: tokenLimit } });
      if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'The provider key could not be saved.');
      onMessage(data?.message ?? 'Provider key saved securely.'); await load(); setApiKey('');
    } catch (cause) { onMessage(cause instanceof Error ? cause.message : 'The provider key could not be saved.'); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!supabase || !activeScope || !existing) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke('ai-provider-settings', { method: 'DELETE', body: { scopeType: scope, scopeId: activeScope.scope_id, provider } });
      if (error || data?.error) throw new Error(data?.error ?? 'The provider key could not be removed.');
      onMessage('Provider key removed.'); await load();
    } catch (cause) { onMessage(cause instanceof Error ? cause.message : 'The provider key could not be removed.'); }
    finally { setSaving(false); }
  };
  if (!supabase) return <Card><Text>Connect APMS to configure AI providers.</Text></Card>;
  return <Card style={{ gap: 12 }}>
    <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>AI provider keys and usage</Text>
    <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>Department keys are used for authorized classes in that department. System Admin configured Edge Function keys are used when no department key is configured. Requests use separately authorized, request-specific student context; sharing a key does not share prompts or records. Secrets are stored in Supabase Vault and are never shown again after saving.</Text>
    <Text style={{ color: colors.warning, fontSize: 12, lineHeight: 18 }}>Before saving keys, disable database statement logging in Supabase. Vault documentation warns that plaintext key arguments can otherwise be captured in SQL logs.</Text>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      {visibleScopes.length > 1 ? <SelectField label="Department" value={scopeId} options={visibleScopes.map((item) => ({ label: item.label ?? 'Authorized department', value: item.scope_id }))} onChange={setScopeId} /> : null}
      <SelectField label="Provider" value={provider} options={[{ label: 'Google Gemini', value: 'gemini' }, { label: 'OpenAI', value: 'openai' }]} onChange={setProvider} />
    </View>
    <Text style={{ color: colors.textMuted, fontSize: 12 }}>{existing ? `A key is configured (${existing.keyHint}).` : 'No key is configured at this scope; APMS will use the next available scope.'}</Text>
    <Field label="API key" value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={existing ? 'Enter a replacement key' : 'Paste provider API key'} />
    <Field label="Model override (optional)" value={model} onChangeText={setModel} autoCapitalize="none" placeholder="Use the applied criteria model by default" />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      <Field label="Monthly request limit" value={requestLimit} onChangeText={(value) => setRequestLimit(value.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="Unlimited" />
      <Field label="Monthly token limit" value={tokenLimit} onChangeText={(value) => setTokenLimit(value.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="Unlimited" />
    </View>
    <Text style={{ color: colors.textMuted, fontSize: 11 }}>Usage this month across your authorized departments: {snapshot?.usage.requests ?? 0} requests · {(snapshot?.usage.inputTokens ?? 0).toLocaleString()} input tokens · {(snapshot?.usage.outputTokens ?? 0).toLocaleString()} output tokens. Blank limits mean unlimited. Requests are blocked before sending when a configured cap has been reached.</Text>
    {snapshot?.usageByModel?.length ? <DataTable columns={['Department', 'Provider', 'Model', 'Requests', 'Input tokens', 'Output tokens']} rows={snapshot.usageByModel.map((item: any) => [`${visibleScopes.find((entry) => entry.scope_id === item.scope_id)?.label ?? 'Department'}`, item.provider, item.model, String(item.requests), Number(item.input_tokens).toLocaleString(), Number(item.output_tokens).toLocaleString()])} /> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}><Button label={existing ? apiKey ? 'Update provider key' : 'Save limits and model' : 'Save provider key'} loading={saving} disabled={(!apiKey && !existing) || !activeScope} onPress={() => void save()} />{existing ? <Button label="Remove key" variant="danger" loading={saving} onPress={() => void remove()} /> : null}</View>
  </Card>;
}
