export const restaurants = [
  {
    id: 101, kind: 'restaurant' as const, name: "مطعم الكرم البغدادي",
    cuisine: "مشاوي وكباب", type: "مطعم شعبي",
    address: "بعقوبة - شارع المتنبي", phone: "07701111111",
    hours: "12:00 م - 11:00 م", status: "مفتوح", rating: 4,
    lat: 33.7430, lng: 44.6520
  },
  {
    id: 102, kind: 'restaurant' as const, name: "مطعم دجلة للمأكولات الشعبية",
    cuisine: "تشريب ومرق", type: "مطعم شعبي",
    address: "بعقوبة - حي النهضة", phone: "07702222222",
    hours: "8:00 ص - 10:00 م", status: "مفتوح", rating: 4,
    lat: 33.7480, lng: 44.6450
  },
  {
    id: 103, kind: 'restaurant' as const, name: "مطعم السدة الذهبي",
    cuisine: "دجاج مشوي وبيتزا", type: "مطعم متوسط",
    address: "بعقوبة - شارع الحرية", phone: "07703333333",
    hours: "10:00 ص - 12:00 م", status: "مغلق", rating: 3,
    lat: 33.7360, lng: 44.6580
  },
  {
    id: 104, kind: 'restaurant' as const, name: "كافيه نخيل ديالى",
    cuisine: "مشروبات وحلويات", type: "كافيه",
    address: "بعقوبة - الشارع التجاري", phone: "07704444444",
    hours: "9:00 ص - 1:00 ص", status: "مفتوح", rating: 5,
    lat: 33.7500, lng: 44.6500
  },
  {
    id: 105, kind: 'restaurant' as const, name: "مطعم الأصالة للكباب",
    cuisine: "كباب وتكة", type: "مطعم شعبي",
    address: "بعقوبة - حي الأمانة", phone: "07705555555",
    hours: "12:00 م - 9:00 م", status: "مغلق", rating: 4,
    lat: 33.7540, lng: 44.6400
  },
  {
    id: 106, kind: 'restaurant' as const, name: "مطعم بابل الشامي",
    cuisine: "مأكولات شامية", type: "مطعم متوسط",
    address: "بعقوبة - قرب الساحة الرئيسية", phone: "07706666666",
    hours: "11:00 ص - 11:00 م", status: "مفتوح", rating: 3,
    lat: 33.7410, lng: 44.6560
  },
  {
    id: 107, kind: 'restaurant' as const, name: "مطعم ليالي الرافدين",
    cuisine: "أسماك مسقوف", type: "مطعم فاخر",
    address: "بعقوبة - كورنيش ديالى", phone: "07707777777",
    hours: "1:00 م - 11:00 م", status: "مفتوح", rating: 5,
    lat: 33.7460, lng: 44.6440
  },
  {
    id: 108, kind: 'restaurant' as const, name: "مقهى الصبح",
    cuisine: "إفطار وشاي عراقي", type: "مقهى شعبي",
    address: "بعقوبة - السوق القديم", phone: "07708888888",
    hours: "5:00 ص - 12:00 م", status: "مفتوح", rating: 4,
    lat: 33.7390, lng: 44.6510
  },
];

export type Restaurant = typeof restaurants[0];
