import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class EntityListQuery {
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
  @IsOptional() @IsString() sort?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() role?: string; // supplier|manufacturer|customer|shipto|salesman|warehouse|lab
}

export class CreateEntityDto {
  @IsString() @MaxLength(20) entityCode!: string;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsBoolean() isSupplier?: boolean;
  @IsOptional() @IsBoolean() isManufacturer?: boolean;
  @IsOptional() @IsBoolean() isBillTo?: boolean;
  @IsOptional() @IsBoolean() isShipTo?: boolean;
  @IsOptional() @IsBoolean() isSalesman?: boolean;
  @IsOptional() @IsBoolean() isShipVia?: boolean;
  @IsOptional() @IsBoolean() isWarehouse?: boolean;
  @IsOptional() @IsBoolean() isLab?: boolean;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(20) terms?: string;
  @IsOptional() @IsString() @MaxLength(20) customerType?: string;
  // Ship-to hierarchy: a ship-to may sit under a parent customer.
  @IsOptional() @IsInt() parentId?: number;
}

export class UpdateEntityDto {
  @IsOptional() @IsBoolean() isSupplier?: boolean;
  @IsOptional() @IsBoolean() isManufacturer?: boolean;
  @IsOptional() @IsBoolean() isBillTo?: boolean;
  @IsOptional() @IsBoolean() isShipTo?: boolean;
  @IsOptional() @IsBoolean() isSalesman?: boolean;
  @IsOptional() @IsBoolean() isShipVia?: boolean;
  @IsOptional() @IsBoolean() isWarehouse?: boolean;
  @IsOptional() @IsBoolean() isLab?: boolean;
  @IsOptional() @IsBoolean() inactive?: boolean;
  @IsOptional() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @IsString() @MaxLength(20) terms?: string;
  @IsOptional() @IsString() @MaxLength(20) customerType?: string;
  @IsOptional() @IsInt() leadTime?: number;
  // Nullable: pass null to detach from a parent (re-asserted in the service).
  @IsOptional() @IsInt() parentId?: number | null;
}

// Address-book link references this install actually uses on entities: the
// primary document address, and a ship-to address. (Legacy also uses these on
// Ordr/Location/Waybill; those are document-time snapshots, not entity master
// data.)
export const ENTITY_ADDRESS_REFERENCES = ['Address', 'ShipToAddress'] as const;

// The document-facing fields shared by create + edit of an entity address.
class AddressFieldsDto {
  @IsOptional() @IsString() @MaxLength(20) department?: string;
  @IsOptional() @IsString() @MaxLength(255) addrLine1?: string;
  @IsOptional() @IsString() @MaxLength(255) addrLine2?: string;
  @IsOptional() @IsString() @MaxLength(255) addrLine3?: string;
  @IsOptional() @IsString() @MaxLength(255) city?: string;
  @IsOptional() @IsString() @MaxLength(2) state?: string;
  @IsOptional() @IsString() @MaxLength(20) zipCode?: string;
  @IsOptional() @IsString() @MaxLength(2) country?: string;
  @IsOptional() @IsString() @MaxLength(255) contact?: string;
  @IsOptional() @IsString() @MaxLength(100) email?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsString() @MaxLength(30) fax?: string;
  @IsOptional() @IsString() emergencyContact?: string;
}

export class CreateAddressDto extends AddressFieldsDto {
  @IsString() @MaxLength(255) name!: string;
  @IsIn(ENTITY_ADDRESS_REFERENCES) reference!: (typeof ENTITY_ADDRESS_REFERENCES)[number];
}

export class UpdateAddressDto extends AddressFieldsDto {
  @IsOptional() @IsString() @MaxLength(255) name?: string;
}
