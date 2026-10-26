import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent, type PropsWithChildren, type ReactNode } from "react";
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
import { formatStudentId, formatStudentIdInput } from "@/utils/studentId";
import { loadFailingGradesRedPreference, loadTablePaginationPreference } from "@/services/actions";

function buttonIcon(label: string): AppIconName {
  const action = label.trim().toLowerCase();
  if (/undo/.test(action)) return "undo";
  if (/redo/.test(action)) return "redo";
  if (/restore|reinstate/.test(action)) return "restore";
  if (/history|changes/.test(action)) return "history";
  if (/archive/.test(action)) return "archive";
  if (/^↑$|move up|make top level|promote/.test(action)) return "moveUp";
  if (/^↓$|move down|demote/.test(action)) return "moveDown";
  if (/previous|back/.test(action)) return "previous";
  if (/next|forward/.test(action)) return "next";
  if (/continue/.test(action)) return "next";
  if (/try again|retry|refresh/.test(action)) return "refresh";
  if (/test connection/.test(action)) return "connection";
  if (/enable mfa|security/.test(action)) return "security";
  if (/mark .* read|done|all present/.test(action)) return "apply";
  if (/all absent/.test(action)) return "absent";
  if (/select all/.test(action)) return "select";
  if (/^send|send question/.test(action)) return "send";
  if (/run ai|generate|draft with ai|draft with gemini|prepare with another ai/.test(action)) return "assistant";
  if (/validate|grading criteria/.test(action)) return "criteria";
  if (/performance evaluation|evaluation criteria|prediction/.test(action)) return "evaluation";
  if (/grading systems/.test(action)) return "grades";
  if (/clear|reset/.test(action)) return "clear";
  if (/delete|remove|deactivate|reject/.test(action)) return "delete";
  if (/manage/.test(action)) return "settings";
  if (/edit|update|review/.test(action)) return "edit";
  if (/save|submit/.test(action)) return "save";
  if (/confirm|approve|record/.test(action)) return "apply";
  if (/export|download|report/.test(action)) return "download";
  if (/import|upload|browse|choose|photo/.test(action)) return "upload";
  if (/write batch/.test(action)) return "save";
  if (/request subject/.test(action)) return "add";
  if (/search|filter/.test(action)) return "search";
  if (/close|cancel|back/.test(action)) return "cancel";
  if (/show|view|open|details/.test(action)) return "show";
  if (/hide/.test(action)) return "hide";
  if (/expand/.test(action)) return "expand";
  if (/collapse/.test(action)) return "collapse";
  if (/duplicate|copy/.test(action)) return "copy";
  if (/paste/.test(action)) return "paste";
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
  compact = false,
  containerStyle,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  icon?: AppIconName;
  description?: string;
  compact?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
}) {
  const hint = description ?? buttonDescription(label);
  const compactControls = useContext(CompactControlsContext);
  const dense = compactControls || compact;
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
        dense && styles.buttonDense,
        styles[`button_${variant}`],
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
        containerStyle,
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
              dense && styles.buttonTextDense,
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
  const compactControls = useContext(CompactControlsContext);
  const isSecure = Boolean(props.secureTextEntry);
  const isStudentId = /student\s*(?:id|number)\b/i.test(label);
  return (
    <View style={[styles.field, compactControls && !props.multiline && styles.fieldDense, compact && styles.compactField, containerStyle]}>
      <View style={styles.labelRow}><Text style={[styles.label, compact && styles.compactLabel]}>{label}</Text>{helpText ? <HelpTooltip title={label} text={helpText} example={helpExample} /> : null}</View>
      <View>
        <TextInput
          {...props}
          value={isStudentId && typeof props.value === "string" ? formatStudentId(props.value) : props.value}
          onChangeText={isStudentId && props.onChangeText ? (value) => props.onChangeText?.(formatStudentIdInput(value)) : props.onChangeText}
          ref={inputRef}
          {...(onKeyDown ? ({ onKeyDown } as any) : {})}
          {...(Platform.OS === "web" && inputType ? ({ type: inputType } as never) : {})}
          secureTextEntry={isSecure ? !secureVisible : props.secureTextEntry}
          accessibilityLabel={props.accessibilityLabel ?? label}
          placeholderTextColor="#99A1AF"
          style={[styles.input, compactControls && !props.multiline && styles.inputDense, compact && styles.compactInput, isSecure && styles.secureInput, error && styles.inputError, props.style]}
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
  const compactControls = useContext(CompactControlsContext);
  if (Platform.OS !== "web") {
    return <Field label={label} value={value} onChangeText={onChange} placeholder="YYYY-MM-DD" error={error} containerStyle={containerStyle} />;
  }

  return (
    <View style={[styles.field, compactControls && styles.fieldDense, containerStyle]}>
      <Text style={styles.label}>{label}</Text>
      {createElement("input", {
        type: "date",
        value,
        onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value),
        "aria-label": label,
        style: compactControls ? styles.webDateInputDense : styles.webDateInput,
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
  hideLabel = false,
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
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const compactControls = useContext(CompactControlsContext);
  const selected = options.find((option) => option.value === value);
  const filteredOptions = searchable
    ? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;
  return (
    <View style={[styles.field, compactControls && styles.fieldDense, compact && styles.compactField, containerStyle]}>
      {!hideLabel ? <View style={styles.labelRow}><Text style={[styles.label, compact && styles.compactLabel]}>{label}</Text>{helpText ? <HelpTooltip title={label} text={helpText} example={helpExample} /> : null}</View> : null}
      <Pressable
        ref={controlRef as any}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => { setQuery(''); setOpen(true); }}
        {...(controlDataSet ? ({ dataSet: controlDataSet } as any) : {})}
        {...(onKeyDown ? ({ onKeyDown } as any) : {})}
        style={[styles.input, compactControls && styles.inputDense, styles.selectInput, compact && styles.compactSelectInput, disabled && styles.disabled, controlStyle]}
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
const tablePageSizes = [5, 10, 25, 50, 100, 500];

const TablePaginationContext = createContext({ enabled: true, setEnabled: (_enabled: boolean) => {}, failingGradesRed: true, setFailingGradesRed: (_enabled: boolean) => {} });

export function TablePaginationProvider({ userId, demoMode, children }: PropsWithChildren<{ userId?: string; demoMode: boolean }>) {
  const [enabled, setEnabled] = useState(true);
  const [failingGradesRed, setFailingGradesRed] = useState(true);
  useEffect(() => {
    let active = true;
    setEnabled(true);
    setFailingGradesRed(true);
    void loadTablePaginationPreference(demoMode ? undefined : userId).then((value) => { if (active) setEnabled(value); }).catch(() => {});
    void loadFailingGradesRedPreference(demoMode ? undefined : userId).then((value) => { if (active) setFailingGradesRed(value); }).catch(() => {});
    return () => { active = false; };
  }, [userId, demoMode]);
  return <TablePaginationContext.Provider value={{ enabled, setEnabled, failingGradesRed, setFailingGradesRed }}>{children}</TablePaginationContext.Provider>;
}

export function useTablePaginationPreference() {
  return useContext(TablePaginationContext);
}

export function TablePageSizeSelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <SelectField label="Rows per page" hideLabel compact value={String(value)} options={tablePageSizes.map((size) => ({ label: `${size} rows`, value: String(size) }))} onChange={(next) => onChange(Number(next))} containerStyle={styles.tablePageSizeField} accessibilityLabel="Rows per page" />;
}

function isTextCell(cell: DataTableCell): cell is string {
  return typeof cell === "string";
}

function isStatusCell(cell: string) {
  return [
    "active",
    "invited",
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
  paginationEnabled,
  widthMode,
  columnHeaderContent,
  columnFlex,
  highlightRow,
  highlightCell,
  formatCell,
}: {
  columns: string[];
  rows: Row[];
  onRowPress?: (row: Row) => void;
  columnWidths?: number[];
  compact?: boolean;
  paginationEnabled?: boolean;
  widthMode?: "content" | "container";
  columnHeaderContent?: (ReactNode | undefined)[];
  columnFlex?: number[];
  highlightRow?: (row: Row) => boolean;
  highlightCell?: (row: Row, columnIndex: number) => boolean;
  formatCell?: (cell: Row[number], row: Row, columnIndex: number) => ReactNode | undefined;
}) {
  const paginationPreference = useTablePaginationPreference();
  const highlightFailingGrades = paginationPreference.failingGradesRed;
  const shouldPaginate = paginationEnabled ?? paginationPreference.enabled;
  const resolvedWidthMode = widthMode ?? (compact ? "content" : "container");
  const [sort, setSort] = useState<{ index: number; direction: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [dateRanges, setDateRanges] = useState<Record<number, TableDateRange>>({});
  const [multiFilters, setMultiFilters] = useState<Record<number, string[]>>({});
  const [filterColumn, setFilterColumn] = useState<number | null>(null);
  const [hoveredHeader, setHoveredHeader] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [availableWidth, setAvailableWidth] = useState(0);
  const studentIdColumns = columns.map((column) => /student\s*(?:id|number)\b/i.test(column));
  const statusColumns = columns.map((column) => /^(?:status|state)$/i.test(column.trim()));
  const actionColumns = columns.map((column) => /^(?:actions?|manage|edit|view|remove|delete|select)$/i.test(column.trim()));
  const filterKinds = useMemo(() => columns.map((column, index) => tableFilterKind(column, rows, index)), [columns, rows]);
  const categoricalOptions = useMemo(() => columns.map((_, index) => filterKinds[index] === "multi"
    ? [...new Set(rows.map((row) => row[index]).filter(isTextCell).map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    : []), [columns, filterKinds, rows]);
  const widths = useMemo(() => columns.map((column, index) => {
    if (columnWidths?.[index]) return columnWidths[index];
    if (actionColumns[index]) return 96;
    const values = rows.map((row) => row[index]).filter(isTextCell) as string[];
    const longest = Math.max(column.length, ...values.map((value) => value.length));
    const paragraphLike = values.some((value) => value.includes("\n") || value.length > 72);
    return paragraphLike ? 280 : longest <= 8 ? 88 : longest <= 15 ? 112 : longest <= 26 ? 148 : 210;
  }), [columns, columnWidths, rows, actionColumns]);
  const visibleRows = useMemo(() => {
    const filtered = rows.filter((row) => columns.every((_, index) => {
      const cell = row[index];
      const textFilter = filters[index]?.trim();
      if (textFilter && (!isTextCell(cell) || !cell.toLocaleLowerCase().includes(textFilter.toLocaleLowerCase()))) return false;
      const selected = multiFilters[index] ?? [];
      if (selected.length && (!isTextCell(cell) || !selected.includes(cell.trim()))) return false;
      const range = dateRanges[index];
      if (range?.from || range?.to) {
        if (!isTextCell(cell)) return false;
        const timestamp = new Date(cell).getTime();
        if (!Number.isFinite(timestamp)) return false;
        const dateOnly = filterKinds[index] === "date";
        const fromTimestamp = range.from ? new Date(dateOnly ? `${range.from}T00:00:00` : range.from).getTime() : null;
        const toTimestamp = range.to ? new Date(dateOnly ? `${range.to}T23:59:59.999` : range.to).getTime() : null;
        if (fromTimestamp != null && Number.isFinite(fromTimestamp) && timestamp < fromTimestamp) return false;
        if (toTimestamp != null && Number.isFinite(toTimestamp) && timestamp > toTimestamp) return false;
      }
      return true;
    }));
    if (!sort) return filtered;
    return [...filtered].sort((left, right) => {
      const a = left[sort.index];
      const b = right[sort.index];
      const leftValue = isTextCell(a) ? a : "";
      const rightValue = isTextCell(b) ? b : "";
      const normalizedA = leftValue.replace(/[,\s%]/g, "");
      const normalizedB = rightValue.replace(/[,\s%]/g, "");
      const numericA = Number(normalizedA);
      const numericB = Number(normalizedB);
      const numericValues = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalizedA) && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalizedB);
      const leftDate = filterKinds[sort.index] === "date" || filterKinds[sort.index] === "dateTime" ? new Date(leftValue).getTime() : Number.NaN;
      const rightDate = filterKinds[sort.index] === "date" || filterKinds[sort.index] === "dateTime" ? new Date(rightValue).getTime() : Number.NaN;
      const compared = Number.isFinite(leftDate) && Number.isFinite(rightDate)
        ? leftDate - rightDate
        : numericValues
          ? numericA - numericB
          : leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
      return sort.direction === "asc" ? compared : -compared;
    });
  }, [rows, columns, filters, dateRanges, multiFilters, filterKinds, sort]);
  const contentWidth = widths.reduce((total, width) => total + width, 0);
  const tableWidth = resolvedWidthMode === "container" ? Math.max(contentWidth, availableWidth) : contentWidth;
  const extraWidth = Math.max(0, tableWidth - contentWidth);
  const automaticFlex: number[] = columns.map((column, index) => actionColumns[index] ? 0 : /name|title|department|program|subject|student|email|description|entity|actor|scope|term|criteria/i.test(column) ? 1 : 0);
  const automaticFlexTotal = automaticFlex.reduce<number>((total, weight) => total + weight, 0);
  const fallbackFlex = columns.map((_, index) => actionColumns[index] ? 0 : 1);
  const fitFlex = columnFlex ?? (automaticFlexTotal ? automaticFlex : fallbackFlex);
  const flexTotal = fitFlex.reduce((total, weight) => total + Math.max(0, weight), 0);
  const fittedWidths = extraWidth > 0 && flexTotal > 0
    ? widths.map((width, index) => width + extraWidth * Math.max(0, fitFlex[index] ?? 0) / flexTotal)
    : extraWidth > 0 && contentWidth > 0
      ? widths.map((width) => width * tableWidth / contentWidth)
      : widths;
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const displayedRows = shouldPaginate ? visibleRows.slice(page * pageSize, (page + 1) * pageSize) : visibleRows;
  const columnStyle = (index: number) => ({ width: fittedWidths[index], flexBasis: fittedWidths[index], flexGrow: 0, flexShrink: 0 });
  useEffect(() => { setPage((current) => Math.min(current, pageCount - 1)); }, [pageCount]);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator
      accessibilityLabel="Scrollable data table"
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      <View style={[styles.table, { width: tableWidth }]}>
        <View style={[styles.tableRow, styles.tableHead, compact && styles.compactTableRow]}>
          {columns.map((column, index) => (
            <View key={column} style={[styles.cell, styles.headCellWrap, compact && styles.compactCell, columnStyle(index)]} {...(Platform.OS === "web" ? ({ onMouseEnter: () => setHoveredHeader(index), onMouseLeave: () => setHoveredHeader((current) => current === index ? null : current) } as never) : {})}>
              {columnHeaderContent?.[index] ? columnHeaderContent[index] : <>
                <View style={styles.tableHeaderLine}>
                  <Text numberOfLines={2} style={styles.headCellText}>{column}</Text>
                  {!actionColumns[index] ? <View style={[styles.tableHeaderActions, Platform.OS === "web" && hoveredHeader !== index && sort?.index !== index && filterColumn !== index && !filters[index] && !dateRanges[index]?.from && !dateRanges[index]?.to && !multiFilters[index]?.length && styles.tableHeaderActionsHidden]}>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Sort by ${column}`} {...(Platform.OS === "web" ? ({ title: `Sort by ${column}`, onFocus: () => setHoveredHeader(index) } as never) : {})} onPress={() => { setPage(0); setSort((current) => current?.index === index ? { index, direction: current.direction === "asc" ? "desc" : "asc" } : { index, direction: "asc" }); }} style={[styles.tableTool, sort?.index === index && styles.tableToolActive]}>
                      <AppIcon name={sort?.index === index && sort.direction === "desc" ? "sortDescending" : "sortAscending"} size={12} color={sort?.index === index ? colors.brand : colors.textMuted} />
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`${filterColumn === index ? "Hide" : "Filter"} ${column}`} {...(Platform.OS === "web" ? ({ title: `Filter ${column}`, onFocus: () => setHoveredHeader(index) } as never) : {})} onPress={() => setFilterColumn((current) => current === index ? null : index)} style={[styles.tableTool, Boolean(filterColumn === index || filters[index] || dateRanges[index]?.from || dateRanges[index]?.to || multiFilters[index]?.length) && styles.tableToolActive]}>
                      <AppIcon name="filter" size={12} color={Boolean(filterColumn === index || filters[index] || dateRanges[index]?.from || dateRanges[index]?.to || multiFilters[index]?.length) ? colors.brand : colors.textMuted} />
                    </Pressable>
                  </View> : null}
                </View>
                {!actionColumns[index] && filterColumn === index ? filterKinds[index] === "date" || filterKinds[index] === "dateTime"
                  ? <TableDateRangeFilter column={column} kind={filterKinds[index] as "date" | "dateTime"} value={dateRanges[index] ?? { from: "", to: "" }} onApply={(range) => { setPage(0); setDateRanges((current) => ({ ...current, [index]: range })); }} />
                  : filterKinds[index] === "multi"
                    ? <TableMultiSelectFilter column={column} options={categoricalOptions[index]} selected={multiFilters[index] ?? []} onChange={(values) => { setPage(0); setMultiFilters((current) => ({ ...current, [index]: values })); }} />
                    : <TextInput accessibilityLabel={`Filter ${column}`} placeholder="Filter…" placeholderTextColor="#99A1AF" value={filters[index] ?? ""} onChangeText={(value) => { setPage(0); setFilters((current) => ({ ...current, [index]: value })); }} style={styles.tableFilterInput} /> : null}
              </>}
            </View>
          ))}
        </View>
          {displayedRows.map((row, index) => (
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
                highlightRow?.(row) && styles.tableRowHighlighted,
              pressed && onRowPress && styles.rowPressed,
            ]}
          >
              {row.map((cell, cellIndex) => (
                <View key={`${cellIndex}-${String(cell)}`} style={[styles.cell, compact && styles.compactCell, columnStyle(cellIndex)]}>
                  {(statusColumns[cellIndex] || cellIndex === row.length - 1 || (isTextCell(cell) && cell.trim().toLowerCase() === "unavailable")) && isTextCell(cell) && isStatusCell(cell) ? (
                    <Badge
                      tone={
                        /^(?:inactive|closed|archived|disabled|never|unavailable)$/i.test(cell.trim())
                        ? "neutral"
                        : /high|failed|rejected|suspended|invalid/i.test(cell)
                        ? "danger"
                        : /invited/i.test(cell)
                          ? "info"
                        : /medium|warning|pending|planned/i.test(cell)
                          ? "warning"
                          : "success"
                    }
                    >
                      {cell}
                    </Badge>
                  ) : (
                    isTextCell(cell) ? formatCell?.(cell, row, cellIndex) ?? <Text style={[styles.cellText, onRowPress && cellIndex === 0 && styles.entityLink, highlightFailingGrades && (highlightCell?.(row, cellIndex) || isFailingGradeCell(columns[cellIndex], cell)) && styles.failingGradeCell]}>{studentIdColumns[cellIndex] ? formatStudentId(cell) : cell}</Text> : cell
                  )}
                </View>
              ))}
            </Pressable>
        ))}
        {!visibleRows.length ? <View style={styles.tableEmpty}><Text style={styles.tableEmptyText}>No matching rows</Text></View> : null}
        {shouldPaginate && visibleRows.length > 0 ? (
          <View style={styles.tablePagination}>
            <View style={styles.tablePaginationSummary}>
              <Text style={styles.tablePaginationText}>Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, visibleRows.length)} of {visibleRows.length}</Text>
              <TablePageSizeSelect value={pageSize} onChange={(value) => { setPageSize(value); setPage(0); }} />
            </View>
            <View style={styles.tablePaginationActions}>
              <Text style={styles.tablePaginationPage}>Page {page + 1} of {pageCount}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Previous page" disabled={page === 0} onPress={() => setPage((current) => Math.max(0, current - 1))} style={[styles.tablePageButton, page === 0 && styles.tablePageButtonDisabled]}><AppIcon name="previous" size={13} color={page === 0 ? "#A1A1AA" : colors.text} /></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Next page" disabled={page >= pageCount - 1} onPress={() => setPage((current) => Math.min(pageCount - 1, current + 1))} style={[styles.tablePageButton, page >= pageCount - 1 && styles.tablePageButtonDisabled]}><AppIcon name="next" size={13} color={page >= pageCount - 1 ? "#A1A1AA" : colors.text} /></Pressable>
            </View>
          </View>
        ) : null}
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
          <View style={styles.confirmDialogActions}>
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
  containerStyle,
  inputStyle,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
}) {
  const compactControls = useContext(CompactControlsContext);
  return (
    <View style={[styles.search, compactControls && styles.searchDense, containerStyle]}>
      <AppIcon name="search" size={18} color={colors.textMuted} />
      <TextInput
        accessibilityLabel={accessibilityLabel}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#99A1AF"
        style={[styles.searchInput, compactControls && styles.searchInputDense, inputStyle]}
      />
    </View>
  );
}

type ToastState = { message: string; show: (message: string) => void; clear: () => void };
const ToastContext = createContext<ToastState | null>(null);
const CompactControlsContext = createContext(false);

export function CompactControlsProvider({ children }: PropsWithChildren) {
  return <CompactControlsContext.Provider value={true}>{children}</CompactControlsContext.Provider>;
}

function isFailingGradeCell(column: string, value: string) {
  const normalizedColumn = column.trim().toLowerCase();
  if (!/(?:score|grade|standing|mastery|effort|final|percentage|^p[1-3]$)/i.test(normalizedColumn)) return false;
  const normalizedValue = value.trim();
  if (/^(?:fail|failing)$/i.test(normalizedValue) || /\bfailing\b/i.test(normalizedValue)) return true;
  const percentage = normalizedValue.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  return percentage ? Number(percentage[1]) < 80 : false;
}

type TableFilterKind = "date" | "dateTime" | "multi" | "text";
type TableDateRange = { from: string; to: string };

function tableFilterKind(column: string, rows: DataTableCell[][], index: number): TableFilterKind {
  const values = rows.map((row) => row[index]).filter(isTextCell).map((value) => value.trim()).filter(Boolean);
  const dateColumn = /\b(date|time|timestamp|created|updated|login|completed|starts|ends)\b/i.test(column);
  if (dateColumn && values.some((value) => Number.isFinite(new Date(value).getTime()))) {
    return /\b(time|timestamp|created|updated|login|completed)\b/i.test(column) || values.some((value) => /\d{1,2}:\d{2}/.test(value)) ? "dateTime" : "date";
  }
  const categoricalColumn = /\b(status|action|entity|role|scope|type|category|classification|severity|provider|model|result|permission|source|outcome|kind|semester|term|program|year|grade)\b/i.test(column);
  const uniqueValues = new Set(values);
  if (categoricalColumn && uniqueValues.size > 0 && uniqueValues.size <= 12 && values.every((value) => value.length <= 80 && !value.includes("\n"))) return "multi";
  return "text";
}

function TableDateRangeFilter({ column, kind, value, onApply }: { column: string; kind: "date" | "dateTime"; value: TableDateRange; onApply: (value: TableDateRange) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [calendarTarget, setCalendarTarget] = useState<"from" | "to">("from");
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  useEffect(() => { if (!open) setDraft(value); }, [open, value]);
  const active = !!(value.from || value.to);
  const inputType = kind === "dateTime" ? "datetime-local" : "date";
  const inputStyle = Platform.OS === "web" ? styles.tableRangeInput : styles.tableRangeNativeInput;
  const updateDateText = (key: "from" | "to", next: string) => setDraft((current) => ({ ...current, [key]: next }));
  const renderInput = (label: string, key: "from" | "to") => <View style={styles.tableRangeInputRow}>
    {Platform.OS === "web"
      ? createElement("input", { type: inputType, value: draft[key], "aria-label": `${column} ${label.toLowerCase()}`, onChange: (event: ChangeEvent<HTMLInputElement>) => updateDateText(key, event.currentTarget.value), style: inputStyle })
      : <TextInput accessibilityLabel={`${column} ${label.toLowerCase()}`} placeholder={kind === "dateTime" ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD"} value={draft[key]} onChangeText={(next) => updateDateText(key, next)} style={inputStyle} />}
    <Pressable accessibilityRole="button" accessibilityLabel={`Choose calendar date for ${column} ${label.toLowerCase()}`} accessibilityState={{ selected: calendarTarget === key }} onPress={() => {
      const currentDate = draft[key].slice(0, 10);
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(currentDate) ? new Date(`${currentDate}T00:00:00`) : new Date();
      setCalendarMonth(new Date(parsed.getFullYear(), parsed.getMonth(), 1));
      setCalendarTarget(key);
    }} style={styles.tableCalendarButton}><AppIcon name="events" size={15} color={calendarTarget === key ? colors.brand : colors.textMuted} /></Pressable>
  </View>;
  const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate();
  const firstWeekday = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1).getDay();
  const selectedDate = calendarTarget ? draft[calendarTarget].slice(0, 10) : "";
  const monthLabel = calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Set ${column} date range`} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={[styles.tableFilterTrigger, active && styles.tableFilterTriggerActive]}>
      <Text numberOfLines={1} style={styles.tableFilterTriggerText}>{active ? `${value.from || "…"} – ${value.to || "…"}` : "Date range"}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} presentationStyle="overFullScreen">
      <View style={styles.tableFilterOverlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close date range filter" onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={styles.tableFilterDialog}>
          <Text style={styles.tableFilterDialogTitle}>{column} range</Text>
          <View style={styles.tableRangeFields}><View style={styles.tableRangeField}><Text style={styles.tableRangeLabel}>From</Text>{renderInput("From", "from")}</View><View style={styles.tableRangeField}><Text style={styles.tableRangeLabel}>To</Text>{renderInput("To", "to")}</View></View>
          <View style={styles.tableCalendar}>
            <View style={styles.tableCalendarHeader}>
              <Pressable accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))} style={styles.tableCalendarNav}><Text style={styles.tableCalendarNavText}>‹</Text></Pressable>
              <Text style={styles.tableCalendarMonth}>{monthLabel}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Next month" onPress={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))} style={styles.tableCalendarNav}><Text style={styles.tableCalendarNavText}>›</Text></Pressable>
            </View>
            <View style={styles.tableCalendarGrid}>{["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => <Text key={day} style={styles.tableCalendarWeekday}>{day}</Text>)}
              {Array.from({ length: firstWeekday }, (_, index) => <View key={`blank-${index}`} style={styles.tableCalendarDay} />)}
              {Array.from({ length: daysInMonth }, (_, index) => {
                const day = index + 1;
                const dateValue = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const selected = selectedDate === dateValue;
                return <Pressable key={dateValue} accessibilityRole="button" accessibilityLabel={dateValue} accessibilityState={{ selected }} onPress={() => {
                  const time = kind === "dateTime" ? (draft[calendarTarget].slice(11, 16) || (calendarTarget === "from" ? "00:00" : "23:59")) : "";
                  updateDateText(calendarTarget, kind === "dateTime" ? `${dateValue}T${time}` : dateValue);
                }} style={[styles.tableCalendarDay, selected && styles.tableCalendarDaySelected]}><Text style={[styles.tableCalendarDayText, selected && styles.tableCalendarDayTextSelected]}>{day}</Text></Pressable>;
              })}
            </View>
          </View>
          <View style={styles.tableFilterDialogActions}>
            <Pressable accessibilityRole="button" onPress={() => { const cleared = { from: "", to: "" }; setDraft(cleared); onApply(cleared); setOpen(false); }} style={styles.tableFilterAction}><Text style={styles.tableFilterActionText}>Clear</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => { onApply(draft); setOpen(false); }} style={[styles.tableFilterAction, styles.tableFilterActionPrimary]}><Text style={[styles.tableFilterActionText, styles.tableFilterActionPrimaryText]}>Apply range</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  </>;
}

function TableMultiSelectFilter({ column, options, selected, onChange }: { column: string; options: string[]; selected: string[]; onChange: (values: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const toggle = (option: string) => onChange(selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option]);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={`Choose ${column} filter values`} accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={[styles.tableFilterTrigger, selected.length > 0 && styles.tableFilterTriggerActive]}>
      <Text numberOfLines={1} style={styles.tableFilterTriggerText}>{selected.length ? `${selected.length} selected` : "All values"}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} presentationStyle="overFullScreen">
      <View style={styles.tableFilterOverlay}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Close ${column} filter`} onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
        <View accessibilityViewIsModal style={styles.tableFilterDialog}>
          <Text style={styles.tableFilterDialogTitle}>Filter {column}</Text>
          <ScrollView style={styles.tableMultiOptions}>{options.map((option) => <Pressable key={option} accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(option) }} onPress={() => toggle(option)} style={styles.tableMultiOption}>
            <View style={[styles.tableMultiCheck, selected.includes(option) && styles.tableMultiCheckSelected]}><Text style={styles.tableMultiCheckMark}>{selected.includes(option) ? "✓" : ""}</Text></View>
            <Text numberOfLines={2} style={styles.tableMultiOptionText}>{option}</Text>
          </Pressable>)}</ScrollView>
          <View style={styles.tableFilterDialogActions}>
            <Pressable accessibilityRole="button" onPress={() => onChange([])} style={styles.tableFilterAction}><Text style={styles.tableFilterActionText}>Clear</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={[styles.tableFilterAction, styles.tableFilterActionPrimary]}><Text style={[styles.tableFilterActionText, styles.tableFilterActionPrimaryText]}>Done</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  </>;
}
const unavailableToast: ToastState = { message: '', show: () => undefined, clear: () => undefined };

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

export function RangeSlider({
  label,
  value,
  onChange,
  minimum = 0,
  maximum = 12,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  minimum?: number;
  maximum?: number;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const range = Math.max(1, maximum - minimum);
  const ratio = Math.max(0, Math.min(1, (value - minimum) / range));
  const scaleValues = Array.from({ length: range + 1 }, (_, index) => minimum + index);
  const noTextSelection = Platform.OS === "web" ? ({ userSelect: "none", WebkitUserSelect: "none" } as any) : null;
  const setFromPosition = (event: any) => {
    if (!trackWidth) return;
    const x = Number(event.nativeEvent.locationX);
    if (!Number.isFinite(x)) return;
    const sliderInset = 8;
    const usableTrackWidth = Math.max(1, trackWidth - sliderInset * 2);
    const position = Math.max(0, Math.min(1, (x - sliderInset) / usableTrackWidth));
    onChange(minimum + Math.round(position * range));
  };
  const adjust = (direction: number) => onChange(Math.max(minimum, Math.min(maximum, value + direction)));
  return (
    <View style={[styles.rangeSlider, noTextSelection]}>
      <View style={styles.rangeSliderLabelRow}>
        <Text style={styles.label}>{label}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.rangeSliderValue}>{value} {value === 1 ? 'unit' : 'units'}</Text>
      </View>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: minimum, max: maximum, now: value }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => adjust(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={setFromPosition}
        onResponderMove={setFromPosition}
        style={[styles.rangeSliderTouchArea, noTextSelection]}
      >
        <View pointerEvents="none" style={styles.rangeSliderTrack}>
          <View style={[styles.rangeSliderProgress, { width: `${ratio * 100}%` }]} />
          <View style={[styles.rangeSliderThumb, { left: `${ratio * 100}%` }]} />
        </View>
      </View>
      <View style={styles.rangeSliderScaleMarks}>
        {scaleValues.map((step) => (
          <View key={step} style={styles.rangeSliderScaleSlot}>
            <View style={[styles.rangeSliderScaleMark, step <= value && styles.rangeSliderScaleMarkActive]} />
          </View>
        ))}
      </View>
      <View style={styles.rangeSliderScale}>
        {scaleValues.map((step) => (
          <Text key={step} style={styles.rangeSliderScaleValue}>{step}</Text>
        ))}
      </View>
    </View>
  );
}

export function RefreshIndicator({ visible, label = "Updating records…" }: { visible: boolean; label?: string }) {
  if (!visible) return null;
  return (
    <View pointerEvents="none" accessibilityRole="progressbar" accessibilityLabel={label} accessibilityLiveRegion="polite" style={styles.refreshIndicator}>
      <ActivityIndicator size="small" color="#FFF" />
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
  // The app root wraps every route in ToastProvider. Keep transient renders
  // during Fast Refresh or isolated route previews from crashing the screen.
  return toast ?? unavailableToast;
}

const styles = StyleSheet.create({
  button: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radius.medium,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brand,
  },
  buttonDense: { minHeight: 32, paddingHorizontal: 12 },
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
  buttonTextDense: { fontSize: 12 },
  buttonTextDark: { color: colors.text },
  buttonContent: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  refreshIndicator: { position: "absolute", top: 24, right: 24, zIndex: 10, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderRadius: radius.medium, backgroundColor: "rgba(16, 42, 34, 0.86)", ...shadow },
  refreshIndicatorText: { color: "#FFF", fontSize: 13 },
  field: { gap: 6 },
  fieldDense: { gap: 4 },
  label: { color: colors.text, fontSize: 13, fontWeight: "600" },
  compactField: { gap: 2 },
  compactLabel: { fontSize: 9, lineHeight: 10 },
  compactInput: { minHeight: 24, height: 25, paddingHorizontal: 5, paddingVertical: 0, borderRadius: 4, fontSize: 11 },
  compactSelectInput: { minHeight: 24, height: 25, paddingHorizontal: 5, borderRadius: 4 },
  compactSelectValue: { fontSize: 11 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  studentIdValidation: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6 },
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
    minHeight: 38,
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: radius.medium,
    paddingHorizontal: 10,
    backgroundColor: "#FFF",
    color: colors.text,
    fontSize: Platform.OS === "web" ? 14 : 16,
  },
  webDateInput: {
    boxSizing: "border-box",
    width: "100%",
    height: 38,
    border: "1px solid #D1D5DB",
    borderRadius: radius.medium,
    paddingLeft: 19,
    paddingRight: 10,
    paddingVertical: 0,
    backgroundColor: "#FFF",
    color: colors.text,
    fontSize: 14,
    fontFamily: "Arial, sans-serif",
  } as never,
  webDateInputDense: { boxSizing: "border-box", width: "100%", height: 40, border: "1px solid #D1D5DB", borderRadius: radius.small, paddingLeft: 19, paddingRight: 10, paddingVertical: 0, backgroundColor: "#FFF", color: colors.text, fontSize: 14, fontFamily: "Arial, sans-serif" } as never,
  inputDense: { minHeight: 36, height: 36, paddingHorizontal: 8, paddingVertical: 0, fontSize: Platform.OS === "web" ? 13 : 15, borderRadius: radius.small },
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
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.medium,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  tableRow: {
    flexDirection: "row",
    minHeight: 42,
    alignItems: "stretch",
    borderBottomWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFF",
  },
  compactTableRow: { minHeight: 34 },
  tableHead: { backgroundColor: "#FAFAFA", borderBottomWidth: 1 },
  cell: { justifyContent: "center", minWidth: 0, paddingHorizontal: 9, paddingVertical: 8 },
  compactCell: { paddingVertical: 5, paddingHorizontal: 8 },
  headCellWrap: { justifyContent: "center", gap: 3, paddingVertical: 6 },
  tableHeaderLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 3 },
  headCellText: {
    color: colors.textMuted,
    flex: 1,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.25,
  },
  tableHeaderActions: { flexDirection: "row", alignItems: "center", gap: 1 },
  tableHeaderActionsHidden: { display: "none" },
  tableTool: { width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
  tableToolActive: { backgroundColor: "#F4EAE8" },
  tableFilterInput: { minHeight: 27, height: 27, borderWidth: 1, borderColor: colors.border, borderRadius: 5, paddingHorizontal: 6, fontSize: 11, color: colors.text, backgroundColor: colors.surface } as never,
  tableFilterTrigger: { minHeight: 27, justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 5, paddingHorizontal: 6, backgroundColor: colors.surface },
  tableFilterTriggerActive: { borderColor: "#D8BDB7", backgroundColor: "#FFFDFC" },
  tableFilterTriggerText: { color: colors.textMuted, fontSize: 10 },
  tableFilterOverlay: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16, backgroundColor: "#00000044" },
  tableFilterDialog: { width: 360, maxWidth: "100%", maxHeight: "85%", gap: 12, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface, ...shadow },
  tableFilterDialogTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  tableRangeFields: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tableRangeField: { flex: 1, minWidth: 145, gap: 5 },
  tableRangeLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600" },
  tableRangeInputRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  tableRangeInput: { boxSizing: "border-box", flex: 1, width: "100%", minWidth: 0, height: 34, paddingHorizontal: 8, borderWidth: 1, borderStyle: "solid", borderColor: colors.border, borderRadius: 6, color: colors.text, backgroundColor: colors.surface, fontSize: 12 },
  tableRangeNativeInput: { flex: 1, minWidth: 0, height: 34, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, color: colors.text, backgroundColor: colors.surface, fontSize: 12 } as never,
  tableCalendarButton: { width: 30, height: 30, borderWidth: 1, borderColor: colors.border, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  tableCalendar: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 9, gap: 7 },
  tableCalendarHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tableCalendarNav: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 5, backgroundColor: colors.canvas },
  tableCalendarNavText: { color: colors.text, fontSize: 20, lineHeight: 22 },
  tableCalendarMonth: { color: colors.text, fontSize: 12, fontWeight: "700" },
  tableCalendarGrid: { flexDirection: "row", flexWrap: "wrap" },
  tableCalendarWeekday: { width: "14.2857%", textAlign: "center", color: colors.textMuted, fontSize: 10, fontWeight: "600", paddingVertical: 4 },
  tableCalendarDay: { width: "14.2857%", height: 30, alignItems: "center", justifyContent: "center", borderRadius: 5 },
  tableCalendarDaySelected: { backgroundColor: colors.brand },
  tableCalendarDayText: { color: colors.text, fontSize: 11 },
  tableCalendarDayTextSelected: { color: "#FFF", fontWeight: "700" },
  tableFilterDialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  tableFilterAction: { minHeight: 32, justifyContent: "center", paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tableFilterActionPrimary: { borderColor: colors.brand, backgroundColor: colors.brand },
  tableFilterActionText: { color: colors.text, fontSize: 12, fontWeight: "600" },
  tableFilterActionPrimaryText: { color: "#FFF" },
  tableMultiOptions: { maxHeight: 280 },
  tableMultiOption: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 34, paddingVertical: 5 },
  tableMultiCheck: { width: 17, height: 17, borderWidth: 1, borderColor: colors.border, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  tableMultiCheckSelected: { borderColor: colors.brand, backgroundColor: colors.brand },
  tableMultiCheckMark: { color: "#FFF", fontSize: 11, fontWeight: "700", lineHeight: 13 },
  tableMultiOptionText: { flex: 1, color: colors.text, fontSize: 12 },
  cellText: { color: colors.text, fontSize: 12, lineHeight: 17 },
  failingGradeCell: { color: colors.danger, fontWeight: "600" },
  entityLink: { color: colors.brand, fontWeight: "600", textDecorationLine: "underline", textDecorationColor: "#D8BDB7" },
  tableEmpty: { minHeight: 42, alignItems: "center", justifyContent: "center", borderTopWidth: 0 },
  tableEmptyText: { color: colors.textMuted, fontSize: 12 },
  tablePagination: { minHeight: 42, flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 10, paddingVertical: 4, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tablePaginationSummary: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  tablePageSizeField: { width: 96 },
  tablePaginationText: { color: colors.textMuted, fontSize: 11 },
  tablePaginationActions: { flexDirection: "row", alignItems: "center", gap: 5 },
  tablePaginationPage: { color: colors.textMuted, fontSize: 11, marginRight: 4 },
  tablePageButton: { width: 27, height: 27, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 5, backgroundColor: colors.surface },
  tablePageButtonDisabled: { backgroundColor: "#FAFAFA", opacity: 0.7 },
  tableRowHighlighted: { backgroundColor: "#F0FDF4" },
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
  confirmDialogActions: {
    marginTop: 24,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
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
  searchDense: { paddingVertical: 4, paddingHorizontal: 8, gap: 6 },
  searchInputDense: { paddingHorizontal: 5, fontSize: Platform.OS === "web" ? 12 : 15 },
  rangeSlider: { marginBottom: 14 },
  rangeSliderLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  rangeSliderValue: { color: colors.brand, fontSize: 13, fontWeight: "700" },
  rangeSliderTouchArea: { height: 34, justifyContent: "center", paddingHorizontal: 8, cursor: "pointer" as any },
  rangeSliderTrack: { height: 6, borderRadius: 4, backgroundColor: colors.border, justifyContent: "center" },
  rangeSliderProgress: { height: 6, borderRadius: 4, backgroundColor: colors.brand },
  rangeSliderThumb: { position: "absolute", marginLeft: -9, width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.brand, backgroundColor: "#FFF", shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 2, elevation: 2 },
  rangeSliderScaleMarks: { flexDirection: "row", justifyContent: "space-between", marginHorizontal: 8, height: 6, marginTop: 1 },
  rangeSliderScaleSlot: { width: 2, marginHorizontal: -1, alignItems: "center" },
  rangeSliderScaleMark: { width: 1, height: 5, backgroundColor: colors.border },
  rangeSliderScaleMarkActive: { backgroundColor: colors.brand },
  rangeSliderScale: { flexDirection: "row", justifyContent: "space-between", marginHorizontal: 8, marginTop: 1 },
  rangeSliderScaleValue: { width: 16, marginHorizontal: -8, color: colors.textMuted, fontSize: 9, lineHeight: 12, textAlign: "center" },
});
