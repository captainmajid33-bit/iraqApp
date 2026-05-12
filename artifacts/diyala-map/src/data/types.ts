import { Clinic } from './clinics';
import { Restaurant } from './restaurants';
import { Pharmacy } from './pharmacies';
import { GasStation } from './gas_stations';

export type MapItem = Clinic | Restaurant | Pharmacy | GasStation;
export type FilterKind = 'clinic' | 'restaurant' | 'pharmacy' | 'gas_station';
