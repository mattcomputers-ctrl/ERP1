import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Actor } from '../auth/current-user.decorator';
import { NATIVE_ID_ALLOC_LOCK } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import type { RunReplacementDto } from './dto/recipe-replacement.dto';
import { RecipeEditorService } from './recipe-editor.service';

// The legacy CMS "Recipe Replacement" tool (RecipeReplacement/-Ingredient/
// -Recipe, actively used through 2026): swap one ingredient for another across
// every recipe that uses it. ERP1 rebuilds it on the native lifecycle engine —
// per selected recipe: CLONE to the next `.NN` revision, swap the ingredient
// on the clone's UI lines (same quantities), then optionally PUBLISH the clone
// (which deactivates the superseded revision via the single-active rule).
// Each step is the ordinary audited operation; a failure on one recipe is
// recorded per-row and the job continues (mirroring the legacy Status/Error
// columns). A failed/unpublished clone is left as a harmless, deletable draft.

@Injectable()
export class RecipeReplacementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly editor: RecipeEditorService,
  ) {}

  /**
   * The recipes a replacement would touch: ACTIVE PUBLISHED production
   * recipes with at least one active ingredient (UI) line using the item.
   */
  async preview(fromItemId: number) {
    const from = await this.prisma.item.findUnique({
      where: { id: fromItemId },
      select: { id: true, itemCode: true, description: true },
    });
    if (!from) throw new NotFoundException('Ingredient item not found');

    const uses = await this.prisma.recipeDetail.findMany({
      where: { context: 'UI', itemId: fromItemId, NOT: { inactive: true }, recipeId: { not: null } },
      select: { recipeId: true, qtyReqd: true },
    });
    const qtyByRecipe = new Map<number, number>();
    for (const u of uses) {
      if (u.recipeId == null) continue;
      qtyByRecipe.set(u.recipeId, (qtyByRecipe.get(u.recipeId) ?? 0) + (u.qtyReqd ?? 0));
    }
    if (!qtyByRecipe.size) return { from, rows: [] };

    const recipes = await this.prisma.recipe.findMany({
      where: {
        id: { in: [...qtyByRecipe.keys()] },
        context: { in: ['RMBA', 'RMPP'] },
        isPublished: true,
        NOT: { inactive: true },
      },
      orderBy: { recipeNumber: 'asc' },
      select: { id: true, recipeNumber: true, context: true, comment: true },
    });

    // Decorate with the produced item so the operator can sanity-check scope.
    const pkLines = recipes.length
      ? await this.prisma.recipeDetail.findMany({
          where: { recipeId: { in: recipes.map((r) => r.id) }, context: 'PK' },
          select: { recipeId: true, itemId: true },
        })
      : [];
    const productByRecipe = new Map(pkLines.map((l) => [l.recipeId, l.itemId]));
    const productIds = [...new Set(pkLines.map((l) => l.itemId).filter((v): v is number => v != null))];
    const products = productIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: productIds } }, select: { id: true, itemCode: true } })
      : [];
    const codeById = new Map(products.map((p) => [p.id, p.itemCode]));

    return {
      from,
      rows: recipes.map((r) => ({
        recipeId: r.id,
        recipeNumber: r.recipeNumber,
        context: r.context,
        comment: r.comment,
        productCode: (() => {
          const pid = productByRecipe.get(r.id);
          return pid != null ? (codeById.get(pid) ?? null) : null;
        })(),
        qtyPerUnit: qtyByRecipe.get(r.id) ?? 0,
      })),
    };
  }

  /**
   * Run a replacement job over the selected recipes. Per recipe:
   * clone → swap → (optionally) publish; failures are recorded per row and
   * the job continues. Returns the per-recipe outcome list.
   */
  async run(dto: RunReplacementDto, actor: Actor) {
    if (dto.fromItemId === dto.toItemId) {
      throw new BadRequestException('The replacement ingredient must differ from the one being replaced.');
    }
    const [from, to] = await Promise.all([
      this.prisma.item.findUnique({ where: { id: dto.fromItemId }, select: { id: true, itemCode: true } }),
      this.prisma.item.findUnique({ where: { id: dto.toItemId }, select: { id: true, itemCode: true } }),
    ]);
    if (!from) throw new BadRequestException(`Ingredient item #${dto.fromItemId} does not exist.`);
    if (!to) throw new BadRequestException(`Replacement item #${dto.toItemId} does not exist.`);
    const recipeIds = [...new Set(dto.recipeIds)];
    if (!recipeIds.length) throw new BadRequestException('Select at least one recipe.');
    const description = dto.description?.trim() || `${from.itemCode} to ${to.itemCode}`;

    // Publishing requires the recipe.publish gate — surface a clear error for
    // the whole job up front rather than 30 identical per-row failures.
    if (dto.publish) {
      const req = await this.editor.publishRequirement(actor.id);
      if (!req.allowed) {
        throw new BadRequestException('Your group is not permitted to publish recipes; run without publish or ask a publisher.');
      }
      if (req.requireReason && !dto.reason?.trim() && !description) {
        throw new BadRequestException('A reason is required to publish the new revisions.');
      }
      if (req.requireSignature && !dto.password) {
        throw new BadRequestException('Your password is required to publish the new revisions.');
      }
    }

    const results: {
      recipeId: number;
      recipeNumber: string | null;
      newRecipeId: number | null;
      newRecipeNumber: string | null;
      published: boolean;
      replacedLines: number;
      error: string | null;
    }[] = [];

    for (const recipeId of recipeIds) {
      const recipe = await this.prisma.recipe.findUnique({
        where: { id: recipeId },
        select: { id: true, recipeNumber: true, context: true, isPublished: true, inactive: true },
      });
      const row = {
        recipeId,
        recipeNumber: recipe?.recipeNumber ?? null,
        newRecipeId: null as number | null,
        newRecipeNumber: null as string | null,
        published: false,
        replacedLines: 0,
        error: null as string | null,
      };
      results.push(row);
      try {
        if (!recipe) throw new BadRequestException('Recipe not found.');
        if (recipe.isPublished !== true || recipe.inactive === true) {
          throw new BadRequestException('Only active published recipes can be revised by a replacement.');
        }
        const usesFrom = await this.prisma.recipeDetail.count({
          where: { recipeId, context: 'UI', itemId: dto.fromItemId, NOT: { inactive: true } },
        });
        if (!usesFrom) throw new BadRequestException(`Does not use ${from.itemCode}.`);

        // 1. Clone to the next .NN revision (audited by the editor).
        const clone = await this.editor.clone(recipeId, { comment: description }, actor);
        row.newRecipeId = clone.id;
        row.newRecipeNumber = clone.recipeNumber;

        // 2. Swap the ingredient on the clone (draft-only, its own audited tx).
        row.replacedLines = await this.swapIngredient(clone.id, clone.recipeNumber, dto.fromItemId, dto.toItemId, from.itemCode ?? String(from.id), to.itemCode ?? String(to.id), actor);

        // 3. Optionally publish (deactivates the source via single-active).
        if (dto.publish) {
          await this.editor.publish(
            clone.id,
            {
              reason: dto.reason?.trim() || description,
              password: dto.password,
              witnessEmail: dto.witnessEmail,
              witnessPassword: dto.witnessPassword,
              witnessExplanation: dto.witnessExplanation,
            },
            actor,
          );
          row.published = true;
        }
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
    }

    const ok = results.filter((r) => !r.error).length;
    await this.audit.record({
      action: 'recipe.replacement',
      actorUserId: actor.id,
      actorLabel: actor.label,
      program: 'recipe.editor',
      summary:
        `Ingredient replacement ${from.itemCode} → ${to.itemCode} (“${description}”): ` +
        `${ok}/${results.length} recipes revised${dto.publish ? ' and published' : ' as drafts'}` +
        (ok < results.length ? `, ${results.length - ok} failed` : ''),
      changes: results.map((r) => ({
        tableName: 'Recipe',
        recordId: String(r.recipeId),
        fieldName: r.error ? 'replacementFailed' : 'replacedBy',
        oldValue: r.recipeNumber,
        newValue: r.error ?? r.newRecipeNumber,
      })),
    });

    return { from, to, description, results };
  }

  /** Swap every active UI line's item From→To on a DRAFT recipe (one audited
   * transaction; quantities preserved). Returns the number of lines changed. */
  private async swapIngredient(
    recipeId: number,
    recipeNumber: string | null,
    fromItemId: number,
    toItemId: number,
    fromCode: string,
    toCode: string,
    actor: Actor,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_ID_ALLOC_LOCK})`;
      const recipe = await tx.recipe.findUnique({ where: { id: recipeId }, select: { isPublished: true, version: true } });
      if (!recipe) throw new NotFoundException('Clone vanished during replacement.');
      if (recipe.isPublished) throw new BadRequestException('The clone was published mid-replacement.');
      const lines = await tx.recipeDetail.findMany({
        where: { recipeId, context: 'UI', itemId: fromItemId, NOT: { inactive: true } },
        select: { id: true },
      });
      if (!lines.length) throw new BadRequestException(`Clone has no active ${fromCode} lines.`);
      await tx.recipeDetail.updateMany({
        where: { id: { in: lines.map((l) => l.id) } },
        data: { itemId: toItemId },
      });
      await tx.recipe.update({
        where: { id: recipeId },
        data: { version: (recipe.version ?? 1) + 1, dateUpdated: new Date() },
      });
      await this.audit.record(
        {
          action: 'recipe.replaceIngredient',
          actorUserId: actor.id,
          actorLabel: actor.label,
          program: 'recipe.editor',
          summary: `Draft ${recipeNumber ?? recipeId}: replaced ${fromCode} with ${toCode} on ${lines.length} line${lines.length === 1 ? '' : 's'}`,
          changes: lines.map((l) => ({
            tableName: 'RecipeDetail',
            recordId: String(l.id),
            fieldName: 'Item',
            oldValue: String(fromItemId),
            newValue: String(toItemId),
          })),
        },
        tx,
      );
      return lines.length;
    });
  }
}
