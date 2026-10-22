import { useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthProvider';
import { AppIcon } from '@/components/Icon';
import { Badge, Button, Card, PageState, useToast } from '@/components/ui';
import { useNotifications, type AppNotification } from '@/services/notifications';
import { colors } from '@/theme/tokens';

export function NotificationCenter() {
  const router = useRouter();
  const { user } = useAuth();
  const toast = useToast();
  const notifications = useNotifications();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const visibleItems = filter === 'unread' ? notifications.items.filter((item) => !item.read) : notifications.items;

  const openNotification = async (item: AppNotification) => {
    try {
      await notifications.markRead(item.id);
      if (item.target && user?.role) router.push(`/portal/${user.role}/${item.target}`);
    } catch {
      toast.show('The notification could not be updated. Try again.');
    }
  };
  const markAllRead = async () => {
    try {
      await notifications.markAllRead();
    } catch {
      toast.show('Notifications could not be updated. Try again.');
    }
  };

  return <View style={styles.page}>
    <Card style={styles.toolbar}>
      <View style={styles.toolbarCopy}>
        <Text style={styles.heading}>Notification center</Text>
        <Text style={styles.subheading}>{notifications.unread ? `${notifications.unread} unread` : 'You are all caught up'}</Text>
      </View>
      {notifications.unread ? <Button compact label="Mark all read" variant="secondary" onPress={() => void markAllRead()} /> : null}
    </Card>

    <Card style={styles.listCard}>
      <View style={styles.listHeader}>
        <View style={styles.filters}>
          {(['all', 'unread'] as const).map((value) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)} style={[styles.filter, filter === value && styles.filterActive]}>
            <Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{value === 'all' ? 'All' : `Unread${notifications.unread ? ` · ${notifications.unread}` : ''}`}</Text>
          </Pressable>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh notifications" onPress={() => void notifications.refresh()} style={styles.refresh}>
          <AppIcon name="refresh" size={15} color={colors.textMuted} />
        </Pressable>
      </View>

      {notifications.loading && !notifications.items.length ? <View style={styles.loading}><ActivityIndicator color={colors.brand} /><Text style={styles.subheading}>Loading notifications…</Text></View>
        : notifications.error && !notifications.items.length ? <PageState kind="error" title="Notifications unavailable" message={notifications.error} action={<Button compact label="Retry" variant="secondary" onPress={() => void notifications.refresh()} />} />
        : visibleItems.length ? <View>
          {visibleItems.map((item) => <NotificationRow key={item.id} item={item} onOpen={() => void openNotification(item)} />)}
        </View>
        : <PageState kind="empty" title={filter === 'unread' ? 'No unread notifications' : 'No notifications yet'} message={filter === 'unread' ? 'New notifications will appear here.' : 'Notifications about your APMS account and work will appear here.'} />}

      {notifications.error && notifications.items.length ? <Text style={styles.error}>{notifications.error}</Text> : null}
      {notifications.hasMore ? <View style={styles.loadMore}><Button compact label={notifications.loadingMore ? 'Loading…' : 'Load more'} variant="secondary" disabled={notifications.loadingMore} onPress={() => void notifications.loadMore()} /></View> : null}
    </Card>
  </View>;
}

function NotificationRow({ item, onOpen }: { item: AppNotification; onOpen: () => void }) {
  const separator = item.message.indexOf(': ');
  const title = separator < 0 ? item.message : item.message.slice(0, separator);
  const body = separator < 0 ? '' : item.message.slice(separator + 2);
  return <View style={[styles.row, !item.read && styles.rowUnread]}>
    <View style={styles.statusColumn}>{item.read ? <View style={styles.readDot} /> : <View style={styles.unreadDot} />}</View>
    <Pressable accessibilityRole="button" onPress={onOpen} style={styles.rowCopy}>
      <View style={styles.rowHeading}><Text style={styles.title}>{title}</Text>{!item.read ? <Badge tone="info">New</Badge> : null}</View>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      <Text style={styles.date}>{new Date(item.createdAt).toLocaleString()}</Text>
    </Pressable>
    {item.actionLabel && item.target ? <View style={styles.action}><Button compact label={item.actionLabel} variant="secondary" onPress={onOpen} /></View> : null}
  </View>;
}

const styles = StyleSheet.create({
  page: { gap: 12 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: 14 },
  toolbarCopy: { flex: 1, minWidth: 180, gap: 3 },
  heading: { color: colors.text, fontSize: 15, fontWeight: '700' },
  subheading: { color: colors.textMuted, fontSize: 12 },
  listCard: { padding: 0, overflow: 'hidden' },
  listHeader: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 14, borderBottomWidth: 1, borderColor: colors.border },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  filter: { minHeight: 30, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 7 },
  filterActive: { backgroundColor: colors.surfaceMuted },
  filterText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  filterTextActive: { color: colors.text },
  refresh: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 7 },
  loading: { minHeight: 120, alignItems: 'center', justifyContent: 'center', gap: 10 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 14, paddingHorizontal: 14, borderBottomWidth: 1, borderColor: colors.border },
  rowUnread: { backgroundColor: '#FFF9F6' },
  statusColumn: { width: 8, paddingTop: 7 },
  unreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.brand },
  readDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.border },
  rowCopy: { flex: 1, minWidth: 0, gap: 4 },
  rowHeading: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  body: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  date: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  action: { alignItems: 'flex-end', paddingLeft: 4 },
  loadMore: { alignItems: 'center', padding: 12 },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: 14, paddingBottom: 8 },
});
