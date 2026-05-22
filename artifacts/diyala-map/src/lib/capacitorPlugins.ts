/**
 * capacitorPlugins.ts — Native Plugin Wrappers
 * ──────────────────────────────────────────────────────────────────────────
 * Provides safe wrappers around Capacitor plugins that gracefully fall back
 * to web browser APIs when running in a non-native context (Replit preview,
 * desktop browser, etc.).
 *
 * Usage:
 *   import { mobileGeo, initPushNotifications, handleBackButton, hideSplash } from '@/lib/capacitorPlugins';
 */

import { Capacitor } from '@capacitor/core';

// ── Platform Detection ────────────────────────────────────────────────────────
export const isNative   = Capacitor.isNativePlatform();
export const platform   = Capacitor.getPlatform(); // 'android' | 'ios' | 'web'

// ─────────────────────────────────────────────────────────────────────────────
// ── Geolocation ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export interface GeoPosition {
  latitude:  number;
  longitude: number;
  accuracy:  number;
}

/**
 * Get current position.
 * Native: uses @capacitor/geolocation (high accuracy GPS)
 * Web:    falls back to browser navigator.geolocation
 */
export async function getCurrentPosition(): Promise<GeoPosition> {
  if (isNative) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 10_000,
    });
    return {
      latitude:  pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy:  pos.coords.accuracy,
    };
  }

  // Web fallback
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      p => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      e => reject(e),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}

/**
 * Watch position continuously.
 * Returns an unsubscribe function — call it to stop watching.
 */
export async function watchPosition(
  callback: (pos: GeoPosition) => void,
  onError?: (err: unknown) => void,
): Promise<() => void> {
  if (isNative) {
    const { Geolocation } = await import('@capacitor/geolocation');
    const watchId = await Geolocation.watchPosition(
      { enableHighAccuracy: true },
      (pos, err) => {
        if (err) { onError?.(err); return; }
        if (pos) callback({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy });
      },
    );
    return () => Geolocation.clearWatch({ id: watchId });
  }

  // Web fallback
  const id = navigator.geolocation.watchPosition(
    p => callback({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
    e => onError?.(e),
    { enableHighAccuracy: true },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Push Notifications ────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

export interface PushToken { value: string }

/**
 * Register for push notifications.
 * Returns the FCM/APNs device token on success, null on web/failure.
 *
 * Call this once after app startup (e.g. after user logs in).
 * Save the returned token to Firestore so you can target specific devices.
 */
export async function initPushNotifications(
  onNotification?: (title: string, body: string, data: Record<string, string>) => void,
): Promise<string | null> {
  if (!isNative) {
    console.log('[capacitorPlugins] Push notifications: web — skipped');
    return null;
  }

  const { PushNotifications } = await import('@capacitor/push-notifications');

  // Request permission
  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') {
    console.warn('[capacitorPlugins] Push permission denied');
    return null;
  }

  // Register
  await PushNotifications.register();

  return new Promise(resolve => {
    // Token received
    PushNotifications.addListener('registration', token => {
      console.log('[capacitorPlugins] Push token:', token.value);
      resolve(token.value);
    });

    PushNotifications.addListener('registrationError', err => {
      console.error('[capacitorPlugins] Push registration error:', err);
      resolve(null);
    });

    // Foreground notification
    if (onNotification) {
      PushNotifications.addListener('pushNotificationReceived', notification => {
        onNotification(
          notification.title ?? '',
          notification.body  ?? '',
          (notification.data as Record<string, string>) ?? {},
        );
      });
    }

    // Notification tapped (app was in background)
    PushNotifications.addListener('pushNotificationActionPerformed', action => {
      const data = (action.notification.data as Record<string, string>) ?? {};
      onNotification?.(
        action.notification.title ?? '',
        action.notification.body  ?? '',
        data,
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── App Back Button (Android) ─────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register hardware back-button handler for Android.
 * Minimizes the app on the root route; navigates back on other routes.
 *
 * @param isRoot  — function that returns true when the current route is "/"
 * @returns cleanup function to remove the listener
 */
export async function handleBackButton(
  isRoot: () => boolean,
): Promise<() => void> {
  if (!isNative || platform !== 'android') {
    return () => {};
  }

  const { App } = await import('@capacitor/app');
  const handle = await App.addListener('backButton', ({ canGoBack }) => {
    if (isRoot()) {
      App.minimizeApp();
    } else if (canGoBack) {
      window.history.back();
    } else {
      App.minimizeApp();
    }
  });
  return () => handle.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Splash Screen ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hide the native splash screen.
 * Call this once your React tree has mounted and the map is ready.
 * No-op on web.
 */
export async function hideSplash(): Promise<void> {
  if (!isNative) return;
  const { SplashScreen } = await import('@capacitor/splash-screen');
  await SplashScreen.hide({ fadeOutDuration: 500 });
}
