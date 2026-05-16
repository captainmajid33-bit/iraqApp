/**
 * mapTheme.ts — وضع الليل/النهار بناءً على ساعة الجهاز
 * Day   : 06:00 – 17:59
 * Night : 18:00 – 05:59
 */
import { useState, useEffect } from 'react';

export interface MapTheme {
  isDay:        boolean;
  tileUrl:      string;
  /** Bottom-sheet / HUD background */
  sheetBg:      string;
  /** Primary text colour */
  textPrimary:  string;
  /** Secondary / dim text */
  textDim:      string;
  /** Card / surface background */
  cardBg:       string;
  /** Card border colour */
  cardBorder:   string;
  /** Label shown in UI */
  label:        '🌙 وضع الليل' | '☀️ وضع النهار';
}

const NIGHT: MapTheme = {
  isDay:       false,
  tileUrl:     'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  sheetBg:     'rgba(5,8,15,0.99)',
  textPrimary: '#ffffff',
  textDim:     'rgba(255,255,255,0.45)',
  cardBg:      'rgba(255,255,255,0.04)',
  cardBorder:  'rgba(255,255,255,0.09)',
  label:       '🌙 وضع الليل',
};

const DAY: MapTheme = {
  isDay:       true,
  tileUrl:     'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  sheetBg:     'rgba(248,249,252,0.98)',
  textPrimary: '#0d1117',
  textDim:     'rgba(13,17,23,0.5)',
  cardBg:      'rgba(13,17,23,0.05)',
  cardBorder:  'rgba(13,17,23,0.10)',
  label:       '☀️ وضع النهار',
};

function getTheme(): MapTheme {
  const h = new Date().getHours();
  return h >= 6 && h < 18 ? DAY : NIGHT;
}

/** Re-evaluates every 60 s so the switch happens automatically at 06:00 / 18:00 */
export function useMapTheme(): MapTheme {
  const [theme, setTheme] = useState<MapTheme>(getTheme);

  useEffect(() => {
    const iv = setInterval(() => {
      const next = getTheme();
      setTheme(prev => prev.isDay === next.isDay ? prev : next);
    }, 60_000);
    return () => clearInterval(iv);
  }, []);

  return theme;
}
