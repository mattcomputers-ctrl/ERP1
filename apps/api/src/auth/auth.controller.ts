import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { toDataURL } from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { MfaConfirmDto, MfaDisableDto, MfaEnrollDto } from './dto/mfa.dto';
import { SessionAuthGuard } from './session-auth.guard';
import { SsoService } from './sso.service';

/** The externally-visible base URL (behind Caddy in production). PUBLIC_URL
 * wins when set; otherwise derived from the request (trust proxy is on). */
function publicBase(req: Request): string {
  const envBase = (process.env.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  return envBase || `${req.protocol}://${req.get('host')}`;
}

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly sso: SsoService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const user = await this.auth.validateUser(dto.email, dto.password, true, {
      totpCode: dto.totpCode,
      recoveryCode: dto.recoveryCode,
    });

    // Mirrors verifyAndTrack's precedence: a TOTP code is tried before a
    // recovery code, so the summary names the factor that actually verified.
    const factor = user.mfaEnabled ? (dto.totpCode ? ' (MFA)' : ' (MFA recovery code)') : '';
    await this.establishSession(req, user, `Login: ${user.email}${factor}`);

    return this.auth.getProfile(user.id);
  }

  /** Shared post-authentication session wiring (password AND SSO logins):
   * rotate the session id across the privilege change (prevents fixation),
   * persist the session row, and audit. */
  private async establishSession(
    req: Request,
    user: { id: string; displayName: string; mustChangePassword: boolean; passwordHash?: string | null },
    auditSummary: string,
  ) {
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve())),
    );
    req.session.userId = user.id;
    req.session.actorLabel = user.displayName;
    req.session.mustChangePassword = user.mustChangePassword;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );

    const ttlHours = Number(process.env.SESSION_TTL_HOURS ?? '12');
    await this.prisma.session
      .create({
        data: {
          id: req.sessionID,
          userId: user.id,
          expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
      })
      .catch((e) => this.logger.warn(`Failed to record session row: ${e?.message ?? e}`));

    await this.audit.record({
      action: 'auth.login',
      actorUserId: user.id,
      actorLabel: user.displayName,
      ip: req.ip,
      summary: auditSummary,
    });
  }

  @Post('logout')
  async logout(@Req() req: Request) {
    const userId = req.session.userId;
    const sid = req.sessionID;
    if (userId) {
      await this.audit.record({
        action: 'auth.logout',
        actorUserId: userId,
        actorLabel: req.session.actorLabel,
        ip: req.ip,
      });
    }
    await this.prisma.session
      .updateMany({ where: { id: sid }, data: { revokedAt: new Date() } })
      .catch((e) => this.logger.warn(`Failed to revoke session row: ${e?.message ?? e}`));
    await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  async me(@Req() req: Request) {
    if (!req.session.userId) throw new UnauthorizedException();
    return this.auth.getProfile(req.session.userId);
  }

  @Post('change-password')
  @UseGuards(SessionAuthGuard)
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const userId = req.session.userId as string;
    await this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
    req.session.mustChangePassword = false;
    await this.audit.record({
      action: 'auth.change_password',
      actorUserId: userId,
      actorLabel: req.session.actorLabel,
      ip: req.ip,
    });
    return { ok: true };
  }

  // --- TOTP MFA (self-service; admin reset lives on /users/:id/mfa-reset) ----

  @Post('mfa/enroll')
  @UseGuards(SessionAuthGuard)
  async mfaEnroll(@Body() dto: MfaEnrollDto, @Req() req: Request) {
    const userId = req.session.userId as string;
    const { secret, otpauthUri, priorSecret } = await this.auth.startMfaEnrollment(userId, dto.password, {
      totpCode: dto.totpCode,
    });
    // The secret stays server-side (session store) until possession is proven;
    // it is returned once for manual entry alongside the QR image. priorSecret
    // pins the state this enrollment may replace (confirm refuses otherwise).
    req.session.mfaEnroll = { secret, priorSecret };
    const qrDataUrl = await toDataURL(otpauthUri, { margin: 1, width: 192 });
    return { otpauthUri, secret, qrDataUrl };
  }

  @Post('mfa/confirm')
  @UseGuards(SessionAuthGuard)
  async mfaConfirm(@Body() dto: MfaConfirmDto, @Req() req: Request) {
    const userId = req.session.userId as string;
    const pending = req.session.mfaEnroll;
    if (!pending) throw new BadRequestException('No MFA enrollment in progress — start again.');
    const result = await this.auth.confirmMfaEnrollment(userId, pending.secret, pending.priorSecret, dto.code, {
      actorLabel: req.session.actorLabel,
      ip: req.ip,
    });
    delete req.session.mfaEnroll;
    return result;
  }

  @Post('mfa/disable')
  @UseGuards(SessionAuthGuard)
  async mfaDisable(@Body() dto: MfaDisableDto, @Req() req: Request) {
    const userId = req.session.userId as string;
    await this.auth.disableMfa(
      userId,
      dto.password,
      { totpCode: dto.totpCode, recoveryCode: dto.recoveryCode },
      { actorLabel: req.session.actorLabel, ip: req.ip },
    );
    return { ok: true };
  }

  // --- OIDC SSO (authorization-code + PKCE; strict pre-provisioned linking) ---

  /** Anonymous login-page probe: is SSO on, and what should the button say? */
  @Get('sso')
  ssoInfo() {
    return this.sso.info();
  }

  @Get('oidc/start')
  async oidcStart(@Req() req: Request, @Res() res: Response) {
    // A top-level browser navigation, like the callback — errors must land the
    // user back on the login page, never on a raw JSON body.
    try {
      const redirectUri = `${publicBase(req)}/api/auth/oidc/callback`;
      const { url, state, nonce, codeVerifier } = await this.sso.start(redirectUri);
      req.session.oidc = { state, nonce, codeVerifier, redirectUri };
      await new Promise<void>((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve())),
      );
      return res.redirect(url);
    } catch (e) {
      const isHttp = e instanceof UnauthorizedException || e instanceof BadRequestException;
      const message = isHttp ? (e as Error).message : 'Single sign-on failed — try again or contact an administrator.';
      this.logger.warn(`OIDC start failed: ${(e as Error)?.message ?? e}`);
      return res.redirect(`/?ssoError=${encodeURIComponent(message)}`);
    }
  }

  @Get('oidc/callback')
  async oidcCallback(@Req() req: Request, @Res() res: Response) {
    const pending = req.session.oidc;
    delete req.session.oidc; // single use — a replayed callback must not verify
    try {
      if (!pending) throw new UnauthorizedException('No sign-in in progress — try again.');
      const query = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      const identity = await this.sso.exchange(`${pending.redirectUri}${query}`, {
        state: pending.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
      });
      // Logged so an administrator can copy the subject into Users → SSO when
      // provisioning (the IdP portal doesn't show the app-scoped `sub`).
      this.logger.log(
        `OIDC subject authenticated: ${identity.sub}${identity.email ? ` (${identity.email})` : ''}`,
      );
      const user = await this.sso.resolveUser(identity.sub);
      await this.establishSession(req, user, `SSO login: ${user.email}`);
      return res.redirect('/');
    } catch (e) {
      // Auth failures carry a safe, user-facing message; protocol errors from
      // the IdP are logged server-side and reported generically.
      const isHttp = e instanceof UnauthorizedException || e instanceof BadRequestException;
      const message = isHttp ? (e as Error).message : 'Single sign-on failed — try again or contact an administrator.';
      this.logger.warn(`OIDC callback failed: ${(e as Error)?.message ?? e}`);
      return res.redirect(`/?ssoError=${encodeURIComponent(message)}`);
    }
  }
}
