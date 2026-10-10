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
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { colors, radius, shadow, space } from "@/theme/tokens";
import { AppIcon } from "@/components/Icon";
import type { AppIconName } from "@/components/Icon";

function buttonIcon(label: string): AppIconName {
  const action = label.trim().toLowerCase();
  if (/delete|remove|deactivate|reject|clear/.test(action)) return "delete";
  if (/edit|manage|update|review/.test(action)) return "edit";
  if (/save|submit/.test(action)) return "save";
  if (/confirm|approve|record/.test(action)) return "apply";
  if (/export|download|report/.test(action)) return "download";
  if (/import|upload|browse|choose file/.test(action)) return "upload";
  if (/search|filter/.test(action)) return "search";
  if (/retry|refresh/.test(action)) return "refresh";
  if (/close|cancel|back/.test(action)) return "cancel";
  if (/show|view|open|details/.test(action)) return "show";
  if (/hide/.test(action)) return "hide";
  if (/apply|assign/.test(action)) return "apply";
  if (/create|add|new/.test(action)) return "add";
  if (/log ?out|sign ?out/.test(action)) return "logout";
  return "info";
}

function buttonDescription(label: string) {
  const action = label.trim().replace(/\s+/g, " ");
  return `${action.endsWith("?") ? action : `${action}.`} Activate to continue.`;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  icon,
  description,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  icon?: AppIconName;
  description?: string;
}) {
  const hint = description ?? buttonDescription(label);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      {...(Platform.OS === "web" ? ({ title: hint } as never) : {})}
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
        <View style={styles.buttonContent}>
          <AppIcon name={icon ?? buttonIcon(label)} size={15} color={variant === "primary" || variant === "danger" ? "#FFF" : colors.brand} />
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
        </View>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  containerStyle,
  inputRef,
  onKeyDown,
  compact = false,
  inputType,
  helpText,
  helpExample,
  ...props
}: TextInputProps & {
  label: string;
  error?: string;
  containerStyle?: StyleProp<ViewStyle>;
  inputRef?: (instance: TextInput | null) => void;
  onKeyDown?: (event: any) => void;
  compact?: boolean;
  inputType?: "date" | "email" | "text" | "color";
  helpText?: string;
  helpExample?: string;
}) {
  const [secureVisible, setSecureVisible] = useState(false);
  const isSecure = Boolean(props.secureTextEntry);
  return (
    <View style={[styles.field, compact && styles.compactField, containerStyle]}>
      <View style={styles.labelRow}><Text style={[styles.label, compact && styles.compactLabel]}>{label}</Text>{helpText ? <HelpTooltip title={label} text={helpText} example={helpExample} /> : null}</View>
      <View>
        <TextInput
          {...props}
          ref={inputRef}
          {...(onKeyDown ? ({ onKeyDown } as any) : {})}
          {...(Platform.OS === "web" && inputType ? ({ type: inputType } as never) : {})}
          secureTextEntry={isSecure ? !secureVisible : props.secureTextEntry}
          accessibilityLabel={props.accessibilityLabel ?? label}
          placeholderTextColor="#99A1AF"
          style={[styles.input, compact && styles.compactInput, isSecure && styles.secureInput, error && styles.inputError, props.style]}
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

export type SelectOption = { label: string; value: string; helpText?: string; helpExample?: string };

export function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder = "Select an option",
  error,
  disabled = false,
  containerStyle,
  controlStyle,
  valueStyle,
  compact = false,
  accessibilityLabel,
  searchable = false,
  deferModalUntilOpen = false,
  helpText,
  helpExample,
  controlRef,
  controlDataSet,
  onKeyDown,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  controlStyle?: StyleProp<ViewStyle>;
  valueStyle?: StyleProp<TextStyle>;
  compact?: boolean;
  accessibilityLabel?: string;
  searchable?: boolean;
  deferModalUntilOpen?: boolean;
  helpText?: string;
  helpExample?: string;
  controlRef?: (instance: any) => void;
  controlDataSet?: Record<string, string>;
  onKeyDown?: (event: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((option) => option.value === value);
  const filteredOptions = searchable
    ? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  return (
    <View style={[styles.field, compact && styles.compactField, containerStyle]}>
      <View style={styles.labelRow}><Text style={[styles.label, compact && styles.compactLabel]}>{label}</Text>{helpText ? <HelpTooltip title={label} text={helpText} example={helpExample} /> : null}</View>
      <Pressable
        ref={controlRef as any}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => { setQuery(''); setOpen(true); }}
        {...(controlDataSet ? ({ dataSet: controlDataSet } as any) : {})}
        {...(onKeyDown ? ({ onKeyDown } as any) : {})}
        style={[styles.input, styles.selectInput, compact && styles.compactSelectInput, disabled && styles.disabled, controlStyle]}
      >
        <Text
          style={[styles.selectValue, compact && styles.compactSelectValue, !selected && styles.selectPlaceholder, valueStyle]}
        >
          {selected?.label ?? placeholder}
        </Text>
        <AppIcon name="chevronDown" size={14} color={colors.textMuted} />
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {(!deferModalUntilOpen || open) ? <Modal
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
                <View key={option.value} style={styles.selectOptionRow}>
                  <Pressable
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
                  {option.helpText ? <HelpTooltip title={option.label} text={option.helpText} example={option.helpExample ?? `For ${label}: ${option.label}`} /> : null}
                </View>
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
      </Modal> : null}
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
  valueColor,
}: {
  label: string;
  value: string;
  delta?: string;
  tone?: "brand" | "success" | "warning" | "danger" | "info";
  valueColor?: string;
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
      <Text style={[styles.metricValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
      {delta ? <Text style={styles.metricDelta}>{delta}</Text> : null}
    </Card>
  );
}

export function Badge({
  children,
  tone = "neutral",
  color: customColor,
}: PropsWithChildren<{
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  color?: string;
}>) {
  const color = customColor ?? (
    tone === "success"
      ? colors.success
      : tone === "warning"
        ? colors.warning
        : tone === "danger"
          ? colors.danger
          : tone === "info"
            ? colors.info
            : colors.textMuted);
  const parsedColor = customColor?.match(/^#([\da-f]{6})$/i)?.[1];
  const isLightCustomColor = parsedColor ? ((parseInt(parsedColor.slice(0, 2), 16) * 299 + parseInt(parsedColor.slice(2, 4), 16) * 587 + parseInt(parsedColor.slice(4, 6), 16) * 114) / 1000) > 205 : false;
  const foregroundColor = isLightCustomColor ? '#475569' : color;
  return (
    <View style={[styles.badge, { backgroundColor: `${color}22`, borderWidth: isLightCustomColor ? 1 : 0, borderColor: isLightCustomColor ? '#CBD5E1' : 'transparent' }]}>
      <Text style={[styles.badgeText, { color: foregroundColor }]}>{children}</Text>
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
  compact = false,
}: {
  columns: string[];
  rows: Row[];
  onRowPress?: (row: Row) => void;
  columnWidths?: number[];
  compact?: boolean;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      accessibilityLabel="Scrollable data table"
    >
      <View style={styles.table}>
        <View style={[styles.tableRow, styles.tableHead, compact && styles.compactTableRow]}>
          {columns.map((column, index) => (
            <Text key={column} style={[styles.cell, styles.headCell, compact && styles.compactCell, columnWidths?.[index] ? { width: columnWidths[index], flexGrow: 0, flexShrink: 0 } : null]}>
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
                compact && styles.compactTableRow,
              pressed && onRowPress && styles.rowPressed,
            ]}
          >
              {row.map((cell, cellIndex) => (
                <View key={`${cell}-${cellIndex}`} style={[styles.cell, compact && styles.compactCell, columnWidths?.[cellIndex] ? { width: columnWidths[cellIndex], flexGrow: 0, flexShrink: 0 } : null]}>
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

export function RefreshIndicator({ visible, label = "Updating records…" }: { visible: boolean; label?: string }) {
  if (!visible) return null;
  return (
    <View pointerEvents="none" accessibilityRole="progressbar" accessibilityLabel={label} accessibilityLiveRegion="polite" style={styles.refreshIndicator}>
      <ActivityIndicator size="small" color={colors.brand} />
      <Text style={styles.refreshIndicatorText}>{label}</Text>
    </View>
  );
}

export function HelpTooltip({ title, text, example }: { title: string; text: string; example?: string }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<any>(null);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [anchor, setAnchor] = useState({ x: 8, y: 8, width: 20, height: 20 });
  const [position, setPosition] = useState({ left: 8, top: 36, width: 260, arrowLeft: 12, side: 'below' as 'above' | 'below' });
  const openTooltip = (event: any) => {
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    const place = (x: number, y: number, width: number, height: number) => {
      setAnchor({ x, y, width, height });
      const tooltipWidth = Math.min(280, Math.max(120, screenWidth - 16));
      const center = x + width / 2;
      const left = Math.max(8, Math.min(center - tooltipWidth / 2, screenWidth - tooltipWidth - 8));
      const estimatedHeight = example ? 190 : 145;
      const side = y + height + estimatedHeight + 8 <= screenHeight - 8 ? 'below' : 'above';
      const top = side === 'below' ? y + height + 6 : Math.max(8, y - estimatedHeight - 6);
      const arrowLeft = Math.max(12, Math.min(center - left - 6, tooltipWidth - 24));
      setPosition({ left, top, width: tooltipWidth, arrowLeft, side });
      setOpen(true);
    };
    if (rect) place(rect.left, rect.top, rect.width, rect.height);
    else if (anchorRef.current?.measureInWindow) anchorRef.current.measureInWindow((x: number, y: number, width: number, height: number) => place(x, y, width, height));
    else place(8, 8, 20, 20);
  };
  const adjustToMeasuredHeight = (event: any) => {
    const height = event.nativeEvent.layout.height;
    const below = anchor.y + anchor.height + height + 6;
    const side = below <= screenHeight - 8 ? 'below' : 'above';
    const top = side === 'below' ? anchor.y + anchor.height + 6 : Math.max(8, anchor.y - height - 6);
    setPosition((current) => current.top === top && current.side === side ? current : { ...current, top, side });
  };
  return (
    <>
      <Pressable
        ref={anchorRef}
        accessibilityRole="button"
        accessibilityLabel={`Help for ${title}`}
        accessibilityState={{ expanded: open }}
        onPress={(event) => open ? setOpen(false) : openTooltip(event)}
        style={styles.helpTooltipButton}
      >
        <Text style={styles.helpTooltipButtonText}>?</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} presentationStyle="overFullScreen">
        <View style={styles.helpTooltipOverlay}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close help" onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
          <View onLayout={adjustToMeasuredHeight} style={[styles.helpTooltipBubble, { left: position.left, top: position.top, width: position.width, maxHeight: screenHeight - 16 }]}>
            <View style={[styles.helpTooltipArrow, position.side === 'below' ? styles.helpTooltipArrowAbove : styles.helpTooltipArrowBelow, { left: position.arrowLeft }]} />
            <Text style={styles.helpTooltipTitle}>{title}</Text>
            <Text style={styles.helpTooltipText}>{text}</Text>
            {example ? <View style={styles.helpTooltipExample}><Text style={styles.helpTooltipExampleLabel}>Example</Text><Text style={styles.helpTooltipExampleText}>{example}</Text></View> : null}
          </View>
        </View>
      </Modal>
    </>
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
  buttonContent: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  refreshIndicator: { position: "absolute", top: 0, right: 0, zIndex: 10, flexDirection: "row", alignItems: "center", gap: 7, minHeight: 24 },
  refreshIndicatorText: { color: colors.textMuted, fontSize: 11 },
  field: { gap: 6 },
  label: { color: colors.text, fontSize: 13, fontWeight: "600" },
  compactField: { gap: 2 },
  compactLabel: { fontSize: 9, lineHeight: 10 },
  compactInput: { minHeight: 24, height: 25, paddingHorizontal: 5, paddingVertical: 0, borderRadius: 4, fontSize: 11 },
  compactSelectInput: { minHeight: 24, height: 25, paddingHorizontal: 5, borderRadius: 4 },
  compactSelectValue: { fontSize: 11 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  helpTooltipOverlay: { flex: 1, position: "relative", backgroundColor: "transparent" },
  helpTooltipButton: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: "#AAB4C3", backgroundColor: "#FFF", alignItems: "center", justifyContent: "center" },
  helpTooltipButtonText: { color: colors.brand, fontSize: 12, fontWeight: "800", lineHeight: 16 },
  helpTooltipBubble: { position: "absolute", zIndex: 99999, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: "#FFF", ...shadow },
  helpTooltipArrow: { position: "absolute", width: 0, height: 0, borderLeftWidth: 7, borderRightWidth: 7, borderLeftColor: "transparent", borderRightColor: "transparent" },
  helpTooltipArrowAbove: { top: -8, borderBottomWidth: 8, borderBottomColor: "#FFF" },
  helpTooltipArrowBelow: { bottom: -8, borderTopWidth: 8, borderTopColor: "#FFF" },
  helpTooltipTitle: { color: colors.text, fontSize: 12, fontWeight: "700", marginBottom: 4 },
  helpTooltipText: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  helpTooltipExample: { marginTop: 9, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 7, borderWidth: 1, borderColor: "#D8E1EF", backgroundColor: "#F2F6FC" },
  helpTooltipExampleLabel: { color: colors.brand, fontSize: 10, fontWeight: "800", textTransform: "uppercase", marginBottom: 3 },
  helpTooltipExampleText: { color: colors.text, fontSize: 12, lineHeight: 17, fontFamily: Platform.OS === "web" ? "monospace" : undefined },
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
  selectOptionRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 4 },
  selectOption: {
    flex: 1,
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
  compactTableRow: { minHeight: 36 },
  tableHead: { backgroundColor: colors.surfaceMuted },
  cell: { flex: 1, minWidth: 110, paddingHorizontal: 14 },
  compactCell: { paddingVertical: 5, paddingHorizontal: 10 },
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
