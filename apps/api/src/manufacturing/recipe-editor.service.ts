import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@erp1/db';
import { AuditService, type FieldChange } from '../audit/audit.service';
import { ESignatureService } from '../audit/esignature.service';
import { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/current-user.decorator';
import { PermissionService } from '../auth/permission.service';
import { NATIVE_ID_ALLOC_LOCK, NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import {
  CloneRecipeDto, CreateRecipeDto, PublishRecipeDto,
  SaveProcedureDto, SetRecipeActiveDto, UpdateRecipeHeaderDto,
} from './dto/recipe-editor.dto';

// Legacy structural conventions, copied from the live data (see
// docs/ASSUMPTIONS.md "Recipe management"): batching recipes are a BA root
// (Phase 'PHASE', BatchType '2') holding ingredient/instruction lines in
// ExecOrder with the product as a PK child; packaging recipes are a flat PK
// root with UI component children. Quantities are stored per 1 lb of product;
// TotalWeight 0.45359237 is that 1 lb expressed in kg (the full conversion
// factor — matches every live BA/PK structural row).
const BATCHING = 'RMBA';
const PACKAGING = 'RMPP';
const LB_IN_KG = 0.45359237;
const ROOT_PHASE = 'PHASE';
const BA_BATCH_TYPE = '2';

// Secured item governing recipe publication — its response level (reason /
// signature / witness) AND per-group perform/witness grants are seeded and
// operator-configurable.
const PUBLISH_SECURED_ITEM = 'recipe.publish';

// The two line contexts the procedure editor manages; everything else on an
// imported draft (BA/PK/UB/IPT/FMT/...) is preserved untouched.
const EDITABLE_LINE_CONTEXTS = new Set(['UI', 'INSTR']);

const typeLabel = (context: string) => (context === BATCHING ? 'batching' : 'packaging');

// Quantities are doubles that round-trip through the UI at a fixed display
// precision — treat within-relative-epsilon values as unchanged so re-saving
// an untouched line doesn't churn the stored value or pollute the audit trail.
const qtyChanged = (before: number | null, next: number | null) => {
  if (before == null || next == null) return before !== next;
  return Math.abs(before - next) > 1e-9 * Math.max(1, Math.abs(before));
};

// Every mutation in this service serializes on the SHARED advisory lock (the
// same key all native-id allocators use) and re-reads recipe state INSIDE the
// locked transaction. That one lock is what makes the lifecycle invariants
// hold under concurrency: published recipes are immutable, at most one active
// published recipe per product+context (single-active rule), no double
// publish, no delete racing a publish. Pre-transaction reads are fast-fail UX
// only — never authoritative.

@Injectable()
export class RecipeEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly esign: ESignatureService,
    private readonly auth: AuthService,
    private readonly permissions: PermissionService,
  ) {}

  // --- create / clone ------------------------------------------------------

  /**
   * Create a draft recipe: header + the structural lines (BA root + PK product
   * for batching; PK root for packaging). Born unpublished; the procedure is
   * authored via saveProcedure and the recipe becomes orderable only at
   * publish. Native ids (≥ NATIVE_ID_BASE) so a legacy re-import can't clobber
   * it; number uniqueness is checked under the id-allocation lock so two
   * concurrent creates can't both claim the same number.
   */
  async create(dto: CreateRecipeDto, actor: Actor) {
    const recipeNumber = dto.recipeNumber.trim();
    if (!recipeNumber) throw new BadRequestException('A recipe number is required.');
    const comment = dto.comment.trim();
    if (!comment) throw new BadRequestException('A recipe comment is required.');

    const product = await this.prisma.item.findUnique({
      where: { id: dto.productItemId },
      select: { id: true, itemCode: true },
    });
    if (!product) throw new BadRequestException(`Product item #${dto.productItemId} does not exist.`);

    // Data-driven default owner (our org): the modal Owner across recipes.
    const ownerId = await this.defaultOwner();
    const isBatch = dto.context === BATCHING;
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      await this.assertNumberFree(tx, recipeNumber);

      const recipeId = (await this.maxNativeId(tx, 'recipe')) + 1;
      let rdId = await this.maxNativeId(tx, 'recipeDetail');

      await tx.recipe.create({
        data: {
          id: recipeId,
          ownerId,
          recipeNumber,
          version: 1,
          comment,
          context: dto.context,
          isPublished: false,
          inactive: false,
          imported: false,
          formulaOnly: false,
          // Matches the live convention — no legacy recipe is Shared.
          shared: false,
          rework: dto.rework ?? false,
          weightUnit: dto.weightUnit ?? 'lb',
          volumeUnit: dto.volumeUnit ?? 'gal',
          leadTime: dto.leadTime ?? null,
          reference: dto.reference ?? null,
          placedBy: actor.label ?? null,
          dateCreated: at,
          dateUpdated: at,
        },
      });

      // inactive is written as an explicit false (not left NULL): the line
      // queries here and in order creation filter `NOT { inactive: true }`,
      // and a NULL is excluded by that predicate in Postgres.
      if (isBatch) {
        const baId = (rdId += 1);
        await tx.recipeDetail.createMany({
          data: [
            {
              id: baId, recipeId, ownerId, context: 'BA', phase: ROOT_PHASE, execOrder: 1,
              batchType: BA_BATCH_TYPE, totalWeight: LB_IN_KG, mustPreweigh: 0, inactive: false,
            },
            {
              id: (rdId += 1), recipeId, ownerId, context: 'PK', parentId: baId,
              itemId: product.id, qtyReqd: 1.0, totalWeight: LB_IN_KG,
              totalWeightPercent: 100, mustPreweigh: 0, inactive: false,
            },
          ],
        });
      } else {
        await tx.recipeDetail.create({
          data: {
            id: (rdId += 1), recipeId, ownerId, context: 'PK',
            itemId: product.id, qtyReqd: 1.0, mustPreweigh: 0, inactive: false,
          },
        });
      }

      await this.audit.record(
        {
          action: 'recipe.create',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary: `Draft ${typeLabel(dto.context)} recipe ${recipeNumber} created (product ${product.itemCode})`,
          changes: [
            { tableName: 'Recipe', recordId: String(recipeId), fieldName: 'RecipeNumber', oldValue: null, newValue: recipeNumber },
            { tableName: 'Recipe', recordId: String(recipeId), fieldName: 'Context', oldValue: null, newValue: dto.context },
            { tableName: 'Recipe', recordId: String(recipeId), fieldName: 'IsPublished', oldValue: null, newValue: 'false' },
          ],
        },
        tx,
      );

      return { id: recipeId, recipeNumber, context: dto.context, isPublished: false };
    });
  }

  /**
   * Clone a recipe into a new unpublished version — the ONLY way to revise a
   * published recipe (published rows are immutable). The new number defaults to
   * the legacy convention `BASE.NN` (VersionSeparator '.', 2-digit sequence;
   * grows past .99 instead of failing); every line is copied verbatim
   * (including structural/UB lines, preserving the Parent tree via an id map).
   */
  async clone(id: number, dto: CloneRecipeDto, actor: Actor) {
    const source = await this.requireRecipe(id);
    if (source.context !== BATCHING && source.context !== PACKAGING) {
      throw new BadRequestException('Only batching (RMBA) and packaging (RMPP) recipes can be cloned.');
    }
    const explicit = dto.recipeNumber?.trim();
    const comment = dto.comment?.trim() || source.comment;
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;

      const recipeNumber = explicit ?? (await this.nextVersionNumber(tx, source.recipeNumber ?? ''));
      await this.assertNumberFree(tx, recipeNumber);

      const recipeId = (await this.maxNativeId(tx, 'recipe')) + 1;
      let rdId = await this.maxNativeId(tx, 'recipeDetail');

      await tx.recipe.create({
        data: {
          id: recipeId,
          ownerId: source.ownerId,
          recipeNumber,
          version: 1,
          comment,
          context: source.context,
          isPublished: false,
          inactive: false,
          imported: false,
          formulaOnly: source.formulaOnly ?? false,
          shared: source.shared ?? false,
          rework: source.rework ?? false,
          weightUnit: source.weightUnit,
          volumeUnit: source.volumeUnit,
          leadTime: source.leadTime,
          reference: source.reference,
          billToId: source.billToId,
          securityGroup: source.securityGroup,
          mergedNumber: source.mergedNumber,
          placedBy: actor.label ?? null,
          dateCreated: at,
          dateUpdated: at,
        },
      });

      const lines = await tx.recipeDetail.findMany({
        where: { recipeId: id },
        orderBy: { id: 'asc' },
      });
      const newIdByOld = new Map<number, number>();
      for (const l of lines) newIdByOld.set(l.id, (rdId += 1));
      if (lines.length) {
        await tx.recipeDetail.createMany({
          data: lines.map((l) => ({
            ...l,
            id: newIdByOld.get(l.id)!,
            recipeId,
            parentId: l.parentId != null ? (newIdByOld.get(l.parentId) ?? null) : null,
          })),
        });
      }

      await this.audit.record(
        {
          action: 'recipe.clone',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary: `Recipe ${source.recipeNumber} cloned to draft ${recipeNumber} (${lines.length} lines)`,
          changes: [
            { tableName: 'Recipe', recordId: String(recipeId), fieldName: 'RecipeNumber', oldValue: null, newValue: recipeNumber },
            { tableName: 'Recipe', recordId: String(recipeId), fieldName: 'ClonedFrom', oldValue: null, newValue: source.recipeNumber },
          ],
        },
        tx,
      );

      return { id: recipeId, recipeNumber, clonedFrom: source.recipeNumber, lines: lines.length };
    });
  }

  // --- draft editing -------------------------------------------------------

  /** Update a draft's header fields (published recipes are immutable). */
  async updateHeader(id: number, dto: UpdateRecipeHeaderDto, actor: Actor) {
    const recipe = await this.requireDraft(id); // fast-fail; re-asserted in the tx
    const changes: FieldChange[] = [];
    const data: Record<string, unknown> = {};
    const set = (field: string, key: keyof typeof recipe, next: unknown) => {
      if (next === undefined) return;
      const norm = typeof next === 'string' ? next.trim() || null : next;
      if (norm === recipe[key]) return;
      data[key as string] = norm;
      changes.push({
        tableName: 'Recipe', recordId: String(id), fieldName: field,
        oldValue: recipe[key] == null ? null : String(recipe[key]),
        newValue: norm == null ? null : String(norm),
      });
    };

    let newNumber: string | undefined;
    if (dto.recipeNumber !== undefined) {
      newNumber = dto.recipeNumber.trim();
      if (!newNumber) throw new BadRequestException('The recipe number cannot be blank.');
      if (newNumber !== recipe.recipeNumber) {
        set('RecipeNumber', 'recipeNumber', newNumber);
      }
    }
    if (dto.comment !== undefined && !dto.comment.trim()) {
      throw new BadRequestException('The recipe comment cannot be blank.');
    }
    set('Comment', 'comment', dto.comment);
    set('Reference', 'reference', dto.reference);
    set('LeadTime', 'leadTime', dto.leadTime);
    set('WeightUnit', 'weightUnit', dto.weightUnit);
    set('VolumeUnit', 'volumeUnit', dto.volumeUnit);
    set('Rework', 'rework', dto.rework);

    // Re-pointing the product rewrites the PK line's item.
    let pk: { id: number; itemId: number | null } | null = null;
    if (dto.productItemId !== undefined) {
      pk = await this.productLine(id);
      if (!pk) throw new BadRequestException('This recipe has no product (PK) line to re-point.');
      if (pk.itemId !== dto.productItemId) {
        const item = await this.prisma.item.findUnique({ where: { id: dto.productItemId }, select: { id: true } });
        if (!item) throw new BadRequestException(`Product item #${dto.productItemId} does not exist.`);
        changes.push({
          tableName: 'RecipeDetail', recordId: String(pk.id), fieldName: 'Item',
          oldValue: pk.itemId == null ? null : String(pk.itemId), newValue: String(dto.productItemId),
        });
      } else {
        pk = null; // unchanged — nothing to write
      }
    }

    if (!changes.length) return { id, unchanged: true };
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Re-assert draft state under the lock; the version check makes the
      // pre-computed diff sound (version bumps on every edit, so equality
      // proves the snapshot is still current).
      const fresh = await tx.recipe.findUnique({ where: { id }, select: { isPublished: true, version: true } });
      if (!fresh) throw new NotFoundException('Recipe not found');
      if (fresh.isPublished) {
        throw new BadRequestException(`Recipe ${recipe.recipeNumber} is published and immutable — clone it to make a new version.`);
      }
      if (fresh.version !== recipe.version) {
        throw new BadRequestException('The recipe was changed by someone else — reload and retry.');
      }
      if (data.recipeNumber !== undefined) {
        await this.assertNumberFree(tx, data.recipeNumber as string, id);
      }
      await tx.recipe.update({
        where: { id },
        data: { ...data, version: (recipe.version ?? 1) + 1, dateUpdated: at },
      });
      if (pk && dto.productItemId !== undefined) {
        await tx.recipeDetail.update({ where: { id: pk.id }, data: { itemId: dto.productItemId } });
      }
      await this.audit.record(
        {
          action: 'recipe.updateHeader',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary: `Draft recipe ${newNumber ?? recipe.recipeNumber} header updated (${changes.length} field${changes.length === 1 ? '' : 's'})`,
          changes,
        },
        tx,
      );
      return { id, changed: changes.length };
    });
  }

  /**
   * Replace a draft's procedure — the ordered ingredient/instruction lines.
   * Quantities arrive at the payload's formula basis and are normalized to the
   * legacy per-1-lb convention (qty ÷ basis). Existing lines (matched by id)
   * are updated in place, new lines get native ids, omitted lines are deleted;
   * structural lines (BA root, PK product, UB, and any imported extras) are
   * preserved untouched. ExecOrder renumbers 2..N+1 under the BA root for
   * batching (the root is 1), 1..N for packaging; ingredient lines are also
   * numbered Line 1..k in material order. (Live RMPP rows carry NULL
   * ExecOrder/Line — native numbering is a deliberate, documented extension
   * for deterministic ordering; see docs/ASSUMPTIONS.md.)
   */
  async saveProcedure(id: number, dto: SaveProcedureDto, actor: Actor) {
    const recipePre = await this.requireDraft(id); // fast-fail; re-asserted in the tx
    const isBatch = recipePre.context === BATCHING;
    const basis = dto.basis ?? 1;

    // Validate payload lines up front (kind-specific requirements + items exist).
    const itemIds = new Set<number>();
    for (const [i, l] of dto.lines.entries()) {
      if (l.kind === 'ingredient') {
        if (l.itemId == null) throw new BadRequestException(`Line ${i + 1}: an ingredient needs an item.`);
        if (l.qty == null || !Number.isFinite(l.qty) || l.qty <= 0) {
          throw new BadRequestException(`Line ${i + 1}: an ingredient needs a quantity greater than zero.`);
        }
        itemIds.add(l.itemId);
      } else if (!l.description?.trim()) {
        throw new BadRequestException(`Line ${i + 1}: an instruction needs text.`);
      }
    }
    const items = itemIds.size
      ? await this.prisma.item.findMany({ where: { id: { in: [...itemIds] } }, select: { id: true, itemCode: true } })
      : [];
    const itemById = new Map(items.map((it) => [it.id, it]));
    for (const iid of itemIds) {
      if (!itemById.has(iid)) throw new BadRequestException(`Ingredient item #${iid} does not exist.`);
    }
    const seenIds = new Set<number>();
    for (const l of dto.lines) {
      if (l.id == null) continue;
      if (seenIds.has(l.id)) throw new BadRequestException(`Line id ${l.id} appears twice in the payload.`);
      seenIds.add(l.id);
    }

    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      // Authoritative state reads under the lock: draft-ness AND the existing
      // line set (two concurrent saves would otherwise merge partially).
      const recipe = await tx.recipe.findUnique({ where: { id } });
      if (!recipe) throw new NotFoundException('Recipe not found');
      if (recipe.isPublished) {
        throw new BadRequestException(`Recipe ${recipe.recipeNumber} is published and immutable — clone it to make a new version.`);
      }

      const existing = await tx.recipeDetail.findMany({
        where: { recipeId: id },
        select: {
          id: true, context: true, itemId: true, qtyReqd: true, description: true,
          execOrder: true, line: true, parentId: true,
        },
      });
      const editable = new Map(existing.filter((l) => EDITABLE_LINE_CONTEXTS.has(l.context ?? '')).map((l) => [l.id, l]));
      const baLine = existing.find((l) => l.context === 'BA') ?? null;
      const pkLine = existing.find((l) => l.context === 'PK') ?? null;
      if (isBatch && !baLine) throw new BadRequestException('This batching recipe has no BA root line; cannot edit its procedure.');
      if (!isBatch && !pkLine) throw new BadRequestException('This packaging recipe has no PK root line; cannot edit its procedure.');
      const parentId = isBatch ? baLine!.id : pkLine!.id;

      // IDOR + kind-change checks against the locked snapshot.
      for (const l of dto.lines) {
        if (l.id == null) continue;
        const row = editable.get(l.id);
        if (!row) throw new BadRequestException(`Line ${l.id} is not an editable procedure line of this recipe.`);
        const rowKind = row.context === 'UI' ? 'ingredient' : 'instruction';
        if (rowKind !== l.kind) {
          throw new BadRequestException(
            `Line ${l.id} is an ${rowKind}; delete it and add a new line instead of changing its kind.`,
          );
        }
      }
      const removedIds = [...editable.keys()].filter((eid) => !seenIds.has(eid));

      let rdId = await this.maxNativeId(tx, 'recipeDetail');
      const changes: FieldChange[] = [];
      let execOrder = isBatch ? 1 : 0; // BA root occupies ExecOrder 1
      let materialLine = 0;
      let added = 0;
      let updated = 0;

      for (const l of dto.lines) {
        execOrder += 1;
        const isIngredient = l.kind === 'ingredient';
        const lineNo = isIngredient ? (materialLine += 1) : null;
        const qtyPerUnit = isIngredient ? l.qty! / basis : null;
        const description = l.description?.trim() || null;

        if (l.id != null) {
          const row = editable.get(l.id)!;
          const data: Record<string, unknown> = {};
          if (isIngredient) {
            if (row.itemId !== l.itemId) {
              data.itemId = l.itemId;
              changes.push({
                tableName: 'RecipeDetail', recordId: String(l.id), fieldName: 'Item',
                oldValue: row.itemId == null ? null : String(row.itemId), newValue: String(l.itemId),
              });
            }
            // Within-epsilon quantities are display-precision round-trips of
            // the stored value — keep the stored value, record no change.
            if (qtyChanged(row.qtyReqd, qtyPerUnit)) {
              data.qtyReqd = qtyPerUnit;
              changes.push({
                tableName: 'RecipeDetail', recordId: String(l.id), fieldName: 'QtyReqd',
                oldValue: row.qtyReqd == null ? null : String(row.qtyReqd), newValue: String(qtyPerUnit),
              });
            }
          }
          if (row.description !== description) {
            data.description = description;
            changes.push({
              tableName: 'RecipeDetail', recordId: String(l.id), fieldName: 'Description',
              oldValue: row.description, newValue: description,
            });
          }
          if (Object.keys(data).length) updated += 1;
          // Position always resyncs (cheap, keeps ordering canonical).
          await tx.recipeDetail.update({
            where: { id: l.id },
            data: { ...data, execOrder, line: lineNo == null ? null : BigInt(lineNo), parentId },
          });
        } else {
          added += 1;
          const newId = (rdId += 1);
          await tx.recipeDetail.create({
            data: {
              id: newId, recipeId: id, ownerId: recipe.ownerId, parentId,
              context: isIngredient ? 'UI' : 'INSTR',
              itemId: isIngredient ? l.itemId : null,
              qtyReqd: qtyPerUnit,
              description, execOrder, line: lineNo == null ? null : BigInt(lineNo), mustPreweigh: 0,
              // Explicit false — NULL would be dropped by `NOT { inactive: true }` filters.
              inactive: false,
            },
          });
          changes.push({
            tableName: 'RecipeDetail', recordId: String(newId), fieldName: 'added',
            oldValue: null,
            newValue: isIngredient
              ? `${itemById.get(l.itemId!)?.itemCode ?? l.itemId} × ${qtyPerUnit}`
              : `INSTR: ${description}`,
          });
        }
      }

      if (removedIds.length) {
        for (const rid of removedIds) {
          const row = editable.get(rid)!;
          changes.push({
            tableName: 'RecipeDetail', recordId: String(rid), fieldName: 'removed',
            oldValue: row.context === 'UI' ? `item ${row.itemId} × ${row.qtyReqd}` : `INSTR: ${row.description}`,
            newValue: null,
          });
        }
        await tx.recipeDetail.deleteMany({ where: { id: { in: removedIds } } });
      }

      await tx.recipe.update({
        where: { id },
        data: { version: (recipe.version ?? 1) + 1, dateUpdated: at },
      });

      await this.audit.record(
        {
          action: 'recipe.saveProcedure',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary:
            `Draft recipe ${recipe.recipeNumber} procedure saved — ` +
            `${added} added, ${updated} updated, ${removedIds.length} removed (${dto.lines.length} lines)`,
          changes,
        },
        tx,
      );

      return { id, lines: dto.lines.length, added, updated, removed: removedIds.length };
    });
  }

  /** Delete an UNPUBLISHED recipe outright (vendor 7.18 parity). */
  async remove(id: number, actor: Actor) {
    await this.requireDraft(id); // fast-fail; re-asserted in the tx

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { recipeNumber: true, isPublished: true } });
      if (!recipe) throw new NotFoundException('Recipe not found');
      if (recipe.isPublished) {
        throw new BadRequestException(`Recipe ${recipe.recipeNumber} is published and immutable — it cannot be deleted.`);
      }
      const orders = await tx.ordr.count({ where: { recipeId: id } });
      if (orders) throw new BadRequestException('This recipe is referenced by orders and cannot be deleted.');

      const { count } = await tx.recipeDetail.deleteMany({ where: { recipeId: id } });
      await tx.recipe.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'recipe.delete',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary: `Draft recipe ${recipe.recipeNumber} deleted (${count} lines)`,
          changes: [
            { tableName: 'Recipe', recordId: String(id), fieldName: 'removed', oldValue: recipe.recipeNumber, newValue: null },
          ],
        },
        tx,
      );
      return { id, removed: true };
    });
  }

  // --- lifecycle: publish / activate / deactivate --------------------------

  /** The effective response requirements for publishing (fail-safe: a missing
   * or disabled secured item never silently drops the control), plus whether
   * the actor's groups hold the PERFORM grant at all. */
  async publishRequirement(actorId: string) {
    const item = await this.permissions.resolveSecuredItem(actorId, PUBLISH_SECURED_ITEM);
    const requireWitness = item.requireWitness;
    return {
      allowed: item.allowed,
      requireReason: !item.exists || item.requireReason,
      requireSignature: !item.exists || item.requireSignature || requireWitness,
      requireWitness,
    };
  }

  /**
   * Publish a draft — the controlled event that makes a recipe orderable.
   * Verify runs first (vendor: publish auto-verifies): a product line, at
   * least one ingredient, complete ingredient lines, and the required revision
   * comment. Publishing enforces the single-active-recipe rule (this install's
   * legacy config): other active published recipes producing the same item in
   * the same context are deactivated in the same transaction — rework recipes
   * are exempt from BOTH sides of that rule (vendor 7.21). Gated by the
   * operator-configurable `recipe.publish` secured item (perform grant +
   * reason / e-signature / witness); published recipes are immutable
   * thereafter. State is re-read and re-verified under the shared advisory
   * lock so concurrent publishes can neither double-publish nor leave two
   * active recipes.
   */
  async publish(id: number, dto: PublishRecipeDto, actor: Actor) {
    // Fast-fail reads (good errors before the slow Argon2 verify); all state
    // checks re-run authoritatively inside the locked transaction.
    const pre = await this.requireRecipe(id);
    if (pre.isPublished) throw new BadRequestException(`Recipe ${pre.recipeNumber} is already published.`);
    if (pre.context !== BATCHING && pre.context !== PACKAGING) {
      throw new BadRequestException('Only batching (RMBA) and packaging (RMPP) recipes can be published.');
    }
    const preErrors = await this.verify(id, pre);
    if (preErrors.length) {
      throw new BadRequestException(`Recipe failed verification: ${preErrors.join(' ')}`);
    }

    const req = await this.publishRequirement(actor.id);
    if (!req.allowed) {
      throw new ForbiddenException('Your group is not permitted to publish recipes (recipe.publish secured item).');
    }
    if (req.requireReason && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required to publish this recipe.');
    }
    const witness = await this.verifySignature(req, dto, actor, 'publish this recipe');
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const recipe = await tx.recipe.findUnique({ where: { id } });
      if (!recipe) throw new NotFoundException('Recipe not found');
      if (recipe.isPublished) throw new BadRequestException(`Recipe ${recipe.recipeNumber} is already published.`);
      const errors = await this.verify(id, recipe, tx);
      if (errors.length) {
        throw new BadRequestException(`Recipe failed verification: ${errors.join(' ')}`);
      }
      const pk = await this.productLine(id, tx);
      const siblings = recipe.rework
        ? [] // rework recipes never deactivate the main recipe
        : await this.activeSiblings(id, recipe.context, pk?.itemId ?? null, tx);

      await tx.recipe.update({
        where: { id },
        data: { isPublished: true, inactive: false, datePublished: at, dateUpdated: at },
      });
      for (const s of siblings) {
        await tx.recipe.update({ where: { id: s.id }, data: { inactive: true, dateUpdated: at } });
      }

      const changes: FieldChange[] = [
        { tableName: 'Recipe', recordId: String(id), fieldName: 'IsPublished', oldValue: 'false', newValue: 'true' },
        { tableName: 'Recipe', recordId: String(id), fieldName: 'DatePublished', oldValue: null, newValue: at.toISOString() },
        ...siblings.map((s) => ({
          tableName: 'Recipe', recordId: String(s.id), fieldName: 'Inactive', oldValue: 'false', newValue: 'true',
        })),
      ];
      const auditLog = await this.audit.record(
        {
          action: 'recipe.publish',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary:
            `Recipe ${recipe.recipeNumber} published${dto.reason ? ` — ${dto.reason.trim()}` : ''}` +
            (siblings.length ? ` (deactivated ${siblings.map((s) => s.recipeNumber).join(', ')})` : '') +
            (witness ? ` (witnessed by ${witness.label})` : ''),
          changes,
        },
        tx,
      );

      if (req.requireSignature) {
        await this.esign.sign(
          {
            securedItemKey: PUBLISH_SECURED_ITEM,
            meaning: 'Recipe publication',
            userId: actor.id,
            userLabel: actor.label ?? actor.id,
            userExplanation: dto.reason?.trim() || null,
            witnessUserId: witness?.id ?? null,
            witnessLabel: witness?.label ?? null,
            witnessExplanation: witness ? (dto.witnessExplanation?.trim() || null) : null,
            masterTable: 'Recipe',
            masterId: String(id),
            auditLogId: auditLog.id,
          },
          tx,
        );
      }

      return {
        id,
        recipeNumber: recipe.recipeNumber,
        published: true,
        deactivated: siblings.map((s) => s.recipeNumber),
      };
    });
  }

  /**
   * Toggle a PUBLISHED recipe between Active and Inactive (the vendor Mode
   * button). Re-activating a non-rework recipe deactivates the currently
   * active sibling(s) atomically, preserving the single-active-recipe rule;
   * the whole decision runs under the shared advisory lock.
   */
  async setActive(id: number, dto: SetRecipeActiveDto, actor: Actor) {
    const pre = await this.requireRecipe(id); // fast-fail
    if (!pre.isPublished) {
      throw new BadRequestException('Only published recipes can be activated or deactivated.');
    }
    const at = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const recipe = await tx.recipe.findUnique({ where: { id } });
      if (!recipe) throw new NotFoundException('Recipe not found');
      if (!recipe.isPublished) {
        throw new BadRequestException('Only published recipes can be activated or deactivated.');
      }
      const currentlyInactive = recipe.inactive === true;
      if (dto.active !== currentlyInactive) {
        // Already in the requested state.
        return { id, unchanged: true, active: !currentlyInactive };
      }

      const pk = dto.active ? await this.productLine(id, tx) : null;
      const siblings =
        dto.active && !recipe.rework
          ? await this.activeSiblings(id, recipe.context, pk?.itemId ?? null, tx)
          : [];

      await tx.recipe.update({ where: { id }, data: { inactive: !dto.active, dateUpdated: at } });
      for (const s of siblings) {
        await tx.recipe.update({ where: { id: s.id }, data: { inactive: true, dateUpdated: at } });
      }
      await this.audit.record(
        {
          action: dto.active ? 'recipe.activate' : 'recipe.deactivate',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary:
            `Recipe ${recipe.recipeNumber} ${dto.active ? 'activated' : 'deactivated'}` +
            `${dto.reason ? ` — ${dto.reason.trim()}` : ''}` +
            (siblings.length ? ` (deactivated ${siblings.map((s) => s.recipeNumber).join(', ')})` : ''),
          changes: [
            { tableName: 'Recipe', recordId: String(id), fieldName: 'Inactive', oldValue: String(currentlyInactive), newValue: String(!dto.active) },
            ...siblings.map((s) => ({
              tableName: 'Recipe', recordId: String(s.id), fieldName: 'Inactive', oldValue: 'false', newValue: 'true',
            })),
          ],
        },
        tx,
      );
      return { id, active: dto.active, deactivated: siblings.map((s) => s.recipeNumber) };
    });
  }

  // --- helpers -------------------------------------------------------------

  /** Verify checklist (also run standalone via GET /recipes/:id/verify). */
  async verify(
    id: number,
    recipe?: { comment: string | null; context: string | null },
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const r = recipe ?? (await this.requireRecipe(id));
    const errors: string[] = [];
    const lines = await db.recipeDetail.findMany({
      where: { recipeId: id, NOT: { inactive: true } },
      select: { context: true, itemId: true, qtyReqd: true },
    });
    const pk = lines.find((l) => l.context === 'PK');
    if (!pk) errors.push('The recipe has no product (PK) line.');
    else if (pk.itemId == null) errors.push('The product line has no item.');
    else if (!(pk.qtyReqd != null && pk.qtyReqd > 0)) errors.push('The product line has no quantity.');
    const ingredients = lines.filter((l) => l.context === 'UI');
    if (!ingredients.length) errors.push('The recipe has no ingredient lines.');
    const incomplete = ingredients.filter((l) => l.itemId == null || !(l.qtyReqd != null && l.qtyReqd > 0));
    if (incomplete.length) {
      errors.push(`${incomplete.length} ingredient line${incomplete.length === 1 ? ' is' : 's are'} missing an item or a quantity greater than zero.`);
    }
    if (!r.comment?.trim()) errors.push('The recipe comment (revision note) is required.');
    return errors;
  }

  private async requireRecipe(id: number) {
    const recipe = await this.prisma.recipe.findUnique({ where: { id } });
    if (!recipe) throw new NotFoundException('Recipe not found');
    return recipe;
  }

  private async requireDraft(id: number) {
    const recipe = await this.requireRecipe(id);
    if (recipe.isPublished) {
      throw new BadRequestException(
        `Recipe ${recipe.recipeNumber} is published and immutable — clone it to make a new version.`,
      );
    }
    if (recipe.context !== BATCHING && recipe.context !== PACKAGING) {
      throw new BadRequestException('Only batching (RMBA) and packaging (RMPP) recipes are editable.');
    }
    return recipe;
  }

  private async productLine(recipeId: number, db: Prisma.TransactionClient = this.prisma) {
    return db.recipeDetail.findFirst({
      where: { recipeId, context: 'PK' },
      orderBy: { id: 'asc' },
      select: { id: true, itemId: true },
    });
  }

  /** Other ACTIVE PUBLISHED non-rework recipes producing the same item in the
   * same context — the set the single-active rule deactivates. */
  private async activeSiblings(
    id: number,
    context: string | null,
    productItemId: number | null,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    if (productItemId == null || !context) return [];
    const pkRows = await db.recipeDetail.findMany({
      where: { context: 'PK', itemId: productItemId, recipeId: { not: id, gt: 0 } },
      select: { recipeId: true },
    });
    const ids = [...new Set(pkRows.map((r) => r.recipeId).filter((v): v is number => v != null))];
    if (!ids.length) return [];
    return db.recipe.findMany({
      where: {
        id: { in: ids },
        context,
        isPublished: true,
        NOT: [{ inactive: true }, { rework: true }],
      },
      select: { id: true, recipeNumber: true },
    });
  }

  /** Next `BASE.NN` number for a version clone (legacy VersionSeparator '.',
   * VersionLength 2). BASE = the source number minus any existing `.NN`.
   * Case-insensitive scan — uniqueness is case-insensitive too, so a
   * differently-cased sibling must advance the sequence, not block it. */
  private async nextVersionNumber(tx: Prisma.TransactionClient, sourceNumber: string) {
    const source = sourceNumber.trim();
    if (!source) throw new BadRequestException('The source recipe has no number; supply an explicit new number.');
    const base = source.replace(/\.\d+$/, '');
    const family = await tx.recipe.findMany({
      where: { recipeNumber: { startsWith: `${base}.`, mode: 'insensitive' } },
      select: { recipeNumber: true },
    });
    const suffixPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`, 'i');
    let max = 0;
    for (const f of family) {
      const m = f.recipeNumber?.match(suffixPattern);
      if (m) max = Math.max(max, Number.parseInt(m[1], 10));
    }
    const next = `${base}.${String(max + 1).padStart(2, '0')}`;
    if (next.length > 20) {
      throw new BadRequestException(
        `The suggested version number ${next} exceeds 20 characters — supply an explicit new number.`,
      );
    }
    return next;
  }

  /** Case-insensitive number-uniqueness check (run under the id-alloc lock). */
  private async assertNumberFree(tx: Prisma.TransactionClient, recipeNumber: string, exceptId?: number) {
    const clash = await tx.recipe.findFirst({
      where: {
        recipeNumber: { equals: recipeNumber, mode: 'insensitive' },
        ...(exceptId != null ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, recipeNumber: true },
    });
    if (clash) {
      throw new BadRequestException(`Recipe number ${clash.recipeNumber} already exists (recipe #${clash.id}).`);
    }
  }

  private async maxNativeId(tx: Prisma.TransactionClient, table: 'recipe' | 'recipeDetail') {
    if (table === 'recipe') {
      return (
        (await tx.recipe.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
        NATIVE_ID_BASE
      );
    }
    return (
      (await tx.recipeDetail.aggregate({ _max: { id: true }, where: { id: { gte: NATIVE_ID_BASE } } }))._max.id ??
      NATIVE_ID_BASE
    );
  }

  /** Data-driven default Owner for native recipes: the modal Owner across
   * existing recipes (our org in this install); null on an empty database. */
  private async defaultOwner(): Promise<number | null> {
    const grouped = await this.prisma.recipe.groupBy({
      by: ['ownerId'],
      where: { ownerId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { ownerId: 'desc' } },
      take: 1,
    });
    return grouped[0]?.ownerId ?? null;
  }

  /** Verify the actor's signature (and optional witness) before the
   * transaction (Argon2 verify is slow). Returns the witness identity if any. */
  private async verifySignature(
    req: { requireSignature: boolean; requireWitness: boolean },
    dto: { password?: string; witnessEmail?: string; witnessPassword?: string },
    actor: Actor,
    what: string,
  ): Promise<{ id: string; label: string } | null> {
    if (!req.requireSignature) return null;
    if (!dto.password) throw new BadRequestException(`Your password is required to ${what}.`);
    await this.auth.verifyPasswordById(actor.id, dto.password);

    if (req.requireWitness && !dto.witnessEmail) {
      throw new BadRequestException(`A witness signature is required to ${what}.`);
    }
    if (dto.witnessEmail) {
      if (!dto.witnessPassword) throw new BadRequestException('Witness password is required.');
      const w = await this.auth.validateUser(dto.witnessEmail, dto.witnessPassword, false);
      if (w.id === actor.id) throw new BadRequestException('The witness must be a different user.');
      if (!(await this.permissions.canWitness(w.id, PUBLISH_SECURED_ITEM))) {
        throw new ForbiddenException('That user is not permitted to witness recipe publication.');
      }
      return { id: w.id, label: w.displayName };
    }
    return null;
  }
}
