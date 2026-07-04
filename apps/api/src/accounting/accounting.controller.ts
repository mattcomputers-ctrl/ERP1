import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import type { TaxableLine } from './tax.service';
import { AccountingExportService } from './export.service';
import { GlMastersService } from './gl-masters.service';
import { TaxService } from './tax.service';
import { ExportAccountingDto } from './dto/export.dto';
import {
  CreateAccountCodeDto,
  CreateGlCodeDto,
  CreateGlGroupCodeDto,
  CreateGlGroupDto,
  TaxPreviewDto,
  TaxRuleBodyDto,
  UpdateDescriptionDto,
  UpdateGlGroupCodeDto,
  UpdateTaxRuleDto,
} from './dto/masters.dto';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('accounting.config')
@Controller('accounting')
export class AccountingController {
  constructor(
    private readonly masters: GlMastersService,
    private readonly tax: TaxService,
    private readonly exporter: AccountingExportService,
  ) {}

  @Get('masters')
  list() {
    return this.masters.masters();
  }

  // GL groups
  @Post('gl-groups')
  createGlGroup(@Body() dto: CreateGlGroupDto, @CurrentUser() actor: Actor) {
    return this.masters.createGlGroup(dto, actor);
  }
  @Patch('gl-groups/:code')
  updateGlGroup(@Param('code') code: string, @Body() dto: UpdateDescriptionDto, @CurrentUser() actor: Actor) {
    return this.masters.updateGlGroup(code, dto, actor);
  }
  @Delete('gl-groups/:code')
  deleteGlGroup(@Param('code') code: string, @CurrentUser() actor: Actor) {
    return this.masters.deleteGlGroup(code, actor);
  }

  // GL codes
  @Post('gl-codes')
  createGlCode(@Body() dto: CreateGlCodeDto, @CurrentUser() actor: Actor) {
    return this.masters.createGlCode(dto, actor);
  }
  @Patch('gl-codes/:code')
  updateGlCode(@Param('code') code: string, @Body() dto: UpdateDescriptionDto, @CurrentUser() actor: Actor) {
    return this.masters.updateGlCode(code, dto, actor);
  }
  @Delete('gl-codes/:code')
  deleteGlCode(@Param('code') code: string, @CurrentUser() actor: Actor) {
    return this.masters.deleteGlCode(code, actor);
  }

  // Account codes
  @Post('account-codes')
  createAccountCode(@Body() dto: CreateAccountCodeDto, @CurrentUser() actor: Actor) {
    return this.masters.createAccountCode(dto, actor);
  }
  @Patch('account-codes/:code')
  updateAccountCode(@Param('code') code: string, @Body() dto: UpdateDescriptionDto, @CurrentUser() actor: Actor) {
    return this.masters.updateAccountCode(code, dto, actor);
  }
  @Delete('account-codes/:code')
  deleteAccountCode(@Param('code') code: string, @CurrentUser() actor: Actor) {
    return this.masters.deleteAccountCode(code, actor);
  }

  // GL group -> account mappings
  @Post('gl-group-codes')
  createGlGroupCode(@Body() dto: CreateGlGroupCodeDto, @CurrentUser() actor: Actor) {
    return this.masters.createGlGroupCode(dto, actor);
  }
  @Patch('gl-group-codes/:id')
  updateGlGroupCode(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGlGroupCodeDto, @CurrentUser() actor: Actor) {
    return this.masters.updateGlGroupCode(id, dto, actor);
  }
  @Delete('gl-group-codes/:id')
  deleteGlGroupCode(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.masters.deleteGlGroupCode(id, actor);
  }

  // Tax rules
  @Post('tax-rules')
  createTaxRule(@Body() dto: TaxRuleBodyDto, @CurrentUser() actor: Actor) {
    return this.masters.createTaxRule(dto, actor);
  }
  @Patch('tax-rules/:id')
  updateTaxRule(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateTaxRuleDto, @CurrentUser() actor: Actor) {
    return this.masters.updateTaxRule(id, dto, actor);
  }
  @Delete('tax-rules/:id')
  deleteTaxRule(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.masters.deleteTaxRule(id, actor);
  }

  /** Dry-run the tax engine for a customer + hypothetical lines. */
  @Post('tax-preview')
  async taxPreview(@Body() dto: TaxPreviewDto) {
    const lines: TaxableLine[] = dto.lines.map((l) => ({ itemId: l.itemId, amount: l.amount, qty: l.qty }));
    const r = await this.tax.forCustomer(dto.billToId, lines, dto.freight ?? 0);
    return {
      tax1: r.taxes[0],
      tax2: r.taxes[1],
      tax3: r.taxes[2],
      total: r.taxes[0] + r.taxes[1] + r.taxes[2],
      rules: r.appliedRules.map((rule) => (rule ? { id: rule.id, description: rule.description } : null)),
    };
  }

  // --- accounting export (IIF / CSV journal) --------------------------------

  @Post('export/preview')
  @RequireProgram('accounting.export')
  exportPreview(@Body() dto: ExportAccountingDto) {
    return this.exporter.preview(dto);
  }

  @Post('export')
  @RequireProgram('accounting.export')
  exportFile(@Body() dto: ExportAccountingDto, @CurrentUser() actor: Actor) {
    return this.exporter.export(dto, actor);
  }

  @Get('export/runs')
  @RequireProgram('accounting.export')
  exportRuns() {
    return this.exporter.runs();
  }
}
