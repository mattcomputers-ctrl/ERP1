import { IsInt, Min } from 'class-validator';
import { ReverseOrderDto } from './reverse-order.dto';

// Reverse ONE shipment event of a shipping order — the target is the packing
// slip (the native SH ChangeSet id shipLots returned). The e-sig pin: the id
// names an immutable posted change set, so the signature can never land on a
// shipment the signer didn't review. Reason/signature/witness/elevation fields
// come from the shared reversal DTO (same order.reverse secured item).
export class ReverseShipmentDto extends ReverseOrderDto {
  @IsInt()
  @Min(1)
  packingSlipId!: number;
}
