/**
 * firebaseConfig.ts — Firebase Web SDK Configuration
 * ──────────────────────────────────────────────────────────────────────────────
 * هذا الملف يحتوي فقط على الإعدادات (config) معزولةً عن منطق التهيئة.
 * سبب العزل: تسهيل التعديل لاحقاً عند إضافة Android / iOS configs.
 *
 * ── الإعدادات حسب المنصة ──
 *
 *  Web (هذا الملف):
 *    الـ appId هنا هو Web App ID من Firebase Console.
 *    مصدره: Firebase Console → Project Settings → Your Apps → Web App
 *
 *  Android:
 *    لا تُضاف هنا — تُضاف عبر ملف google-services.json
 *    مكانه في المشروع بعد cap add android:
 *      android/app/google-services.json
 *
 *  iOS:
 *    لا تُضاف هنا — تُضاف عبر ملف GoogleService-Info.plist
 *    مكانه في المشروع بعد cap add ios:
 *      ios/App/App/GoogleService-Info.plist
 *
 * ── للتعديل ──
 *   إذا أنشأت مشروع Firebase جديداً، غيّر القيم أدناه فقط دون لمس firebase.ts
 */

export const firebaseConfig = {
  apiKey:            "AIzaSyA79tDp7uQBGW8ye-M3_cQSj7xbNUr52uo",
  authDomain:        "diyalaapp.firebaseapp.com",
  projectId:         "diyalaapp",
  storageBucket:     "diyalaapp.firebasestorage.app",
  messagingSenderId: "904460783186",

  // ── Web App ID (من Firebase Console → Your Apps → Web) ──────────────────
  appId: "1:904460783186:web:07b20dda77ed306ceb198b",

  // ── Measurement ID (اختياري — لـ Analytics) ─────────────────────────────
  // measurementId: "G-XXXXXXXXXX",
};
