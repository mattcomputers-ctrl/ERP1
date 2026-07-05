import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NATIVE_ID_BASE } from '../common/locks';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { MailTransport, type SmtpConfig } from './mail-transport';
import { parseRecipients } from './template';

// Legacy ran `exec EmailProcessor` from a 1-minute SQL Agent job; ERP1 polls
// in-process on the same cadence.
const POLL_MS = 60_000;
const BATCH = 20;
const MAX_ATTEMPTS = 5;
// A claim older than this with no outcome means the claiming process died
// mid-send (crash/kill between SMTP accept and the status write) — the sweep
// returns it to the queue. Its attempt was already counted at claim time, so
// a crash loop still converges on 'Failed'.
const STALE_CLAIM_MS = 10 * 60_000;

export interface ProcessResult {
  skipped?: 'disabled' | 'unconfigured';
  sent: number;
  failed: number;
  /** Stale 'Sending' claims returned to the queue (or parked) by the sweep. */
  recovered: number;
}

/**
 * Delivers queued EmailSent rows over SMTP (the legacy EmailProcessor +
 * Database Mail leg, owned by ERP1). Emitters queue fully rendered rows
 * in-transaction; this service owns every status transition out of
 * 'Not sent'.
 *
 * Dispatch protocol (an SMTP send is a non-transactional side effect, so it
 * must NEVER sit inside a database transaction whose rollback would erase the
 * record of it — a rolled-back 'Sent' means duplicate delivery forever):
 *   1. CLAIM: a tiny transaction CAS-moves the lowest pending row to
 *      'Sending' (attempts+1, claim timestamp) using FOR UPDATE SKIP LOCKED —
 *      concurrent dispatchers (poller tick + manual "process now") simply
 *      claim different rows; no advisory lock needed.
 *   2. SEND: outside any transaction, bounded by the transport's own
 *      connection/greeting/socket timeouts.
 *   3. MARK: 'Sent' (+sentAt) on success; on failure back to 'Not sent' with
 *      the error, or 'Failed' once MAX_ATTEMPTS is reached.
 * A crash between 2 and 3 leaves 'Sending'; the sweep at the top of each run
 * re-queues claims older than STALE_CLAIM_MS (at-least-once delivery, with
 * the attempt already durably counted — the retry cap still converges).
 *
 * - Master switch: notifications.enabled (delivery only — queueing always
 *   happens, so the e-mail log doubles as a dry-run trail while it is off).
 * - SMTP config: SMTP_URL env var overrides the smtp.* settings.
 * - Only NATIVE rows (id >= NATIVE_ID_BASE) are ever dispatched: the 516
 *   imported legacy rows are 2022 history stuck at 'Not sent' (this install's
 *   Database Mail never worked) and must never be mass-mailed years later.
 */
