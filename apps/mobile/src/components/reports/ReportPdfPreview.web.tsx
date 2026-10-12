import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

export default function ReportPdfPreview({ uri, style }: { uri: string; style?: StyleProp<ViewStyle> }) {
  const frameStyle = StyleSheet.flatten(style);
  return React.createElement('iframe' as React.ElementType, {
    src: uri,
    title: 'Generated PDF report preview',
    style: { ...frameStyle, border: 0, backgroundColor: '#E7E9ED' },
  });
}
