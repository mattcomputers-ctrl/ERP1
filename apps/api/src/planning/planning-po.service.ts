import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PriceVersionService } from '../purchasing/price-version.service';
import { PurchasingService } from '../purchasing/purchasing.service';
import type { CreatePoFromPlanDto } from './dto/create-po-from-plan.dto';

// §10 Planning — Create Purchase Order from the Plan Tracing viewer
// (vendor UG §14.2.1): selected Short lines become ONE purchase order.
// Vendor rules enforced verbatim: all selected lines must be the same
// Item + Required-Manufacturer combination, supplier pricing must exist for
// that combination, and a requirement that pins a specific sublot can never
// be purchased. When more than one supplier prices the combination the
// caller is asked which to use (options returned, nothing created) — the
// vendor's "which pricing" prompt.

const ORDERABLE_REFERENCES = ['Short', 'Negative'];

export interface SupplierOption {
  supplierId: number;
  supplierCode: string;
  preferred: boolean; // the item's preferred supplier (Item.Supplier)
  price: number | null; // tier price for the total quantity
  leadTime: number | null;
}

@Injectable()
export class PlanningPoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchasing: PurchasingService,
    private readonly priceVersions: PriceVersionService,
  ) {}

  async createPoFromPlan(dto: CreatePoFromPlanDto, actor: Actor) {
    const ids = [...new Set(dto.planTraceIds)];
    const rows = await this.prisma.planTrace.findMany({
      where: { id: { in: ids.map((v) => BigInt(v)) } },
      select: {
        id: true, itemId: true, reference: true, quantity: true,
        manufacturerId: true, reqdSublotId: true, dateRequired: true,
      },
    });
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => Number(r.id)));
      throw new NotFoundException(`Plan trace line(s) not found: ${ids.filter((i) => !found.has(i)).join(', ')}`);
    }

    for (const r of rows) {
      if (!r.reference || !ORDERABLE_REFERENCES.includes(r.reference)) {
        throw new BadRequestException(
          `Line ${r.id} is "${r.reference ?? '?'}" — only Short/Negative requirements can be ordered.`,
        );
      }
      if (r.reqdSublotId != null) {
        throw new BadRequestException(
          `Line ${r.id} requires a specific sublot — a purchase order cannot supply it (UG §14.2.1).`,
        );
      }
    }
    const itemIds = [...new Set(rows.map((r) => r.itemId))];
    const manufacturerIds = [...new Set(rows.map((r) => r.manufacturerId ?? null))];
    if (itemIds.length !== 1 || itemIds[0] == null || manufacturerIds.length !== 1) {
      throw new BadRequestException(
        'All selected lines must be for the same Item and Required Manufacturer combination.',
      );
    }
    const itemId = itemIds[0];
    const manufacturerId = manufacturerIds[0];

    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, itemCode: true, supplierId: true },
    });
    if (!item) throw new NotFoundException(`Item ${itemId} not found`);

    const quantity = rows.reduce((s, r) => s + (r.quantity ?? 0), 0);
    if (quantity <= 0) throw new BadRequestException('The selected lines have no quantity to order.');
    const requiredDates = rows.map((r) => r.dateRequired).filter((d): d is Date => d != null);
    const dateRequired = requiredDates.length
      ? new Date(Math.min(...requiredDates.map((d) => d.getTime())))
      : null;

    const options = await this.supplierOptions(itemId, manufacturerId, quantity, item.supplierId);
    if (!options.length) {
      throw new BadRequestException(
        `No supplier pricing is set up for ${item.itemCode}` +
          (manufacturerId != null ? ' with the required manufacturer' : '') +
          ' — add a price version detail first (UG §14.2.1 requires pricing).',
      );
    }

    let supplierId = dto.supplierId ?? null;
    if (supplierId == null) {
      if (options.length > 1) {
        // The vendor's "which pricing to use" prompt: nothing is created;
        // the caller re-posts with the chosen supplier.
        return { created: false as const, needsSupplierChoice: true as const, options, quantity, itemId };
      }
      supplierId = options[0].supplierId;
    } else if (!options.some((o) => o.supplierId === supplierId)) {
      throw new BadRequestException('That supplier has no pricing for this item/manufacturer combination.');
    }

    const res = await this.purchasing.create(
      {
        supplierId,
        lines: [{ itemId, qtyReqd: quantity, manufacturerId: manufacturerId ?? undefined }],
        dateRequired: dateRequired?.toISOString(),
        reference: 'Plan Trace',
      },
      actor,
    );
    const chosen = options.find((o) => o.supplierId === supplierId);
    return {
      created: true as const,
      orderId: res.id,
      supplierId,
      supplierCode: chosen?.supplierCode ?? String(supplierId),
      itemId,
      itemCode: item.itemCode,
      quantity,
      price: chosen?.price ?? null,
      lines: rows.length,
    };
  }

  /**
   * Suppliers whose CURRENT (effective) price version prices this item — and,
   * when the requirement pins a manufacturer, whose detail is either generic
   * (no manufacturer) or for that manufacturer. The manufacturer-aware
   * lineSourcing is the single source of truth for BOTH qualification and the
   * quoted price, so the detail that qualifies a supplier is exactly the one
   * the PO will be priced/packaged from. Non-supplier entities (sales price
   * lists share the PriceVersion/PriceDetail tables) never qualify.
   * Preferred supplier (Item.Supplier) first.
   */
  private async supplierOptions(
    itemId: number,
    manufacturerId: number | null,
    quantity: number,
    preferredSupplierId: number | null,
  ): Promise<SupplierOption[]> {
    // Cheap discovery of candidate entities (any version); the effective
    // manufacturer-aware sourcing below decides who actually qualifies.
    const details = await this.prisma.priceDetail.findMany({
      where: {
        itemId,
        ...(manufacturerId != null ? { OR: [{ manufacturerId: null }, { manufacturerId }] } : {}),
      },
      select: { priceVersionId: true },
    });
    const versionIds = [...new Set(details.map((d) => d.priceVersionId).filter((v): v is number => v != null))];
    if (!versionIds.length) return [];
    const versions = await this.prisma.priceVersion.findMany({
      where: { id: { in: versionIds } },
      select: { entityId: true },
    });
    const candidateIds = [...new Set(versions.map((v) => v.entityId).filter((v): v is number => v != null))];
    if (!candidateIds.length) return [];
    const suppliers = await this.prisma.entity.findMany({
      where: { id: { in: candidateIds }, isSupplier: true },
      select: { id: true, entityCode: true },
    });

    const out: SupplierOption[] = [];
    for (const s of suppliers) {
      const sourcing = await this.priceVersions.lineSourcing(s.id, itemId, quantity, manufacturerId);
      if (!sourcing) continue; // no qualifying detail on the CURRENT version
      out.push({
        supplierId: s.id,
        supplierCode: s.entityCode ?? String(s.id),
        preferred: s.id === preferredSupplierId,
        price: sourcing.price,
        leadTime: sourcing.leadTime,
      });
    }
    out.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.supplierCode.localeCompare(b.supplierCode));
    return out;
  }
}
