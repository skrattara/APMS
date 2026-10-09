import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent, type PointerEvent } from "react-native";
import { Bar, CartesianChart, Line, Pie, PolarChart, Scatter } from "victory-native";

import { PageState } from "@/components/ui";
import { colors } from "@/theme/tokens";

export type VisualizationKind = "discrete" | "continuous" | "categorical" | "binary" | "timeseries";
export type VisualizationDatum = {
  label: string;
  value: number;
  category?: string;
  kind?: VisualizationKind;
  timestamp?: string;
};
export type VisualizationType = "bar" | "line" | "pie" | "histogram";

const palette = [colors.brand, colors.info, colors.success, colors.warning, colors.danger, "#7C3AED", "#0891B2"];
const MAX_RENDERED_POINTS = 120;

function reducePoints(data: VisualizationDatum[], chartType: VisualizationType) {
  if (chartType === "pie") {
    const sorted = [...data].sort((a, b) => b.value - a.value);
    if (sorted.length <= 20) return sorted;
    const visible = sorted.slice(0, 19);
    const other = sorted.slice(19);
    visible.push({ label: "Other", value: other.reduce((sum, point) => sum + point.value, 0) });
    return visible;
  }
  if (data.length <= MAX_RENDERED_POINTS) return data;
  const bucketSize = Math.ceil(data.length / MAX_RENDERED_POINTS);
  return Array.from({ length: Math.ceil(data.length / bucketSize) }, (_, bucket) => {
    const chunk = data.slice(bucket * bucketSize, (bucket + 1) * bucketSize);
    const representative = chunk[Math.floor(chunk.length / 2)];
    return {
      ...representative,
      label: `${chunk[0].label}–${chunk[chunk.length - 1].label}`,
      value: chartType === "bar"
        ? chunk.reduce((sum, point) => sum + point.value, 0)
        : chunk.reduce((sum, point) => sum + point.value, 0) / chunk.length,
    };
  });
}

function buildHistogram(data: VisualizationDatum[], suffix: string) {
  if (!data.length) return [];
  const values = data.map((point) => point.value);
  const isPercentage = suffix === "%" && values.every((value) => value >= 0 && value <= 100);
  let min = isPercentage ? 0 : Math.floor(Math.min(...values));
  let max = isPercentage ? 100 : Math.ceil(Math.max(...values));
  if (min === max) max = min + 1;
  const count = isPercentage ? 10 : Math.min(12, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const step = (max - min) / count;
  const bins = Array.from({ length: count }, (_, index) => {
    const start = min + index * step;
    const end = index === count - 1 ? max : min + (index + 1) * step;
    const digits = step < 1 ? 1 : 0;
    return {
      label: `${start.toFixed(digits)}–${end.toFixed(digits)}${suffix}`,
      value: 0,
      kind: "continuous" as const,
    };
  });
  for (const value of values) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((value - min) / step)));
    bins[index].value += 1;
  }
  return bins;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);

function formatTimeSeriesLabel(point: VisualizationDatum) {
  if (point.kind !== "timeseries" || !point.timestamp) return point.label;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(point.timestamp);
  if (!match) return point.label;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return `${new Intl.DateTimeFormat("en", { month: "short" }).format(date)} ${date.getDate()}`;
}

