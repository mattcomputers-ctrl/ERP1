import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService } from '../../audit/audit.service';
import type { Actor } from '../../auth/current-user.decorator';
import { buildList } from '../../common/list';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../../common/locks';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateAddressDto,
  CreateEntityDto,
  EntityListQuery,
  UpdateAddressDto,
  UpdateEntityDto,
} from './entities.dto';

const SORTABLE = ['entityCode', 'createdAt', 'customerType', 'group'];
const ROLE_FLAG: Record<string, string> = {
  supplier: 'isSupplier',
  manufacturer: 'isManufacturer',
  customer: 'isBillTo',
  shipto: 'isShipTo',
  salesman: 'isSalesman',
  shipvia: 'isShipVia',
  warehouse: 'isWarehouse',
  lab: 'isLab',
};
// The canonical primary-address reference (legacy + PartyService + documents all
// key the display/document address off Reference='Address').
const PRIMARY_REF = 'Address';
// The Address columns the editor writes (shared by add + edit).
const ADDRESS_FIELDS = [
  'name', 'department', 'addrLine1', 'addrLine2', 'addrLine3', 'city', 'state',
  'zipCode', 'country', 'contact', 'email', 'phone', 'fax', 'emergencyContact',
] as const;

@Injectable()
export class EntitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: EntityListQuery) {
    const { skip, take, orderBy, page, pageSize } = buildList(query, {
      sortable: SORTABLE,
      defaultSort: { entityCode: 'asc' },
    });
    const where: Record<string, unknown> = {};
    if (query.q) {
      where.OR = [
        { entityCode: { contains: query.q, mode: 'insensitive' } },
        { theirCode: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.role && ROLE_FLAG[query.role]) {
      where[ROLE_FLAG[query.role]] = true;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.entity.findMany({ where, skip, take, orderBy }),
      this.prisma.entity.count({ where }),
    ]);
    const names = await this.primaryNames(rows.map((r) => r.id));
    return {
      rows: rows.map((r) => ({ ...r, name: names[r.id] ?? null })),
      total,
      page,
      pageSize,
    };
  }

  async get(id: number) {
    const entity = await this.prisma.entity.findUnique({ where: { id } });
    if (!entity) throw new NotFoundException('Entity not found');
    return { ...entity, addresses: await this.addressesFor(id) };
  }

