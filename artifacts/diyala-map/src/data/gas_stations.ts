export const gasStations = [
  {
    id: 301, kind: 'gas_station' as const, name: "محطة بعقوبة المركزية",
    details: "بنزين · غاز · كهرباء", address: "بعقوبة - الشارع الرئيسي",
    phone: "07701999001", hours: "24 ساعة", status: "مفتوح",
    lat: 33.7462, lng: 44.6530
  },
  {
    id: 302, kind: 'gas_station' as const, name: "محطة النهضة للوقود",
    details: "بنزين · غاز", address: "بعقوبة - حي النهضة",
    phone: "07702999002", hours: "6:00 ص - 10:00 م", status: "مفتوح",
    lat: 33.7495, lng: 44.6415
  },
  {
    id: 303, kind: 'gas_station' as const, name: "محطة الأمانة",
    details: "بنزين · ديزل", address: "بعقوبة - حي الأمانة",
    phone: "07703999003", hours: "24 ساعة", status: "مغلق",
    lat: 33.7385, lng: 44.6570
  },
];

export type GasStation = typeof gasStations[0];
