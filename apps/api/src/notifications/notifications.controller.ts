import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, type Actor } from '../auth/current-user.decorator';
import { ProgramGuard, RequireProgram } from '../auth/program.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CreateNotificationDetailDto, CreateNotificationDto, TestEmailDto, UpdateNotificationDto } from './dto/notifications.dto';
import { EmailProcessorService } from './email-processor.service';
import { MailTransport } from './mail-transport';
import { NotificationsService } from './notifications.service';

@UseGuards(SessionAuthGuard, ProgramGuard)
@RequireProgram('notifications.config')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly processor: EmailProcessorService,
    private readonly transport: MailTransport,
    private readonly audit: AuditService,
  ) {}

  @Get()
  overview() {
    return this.notifications.overview();
  }

  // Rules
  @Post('rules')
  createRule(@Body() dto: CreateNotificationDto, @CurrentUser() actor: Actor) {
    return this.notifications.createRule(dto, actor);
  }
  @Patch('rules/:id')
  updateRule(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateNotificationDto, @CurrentUser() actor: Actor) {
    return this.notifications.updateRule(id, dto, actor);
  }
  @Delete('rules/:id')
  deleteRule(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.notifications.deleteRule(id, actor);
  }
  @Post('rules/:id/details')
  addDetail(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateNotificationDetailDto, @CurrentUser() actor: Actor) {
    return this.notifications.addDetail(id, dto, actor);
  }
  @Delete('details/:id')
  deleteDetail(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.notifications.deleteDetail(id, actor);
  }

  // E-mail log
  @Get('emails')
  emails(
    @Query('status') status?: string,
    @Query('code') code?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.notifications.emails({
      status: status || undefined,
      code: code || undefined,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Post('emails/:id/requeue')
  requeue(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: Actor) {
    return this.notifications.requeue(id, actor);
  }

  /** Manual "process the queue now" (the poller also runs every minute). */
  @Post('process')
  process() {
    return this.processor.processPending();
  }

  /** Immediate SMTP round-trip with the current configuration (audited). */
  @Post('test')
  async test(@Body() dto: TestEmailDto, @CurrentUser() actor: Actor) {
    const config = await this.processor.smtpConfig();
    if (!config) return { ok: false, error: 'SMTP is not configured (set smtp.host or the SMTP_URL environment variable).' };
    let result: { ok: boolean; error?: string };
    try {
      await this.transport.send(config, {
        from: config.from ?? 'erp1@localhost',
        to: [dto.to],
        subject: 'ERP1 test e-mail',
        html: '<p>This is a test e-mail from ERP1 notifications. If you can read this, SMTP delivery works.</p>',
      });
      result = { ok: true };
    } catch (err) {
      result = { ok: false, error: ((err as Error).message ?? String(err)).slice(0, 500) };
    }
    await this.audit.record({
      action: 'notifications.config',
      actorUserId: actor.id,
      actorLabel: actor.label,
      program: 'notifications.config',
      summary: `Test e-mail to ${dto.to}: ${result.ok ? 'sent' : `failed (${result.error})`}`,
      changes: [],
    });
    return result;
  }
}