/** Creates a vector snapshot for web PNG export because Skia's canvas isn't serialized by DOM snapshot libraries. */
export function createVisualizationSvg(data: VisualizationDatum[], type: VisualizationType, suffix = "", color: string = colors.brand) {
  const validData = data.filter((point) => Number.isFinite(point.value) && (type !== "pie" || point.value > 0));
  const points = type === "histogram" ? buildHistogram(validData, suffix) : reducePoints(validData, type);
  const width = 960;
  const height = 480;
  const label = (value: string, x: number, y: number, anchor = "middle", size = 14, fill = "#667085") => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, sans-serif" font-size="${size}" fill="${fill}">${escapeXml(value)}</text>`;
  const shortLabels = points.length <= 6 ? points.map((point, index) => ({ point, index })) : Array.from({ length: 6 }, (_, tick) => {
    const index = Math.round(tick * (points.length - 1) / 5);
    return { point: points[index], index };
  });
  const chartColor = /^#[\da-f]{3,8}$/i.test(color) ? color : "#8A3324";
  let content = "";

  if (type === "pie") {
    const total = points.reduce((sum, point) => sum + point.value, 0);
    const cx = 330;
    const cy = 240;
    const radius = 178;
    let start = -Math.PI / 2;
    content = points.map((point, index) => {
      const end = start + point.value / total * Math.PI * 2;
      const largeArc = end - start > Math.PI ? 1 : 0;
      const x1 = cx + radius * Math.cos(start);
      const y1 = cy + radius * Math.sin(start);
      const x2 = cx + radius * Math.cos(end);
      const y2 = cy + radius * Math.sin(end);
      const path = `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${palette[index % palette.length]}" stroke="#fff" stroke-width="3"/>`;
      start = end;
      const legendY = 108 + index * Math.min(34, 310 / Math.max(points.length, 1));
      return `${path}<rect x="590" y="${legendY - 14}" width="14" height="14" rx="3" fill="${palette[index % palette.length]}"/>${label(`${point.label}: ${point.value.toLocaleString()}${suffix}`, 616, legendY, "start", 14, "#344054")}`;
    }).join("");
  } else {
    const plot = { left: 76, top: 28, right: 930, bottom: 378 };
    const plotWidth = plot.right - plot.left;
    const plotHeight = plot.bottom - plot.top;
    const isPercentageChart = (type === "bar" || type === "line") && suffix === "%";
    const maxValue = isPercentageChart ? 100 : Math.max(1, ...points.map((point) => point.value));
    const tickStep = maxValue / 4;
    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = tickStep * index;
      const y = plot.bottom - value / maxValue * plotHeight;
      return `<line x1="${plot.left}" y1="${y}" x2="${plot.right}" y2="${y}" stroke="#E4E7EC" stroke-width="1"/>${label(`${value.toFixed(maxValue < 10 ? 1 : 0)}${suffix}`, plot.left - 12, y + 5, "end", 12)}`;
    }).join("");
    const slotWidth = plotWidth / points.length;
    const marks = type === "line"
      ? `<path d="${points.map((point, index) => `${index ? "L" : "M"} ${plot.left + slotWidth * (index + 0.5)} ${plot.bottom - point.value / maxValue * plotHeight}`).join(" ")}" fill="none" stroke="${chartColor}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>${points.map((point, index) => `<circle cx="${plot.left + slotWidth * (index + 0.5)}" cy="${plot.bottom - point.value / maxValue * plotHeight}" r="7" fill="#FFFFFF" stroke="${chartColor}" stroke-width="3"/>`).join("")}`
      : points.map((point, index) => {
        const barWidth = Math.max(2, slotWidth * (type === "histogram" ? 0.9 : 0.68));
        const barHeight = point.value / maxValue * plotHeight;
        return `<rect x="${plot.left + slotWidth * index + (slotWidth - barWidth) / 2}" y="${plot.bottom - barHeight}" width="${barWidth}" height="${barHeight}" rx="4" fill="${chartColor}"/>`;
      }).join("");
    const xTicks = shortLabels.map(({ index }) => {
      const x = plot.left + slotWidth * (index + 0.5);
      return `<line x1="${x}" y1="${plot.bottom}" x2="${x}" y2="${plot.bottom + 5}" stroke="#98A2B3"/>`;
    }).join("");
    const xLabels = shortLabels.map(({ point, index }) => label(formatTimeSeriesLabel(point), plot.left + slotWidth * (index + 0.5), plot.bottom + 22, "middle", 12)).join("");
    content = `${grid}${marks}<line x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}" stroke="#98A2B3"/>${xTicks}${xLabels}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>${content}</svg>`;
}

