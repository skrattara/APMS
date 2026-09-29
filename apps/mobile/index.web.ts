import "@expo/metro-runtime";
import { LoadSkiaWeb } from "@shopify/react-native-skia/lib/module/web";
import { App } from "expo-router/build/qualified-entry";
import { renderRootComponent } from "expo-router/build/renderRootComponent";

LoadSkiaWeb({
  // Expo serves files from the app's public/ directory at the web root.
  // CanvasKit's default path is relative to Metro's /apps/mobile bundle URL.
  locateFile: (file: string) => new URL(`/${file}`, window.location.origin).href,
}).then(() => {
  renderRootComponent(App);
});
