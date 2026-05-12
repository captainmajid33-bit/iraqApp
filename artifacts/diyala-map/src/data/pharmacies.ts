export const pharmacies = [
  {
    id: 201, kind: 'pharmacy' as const, name: "صيدلية الشفاء المركزية",
    pharmacist: "صيدلاني: أحمد كاظم الموسوي",
    type: "صيدلية عامة", address: "بعقوبة - شارع الرئيسي",
    phone: "07701000001", hours: "8:00 ص - 10:00 م", status: "مفتوح",
    lat: 33.7445, lng: 44.6505
  },
  {
    id: 202, kind: 'pharmacy' as const, name: "صيدلية الرعاية الحديثة",
    pharmacist: "صيدلانية: نور حسين العبيدي",
    type: "صيدلية تخصصية", address: "بعقوبة - حي الأمانة",
    phone: "07702000002", hours: "9:00 ص - 11:00 م", status: "مفتوح",
    lat: 33.7490, lng: 44.6430
  },
  {
    id: 203, kind: 'pharmacy' as const, name: "صيدلية النهضة",
    pharmacist: "صيدلاني: علي محمد الجبوري",
    type: "صيدلية عامة", address: "بعقوبة - شارع الجمهورية",
    phone: "07703000003", hours: "24 ساعة", status: "مفتوح",
    lat: 33.7370, lng: 44.6590
  },
  {
    id: 204, kind: 'pharmacy' as const, name: "صيدلية الأمل",
    pharmacist: "صيدلانية: رهام طاهر السامرائي",
    type: "صيدلية عامة", address: "بعقوبة - حي العصري",
    phone: "07704000004", hours: "8:00 ص - 8:00 م", status: "مغلق",
    lat: 33.7400, lng: 44.6550
  },
  {
    id: 205, kind: 'pharmacy' as const, name: "صيدلية دجلة للأدوية",
    pharmacist: "صيدلاني: حيدر ناصر الدليمي",
    type: "صيدلية تخصصية", address: "بعقوبة - مجاور المستشفى العام",
    phone: "07705000005", hours: "8:00 ص - 12:00 م", status: "مفتوح",
    lat: 33.7580, lng: 44.6370
  },
  {
    id: 206, kind: 'pharmacy' as const, name: "صيدلية الصحة والعافية",
    pharmacist: "صيدلاني: زياد فراس التميمي",
    type: "صيدلية عامة", address: "بعقوبة - السوق المركزي",
    phone: "07706000006", hours: "9:00 ص - 9:00 م", status: "مفتوح",
    lat: 33.7420, lng: 44.6480
  },
  {
    id: 207, kind: 'pharmacy' as const, name: "صيدلية الوفاء",
    pharmacist: "صيدلانية: مريم سالم الحيالي",
    type: "صيدلية عامة", address: "بعقوبة - حي النهضة",
    phone: "07707000007", hours: "8:00 ص - 10:00 م", status: "مغلق",
    lat: 33.7465, lng: 44.6460
  },
  {
    id: 208, kind: 'pharmacy' as const, name: "صيدلية الخير للأدوية",
    pharmacist: "صيدلاني: كرار عدنان المنصوري",
    type: "صيدلية عامة", address: "بعقوبة - شارع المدارس",
    phone: "07708000008", hours: "24 ساعة", status: "مفتوح",
    lat: 33.7530, lng: 44.6415
  },
];

export type Pharmacy = typeof pharmacies[0];
