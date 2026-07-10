import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Header changes to an open revision draft (UG §7.2.2: the revision comment). */
export class UpdateRevisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  revisionComment?: string;
}

/** A test carried by an IPT line added by the revision. */
export class RevisionTestDto {
  @IsString()
  @MaxLength(20)
  test!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  qualifier?: string;

  @IsOptional()
  @IsNumber()
  min?: number;

  @IsOptional()
  @IsNumber()
  max?: number;

  @IsOptional()
  @IsNumber()
  target?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/**
 * Add a line to the revision draft: an ingredient (UI — item + qty required),
 * an instruction step (INSTR — description required), or an in-process test
 * step (IPT — tests list; the vendor's failed-IPT fix adds ingredients then a
 * new IPT after them, UG §7.2.5).
 */
export class AddRevisionLineDto {
  @IsIn(['UI', 'INSTR', 'IPT'])
  context!: 'UI' | 'INSTR' | 'IPT';

  @IsOptional()
  @IsInt()
  itemId?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qty?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phase?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RevisionTestDto)
  tests?: RevisionTestDto[];
}

/** Edit a draft line: quantity on material (UI) lines, comment on any editable line. */
export class UpdateRevisionLineDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(1_000_000_000)
  qtyReqd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

/** Publish the draft — apply it to the released order (e-signable action). */
export class PublishRevisionDto {
  /**
   * The draft the signer reviewed. Asserted against the open draft under the
   * order row lock — a signature must never land on a draft that was swapped
   * (rejected + reopened) while the publish dialog was open.
   */
  @IsInt()
  editId!: number;

  /**
   * The draft's updatedAt as last seen by the signer (optimistic-concurrency
   * token from GET /orders/:id/revisions). When present it must match the
   * draft under the lock, so content edited after the review is refused too.
   */
  @IsOptional()
  @IsISO8601()
  draftUpdatedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  // --- electronic signature (required when the order.revise secured item
  // demands a signature; the service enforces conditional presence) ---

  /** The signer's (current user's) password, re-entered to sign the publish. */
  @IsOptional()
  @IsString()
  password?: string;

  /** Optional second-person witness credentials. */
  @IsOptional()
  @IsEmail()
  witnessEmail?: string;

  @IsOptional()
  @IsString()
  witnessPassword?: string;

  /** Signer's TOTP code — demanded when the signer is MFA-enrolled. */
  @IsOptional()
  @IsString()
  totpCode?: string;

  /** Witness's TOTP code — demanded when the witness is MFA-enrolled. */
  @IsOptional()
  @IsString()
  witnessTotpCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  witnessExplanation?: string;
}

/** Cancel the draft (UG §7.1.7 — the edit gets status REJ, its number is reused). */
export class RejectRevisionDto {
  /** The draft being cancelled — same pin as publish (never cancel a swapped draft). */
  @IsInt()
  editId!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
