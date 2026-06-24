import { IsString, MaxLength } from 'class-validator';

// Reverse a posted receipt (purchase or miscellaneous). A reason is required and
// recorded; the reversal is only allowed while the received stock is still
// untouched (see InventoryService.reverseReceipt).
export class ReverseReceiptDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}
