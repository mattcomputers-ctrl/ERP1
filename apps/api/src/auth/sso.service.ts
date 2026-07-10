import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OidcProviderService, type OidcProviderSettings, type OidcStart } from './oidc-provider.service';

// OIDC SSO orchestration (greenfield security requirement — no legacy
// counterpart). Configuration lives in the sso.* app settings (§14 registry,
// Security group; read directly — AuthModule cannot import SettingsModule,
// whose controller guards come from THIS module). Users are linked STRICTLY by
// a pre-provisioned users.ssoSubject — there is no just-in-time user creation:
// authenticating at the IdP proves identity, not authorization to use ERP1.

@Injectable()
export class SsoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: OidcProviderService,
  ) {}

  private async ssoSettings() {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: ['sso.enabled', 'sso.issuer', 'sso.clientId', 'sso.clientSecret', 'sso.buttonLabel'] } },
    });
    const val = (key: string) => rows.find((r) => r.key === key)?.value?.trim() ?? '';
    const issuer = val('sso.issuer');
    const clientId = val('sso.clientId');
    const clientSecret = val('sso.clientSecret');
    return {
      // "Enabled" only counts when the provider is actually configured — a
      // half-configured switch must not render a dead login button.
      enabled: val('sso.enabled') === 'true' && !!issuer && !!clientId && !!clientSecret,
      label: val('sso.buttonLabel') || 'Sign in with SSO',
      cfg: { issuer, clientId, clientSecret } satisfies OidcProviderSettings,
    };
  }

  /** Public login-page info (safe for anonymous callers). */
  async info(): Promise<{ enabled: boolean; label: string }> {
    const s = await this.ssoSettings();
    return { enabled: s.enabled, label: s.label };
  }

  async start(redirectUri: string): Promise<OidcStart> {
    const s = await this.ssoSettings();
    if (!s.enabled) throw new BadRequestException('Single sign-on is not enabled');
    return this.provider.start(s.cfg, redirectUri);
  }

  async exchange(
    currentUrl: string,
    checks: { state: string; nonce: string; codeVerifier: string },
  ) {
    const s = await this.ssoSettings();
    if (!s.enabled) throw new BadRequestException('Single sign-on is not enabled');
    return this.provider.exchange(s.cfg, currentUrl, checks);
  }

  /**
   * Resolve the authenticated IdP subject to a pre-provisioned ERP1 user.
   * No JIT creation; DISABLED accounts are refused (same rule as the password
   * path). Advances lastLoginAt like a password login.
   */
  async resolveUser(sub: string) {
    const user = await this.prisma.user.findUnique({ where: { ssoSubject: sub } });
    if (!user) {
      throw new UnauthorizedException(
        'Your account is not provisioned for single sign-on. Ask an administrator to link it.',
      );
    }
    if (user.status === 'DISABLED') throw new UnauthorizedException('Account is disabled');
    return this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
  }
}
