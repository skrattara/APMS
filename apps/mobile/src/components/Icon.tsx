import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { StyleProp, ViewStyle } from 'react-native';

export type AppIconName =
  | 'home' | 'feedback' | 'grades' | 'settings' | 'students' | 'records'
  | 'analytics' | 'assistant' | 'faculty' | 'criteria' | 'evaluation' | 'events'
  | 'roles' | 'logs' | 'system' | 'backup' | 'admins' | 'security'
  | 'notifications' | 'info' | 'logout' | 'menu' | 'search' | 'email'
  | 'password' | 'visibility' | 'visibilityOff' | 'checkbox' | 'brand'
  | 'trend' | 'chart' | 'person' | 'error' | 'denied' | 'empty' | 'success'
  | 'metric' | 'chevronDown'
  | 'copy' | 'paste' | 'clear' | 'sortAscending' | 'sortDescending' | 'filter'
  | 'hide' | 'show' | 'expand' | 'collapse' | 'edit' | 'delete';

const ICONS: Record<AppIconName, SymbolViewProps['name']> = {
  home: { ios: 'house.fill', android: 'home', web: 'home' },
  feedback: { ios: 'bubble.left.fill', android: 'feedback', web: 'feedback' },
  grades: { ios: 'doc.text.fill', android: 'grading', web: 'grading' },
  settings: { ios: 'gearshape.fill', android: 'settings', web: 'settings' },
  students: { ios: 'person.2.fill', android: 'group', web: 'group' },
  records: { ios: 'folder.fill', android: 'description', web: 'description' },
  analytics: { ios: 'chart.bar.fill', android: 'analytics', web: 'analytics' },
  assistant: { ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' },
  faculty: { ios: 'person.3.fill', android: 'school', web: 'school' },
  criteria: { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' },
  evaluation: { ios: 'waveform.path.ecg', android: 'monitoring', web: 'monitoring' },
  events: { ios: 'calendar', android: 'event', web: 'event' },
  roles: { ios: 'person.2.fill', android: 'manage_accounts', web: 'manage_accounts' },
  logs: { ios: 'list.bullet.rectangle', android: 'article', web: 'article' },
  system: { ios: 'gearshape.2.fill', android: 'settings', web: 'settings' },
  backup: { ios: 'externaldrive.fill', android: 'backup', web: 'backup' },
  admins: { ios: 'person.crop.circle.fill', android: 'admin_panel_settings', web: 'admin_panel_settings' },
  security: { ios: 'shield.fill', android: 'security', web: 'security' },
  notifications: { ios: 'bell.fill', android: 'notifications', web: 'notifications' },
  info: { ios: 'info.circle.fill', android: 'info', web: 'info' },
  logout: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' },
  menu: { ios: 'line.3.horizontal', android: 'menu', web: 'menu' },
  search: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  email: { ios: 'envelope.fill', android: 'mail', web: 'mail' },
  password: { ios: 'lock.fill', android: 'lock', web: 'lock' },
  visibility: { ios: 'eye.fill', android: 'visibility', web: 'visibility' },
  visibilityOff: { ios: 'eye.slash.fill', android: 'visibility_off', web: 'visibility_off' },
  checkbox: { ios: 'square', android: 'check_box_outline_blank', web: 'check_box_outline_blank' },
  brand: { ios: 'chart.line.uptrend.xyaxis', android: 'trending_up', web: 'trending_up' },
  trend: { ios: 'chart.line.uptrend.xyaxis', android: 'trending_up', web: 'trending_up' },
  chart: { ios: 'chart.bar.fill', android: 'bar_chart', web: 'bar_chart' },
  person: { ios: 'person.crop.circle.fill', android: 'person', web: 'person' },
  error: { ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' },
  denied: { ios: 'hand.raised.fill', android: 'block', web: 'block' },
  empty: { ios: 'tray.fill', android: 'inbox', web: 'inbox' },
  success: { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' },
  metric: { ios: 'chart.bar.xaxis', android: 'monitoring', web: 'monitoring' },
  chevronDown: { ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' },
  copy: { ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' },
  paste: { ios: 'doc.on.clipboard', android: 'content_paste', web: 'content_paste' },
  clear: { ios: 'xmark.circle', android: 'backspace', web: 'backspace' },
  sortAscending: { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' },
  sortDescending: { ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' },
  filter: { ios: 'line.3.horizontal.decrease', android: 'filter_alt', web: 'filter_alt' },
  hide: { ios: 'eye.slash', android: 'visibility_off', web: 'visibility_off' },
  show: { ios: 'eye', android: 'visibility', web: 'visibility' },
  expand: { ios: 'arrow.down.right.and.arrow.up.left', android: 'unfold_more', web: 'unfold_more' },
  collapse: { ios: 'arrow.up.left.and.arrow.down.right', android: 'unfold_less', web: 'unfold_less' },
  edit: { ios: 'pencil', android: 'edit', web: 'edit' },
  delete: { ios: 'trash', android: 'delete', web: 'delete' },
};

export function AppIcon({ name, size = 18, color, style }: { name: AppIconName; size?: number; color: string; style?: StyleProp<ViewStyle> }) {
  return <SymbolView name={ICONS[name]} size={size} tintColor={color} style={[{ width: size, height: size }, style]} />;
}
