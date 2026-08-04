import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "fi.tiyouba.lashkirja",
  appName: "Tilikirja",
  webDir: "public",
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith("http://"),
        androidScheme: "https",
      }
    : undefined,
  ios: {
    contentInset: "automatic",
    allowsLinkPreview: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: "#faf7f2",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#faf7f2",
    },
  },
};

export default config;