  async create(dto: CreateEntityDto, actor: Actor) {
    const exists = await this.prisma.entity.findUnique({ where: { entityCode: dto.entityCode } });
    if (exists) throw new BadRequestException('Entity code already exists');
    if (dto.parentId != null) await this.assertParent(dto.parentId, null);

    const entity = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const e = await tx.entity.create({
        data: {
          entityCode: dto.entityCode,
          isSupplier: dto.isSupplier ?? false,
          isManufacturer: dto.isManufacturer ?? false,
          isBillTo: dto.isBillTo ?? false,
          isShipTo: dto.isShipTo ?? false,
          isSalesman: dto.isSalesman ?? false,
          isShipVia: dto.isShipVia ?? false,
          isWarehouse: dto.isWarehouse ?? false,
          isLab: dto.isLab ?? false,
          currency: dto.currency,
          terms: dto.terms,
          customerType: dto.customerType,
          parentId: dto.parentId ?? null,
          isDivision: false,
          context: '',
        },
      });
      if (dto.name) {
        const addressId = await this.nextNativeAddressId(tx);
        await tx.address.create({ data: { id: addressId, name: dto.name } });
        await tx.addressReference.create({
          data: { address: addressId, tableName: 'Entity', tableId: e.id, reference: PRIMARY_REF },
        });
      }
      await this.audit.record(
        {
          action: 'entity.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.entities',
          summary: `Created entity ${e.entityCode}`,
          changes: [
            { tableName: 'Entity', recordId: String(e.id), fieldName: 'entityCode', oldValue: null, newValue: e.entityCode },
          ],
        },
        tx,
      );
      return e;
    });
    return { id: entity.id, entityCode: entity.entityCode };
  }

  async update(id: number, dto: UpdateEntityDto, actor: Actor) {
    const existing = await this.prisma.entity.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Entity not found');
    if (dto.parentId != null) await this.assertParent(dto.parentId, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const e = await tx.entity.update({ where: { id }, data: { ...dto } });
      await this.audit.record(
        {
          action: 'entity.update',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.entities',
          summary: `Updated entity ${e.entityCode}`,
          // Only record fields that actually changed — the edit form sends every
          // role flag each time, so logging all keys would be pure noise.
          changes: Object.keys(dto)
            .map((k) => ({
              tableName: 'Entity',
              recordId: String(id),
              fieldName: k,
              oldValue: String((existing as Record<string, unknown>)[k] ?? ''),
              newValue: String((dto as Record<string, unknown>)[k] ?? ''),
            }))
            .filter((c) => c.oldValue !== c.newValue),
        },
        tx,
      );
      return e;
    });
    return { id: updated.id, entityCode: updated.entityCode };
  }

  // --- address book (Address + AddressReference) ---------------------------

  /** Add an address to an entity (native Address id ≥ NATIVE_ID_BASE + its
   * AddressReference link). Only one primary ('Address') reference is allowed so
   * documents resolve deterministically; ship-to addresses may repeat. */
  async addAddress(entityId: number, dto: CreateAddressDto, actor: Actor) {
    const entity = await this.prisma.entity.findUnique({ where: { id: entityId }, select: { id: true, entityCode: true } });
    if (!entity) throw new NotFoundException('Entity not found');

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Re-assert the single-primary invariant INSIDE the locked tx (there is no
      // DB unique constraint — AddressReference's PK includes the address id — so
      // a pre-tx check is TOCTOU-racy under concurrent submits).
      if (dto.reference === PRIMARY_REF) {
        const existingPrimary = await tx.addressReference.findFirst({
          where: { tableName: 'Entity', tableId: entityId, reference: PRIMARY_REF },
          select: { address: true },
        });
        if (existingPrimary) throw new BadRequestException('A primary address already exists; edit it instead of adding another.');
      }
      const addressId = await this.nextNativeAddressId(tx);
      await tx.address.create({ data: { id: addressId, ...this.addressData(dto) } as Prisma.AddressUncheckedCreateInput });
      await tx.addressReference.create({
        data: { address: addressId, tableName: 'Entity', tableId: entityId, reference: dto.reference },
      });
      await this.audit.record(
        {
          action: 'entity.address.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.entities',
          summary: `Address (${dto.reference}) "${dto.name}" added to entity ${entity.entityCode}`,
          changes: [{ tableName: 'Address', recordId: String(addressId), fieldName: 'Name', oldValue: null, newValue: dto.name }],
        },
        tx,
      );
      return { id: addressId, reference: dto.reference };
    });
  }

  /** Edit an entity's address (IDOR-safe: the address must be linked to this
   * entity). COPY-ON-WRITE for legacy/shared rows: a legacy Address (id below the
   * native range) or one referenced by anything besides THIS entity is shared by
   * historical document snapshots (Ordr/Waybill/Location ShipToAddress point at
   * the same Address row), so editing it in place would silently rewrite those
   * documents. In that case we mint a fresh native Address (copying the row +
   * applying the edits) and repoint only this entity's references to it. A native,
   * exclusively-owned address is edited in place. */
  async updateAddress(entityId: number, addressId: number, dto: UpdateAddressDto, actor: Actor) {
    await this.assertAddressOnEntity(entityId, addressId);
    const data = this.addressData(dto);
    if (Object.keys(data).length === 0) return { id: addressId, unchanged: true };

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const existing = await tx.address.findUnique({ where: { id: addressId } });
      if (!existing) throw new NotFoundException('Address not found');
      // Shared if any reference to this address is NOT one of THIS entity's Entity
      // references (document snapshots, other entities), or if it is a legacy row.
      const foreignRefs = await tx.addressReference.count({
        where: { address: addressId, NOT: { tableName: 'Entity', tableId: entityId } },
      });
      const shared = addressId < NATIVE_ID_BASE || foreignRefs > 0;

      if (!shared) {
        await tx.address.update({ where: { id: addressId }, data });
        await this.recordAddressUpdate(tx, entityId, addressId, actor, false);
        return { id: addressId };
      }

      // Copy-on-write: fresh native Address = existing row + edits; repoint only
      // this entity's references (keeping their reference labels).
      const { id: _old, ...rest } = existing;
      const newId = await this.nextNativeAddressId(tx);
      await tx.address.create({ data: { ...rest, ...data, id: newId } as Prisma.AddressUncheckedCreateInput });
      const ownRefs = await tx.addressReference.findMany({
        where: { tableName: 'Entity', tableId: entityId, address: addressId },
        select: { reference: true },
      });
      await tx.addressReference.deleteMany({ where: { tableName: 'Entity', tableId: entityId, address: addressId } });
      await tx.addressReference.createMany({
        data: ownRefs.map((r) => ({ address: newId, tableName: 'Entity', tableId: entityId, reference: r.reference })),
      });
      await this.recordAddressUpdate(tx, entityId, newId, actor, true);
      return { id: newId, copiedFrom: addressId };
    });
  }

  private async recordAddressUpdate(tx: Prisma.TransactionClient, entityId: number, addressId: number, actor: Actor, copied: boolean) {
    await this.audit.record(
      {
        action: 'entity.address.update',
        actorUserId: actor.id,
        actorLabel: actor.label,
        program: 'master.entities',
        summary: `Address #${addressId} on entity ${entityId} updated${copied ? ' (copy-on-write from a shared/legacy address)' : ''}`,
      },
      tx,
    );
  }

  /** Remove an address from an entity: drop this entity's reference(s) to it,
   * then delete the Address row only if it is native and now unreferenced
   * (never delete a shared / legacy address). */
  async removeAddress(entityId: number, addressId: number, actor: Actor) {
    await this.assertAddressOnEntity(entityId, addressId);
    return this.prisma.$transaction(async (tx) => {
      await tx.addressReference.deleteMany({ where: { tableName: 'Entity', tableId: entityId, address: addressId } });
      const stillReferenced = await tx.addressReference.count({ where: { address: addressId } });
      const deletedAddress = stillReferenced === 0 && addressId >= NATIVE_ID_BASE;
      if (deletedAddress) await tx.address.delete({ where: { id: addressId } });
      await this.audit.record(
        {
          action: 'entity.address.delete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'master.entities',
          summary: `Address #${addressId} removed from entity ${entityId}${deletedAddress ? ' (address deleted)' : ''}`,
        },
        tx,
      );
      return { id: addressId, deletedAddress };
    });
  }

  /** Entity picker for the parent (ship-to hierarchy) selector. */
  async entityOptions(q?: string, role?: string) {
    const term = q?.trim();
    const and: Prisma.EntityWhereInput[] = [];
    if (role && ROLE_FLAG[role]) and.push({ [ROLE_FLAG[role]]: true });
    if (term) and.push({ entityCode: { contains: term, mode: 'insensitive' } });
    const where: Prisma.EntityWhereInput = and.length ? { AND: and } : {};
    const rows = await this.prisma.entity.findMany({ where, take: 25, orderBy: { entityCode: 'asc' }, select: { id: true, entityCode: true } });
    const names = await this.primaryNames(rows.map((r) => r.id));
    return { rows: rows.map((r) => ({ id: r.id, code: r.entityCode, name: names[r.id] ?? null })) };
  }

  // --- helpers -------------------------------------------------------------

  private async primaryNames(ids: number[]): Promise<Record<number, string>> {
    if (!ids.length) return {};
    const refs = await this.prisma.addressReference.findMany({
      where: { tableName: 'Entity', tableId: { in: ids } },
    });
    const pick = new Map<number, number>(); // entityId -> addressId (prefer PRIMARY_REF)
    for (const r of refs) {
      if (!pick.has(r.tableId) || r.reference === PRIMARY_REF) pick.set(r.tableId, r.address);
    }
    const addrIds = [...new Set(pick.values())];
    if (!addrIds.length) return {};
    const addrs = await this.prisma.address.findMany({
      where: { id: { in: addrIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(addrs.map((a) => [a.id, a.name]));
    const out: Record<number, string> = {};
    for (const [eid, aid] of pick) {
      const n = nameById.get(aid);
      if (n) out[eid] = n;
    }
    return out;
  }

  private async addressesFor(id: number) {
    const refs = await this.prisma.addressReference.findMany({
      where: { tableName: 'Entity', tableId: id },
    });
    if (!refs.length) return [];
    const addrs = await this.prisma.address.findMany({ where: { id: { in: refs.map((r) => r.address) } } });
    const byId = new Map(addrs.map((a) => [a.id, a]));
    return refs
      .map((r) => {
        const a = byId.get(r.address);
        return a ? { reference: r.reference, ...a } : null;
      })
      .filter((v): v is NonNullable<typeof v> => v != null);
  }

  /** Pick only the address columns present on the DTO (undefined skipped). */
  private addressData(dto: CreateAddressDto | UpdateAddressDto): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of ADDRESS_FIELDS) {
      if ((dto as Record<string, unknown>)[f] !== undefined) out[f] = (dto as Record<string, unknown>)[f];
    }
    return out;
  }

  private async assertAddressOnEntity(entityId: number, addressId: number) {
    const ref = await this.prisma.addressReference.findFirst({
      where: { tableName: 'Entity', tableId: entityId, address: addressId },
      select: { address: true },
    });
    if (!ref) throw new NotFoundException('Address not found on this entity');
  }

  /** Validate a parent-entity reference (exists, not self). */
  private async assertParent(parentId: number, selfId: number | null) {
    if (selfId != null && parentId === selfId) throw new BadRequestException('An entity cannot be its own parent');
    const parent = await this.prisma.entity.findUnique({ where: { id: parentId }, select: { id: true } });
    if (!parent) throw new BadRequestException(`Unknown parent entity id ${parentId}`);
  }

  private async nextNativeAddressId(tx: Prisma.TransactionClient): Promise<number> {
    return ((await tx.address.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
  }
}
