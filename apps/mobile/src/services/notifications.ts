import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { supabase } from "./supabase";

export type AppNotification = {
  id: string;
  message: string;
  read: boolean;
  createdAt: string;
  target: string | null;
  actionLabel?: string | null;
};

export function useNotifications() {
  const { user, demoMode } = useAuth();
  const userId = user?.id;
  const userRole = user?.role;
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!userId || !userRole) {
      setItems([]);
      setHasMore(false);
      setUnreadCount(0);
      setError(null);
      return;
    }
    if (demoMode) {
      const demoItems = demoNotifications();
      setItems(demoItems);
      setHasMore(false);
      setUnreadCount(demoItems.filter((item) => !item.read).length);
      setError(null);
      return;
    }
    if (!supabase) {
      setItems([]);
      setHasMore(false);
      setUnreadCount(0);
      setError(null);
      return;
    }
    setLoading(true);
    const [pageResult, unreadResult] = await Promise.all([
      supabase.from("notifications").select("id,title,body,read_at,created_at,entity_type,entity_id", { count: "exact" }).eq("recipient_id", userId).order("created_at", { ascending: false }).order("id", { ascending: true }).range(0, 19),
      supabase.from("notifications").select("id", { count: "exact", head: true }).eq("recipient_id", userId).is("read_at", null),
    ]);
    const data = pageResult.data;
    const requestError = pageResult.error ?? unreadResult.error;
    if (requestError) setError("Notifications could not be loaded.");
    else {
      setError(null);
      const nextItems = (data ?? []).map((item) => ({
          id: item.id,
          message: `${item.title}: ${item.body}`,
          read: Boolean(item.read_at),
          createdAt: item.created_at,
          target: notificationTarget(item.entity_type, item.entity_id, userRole),
          actionLabel: item.entity_type === "grade_encoding_deadline_request"
            ? userRole === "system_admin" ? "Review request" : userRole === "academic_admin" ? "View request" : null
            : item.entity_type === "grade_encoding_deadline_reminder"
              ? userRole === "faculty" ? "View gradebook" : userRole === "academic_admin" ? "View deadlines" : null
            : item.entity_type === "subject_request" || item.entity_type === "class_request"
              ? userRole === "academic_admin" ? "Review request" : userRole === "faculty" ? "View request" : null
            : null,
        }));
      setItems(nextItems);
      setHasMore(pageResult.count == null ? nextItems.length === 20 : nextItems.length < pageResult.count);
      setUnreadCount(unreadResult.count ?? nextItems.filter((item) => !item.read).length);
    }
    setLoading(false);
  }, [demoMode, userId, userRole]);

  const loadMore = useCallback(async () => {
    if (!userId || !userRole || demoMode || !supabase || !hasMore || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const from = items.length;
    const { data, error: requestError, count } = await supabase
      .from("notifications")
      .select("id,title,body,read_at,created_at,entity_type,entity_id", { count: "exact" })
      .eq("recipient_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + 19);
    if (requestError) setError("More notifications could not be loaded.");
    else {
      const nextItems = (data ?? []).map((item) => ({
        id: item.id,
        message: `${item.title}: ${item.body}`,
        read: Boolean(item.read_at),
        createdAt: item.created_at,
        target: notificationTarget(item.entity_type, item.entity_id, userRole),
        actionLabel: item.entity_type === "grade_encoding_deadline_request"
          ? userRole === "system_admin" ? "Review request" : userRole === "academic_admin" ? "View request" : null
          : item.entity_type === "grade_encoding_deadline_reminder"
            ? userRole === "faculty" ? "View gradebook" : userRole === "academic_admin" ? "View deadlines" : null
          : item.entity_type === "subject_request" || item.entity_type === "class_request"
            ? userRole === "academic_admin" ? "Review request" : userRole === "faculty" ? "View request" : null
          : null,
      }));
      setItems((current) => [...current, ...nextItems]);
      setHasMore(count == null ? nextItems.length === 20 : from + nextItems.length < count);
      setError(null);
    }
    loadingMoreRef.current = false;
    setLoadingMore(false);
  }, [demoMode, hasMore, items.length, userId, userRole]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!userId || demoMode || !supabase) return;
    const channel = supabase
      .channel(`notifications-${userId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `recipient_id=eq.${userId}`,
      }, () => { void refresh(); })
      .subscribe();
    return () => { void supabase?.removeChannel(channel); };
  }, [demoMode, refresh, userId]);

  const markRead = useCallback(
    async (id: string) => {
      if (!user) return;
      if (demoMode) {
        const wasUnread = items.some((item) => item.id === id && !item.read);
        setItems((current) =>
          current.map((item) =>
            item.id === id ? { ...item, read: true } : item,
          ),
        );
        if (wasUnread) setUnreadCount((current) => Math.max(0, current - 1));
        return;
      }
      if (!supabase) return;
      const { error: requestError } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .eq("recipient_id", user.id);
      if (requestError)
        throw new Error("The notification could not be marked as read.");
      const wasUnread = items.some((item) => item.id === id && !item.read);
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, read: true } : item,
        ),
      );
      if (wasUnread) setUnreadCount((current) => Math.max(0, current - 1));
    },
    [demoMode, items, user],
  );

  const markAllRead = useCallback(async () => {
    if (!user) return;
    if (demoMode) {
      setItems((current) => current.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
      return;
    }
    if (!supabase) return;
    const { error: requestError } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", user.id)
      .is("read_at", null);
    if (requestError) throw new Error("Notifications could not be updated.");
    setItems((current) => current.map((item) => ({ ...item, read: true })));
    setUnreadCount(0);
  }, [demoMode, user]);

  return {
    items,
    unread: unreadCount,
    loading,
    loadingMore,
    hasMore,
    error,
    refresh,
    loadMore,
    markRead,
    markAllRead,
  };
}

function demoNotifications(): AppNotification[] {
  const now = Date.now();
  return [
    {
      id: "demo-1",
      message: "Grades Submitted: Midterm results are ready for review.",
      read: false,
      createdAt: new Date(now - 5 * 60_000).toISOString(),
      target: "grades",
    },
    {
      id: "demo-2",
      message: "New Feedback: Your performance assessment is available.",
      read: false,
      createdAt: new Date(now - 60 * 60_000).toISOString(),
      target: "feedback",
    },
    {
      id: "demo-3",
      message: "Upcoming Event: Faculty review meeting starts tomorrow.",
      read: false,
      createdAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      target: "events",
    },
    {
      id: "demo-4",
      message: "Analytics report updated from fictional validation records.",
      read: true,
      createdAt: new Date(now - 5 * 60 * 60_000).toISOString(),
      target: "analytics",
    },
    {
      id: "demo-5",
      message: "System Update: APMS maintenance completed successfully.",
      read: true,
      createdAt: new Date(now - 24 * 60 * 60_000).toISOString(),
      target: null,
    },
  ];
}

function notificationTarget(
  entityType: string | null,
  entityId: string | null,
  role: string,
) {
  if (!entityType || !entityId) return null;
  if (entityType === "grade_encoding_deadline_request") {
    if (role === "system_admin") return "system?settingsCategory=Grade%20deadlines";
    if (role === "academic_admin") return "deadlines";
    return null;
  }
  if (entityType === "grade_encoding_deadline_reminder") {
    if (role === "faculty") return "gradebook";
    if (role === "academic_admin") return "deadlines";
    return null;
  }
  if (entityType === "subject_request") {
    if (role === "academic_admin") return "subjects";
    if (role === "faculty") return "classes";
    return null;
  }
  if (entityType === "class_request") {
    if (role === "academic_admin" || role === "faculty") return "classes";
    return null;
  }
  const screens: Record<string, string> = {
    feedback_record: "feedback",
    assessment_result: "grades",
    event: "events",
    backup: "backup",
  };
  return screens[entityType]
    ? `${screens[entityType]}?record=${encodeURIComponent(entityId)}`
    : null;
}