@Injectable()
export class EmailProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailProcessorService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly transport: MailTransport,
  ) {}

  onModuleInit() {
    // Integration tests instantiate services directly and drive processPending
    // explicitly; the poller only runs in a real API process.
    if (process.env.NODE_ENV === 'test' || process.env.NOTIFICATIONS_POLL === 'off') return;
    this.timer = setInterval(() => {
      void this.processPending().catch((err) => this.logger.error(`dispatch tick failed: ${(err as Error).message}`));
    }, POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async smtpConfig(): Promise<SmtpConfig | null> {
    const url = process.env.SMTP_URL?.trim();
    if (url) {
      const from = await this.settings.get('smtp.from', '');
      return { url, from: from || undefined };
    }
    const [host, port, secure, user, password, from] = await Promise.all([
      this.settings.get('smtp.host', ''),
      this.settings.getNumber('smtp.port', 587),
      this.settings.get('smtp.secure', 'false'),
      this.settings.get('smtp.user', ''),
      this.settings.get('smtp.password', ''),
      this.settings.get('smtp.from', ''),
    ]);
    if (!host.trim()) return null;
    return {
      host: host.trim(),
      port,
      secure: secure === 'true',
      user: user.trim() || undefined,
      password: password || undefined,
      from: from.trim() || user.trim() || undefined,
    };
  }

  async processPending(): Promise<ProcessResult> {
    const enabled = (await this.settings.get('notifications.enabled', 'false')) === 'true';
    if (!enabled) return { skipped: 'disabled', sent: 0, failed: 0, recovered: 0 };
    const config = await this.smtpConfig();
    if (!config) return { skipped: 'unconfigured', sent: 0, failed: 0, recovered: 0 };
    const from = config.from ?? 'erp1@localhost';

    const recovered = await this.recoverStaleClaims();

    let sent = 0;
    let failed = 0;
    // A row that fails in this run goes back to 'Not sent' — exclude it from
    // further claims so its retry waits for the NEXT poll instead of burning
    // the whole attempt budget against a down server in one tick.
    const processed: number[] = [];
    for (let n = 0; n < BATCH; n++) {
      const email = await this.claimNext(processed);
      if (!email) break;
      processed.push(email.id);

      const to = parseRecipients(email.sendTo);
      if (to.length === 0) {
        // Unsendable — park it immediately rather than retrying forever.
        await this.prisma.emailSent.update({
          where: { id: email.id },
          data: { status: 'Failed', error: 'No valid recipient addresses' },
        });
        failed += 1;
        continue;
      }

      try {
        // OUTSIDE any transaction (see the dispatch protocol above).
        await this.transport.send(config, {
          from,
          to,
          subject: email.subject ?? '',
          html: email.text ?? '',
        });
        await this.prisma.emailSent.update({
          where: { id: email.id },
          data: { status: 'Sent', sentAt: new Date(), error: null },
        });
        sent += 1;
      } catch (err) {
        const message = ((err as Error).message ?? String(err)).slice(0, 2000);
        await this.prisma.emailSent.update({
          where: { id: email.id },
          data: { status: email.attempts >= MAX_ATTEMPTS ? 'Failed' : 'Not sent', error: message },
        });
        failed += 1;
        this.logger.warn(`e-mail ${email.id} attempt ${email.attempts} failed: ${message}`);
      }
    }
    return { sent, failed, recovered };
  }

  /**
   * CAS-claim the lowest pending native row: 'Not sent' -> 'Sending' with the
   * attempt counted DURABLY before the send is tried. SKIP LOCKED makes
   * concurrent claimers take different rows instead of blocking.
   */
  private async claimNext(excludeIds: number[]): Promise<{ id: number; sendTo: string | null; subject: string | null; text: string | null; attempts: number } | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<{ id: number }[]>`
        SELECT "EmailSent" AS id FROM "EmailSent"
        WHERE "Status" = 'Not sent' AND "EmailSent" >= ${NATIVE_ID_BASE}
          AND "EmailSent" != ALL(${excludeIds})
        ORDER BY "EmailSent" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      if (!candidates.length) return null;
      return tx.emailSent.update({
        where: { id: candidates[0].id },
        data: { status: 'Sending', attempts: { increment: 1 }, claimedAt: new Date() },
        select: { id: true, sendTo: true, subject: true, text: true, attempts: true },
      });
    });
  }

  /** Return crashed claims to the queue (or park them once over the cap). */
  private async recoverStaleClaims(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
    const [requeued, parked] = await Promise.all([
      this.prisma.emailSent.updateMany({
        where: { status: 'Sending', claimedAt: { lt: cutoff }, attempts: { lt: MAX_ATTEMPTS } },
        data: { status: 'Not sent', error: 'Recovered from an interrupted dispatch' },
      }),
      this.prisma.emailSent.updateMany({
        where: { status: 'Sending', claimedAt: { lt: cutoff }, attempts: { gte: MAX_ATTEMPTS } },
        data: { status: 'Failed', error: 'Recovered from an interrupted dispatch (attempt cap reached)' },
      }),
    ]);
    const n = requeued.count + parked.count;
    if (n) this.logger.warn(`recovered ${n} interrupted dispatch claim(s)`);
    return n;
  }
}
