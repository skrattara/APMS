import type { Role } from "@apms/domain";
import { useRouter } from "expo-router";
import { useState, type PropsWithChildren } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { useAuth } from "@/auth/AuthProvider";
import { NAVIGATION, ROLE_LABELS } from "@/config/navigation";
import { AppIcon } from "@/components/Icon";
import { Button, Card } from "@/components/ui";
import { useNotifications } from "@/services/notifications";
import { colors, shadow } from "@/theme/tokens";

export function AppShell({
  role,
  screen,
  title,
  subtitle,
  actions,
  hidePageHeader = false,
  children,
}: PropsWithChildren<{
  role: Role;
  screen: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  hidePageHeader?: boolean;
}>) {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { width } = useWindowDimensions();
  const compact = width < 800;
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const notifications = useNotifications();
  const reducedFacultySidebar = sidebarCollapsed && !compact;
  const brandCaption = ROLE_LABELS[role];
  const profileRole = ROLE_LABELS[role];
  const showAiPill = role !== "system_admin";
  const navigate = (key: string) => {
    router.push(`/portal/${role}/${key}`);
    setMenuOpen(false);
  };
  const sidebar = (
    <View style={[styles.sidebar, compact && styles.mobileSidebar, reducedFacultySidebar && styles.sidebarCollapsed]}>
      <View
        style={[
          styles.brandBlock,
          reducedFacultySidebar && styles.reducedBrand,
        ]}
      >
        <View style={[styles.brandIcon, styles.facultyBrandIcon]}>
          <AppIcon name="faculty" size={18} color={colors.brand} />
        </View>
        {!reducedFacultySidebar ? (
          <View>
            <Text style={styles.brand}>APMS</Text>
            <Text style={styles.brandCaption}>{brandCaption}</Text>
          </View>
        ) : null}
      </View>
      {!reducedFacultySidebar ? (
        <>
          <View style={styles.portalLabel}>
            <Text style={styles.portalText}>Menu</Text>
          </View>
          <ScrollView contentContainerStyle={styles.nav}>
            {NAVIGATION[role]
              .filter((item) => item.key !== "settings" && !item.hidden)
              .map((item) => (
          <Pressable
            accessibilityRole="link"
                  key={item.key}
                  onPress={() => navigate(item.key)}
                  style={({ pressed }) => [
                    styles.navItem,
                    screen === item.key && styles.navItemActive,
                    screen === item.key && styles.facultyNavActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <AppIcon
                    name={item.icon}
                    size={17}
                    color={screen === item.key ? "#FFD21E" : "#FFFFFF99"}
                    style={styles.navIcon}
                  />
                  <Text
                    style={[
                      styles.navText,
                      screen === item.key && styles.navTextActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              ))}
          </ScrollView>
        </>
      ) : (
        <View style={styles.sidebarSpacer} />
      )}
      <View style={styles.sidebarFooter}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Logout"
          onPress={() => void signOut().then(() => router.replace("/"))}
          style={styles.footerLink}
        >
          <AppIcon name="logout" size={17} color="#FFA2A2B3" />
          {!reducedFacultySidebar ? <Text style={styles.logoutText}>Logout</Text> : null}
        </Pressable>
      </View>
    </View>
  );

  return (
    <View style={styles.root}>
      {!compact ? (
        sidebar
      ) : (
        <Modal
          visible={menuOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setMenuOpen(false)}
        >
          <Pressable
            style={styles.drawerOverlay}
            onPress={() => setMenuOpen(false)}
          >
            {sidebar}
          </Pressable>
        </Modal>
      )}
      <View style={styles.main}>
        <View style={styles.topbar}>
          <View style={styles.topbarStart}>
            {compact ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open menu"
                onPress={() => setMenuOpen(true)}
                style={styles.iconButton}
              >
                <AppIcon name="menu" size={18} color={colors.textMuted} />
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                onPress={() => setSidebarCollapsed((value) => !value)}
                style={styles.iconButton}
              >
                <AppIcon name="menu" size={18} color={colors.textMuted} />
              </Pressable>
            )}
          </View>
          <View style={styles.topbarActions}>
            {showAiPill && !compact ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Gemini AI connected"
                onPress={() => navigate("assistant")}
                style={styles.aiPill}
              >
                <AppIcon name="assistant" size={13} color="#F97316" />
                <Text style={styles.aiPillText}>Gemini AI connected</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Notifications${notifications.unread ? `, ${notifications.unread} unread` : ""}`}
              onPress={() => {
                setProfileOpen(false);
                setNotificationsOpen((value) => !value);
              }}
              style={styles.iconButton}
            >
              <AppIcon
                name="notifications"
                size={18}
                color={colors.textMuted}
              />
              {notifications.unread ? (
                <View style={styles.notificationBadge}>
                  <Text style={styles.notificationBadgeText}>
                    {notifications.unread > 9 ? "9+" : notifications.unread}
                  </Text>
                </View>
              ) : null}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Profile menu"
              onPress={() => setProfileOpen((value) => !value)}
              style={[styles.facultyProfile, compact && styles.compactProfile]}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {user?.firstName?.[0]}
                  {user?.lastName?.[0]}
                </Text>
              </View>
              {!compact ? (
                <View>
                  <Text style={styles.facultyProfileName}>
                    {user?.firstName} {user?.lastName}
                  </Text>
                  <Text style={styles.facultyProfileRole}>{profileRole}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
        </View>
        {notificationsOpen ? (
          <Card style={styles.notificationPanel}>
            <View style={styles.noticeHeader}>
              <View>
                <Text style={styles.popoverTitle}>Notifications</Text>
                <Text style={styles.noticeCount}>
                  {notifications.unread} new
                </Text>
              </View>
              {notifications.unread ? (
                <Button
                  label="Mark all read"
                  variant="ghost"
                  onPress={() => void notifications.markAllRead()}
                />
              ) : null}
            </View>
            {notifications.loading ? (
              <ActivityIndicator color={colors.brand} />
            ) : notifications.error ? (
              <>
                <Text style={styles.noticeText}>{notifications.error}</Text>
                <Button
                  label="Retry"
                  variant="ghost"
                  onPress={() => void notifications.refresh()}
                />
              </>
            ) : notifications.items.length ? (
              notifications.items.map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() =>
                    void notifications.markRead(item.id).then(() => {
                      if (item.target) {
                        setNotificationsOpen(false);
                        navigate(item.target);
                      }
                    })
                  }
                  style={[styles.notice, !item.read && styles.noticeUnread]}
                >
                  <Text style={styles.noticeTitle}>
                    {item.message.split(": ")[0]}
                  </Text>
                  <Text style={styles.noticeText}>
                    {item.message.split(": ").slice(1).join(": ")}
                  </Text>
                  <Text style={styles.noticeDate}>
                    {new Date(item.createdAt).toLocaleString()}
                  </Text>
                </Pressable>
              ))
            ) : (
              <Text style={styles.noticeText}>You have no notifications.</Text>
            )}
            <Text style={styles.viewAll}>View All Notifications</Text>
          </Card>
        ) : null}
        {profileOpen ? (
          <Card style={styles.profilePanel}>
            <View style={styles.profilePanelHead}>
              <View style={styles.profileAvatar}>
                <Text style={styles.avatarText}>
                  {user?.firstName?.[0]}
                  {user?.lastName?.[0]}
                </Text>
              </View>
              <View>
                <Text style={styles.popoverTitle}>
                  {user?.firstName} {user?.lastName}
                </Text>
                <Text style={styles.profileEmail}>{ROLE_LABELS[role]}</Text>
              </View>
            </View>
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                setProfileOpen(false);
                navigate("settings");
              }}
              style={styles.profileOption}
            >
              <AppIcon name="settings" size={16} color={colors.textMuted} />
              <View>
                <Text style={styles.profileOptionTitle}>Account settings</Text>
                <Text style={styles.profileOptionCopy}>Profile, password, MFA, and notifications</Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => void signOut().then(() => router.replace("/"))}
              style={styles.profileOption}
            >
              <AppIcon name="logout" size={16} color={colors.danger} />
              <View>
                <Text style={styles.logoutOption}>Log Out</Text>
                <Text style={styles.profileOptionCopy}>
                  Sign out of your account
                </Text>
              </View>
            </Pressable>
          </Card>
        ) : null}
        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentInner}
        >
          {!hidePageHeader ? (
            <View style={styles.pageHeader}>
              <View>
                <View style={styles.pageTitleRow}>
                  <Text accessibilityRole="header" style={styles.pageTitle}>
                    {title}
                  </Text>
                </View>
                {subtitle ? (
                  <Text style={styles.pageSubtitle}>{subtitle}</Text>
                ) : null}
              </View>
              {actions ? (
                <View style={styles.pageActions}>{actions}</View>
              ) : null}
            </View>
          ) : null}
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: colors.canvas,
    minHeight: Platform.OS === "web" ? ("100vh" as never) : undefined,
  },
  sidebar: { width: 208, backgroundColor: "#4A1E15", paddingTop: 16 },
  sidebarCollapsed: { width: 68 },
  mobileSidebar: { height: "100%", ...shadow },
  drawerOverlay: { flex: 1, backgroundColor: "#00000055" },
  brandBlock: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  reducedBrand: { paddingLeft: 16 },
  brandIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFF",
  },
  facultyBrandIcon: { width: 32, height: 32, borderRadius: 10 },
  brandIconText: { color: colors.brand, fontSize: 23, fontWeight: "800" },
  brand: { color: "#FFF", fontWeight: "600", fontSize: 13 },
  brandCaption: { color: "#E9D5D0", fontSize: 10 },
  portalLabel: {
    marginTop: 18,
    marginHorizontal: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  portalText: {
    color: "#FFFFFF4D",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  nav: { paddingHorizontal: 8, paddingVertical: 4, gap: 8 },
  sidebarSpacer: { flex: 1 },
  navItem: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  navItemActive: { backgroundColor: "#FFFFFF33" },
  facultyNavActive: {
    borderLeftWidth: 3,
    borderLeftColor: "#FFD21E",
    paddingLeft: 7,
  },
  navIcon: { width: 18, color: "#FFFFFF99", textAlign: "center", fontSize: 14 },
  navText: { color: "#FFFFFF99", fontSize: 13, flex: 1 },
  navTextActive: { color: "#FFF" },
  pressed: { opacity: 0.75 },
  sidebarFooter: {
    marginTop: "auto",
    borderTopWidth: 1,
    borderColor: "#FFFFFF1A",
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 2,
  },
  footerLink: {
    minHeight: 36,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 9,
  },
  footerLinkActive: {
    backgroundColor: "#FFFFFF33",
    borderLeftWidth: 3,
    borderLeftColor: "#FFD21E",
    paddingLeft: 7,
  },
  footerIcon: { color: "#FFFFFF99", fontSize: 16 },
  footerText: { color: "#FFFFFF99", fontSize: 13 },
  logoutIcon: { color: "#FFA2A2B3", fontSize: 16 },
  logoutText: { color: "#FFA2A2B3", fontSize: 13 },
  main: { flex: 1, minWidth: 0 },
  topbar: {
    height: 55,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  topbarStart: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  menuIcon: { color: colors.textMuted, fontSize: 16 },
  topbarActions: { flexDirection: "row", gap: 6, alignItems: "center" },
  aiPill: {
    height: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#F6D88A",
    backgroundColor: "#FFFBEB",
  },
  aiPillText: { color: "#C76518", fontSize: 11 },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
  },
  icon: { color: colors.textMuted, fontSize: 15 },
  notificationBadge: {
    position: "absolute",
    right: -2,
    top: -3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  notificationBadgeText: { color: "#FFF", fontSize: 8, fontWeight: "700" },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#FFF", fontSize: 10 },
  facultyProfile: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minWidth: 126,
  },
  compactProfile: { minWidth: 32 },
  facultyProfileName: { color: colors.text, fontSize: 11 },
  facultyProfileRole: { color: "#99A1AF", fontSize: 10 },
  graderTopbar: { height: 65 },
  notificationPanel: {
    position: "absolute",
    zIndex: 20,
    right: 58,
    top: 58,
    width: 380,
    maxHeight: 493,
  },
  profilePanel: {
    position: "absolute",
    zIndex: 20,
    right: 20,
    top: 58,
    width: 280,
    gap: 4,
    padding: 12,
  },
  profilePanelHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    borderBottomWidth: 1,
    borderColor: colors.border,
    marginBottom: 4,
  },
  profileAvatar: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  profileOption: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  profileOptionTitle: { fontSize: 12, fontWeight: "600", color: colors.text },
  profileOptionCopy: { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  logoutOption: { fontSize: 12, fontWeight: "600", color: colors.danger },
  popoverTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.text,
    marginBottom: 2,
  },
  notice: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  noticeUnread: { backgroundColor: "#FDF1ED" },
  noticeText: { color: colors.textMuted, fontSize: 12 },
  noticeDate: { color: "#99A1AF", fontSize: 10, marginTop: 4 },
  profileEmail: { color: colors.textMuted, fontSize: 11 },
  noticeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingBottom: 8,
  },
  noticeCount: { color: colors.danger, fontSize: 10 },
  noticeTitle: { color: colors.text, fontSize: 12, fontWeight: "600" },
  viewAll: {
    color: colors.brand,
    fontSize: 11,
    textAlign: "center",
    paddingTop: 10,
  },
  content: { flex: 1 },
  contentInner: {
    width: "100%",
    maxWidth: 1500,
    alignSelf: "center",
    paddingHorizontal: 19,
    paddingTop: 20,
    paddingBottom: 2,
    gap: 20,
  },
  pageHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    justifyContent: "space-between",
    alignItems: "center",
  },
  pageTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pageTitle: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "500",
  },
  monitoringPill: {
    height: 19,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: "#F6EADA",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  monitoringText: { color: colors.brand, fontSize: 10 },
  pageSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  pageActions: { flexDirection: "row", gap: 8 },
});
