import { Clinic } from './clinics';
import { Restaurant } from './restaurants';
import { Pharmacy } from './pharmacies';

export type MapItem = Clinic | Restaurant | Pharmacy;
export type FilterKind = 'clinic' | 'restaurant' | 'pharmacy';
