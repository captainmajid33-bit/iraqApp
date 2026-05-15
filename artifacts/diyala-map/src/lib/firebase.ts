import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey:            "AIzaSyA79tDp7uQBGW8ye-M3_cQSj7xbNUr52uo",
  authDomain:        "diyalaapp.firebaseapp.com",
  projectId:         "diyalaapp",
  storageBucket:     "diyalaapp.firebasestorage.app",
  messagingSenderId: "904460783186",
  appId:             "1:904460783186:web:07b20dda77ed306ceb198b",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db   = getFirestore(app);
export default app;
