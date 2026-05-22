/**
 * firebase.ts — Firebase Initialization
 * ──────────────────────────────────────────────────────────────────────────────
 * يستورد الإعدادات من firebaseConfig.ts المعزول ويُهيّئ الـ SDK.
 * لتغيير أي إعداد (API Key, Project ID…) عدّل firebaseConfig.ts فقط.
 */

import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { firebaseConfig } from "./firebaseConfig";

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);
export default app;
