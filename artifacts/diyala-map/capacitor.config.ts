import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.diyalamap.app',
  appName: 'المعدل',
  webDir: 'dist/public',

  // ── Server (Development Live Reload) ─────────────────────────────────────
  // Uncomment the block below to enable live-reload from Replit during
  // connected USB debugging. Replace the URL with your Replit preview URL.
  // server: {
  //   url: 'https://YOUR-REPLIT-APP.replit.app',
  //   cleartext: true,
  // },

  // ── Android ───────────────────────────────────────────────────────────────
  android: {
    backgroundColor: '#05080f',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false, // set true during development
  },

  // ── iOS ───────────────────────────────────────────────────────────────────
  ios: {
    contentInset: 'always',
    backgroundColor: '#05080f',
    scrollEnabled: false,
  },

  // ── Plugins ───────────────────────────────────────────────────────────────
  plugins: {
    SplashScreen: {
      launchShowDuration: 2500,
      launchAutoHide: false,          // We hide it manually after app is ready
      backgroundColor: '#05080f',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },

    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },

    Geolocation: {
      // Permissions are declared in AndroidManifest.xml & Info.plist
    },

    // ── Status Bar ──────────────────────────────────────────────────────────
    // Makes status bar overlay the WebView for true full-screen dark UI
    StatusBar: {
      overlaysWebView: true,
      style: 'DARK',
      backgroundColor: '#05080f',
    },
  },
};

export default config;