export function VisualizationChart({
  data,
  type,
  height = 230,
  suffix = "",
  color = colors.brand,
}: {
  data: VisualizationDatum[];
  type: VisualizationType;
  height?: number;
  suffix?: string;
  color?: string;
}) {
  const safeData = useMemo<VisualizationDatum[]>(
    () => {
      const validData = data.filter((point) => Number.isFinite(point.value) && (type !== "pie" || point.value > 0));
      return type === "histogram" ? buildHistogram(validData, suffix) : reducePoints(validData, type);
    },
    [data, suffix, type],
  );
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [yAxisTicks, setYAxisTicks] = useState<Array<{ label: string; y: number }>>([]);
  const [xAxisTicks, setXAxisTicks] = useState<Array<{ label: string; x: number }>>([]);
  const yAxisTicksRef = useRef<Array<{ label: string; y: number }>>([]);
  const axisUpdateScheduled = useRef(false);
  const xAxisTicksRef = useRef<Array<{ label: string; x: number }>>([]);
  const xAxisUpdateScheduled = useRef(false);
  const chartWidth = useRef(0);
  const chartBounds = useRef<{ left: number; right: number } | null>(null);
  const pieTotal = useMemo(() => safeData.reduce((sum, point) => sum + point.value, 0), [safeData]);
  const handleLayout = (event: LayoutChangeEvent) => { chartWidth.current = event.nativeEvent.layout.width; };
  const handlePointerMove = (event: PointerEvent) => {
    const { offsetX, offsetY, pointerType } = event.nativeEvent;
    if (pointerType === "touch") return;
    let index = -1;
    if (type === "pie") {
      const dx = offsetX - chartWidth.current / 2;
      const dy = offsetY - height / 2;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const outerRadius = Math.min(chartWidth.current, height) / 2;
      if (radius < outerRadius * 0.58 || radius > outerRadius) {
        setHover(null);
        return;
      }
      const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 450) % 360;
      let cursor = angle / 360 * pieTotal;
      index = safeData.findIndex((point) => {
        cursor -= point.value;
        return cursor < 0;
      });
    } else {
      const bounds = chartBounds.current;
      const left = bounds?.left ?? 16;
      const right = bounds?.right ?? chartWidth.current - 16;
      if (right <= left || !safeData.length) return;
      const ratio = clamp((offsetX - left) / (right - left), 0, 1);
      index = safeData.length === 1 ? 0 : Math.round(ratio * (safeData.length - 1));
    }
    if (index < 0 || index >= safeData.length) {
      setHover(null);
      return;
    }
    setHover((current) => current?.index === index ? current : { index, x: offsetX, y: offsetY });
  };
  useEffect(() => setHover(null), [safeData, type]);
  const hoveredPoint = hover ? safeData[hover.index] : undefined;
  const xAxisLabelIndexes = useMemo(() => {
    const tickCount = Math.min(6, safeData.length);
    return Array.from({ length: tickCount }, (_, index) => tickCount <= 1 ? 0 : Math.round(index * (safeData.length - 1) / (tickCount - 1)));
  }, [safeData.length]);
  const isPercentageChart = (type === "bar" || type === "line") && suffix === "%";
  const tooltipLeft = hover ? clamp(hover.x + 12, 4, Math.max(4, chartWidth.current - 176)) : 0;
  const tooltipTop = hover ? clamp(hover.y - 56, 4, Math.max(4, height - 52)) : 0;
  const syncYAxisTicks = (ticks: Array<{ label: string; y: number }>) => {
    const current = yAxisTicksRef.current;
    const unchanged = current.length === ticks.length && current.every((tick, index) => tick.label === ticks[index]?.label && Math.abs(tick.y - (ticks[index]?.y ?? 0)) < 0.5);
    if (unchanged || axisUpdateScheduled.current) return;
    yAxisTicksRef.current = ticks;
    axisUpdateScheduled.current = true;
    requestAnimationFrame(() => {
      axisUpdateScheduled.current = false;
      setYAxisTicks(yAxisTicksRef.current);
    });
  };
  const syncXAxisTicks = (ticks: Array<{ label: string; x: number }>) => {
    const current = xAxisTicksRef.current;
    const unchanged = current.length === ticks.length && current.every((tick, index) => tick.label === ticks[index]?.label && Math.abs(tick.x - (ticks[index]?.x ?? 0)) < 0.5);
    if (unchanged || xAxisUpdateScheduled.current) return;
    xAxisTicksRef.current = ticks;
    xAxisUpdateScheduled.current = true;
    requestAnimationFrame(() => {
      xAxisUpdateScheduled.current = false;
      setXAxisTicks(xAxisTicksRef.current);
    });
  };

  if (!safeData.length) {
    return <PageState kind="empty" title="No chart data" message="No values are available for this selection." />;
  }

  if (type === "pie") {
    const slices = safeData.map((point, index) => ({ ...point, color: palette[index % palette.length] }));
    return (
      <View>
        <View style={{ height, width: "100%", position: "relative" }} onLayout={handleLayout}>
          <PolarChart data={slices} labelKey="label" valueKey="value" colorKey="color">
            <Pie.Chart innerRadius="58%" startAngle={-90}>
              {() => <Pie.Slice />}
            </Pie.Chart>
          </PolarChart>
          {hoveredPoint ? <View pointerEvents="none" style={[styles.tooltip, { left: tooltipLeft, top: tooltipTop }]}>
            <Text style={styles.tooltipTitle}>{hoveredPoint.label}</Text>
            <Text style={styles.tooltipValue}>{hoveredPoint.value.toLocaleString()} · {pieTotal ? `${(hoveredPoint.value / pieTotal * 100).toFixed(1)}%` : "0%"}</Text>
          </View> : null}
          {Platform.OS === "web" ? <View pointerEvents="box-only" onPointerMove={handlePointerMove} onPointerLeave={() => setHover(null)} style={StyleSheet.absoluteFill} /> : null}
        </View>
        <View style={styles.legend}>
          {slices.map((slice, index) => (
            <View key={`${index}-${slice.label}`} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: slice.color }]} />
              <Text style={styles.legendLabel}>{slice.label}</Text>
              <Text style={styles.legendValue}>{slice.value}{suffix}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.cartesianRow}>
        <View accessibilityRole="text" accessibilityLabel="Y axis values" pointerEvents="none" style={[styles.yAxis, { height }]}>
          {yAxisTicks.map((tick, index) => <Text key={`${index}-${tick.label}`} numberOfLines={1} style={[styles.yAxisLabel, { top: clamp(tick.y - 7, 0, height - 14) }]}>{tick.label}</Text>)}
        </View>
        <View style={{ height, flex: 1, minWidth: 0, position: "relative" }} onLayout={handleLayout}>
          <CartesianChart
            data={safeData}
            xKey="label"
            yKeys={["value"]}
            domain={isPercentageChart ? { y: [0, 100] } : undefined}
            domainPadding={{ left: 16, right: 16, top: 12 }}
          >
            {({ points, chartBounds: bounds, yTicks, yScale }) => {
              chartBounds.current = bounds;
              const displayYTicks = isPercentageChart ? [0, 25, 50, 75, 100] : yTicks;
              syncYAxisTicks(displayYTicks.map((tick) => ({ label: `${(isPercentageChart ? Math.round(tick) : Number(tick.toFixed(1))).toLocaleString()}${suffix}`, y: yScale(tick) })));
              syncXAxisTicks(xAxisLabelIndexes.flatMap((index) => {
                const point = points.value[index];
                return point ? [{ label: formatTimeSeriesLabel(safeData[index]), x: point.x }] : [];
              }));
              return type === "line"
                ? <>
                    <Line points={points.value} color={color} strokeWidth={3} curveType="natural" />
                    <Scatter points={points.value} color={color} style="stroke" strokeWidth={3} radius={6} />
                  </>
                : <Bar points={points.value} chartBounds={bounds} color={color} roundedCorners={{ topLeft: 5, topRight: 5 }} />;
            }}
          </CartesianChart>
          {hoveredPoint ? <View pointerEvents="none" style={[styles.tooltip, { left: tooltipLeft, top: tooltipTop }]}>
            <Text style={styles.tooltipTitle}>{hoveredPoint.label}</Text>
            <Text style={styles.tooltipValue}>{type === "histogram" ? `${hoveredPoint.value.toLocaleString()} records` : `${hoveredPoint.value.toFixed(1)}${suffix}`}</Text>
          </View> : null}
          {Platform.OS === "web" ? <View pointerEvents="box-only" onPointerMove={handlePointerMove} onPointerLeave={() => setHover(null)} style={StyleSheet.absoluteFill} /> : null}
        </View>
      </View>
      <View accessibilityRole="text" accessibilityLabel={`X axis: ${xAxisTicks.map((tick) => tick.label).join(", ")}`} style={styles.xAxis}>
        {xAxisTicks.map((tick, index) => <View key={`${index}-${tick.label}`}>
          <View style={[styles.xAxisTick, { left: tick.x }]} />
          <Text numberOfLines={1} style={[styles.xAxisLabel, { left: tick.x }]}>{tick.label}</Text>
        </View>)}
      </View>
      {type !== "line" ? <View style={styles.legend}>
        {safeData.map((point, index) => (
          <View key={`${index}-${point.label}`} style={styles.legendItem}>
            <Text numberOfLines={1} style={styles.legendLabel}>{point.label}</Text>
            <Text style={styles.legendValue}>{type === "histogram" ? point.value.toLocaleString() : `${point.value.toFixed(1)}${suffix}`}</Text>
          </View>
        ))}
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingTop: 10 },
  cartesianRow: { flexDirection: "row", width: "100%" },
  yAxis: { width: 42, position: "relative", justifyContent: "center", borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border },
  yAxisLabel: { position: "absolute", right: 4, color: colors.textMuted, fontSize: 10, textAlign: "right", width: 36 },
  xAxis: { position: "relative", height: 25, marginLeft: 42 },
  xAxisTick: { position: "absolute", top: 0, width: StyleSheet.hairlineWidth, height: 5, backgroundColor: colors.textMuted },
  xAxisLabel: { position: "absolute", top: 6, width: 80, marginLeft: -40, color: colors.textMuted, fontSize: 10, textAlign: "center" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%" },
  legendLabel: { color: colors.textMuted, fontSize: 11, flexShrink: 1 },
  legendValue: { color: colors.text, fontSize: 11, fontWeight: "700" },
  swatch: { height: 9, width: 9, borderRadius: 5 },
  tooltip: { position: "absolute", zIndex: 5, maxWidth: 168, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: "#6B2C1F", backgroundColor: "#221916" },
  tooltipTitle: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  tooltipValue: { color: "#F4DAD3", fontSize: 11, marginTop: 2 },
});
