import { WebView } from 'react-native-webview';
import type { StyleProp, ViewStyle } from 'react-native';

export default function ReportPdfPreview({ uri, style }: { uri: string; style?: StyleProp<ViewStyle> }) {
  return <WebView source={{ uri }} style={style} />;
}
