import { Controller, Get, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { SettingsService } from './settings.service';

/**
 * Document branding for the print-faithful pages (invoice, packing slip, PO,
 * CofA, labels): company name + optional logo data URL. Session-only — every
 * authenticated user who can open a document may render its header; the
 * values are the ones already printed on the documents themselves (the
 * admin.config gate stays on WRITING them via the settings controller).
 */
@UseGuards(SessionAuthGuard)
@Controller('settings')
export class BrandingController {
  constructor(private readonly settings: SettingsService) {}

  @Get('branding')
  async branding() {
    const [companyName, logoDataUrl] = await Promise.all([
      this.settings.get('company.name', 'Precision Ink Corporation'),
      this.settings.get('company.logoDataUrl', ''),
    ]);
    return { companyName, logoDataUrl: logoDataUrl || null };
  }
}
