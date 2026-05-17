/**
 * useDoctorGeofence
 * -----------------
 * Silent background hook that watches the current user's today-appointments
 * mirror collection (users/{uid}/myAppointments) and, every 5 minutes during
 * the ±15 min / +60 min window around each slot, checks whether the user is
 * within 50 m of the clinic.  On arrival it writes:
 *   doctors/{doctorId}/appointments/{apptDocId}
 *     → isUserArrived: true, arrivalMethod: "GPS_Geofence", arrivalTime: now
 *   users/{uid}/myAppointments/{mirrorId}
 *     → isUserArrived: true  (stops re-triggering)
 */

import { useEffect, useRef } from 'react';
import {
  collection, query, where, onSnapshot,
  doc, updateDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getUserFromStorage } from '@/components/UserLoginOverlay';

// ── Haversine distance (metres) ───────────────────────────────────────────────
function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R    = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Helper: today as "DD-MM-YYYY" ─────────────────────────────────────────────
function todayStr(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

interface PendingAppt {
  mirrorId:  string;
  doctorId:  string;
  apptDocId: string;
  slot_time: string; // "HH:MM"
  doctorLat: number;
  doctorLng: number;
}

const CHECK_INTERVAL_MS  = 5 * 60 * 1000; // every 5 minutes
const FENCE_RADIUS_M     = 50;            // metres
const WINDOW_BEFORE_MS   = 15 * 60 * 1000; // 15 min before slot
const WINDOW_AFTER_MS    = 60 * 60 * 1000; // 60 min after slot

export function useDoctorGeofence(
  userLocationRef: React.MutableRefObject<{ lat: number; lng: number } | null>,
): void {
  const pendingRef   = useRef<PendingAppt[]>([]);
  const arrivedRef   = useRef<Set<string>>(new Set()); // mirrorIds already confirmed

  useEffect(() => {
    const user = getUserFromStorage();
    if (!user?.uid) return;
    const userId: string = user.uid;

    const today = todayStr();

    // ── Firestore listener — today's unconfirmed appointments ───────────────
    const mirrorCol = collection(db, 'users', userId, 'myAppointments');
    const q = query(
      mirrorCol,
      where('date',          '==', today),
      where('isUserArrived', '==', false),
    );

    const unsub = onSnapshot(q, (snap) => {
      pendingRef.current = snap.docs
        .filter(d => !arrivedRef.current.has(d.id))
        .map(d => {
          const data = d.data();
          return {
            mirrorId:  d.id,
            doctorId:  String(data.doctorId  ?? ''),
            apptDocId: String(data.apptDocId ?? ''),
            slot_time: String(data.slot_time ?? ''),
            doctorLat: Number(data.doctorLat ?? 0),
            doctorLng: Number(data.doctorLng ?? 0),
          };
        })
        .filter(a =>
          a.doctorId  &&
          a.apptDocId &&
          a.slot_time &&
          a.doctorLat !== 0 &&
          a.doctorLng !== 0,
        );
    }, () => { /* silent on error */ });

    // ── Proximity check ──────────────────────────────────────────────────────
    async function checkProximity() {
      const loc = userLocationRef.current;
      if (!loc || pendingRef.current.length === 0) return;

      const now = Date.now();

      for (const appt of [...pendingRef.current]) {
        if (arrivedRef.current.has(appt.mirrorId)) continue;

        // Check time window
        const [h, m]   = appt.slot_time.split(':').map(Number);
        const slotMs   = new Date().setHours(h, m, 0, 0);
        const diffMs   = slotMs - now;
        const inWindow = diffMs >= -WINDOW_AFTER_MS && diffMs <= WINDOW_BEFORE_MS;
        if (!inWindow) continue;

        // Check distance
        const distM = haversineMeters(loc.lat, loc.lng, appt.doctorLat, appt.doctorLng);
        if (distM > FENCE_RADIUS_M) continue;

        // ── Arrived! mark immediately to prevent double-write ────────────────
        arrivedRef.current.add(appt.mirrorId);
        pendingRef.current = pendingRef.current.filter(a => a.mirrorId !== appt.mirrorId);

        const arrivalPayload = {
          isUserArrived: true,
          arrivalMethod: 'GPS_Geofence' as const,
          arrivalTime:   serverTimestamp(),
        };

        try {
          // 1. Update canonical appointment document
          await updateDoc(
            doc(db, 'doctors', appt.doctorId, 'appointments', appt.apptDocId),
            arrivalPayload,
          );
          // 2. Update mirror doc so listener stops re-fetching it
          await updateDoc(
            doc(db, 'users', userId, 'myAppointments', appt.mirrorId),
            { isUserArrived: true, arrivalTime: serverTimestamp() },
          );
        } catch {
          // On failure, allow retry next tick
          arrivedRef.current.delete(appt.mirrorId);
        }
      }
    }

    // Run once immediately, then on interval
    checkProximity();
    const timer = setInterval(checkProximity, CHECK_INTERVAL_MS);

    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Intentionally empty deps — runs once per mount; userLocationRef is stable.
}
