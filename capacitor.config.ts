import type { CapacitorConfig } from '@capacitor/cli';

// Wraps the game in a native Android app (see android/ and the README).
const config: CapacitorConfig = {
  appId: 'com.kaddakaman.rts',
  appName: 'Shatterfront',
  webDir: 'dist',
  backgroundColor: '#0b0f14',
  android: {
    // Gamepads, touch and audio all work inside the app.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SystemBars: {
      // Full screen; also exposes --safe-area-inset-* CSS variables for phones with notches.
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      style: 'DARK',
      hidden: true,
    },
  },
};

export default config;
