import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface Party {
  entityCode: string | null;
  name: string | null;
  line1: string | null;
  line2: string | null;
  cityStateZip: string | null;
}

/**
 * Resolves entity ids to display name + address. Entity has NO Name column — the
 * name and street address live on Address, linked via AddressReference
 * (TableName='Entity'), Reference='Address' preferred. Shared by all documents.
 */
@Injectable()
export class PartyService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(ids: (number | null | undefined)[]): Promise<Map<number, Party>> {
    const distinct = [...new Set(ids.filter((v): v is number => v != null))];
    if (!distinct.length) return new Map();

    const [entities, refs] = await Promise.all([
      this.prisma.entity.findMany({ where: { id: { in: distinct } }, select: { id: true, entityCode: true } }),
      this.prisma.addressReference.findMany({
        where: { tableName: 'Entity', tableId: { in: distinct } },
        select: { tableId: true, address: true, reference: true },
      }),
    ]);
    const addrIdByEntity = new Map<number, number>();
    for (const r of refs) {
      if (!addrIdByEntity.has(r.tableId) || r.reference === 'Address') addrIdByEntity.set(r.tableId, r.address);
    }
    const addrIds = [...new Set([...addrIdByEntity.values()])];
    const addresses = addrIds.length
      ? await this.prisma.address.findMany({
          where: { id: { in: addrIds } },
          select: { id: true, name: true, addrLine1: true, addrLine2: true, city: true, state: true, zipCode: true },
        })
      : [];
    const addrById = new Map(addresses.map((a) => [a.id, a]));

    const out = new Map<number, Party>();
    for (const e of entities) {
      const a = addrIdByEntity.has(e.id) ? addrById.get(addrIdByEntity.get(e.id)!) : undefined;
      const cityStateZip = a ? [a.city, a.state].filter(Boolean).join(', ') + (a.zipCode ? ` ${a.zipCode}` : '') : null;
      out.set(e.id, {
        entityCode: e.entityCode,
        name: a?.name ?? e.entityCode,
        line1: a?.addrLine1 ?? null,
        line2: a?.addrLine2 ?? null,
        cityStateZip: cityStateZip || null,
      });
    }
    return out;
  }
}
