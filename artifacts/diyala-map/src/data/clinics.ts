export const clinics = [
  {
    id: 1, kind: 'clinic' as const, name: "عيادة الدكتور مصطفى غني",
    doctor: "د. مصطفى غني",
    specialty: "طب أسنان", address: "بعقوبة - شارع الرئيسي",
    phone: "07701234567", hours: "9:00 ص - 5:00 م", status: "مفتوح",
    lat: 33.7451, lng: 44.6488
  },
];

export type Clinic = typeof clinics[0];
