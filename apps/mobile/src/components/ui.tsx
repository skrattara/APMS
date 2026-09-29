import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ChangeEvent, type PropsWithChildren, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { colors, radius, shadow, space } from "@/theme/tokens";
import { AppIcon } from "@/components/Icon";

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[`button_${variant}`],
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={
            variant === "primary" || variant === "danger"
              ? "#FFF"
              : colors.brand
          }
        />
      ) : (
        <Text
          style={[
            styles.buttonText,
            variant !== "primary" &&
              variant !== "danger" &&
              styles.buttonTextDark,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  containerStyle,
  inputType,
  ...props
}: TextInputProps & {
  label: string;
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
  inputType?: "date" | "email" | "text";
}) {
  const [secureVisible, setSecureVisible] = useState(false);
  const isSecure = Boolean(props.secureTextEntry);
  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={styles.label}>{label}</Text>
      <View>
        <TextInput
          {...props}
          {...(Platform.OS === "web" && inputType ? ({ type: inputType } as never) : {})}
          secureTextEntry={isSecure ? !secureVisible : props.secureTextEntry}
          accessibilityLabel={props.accessibilityLabel ?? label}
          placeholderTextColor="#99A1AF"
          style={[styles.input, isSecure && styles.secureInput, error && styles.inputError, props.style]}
        />
        {isSecure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={secureVisible ? `Hide ${label}` : `Show ${label}`}
            onPress={() => setSecureVisible((value) => !value)}
            style={styles.visibilityToggle}
          >
            <AppIcon name={secureVisible ? "visibilityOff" : "visibility"} size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function DateField({
  label,
  value,
  onChange,
  error,
  containerStyle,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  if (Platform.OS !== "web") {
    return <Field label={label} value={value} onChangeText={onChange} placeholder="YYYY-MM-DD" error={error} containerStyle={containerStyle} />;
  }

  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={styles.label}>{label}</Text>
      {createElement("input", {
        type: "date",
        value,
        onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value),
        "aria-label": label,
        style: styles.webDateInput,
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export type SelectOption = { label: string; value: string };

export function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder = "Select an option",
  error,
  disabled = false,
  containerStyle,
  searchable = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);
  const filteredOptions = searchable
    ? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  return (
    <View style={[styles.field, containerStyle]}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => { setQuery(''); setOpen(true); }}
        style={[styles.input, styles.selectInput, disabled && styles.disabled]}
      >
        <Text
          style={[styles.selectValue, !selected && styles.selectPlaceholder]}
        >
          {selected?.label ?? placeholder}
        </Text>
        <AppIcon name="chevronDown" size={14} color={colors.textMuted} />
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.selectOverlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${label} options`}
            onPress={() => setOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <Card style={styles.selectDialog}>
            <Text style={styles.selectTitle}>{label}</Text>
            {searchable ? <Field label="Search" value={query} onChangeText={setQuery} placeholder={`Search ${label.toLowerCase()}`} autoCapitalize="none" /> : null}
            <ScrollView
              style={styles.selectOptions}
              keyboardShouldPersistTaps="handled"
            >
              {filteredOptions.map((option) => (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: option.value === value }}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  style={[
                    styles.selectOption,
                    option.value === value && styles.selectOptionActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.selectOptionText,
                      option.value === value && styles.selectOptionTextActive,
                    ]}
                  >
                    {option.label}
                  </Text>
                  {option.value === value ? (
                    <AppIcon name="success" size={15} color={colors.brand} />
                  ) : null}
                </Pressable>
              ))}
              {searchable && !filteredOptions.length ? <Text style={styles.selectEmpty}>No matching options.</Text> : null}
            </ScrollView>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={() => setOpen(false)}
            />
          </Card>
        </View>
      </Modal>
    </View>
  );
}

export type ChartDatum = { label: string; value: number };

export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function MetricCard({
  label,
  value,
  delta,
  tone = "brand",
}: {
  label: string;
  value: string;
  delta?: string;
  tone?: "brand" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <Card style={styles.metric}>
      <View
        style={[
          styles.metricIcon,
          {
            backgroundColor:
              tone === "brand"
                ? "#F7ECE9"
                : tone === "success"
                  ? "#E8F8F2"
                  : tone === "warning"
                    ? "#FFF3DF"
                    : tone === "info"
                      ? "#EAF1FF"
                      : "#FEECEC",
          },
        ]}
      >
        <AppIcon name="metric" size={18} color={colors[tone]} />
      </View>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      {delta ? <Text style={styles.metricDelta}>{delta}</Text> : null}
    </Card>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: PropsWithChildren<{
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}>) {
  const color =
    tone === "success"
      ? colors.success
      : tone === "warning"
        ? colors.warning
        : tone === "danger"
          ? colors.danger
          : tone === "info"
            ? colors.info
            : colors.textMuted;
  return (
    <View style={[styles.badge, { backgroundColor: `${color}15` }]}>
      <Text style={[styles.badgeText, { color }]}>{children}</Text>
    </View>
  );
}

type DataTableCell = string | ReactNode;

function isTextCell(cell: DataTableCell): cell is string {
  return typeof cell === "string";
}

function isStatusCell(cell: string) {
  return [
    "active",
    "inactive",
    "pending",
    "approved",
    "rejected",
    "recorded",
    "valid",
    "invalid",
    "passing",
    "failing",
    "incomplete",
    "unavailable",
    "no sessions",
    "low risk",
    "medium risk",
    "high risk",
  ].includes(cell.trim().toLowerCase());
}

export function DataTable<Row extends DataTableCell[]>({
  columns,
  rows,
  onRowPress,
  columnWidths,
}: {
  columns: string[];
  rows: Row[];
  onRowPress?: (row: Row) => void;
  columnWidths?: number[];
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      accessibilityLabel="Scrollable data table"
    >
      <View style={styles.table}>
        <View style={[styles.tableRow, styles.tableHead]}>
          {columns.map((column, index) => (
            <Text key={column} style={[styles.cell, styles.headCell, columnWidths?.[index] ? { width: columnWidths[index], flexGrow: 0, flexShrink: 0 } : null]}>
              {column}
            </Text>
          ))}
        </View>
          {rows.map((row, index) => (
            <Pressable
              key={`${row[0]}-${index}`}
              accessibilityRole={onRowPress ? "button" : undefined}
              accessibilityLabel={
                onRowPress && isTextCell(row[0]) ? `Open ${row[0]}` : undefined
              }
              disabled={!onRowPress}
              onPress={() => onRowPress?.(row)}
              style={({ pressed }) => [
                styles.tableRow,
              pressed && onRowPress && styles.rowPressed,
            ]}
          >
              {row.map((cell, cellIndex) => (
                <View key={`${cell}-${cellIndex}`} style={[styles.cell, columnWidths?.[cellIndex] ? { width: columnWidths[cellIndex], flexGrow: 0, flexShrink: 0 } : null]}>
                  {cellIndex === row.length - 1 && isTextCell(cell) && isStatusCell(cell) ? (
                    <Badge
                      tone={
                        cell.includes("High") || cell.includes("Failed")
                        ? "danger"
                        : cell.includes("Medium") || cell.includes("Warning")
                          ? "warning"
                          : "success"
                    }
                    >
                      {cell}
                    </Badge>
                  ) : (
                    isTextCell(cell) ? <Text style={styles.cellText}>{cell}</Text> : cell
                  )}
                </View>
              ))}
            </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

export function PageState({
  kind,
  title,
  message,
  action,
}: {
  kind: "loading" | "empty" | "error" | "denied";
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.state}>
      {kind === "loading" ? (
        <ActivityIndicator accessibilityLabel="Loading" color={colors.brand} />
      ) : (
        <View style={styles.stateIcon}>
          <AppIcon
            name={
              kind === "error"
                ? "error"
                : kind === "denied"
                  ? "denied"
                  : "empty"
            }
            size={23}
            color={colors.textMuted}
          />
        </View>
      )}
      <Text accessibilityRole="header" style={styles.stateTitle}>
        {title}
      </Text>
      <Text style={styles.stateMessage}>{message}</Text>
      {action}
    </View>
  );
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  pending = false,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={pending ? undefined : onClose}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <Card style={styles.dialog}>
          <Text accessibilityRole="header" style={styles.dialogTitle}>
            {title}
          </Text>
          <Text style={styles.dialogMessage}>{message}</Text>
          <View style={styles.dialogActions}>
            <Button
              label={cancelLabel}
              variant="secondary"
              disabled={pending}
              onPress={onClose}
            />
            <Button
              label={confirmLabel}
              loading={pending}
              variant={danger ? "danger" : "primary"}
              onPress={onConfirm}
            />
          </View>
        </Card>
      </View>
    </Modal>
  );
}

export function Toast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <Pressable accessibilityLabel={`${message}. Dismiss notification`} onPress={onClose} style={styles.toast}>
      <AppIcon name="success" size={17} color="#FFF" />
      <Text style={styles.toastText}>{message}</Text>
    </Pressable>
  );
}

export function Tabs({
  values,
  selected,
  onSelect,
}: {
  values: string[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.tabs}>
      {values.map((value) => (
        <Pressable
          key={value}
          accessibilityRole="tab"
          accessibilityState={{ selected: selected === value }}
          onPress={() => onSelect(value)}
          style={[styles.tab, selected === value && styles.activeTab]}
        >
          <Text
            style={[styles.tabText, selected === value && styles.activeTabText]}
          >
            {value}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function SearchFilter({
  value,
  onChange,
  placeholder = "Search records...",
  accessibilityLabel = "Search records",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
}) {
  return (
    <View style={styles.search}>
      <AppIcon name="search" size={18} color={colors.textMuted} />
      <TextInput
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#99A1AF"
        style={styles.searchInput}
      />
    </View>
  );
}

type ToastState = { message: string; show: (message: string) => void; clear: () => void };
const ToastContext = createContext<ToastState | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
  const [message, setMessage] = useState("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setMessage("");
  }, []);
  const show = useCallback((nextMessage: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setMessage(nextMessage);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      setMessage("");
    }, 10000);
  }, []);
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  return (
    <ToastContext.Provider value={{ message, show, clear }}>
      {children}
      <View pointerEvents="box-none" style={styles.toastHost}>
        {message ? <Toast message={message} onClose={clear} /> : null}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used inside ToastProvider.");
  return toast;
}

const styles = StyleSheet.create({
  button: {
    minHeight: 40,
    paddingHorizontal: 18,
    borderRadius: radius.medium,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brand,
  },
  button_primary: { backgroundColor: colors.brand },
  button_secondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  button_danger: { backgroundColor: colors.danger },
  button_ghost: { backgroundColor: "transparent" },
  pressed: { opacity: 0.78, transform: [{ scale: 0.96 }] },
  disabled: { opacity: 0.5 },
  buttonText: { color: "#FFF", fontSize: 13, fontWeight: "600" },
  buttonTextDark: { color: colors.text },
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 13, fontWeight: "600" },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: radius.medium,
    paddingHorizontal: 12,
    backgroundColor: "#FFF",
    color: colors.text,
    fontSize: Platform.OS === "web" ? 14 : 16,
  },
  webDateInput: {
    boxSizing: "border-box",
    width: "100%",
    height: 44,
    border: "1px solid #D1D5DB",
    borderRadius: radius.medium,
    paddingHorizontal: 12,
    paddingVertical: 0,
    backgroundColor: "#FFF",
    color: colors.text,
    fontSize: 14,
    fontFamily: "inherit",
  } as never,
  inputError: { borderColor: colors.danger },
  secureInput: { paddingRight: 48 },
  visibilityToggle: {
    position: "absolute",
    right: 7,
    top: 6,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.small,
  },
  error: { color: colors.danger, fontSize: 12 },
  selectInput: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectValue: { flex: 1, color: colors.text, fontSize: Platform.OS === "web" ? 14 : 16 },
  selectPlaceholder: { color: "#99A1AF" },
  selectOverlay: {
    flex: 1,
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#00000066",
  },
  selectDialog: {
    width: "100%",
    maxWidth: 460,
    maxHeight: "80%",
    gap: 14,
    padding: 20,
  },
  selectTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  selectEmpty: { color: colors.textMuted, fontSize: 13, padding: 12, textAlign: "center" },
  selectOptions: { maxHeight: 360 },
  selectOption: {
    minHeight: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.medium,
  },
  selectOptionActive: { backgroundColor: "#F7ECE9" },
  selectOptionText: { color: colors.text, fontSize: 14 },
  selectOptionTextActive: { color: colors.brand, fontWeight: "700" },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    ...shadow,
  },
  metric: { flex: 1, minWidth: 185, gap: 4 },
  metricIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  metricLabel: { color: colors.textMuted, fontSize: 12 },
  metricValue: {
    color: colors.text,
    fontSize: 24,
    lineHeight: 32,
    fontWeight: "700",
  },
  metricDelta: { color: colors.success, fontSize: 11 },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  badgeText: { fontSize: 11, fontWeight: "600" },
  table: {
    width: "100%",
    minWidth: 760,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.medium,
    overflow: "hidden",
  },
  tableRow: {
    flexDirection: "row",
    minHeight: 50,
    alignItems: "center",
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFF",
  },
  tableHead: { backgroundColor: colors.surfaceMuted },
  cell: { flex: 1, minWidth: 110, paddingHorizontal: 14 },
  headCell: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  cellText: { color: colors.text, fontSize: 13 },
  rowPressed: { backgroundColor: "#FCF8F7" },
  state: { padding: 42, alignItems: "center", gap: 8 },
  stateIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    backgroundColor: "#F3F4F6",
  },
  stateTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  stateMessage: {
    maxWidth: 420,
    textAlign: "center",
    fontSize: Platform.OS === "web" ? 13 : 16,
    color: colors.textMuted,
  },
  overlay: {
    flex: 1,
    backgroundColor: "#00000066",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  dialog: { width: "100%", maxWidth: 430, padding: 24 },
  dialogTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  dialogMessage: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 20,
  },
  dialogActions: {
    marginTop: 24,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  toast: {
    position: "absolute",
    right: 24,
    top: 24,
    zIndex: 100,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#102A22",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: radius.medium,
    ...shadow,
  },
  toastHost: { ...StyleSheet.absoluteFill, zIndex: 1000, elevation: 1000 },
  toastText: { color: "#FFF", fontSize: 13 },
  tabs: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: colors.border,
    gap: 18,
  },
  tab: { paddingVertical: 10 },
  activeTab: { borderBottomWidth: 2, borderColor: colors.brand },
  tabText: { color: colors.textMuted, fontSize: 13 },
  activeTabText: { color: colors.brand, fontWeight: "600" },
  search: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0,
    width: "100%",
    maxWidth: 420,
    height: 40,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFF",
    borderRadius: radius.medium,
    paddingHorizontal: 12,
  },
  searchIcon: { color: colors.textMuted, fontSize: 18 },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
    color: colors.text,
    fontSize: Platform.OS === "web" ? 13 : 16,
  },
});
