import { getErrorMessage } from '@/services/errors';
import { useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";

import { Button, Card } from "@/components/ui";
import { colors } from "@/theme/tokens";
import { createVisualizationSvg, VisualizationChart, type VisualizationDatum, type VisualizationType } from "./VisualizationChart";

async function downloadSvgAsPng(svg: string, fileName: string) {
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = svgUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("The chart preview could not be rendered for export."));
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG export is unavailable in this browser.");
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The chart image could not be encoded as PNG.")), "image/png"));
    const pngUrl = URL.createObjectURL(png);
    const anchor = document.createElement("a");
    anchor.href = pngUrl;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(pngUrl);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

export function VisualizationPanel({
  title,
  description,
  data,
  type,
  suffix,
  height,
  color,
  controls,
}: {
  title: string;
  description?: string;
  data: VisualizationDatum[];
  type: VisualizationType;
  suffix?: string;
  height?: number;
  color?: string;
  controls?: ReactNode;
}) {
  const chartRef = useRef<View>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const exportPng = async () => {
    if (!chartRef.current) return;
    setExporting(true);
    setExportError("");
    try {
      const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "apms-chart"}.png`;
      if (Platform.OS === "web") {
        await downloadSvgAsPng(createVisualizationSvg(data, type, suffix, color), fileName);
      } else {
        const uri = await captureRef(chartRef, { format: "png", quality: 1, result: "tmpfile" });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Export chart as PNG", UTI: "public.png" });
        } else setExportError("PNG sharing is unavailable on this device.");
      }
    } catch (cause) {
      setExportError(getErrorMessage(cause, "The chart image could not be exported."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card style={styles.card}>
      <View style={styles.heading}>
        <View style={styles.titleBlock}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
        </View>
        <Button label={exporting ? "Exporting…" : "Export PNG"} variant="secondary" loading={exporting} onPress={() => void exportPng()} />
      </View>
      {controls ? <View style={styles.controls}>{controls}</View> : null}
      <View ref={chartRef} collapsable={false} style={styles.exportArea}>
        <VisualizationChart data={data} type={type} suffix={suffix} height={height} color={color} />
      </View>
      {exportError ? <Text accessibilityRole="alert" style={styles.exportError}>{exportError}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { minWidth: 0, flex: 1 },
  heading: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 },
  controls: { marginBottom: 12 },
  titleBlock: { flex: 1, minWidth: 180 },
  title: { color: colors.text, fontSize: 15, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  exportArea: { backgroundColor: "#FFFFFF", minWidth: 0, padding: 4 },
  exportError: { color: colors.danger, fontSize: 12, marginTop: 8 },
});
