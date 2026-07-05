import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * The outbound-mail seam. Production uses SMTP via nodemailer; integration
 * tests substitute a fake (same pattern as the LegacyDbService seam). Legacy
 * CMS handed this leg to SQL Server Database Mail — which was never
 * operational in this install; ERP1 owns delivery directly.
 */
export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
}

export interface SmtpConfig {
  /** Full smtp:// or smtps:// URL — overrides the field-level settings. */
  url?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from?: string;
}

// Every send happens while a dispatch claim is open (EmailProcessorService),
// so a hung SMTP conversation must fail fast — nodemailer's defaults (2 min
// connect, 10 min socket) would pin the dispatcher on one blackholed server.
const TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

@Injectable()
export class MailTransport {
  async send(config: SmtpConfig, message: MailMessage): Promise<void> {
    const transporter = nodemailer.createTransport(
      config.url
        ? { url: config.url, ...TIMEOUTS }
        : {
            host: config.host,
            port: config.port ?? 587,
            secure: config.secure ?? false,
            auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined,
            // Never hand credentials to a plaintext channel: when a password
            // is configured on a non-implicit-TLS port, the STARTTLS upgrade
            // is mandatory (an unauthenticated internal relay stays
            // opportunistic).
            requireTLS: Boolean(config.user) && !(config.secure ?? false),
            ...TIMEOUTS,
          },
    );
    try {
      await transporter.sendMail({
        from: message.from,
        to: message.to.join(', '),
        subject: message.subject,
        html: message.html,
      });
    } finally {
      transporter.close();
    }
  }
}
