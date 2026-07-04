import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateAccountCodeDto,
  CreateGlCodeDto,
  CreateGlGroupCodeDto,
  CreateGlGroupDto,
  TaxRuleBodyDto,
  UpdateDescriptionDto,
  UpdateGlGroupCodeDto,
  UpdateTaxRuleDto,
} from './dto/masters.dto';

const PROGRAM = 'accounting.config';

/**
 * CRUD for the accounting master tables (UG ch.17): GL groups / GL codes /
 * account codes / the (group, code) -> account mapping grid / tax rules.
 * These are legacy-mirrored tables — during parallel running the legacy
 * system stays master for imported keys (sync upserts by key), while rows
 * created here (new keys; native ids for the int-PK tables) are never touched
 * by the import. Every mutation is audited.
 */
@Injectable()
export class GlMastersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Everything the Accounting masters page needs — the tables are tiny. */
  async masters() {
    const [glGroups, glCodes, accountCodes, glGroupCodes, taxRules, groupUse] = await Promise.all([
      this.prisma.gLGroup.findMany({ orderBy: { glGroup: 'asc' } }),
      this.prisma.gLCode.findMany({ orderBy: { glCode: 'asc' } }),
      this.prisma.accountCode.findMany({ orderBy: { accountCode: 'asc' } }),
      this.prisma.gLGroupCode.findMany({ orderBy: [{ glGroup: 'asc' }, { glCode: 'asc' }] }),
      this.prisma.taxRule.findMany({ orderBy: [{ taxNumber: 'asc' }, { id: 'asc' }] }),
      this.prisma.item.groupBy({ by: ['glGroup'], _count: true, where: { glGroup: { not: null } } }),
    ]);
    const itemCountByGroup = new Map(groupUse.map((g) => [g.glGroup, g._count]));
    return {
      glGroups: glGroups.map((g) => ({ ...g, itemCount: itemCountByGroup.get(g.glGroup) ?? 0 })),
      glCodes,
      accountCodes,
      glGroupCodes,
      taxRules,
    };
  }

  // --- GL groups -----------------------------------------------------------

  async createGlGroup(dto: CreateGlGroupDto, actor: Actor) {
    const glGroup = dto.glGroup.trim();
    if (!glGroup) throw new BadRequestException('GL group is required.');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLGroup.findUnique({ where: { glGroup } });
      if (existing) throw new ConflictException(`GL group '${glGroup}' already exists.`);
      const row = await tx.gLGroup.create({ data: { glGroup, description: dto.description ?? glGroup } });
      await this.record(actor, tx, `GL group '${glGroup}' created`, 'GLGroup', glGroup);
      return row;
    });
  }

  async updateGlGroup(code: string, dto: UpdateDescriptionDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLGroup.findUnique({ where: { glGroup: code } });
      if (!existing) throw new NotFoundException('GL group not found');
      const newDescription = dto.description !== undefined ? dto.description : existing.description;
      const row = await tx.gLGroup.update({ where: { glGroup: code }, data: { description: newDescription } });
      await this.record(actor, tx, `GL group '${code}' description updated`, 'GLGroup', code, existing.description, newDescription);
      return row;
    });
  }

  async deleteGlGroup(code: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLGroup.findUnique({ where: { glGroup: code } });
      if (!existing) throw new NotFoundException('GL group not found');
      const [mappings, items] = await Promise.all([
        tx.gLGroupCode.count({ where: { glGroup: code } }),
        tx.item.count({ where: { glGroup: code } }),
      ]);
      if (items > 0) throw new ConflictException(`GL group '${code}' is used by ${items} item(s).`);
      if (mappings > 0) throw new ConflictException(`GL group '${code}' has ${mappings} account mapping(s) — remove them first.`);
      await tx.gLGroup.delete({ where: { glGroup: code } });
      await this.record(actor, tx, `GL group '${code}' deleted`, 'GLGroup', code);
      return { deleted: true };
    });
  }

  // --- GL codes ------------------------------------------------------------

  async createGlCode(dto: CreateGlCodeDto, actor: Actor) {
    const glCode = dto.glCode.trim();
    if (!glCode) throw new BadRequestException('GL code is required.');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLCode.findUnique({ where: { glCode } });
      if (existing) throw new ConflictException(`GL code '${glCode}' already exists.`);
      const row = await tx.gLCode.create({ data: { glCode, description: dto.description ?? glCode, version: 1 } });
      await this.record(actor, tx, `GL code '${glCode}' created`, 'GLCode', glCode);
      return row;
    });
  }

  async updateGlCode(code: string, dto: UpdateDescriptionDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLCode.findUnique({ where: { glCode: code } });
      if (!existing) throw new NotFoundException('GL code not found');
      const newDescription = dto.description !== undefined ? dto.description : existing.description;
      const row = await tx.gLCode.update({ where: { glCode: code }, data: { description: newDescription } });
      await this.record(actor, tx, `GL code '${code}' description updated`, 'GLCode', code, existing.description, newDescription);
      return row;
    });
  }

  async deleteGlCode(code: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLCode.findUnique({ where: { glCode: code } });
      if (!existing) throw new NotFoundException('GL code not found');
      const mappings = await tx.gLGroupCode.count({ where: { glCode: code } });
      if (mappings > 0) throw new ConflictException(`GL code '${code}' is mapped in ${mappings} GL group(s) — remove the mappings first.`);
      await tx.gLCode.delete({ where: { glCode: code } });
      await this.record(actor, tx, `GL code '${code}' deleted`, 'GLCode', code);
      return { deleted: true };
    });
  }

  // --- Account codes ---------------------------------------------------------

  async createAccountCode(dto: CreateAccountCodeDto, actor: Actor) {
    const accountCode = dto.accountCode.trim();
    if (!accountCode) throw new BadRequestException('Account code is required.');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.accountCode.findUnique({ where: { accountCode } });
      if (existing) throw new ConflictException(`Account code '${accountCode}' already exists.`);
      const row = await tx.accountCode.create({ data: { accountCode, description: dto.description ?? accountCode, version: 1 } });
      await this.record(actor, tx, `Account code '${accountCode}' created`, 'AccountCode', accountCode);
      return row;
    });
  }

  async updateAccountCode(code: string, dto: UpdateDescriptionDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.accountCode.findUnique({ where: { accountCode: code } });
      if (!existing) throw new NotFoundException('Account code not found');
      const newDescription = dto.description !== undefined ? dto.description : existing.description;
      const row = await tx.accountCode.update({ where: { accountCode: code }, data: { description: newDescription } });
      await this.record(actor, tx, `Account code '${code}' description updated`, 'AccountCode', code, existing.description, newDescription);
      return row;
    });
  }

  async deleteAccountCode(code: string, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.accountCode.findUnique({ where: { accountCode: code } });
      if (!existing) throw new NotFoundException('Account code not found');
      const mappings = await tx.gLGroupCode.count({ where: { accountCode: code } });
      if (mappings > 0) throw new ConflictException(`Account code '${code}' is mapped in ${mappings} GL group(s) — remove the mappings first.`);
      await tx.accountCode.delete({ where: { accountCode: code } });
      await this.record(actor, tx, `Account code '${code}' deleted`, 'AccountCode', code);
      return { deleted: true };
    });
  }

  // --- GL group codes (the mapping grid) -------------------------------------

  async createGlGroupCode(dto: CreateGlGroupCodeDto, actor: Actor) {
    const glGroup = dto.glGroup.trim();
    const glCode = dto.glCode.trim();
    const accountCode = dto.accountCode?.trim() || null;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const [group, codeRow, account, dup] = await Promise.all([
        tx.gLGroup.findUnique({ where: { glGroup } }),
        tx.gLCode.findUnique({ where: { glCode } }),
        accountCode ? tx.accountCode.findUnique({ where: { accountCode } }) : Promise.resolve(null),
        tx.gLGroupCode.findUnique({ where: { glGroup_glCode: { glGroup, glCode } } }),
      ]);
      if (!group) throw new BadRequestException(`Unknown GL group '${glGroup}'.`);
      if (!codeRow) throw new BadRequestException(`Unknown GL code '${glCode}'.`);
      if (accountCode && !account) throw new BadRequestException(`Unknown account code '${accountCode}'.`);
      if (dup) throw new ConflictException(`GL group '${glGroup}' already maps GL code '${glCode}'.`);
      const id = ((await tx.gLGroupCode.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const row = await tx.gLGroupCode.create({ data: { id, glGroup, glCode, accountCode } });
      await this.record(actor, tx, `GL mapping ${glGroup}/${glCode} -> ${accountCode ?? '(none)'} created`, 'GLGroupCode', String(id));
      return row;
    });
  }

  async updateGlGroupCode(id: number, dto: UpdateGlGroupCodeDto, actor: Actor) {
    const accountCode = dto.accountCode?.trim() || null;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLGroupCode.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('GL group mapping not found');
      if (accountCode) {
        const account = await tx.accountCode.findUnique({ where: { accountCode } });
        if (!account) throw new BadRequestException(`Unknown account code '${accountCode}'.`);
      }
      const row = await tx.gLGroupCode.update({ where: { id }, data: { accountCode } });
      await this.record(
        actor, tx,
        `GL mapping ${existing.glGroup}/${existing.glCode}: account ${existing.accountCode ?? '(none)'} -> ${accountCode ?? '(none)'}`,
        'GLGroupCode', String(id), existing.accountCode, accountCode,
      );
      return row;
    });
  }

  async deleteGlGroupCode(id: number, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.gLGroupCode.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('GL group mapping not found');
      await tx.gLGroupCode.delete({ where: { id } });
      await this.record(actor, tx, `GL mapping ${existing.glGroup}/${existing.glCode} deleted`, 'GLGroupCode', String(id));
      return { deleted: true };
    });
  }

  // --- Tax rules -------------------------------------------------------------

  async createTaxRule(dto: TaxRuleBodyDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const id = ((await tx.taxRule.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ?? NATIVE_ID_BASE) + 1;
      const row = await tx.taxRule.create({
        data: {
          id,
          description: dto.description ?? null,
          version: 1,
          context: String(dto.taxNumber),
          itemTaxGroup: dto.itemTaxGroup?.trim() || null,
          entityTaxGroup: dto.entityTaxGroup?.trim() || null,
          rate: dto.rate ?? null,
          amount: dto.amount ?? null,
          taxOnTax: dto.taxOnTax ?? false,
          taxNumber: dto.taxNumber,
        },
      });
      await this.record(actor, tx, `Tax rule '${dto.description ?? id}' (level ${dto.taxNumber}) created`, 'TaxRule', String(id));
      return row;
    });
  }

  async updateTaxRule(id: number, dto: UpdateTaxRuleDto, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.taxRule.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Tax rule not found');
      // Explicit null on @IsOptional() fields skips class-validator — re-assert
      // numeric sanity here (hard convention).
      if (dto.rate != null && (typeof dto.rate !== 'number' || dto.rate < 0)) throw new BadRequestException('Rate must be a non-negative number.');
      if (dto.amount != null && (typeof dto.amount !== 'number' || dto.amount < 0)) throw new BadRequestException('Amount must be a non-negative number.');
      const taxNumber = dto.taxNumber ?? existing.taxNumber;
      const row = await tx.taxRule.update({
        where: { id },
        data: {
          description: dto.description !== undefined ? dto.description : existing.description,
          itemTaxGroup: dto.itemTaxGroup !== undefined ? (dto.itemTaxGroup?.trim() || null) : existing.itemTaxGroup,
          entityTaxGroup: dto.entityTaxGroup !== undefined ? (dto.entityTaxGroup?.trim() || null) : existing.entityTaxGroup,
          rate: dto.rate !== undefined ? dto.rate : existing.rate,
          amount: dto.amount !== undefined ? dto.amount : existing.amount,
          // Explicit null (skips @IsBoolean) must not NULL a boolean mirror
          // column — treat it like "omitted".
          taxOnTax: dto.taxOnTax != null ? dto.taxOnTax : existing.taxOnTax,
          taxNumber,
          context: taxNumber != null ? String(taxNumber) : existing.context,
        },
      });
      await this.record(actor, tx, `Tax rule ${id} updated`, 'TaxRule', String(id));
      return row;
    });
  }

  async deleteTaxRule(id: number, actor: Actor) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.taxRule.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Tax rule not found');
      await tx.taxRule.delete({ where: { id } });
      await this.record(actor, tx, `Tax rule ${id} ('${existing.description ?? ''}') deleted`, 'TaxRule', String(id));
      return { deleted: true };
    });
  }

  // --- helpers ---------------------------------------------------------------

  private record(
    actor: Actor,
    tx: Parameters<AuditService['record']>[1],
    summary: string,
    tableName: string,
    recordId: string,
    oldValue?: string | null,
    newValue?: string | null,
  ) {
    return this.audit.record(
      {
        action: PROGRAM,
        actorUserId: actor.id,
        actorLabel: actor.label,
        program: PROGRAM,
        summary,
        changes: [{ tableName, recordId, fieldName: '*', oldValue: oldValue ?? null, newValue: newValue ?? null }],
      },
      tx,
    );
  }
}
