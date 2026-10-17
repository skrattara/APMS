import { Text, View } from 'react-native';

import { summarizeSavedForecast, type SavedForecastLike } from '@apms/domain';
import { Badge, Card } from '@/components/ui';
import { colors } from '@/theme/tokens';

export function AIAdvisoryForecast({ forecast, compact = false }: { forecast: SavedForecastLike | null | undefined; compact?: boolean }) {
  const summary = summarizeSavedForecast(forecast);
  const freshnessText = summary.freshness === 'recent_by_time'
    ? 'Recent by time only'
    : summary.freshness === 'older_by_time' ? 'Older than 24 hours' : 'Generation time unavailable';
  const generatedText = summary.generatedAt ? new Date(summary.generatedAt).toLocaleString() : 'Not recorded';
  const model = [summary.modelProvider, summary.modelName].filter(Boolean).join(' · ');

  return <Card style={{ gap: 6, padding: compact ? 10 : 14 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <Badge tone="warning">Advisory forecast</Badge>
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
        {summary.available ? `Predicted standing ${summary.predictedStanding!.toFixed(1)}%` : 'No saved forecast'}
      </Text>
    </View>
    {summary.available && summary.riskProbability != null ? <Text style={{ color: colors.textMuted, fontSize: 12 }}>
      AI risk probability {(summary.riskProbability * 100).toFixed(1)}% · advisory estimate, not model confidence
    </Text> : null}
    <Text style={{ color: colors.textMuted, fontSize: 12 }}>
      {freshnessText} · generated {generatedText}. Records or grading rules may have changed since this forecast was saved. Review before use.
    </Text>
    {model ? <Text style={{ color: colors.textMuted, fontSize: 12 }}>Model: {model}{forecast?.modelVersion ? ` · version ${forecast.modelVersion}` : ''}</Text> : null}
    {summary.dataBasis ? <Text style={{ color: colors.textMuted, fontSize: 12 }}>Data basis: {summary.dataBasis}</Text> : null}
  </Card>;
}
