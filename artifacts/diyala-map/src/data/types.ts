export type FilterKind = string;

export interface MapItem {
  id: number;
  kind: string;
  category: string;
  name: string;
  details?: string;
  address: string;
  phone: string;
  hours: string;
  status: string;
  rating?: number | null;
  lat: number;
  lng: number;
  // legacy static-data fields kept for compat
  doctor?: string;
  specialty?: string;
  cuisine?: string;
  type?: string;
  pharmacist?: string;
}

export interface Category {
  id: number;
  slug: string;
  labelAr: string;
  labelEn: string;
  color: string;
  icon: string;
}
