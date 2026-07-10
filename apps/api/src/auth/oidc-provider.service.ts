import { Injectable } from '@nestjs/common';
import * as oidc from 'openid-client';

// The OIDC protocol seam. Everything openid-client (discovery, PKCE,
// authorization-code exchange, ID-token validation) lives behind this ONE
// injectable so integration tests can fake the identity provider the same way
// the import engine fakes the legacy DB (LegacyDbService) and the mail
// dispatcher fakes SMTP (MailTransport).
//
// Note: openid-client v6 is ESM-only; the API compiles to CommonJS. Node
// >= 22.12 loads it via require(esm) — the runtime baseline here is Node 22
// (node:22-bookworm-slim in Docker, portable Node 22 on the dev host).

export interface OidcProviderSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export interface OidcStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcIdentity {
  sub: string;
  email?: string;
  name?: string;
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const SCOPE = 'openid profile email';

@Injectable()
export class OidcProviderService {
  private cache: { key: string; config: oidc.Configuration; at: number } | null = null;

  private async getConfig(s: OidcProviderSettings): Promise<oidc.Configuration> {
    const key = `${s.issuer}|${s.clientId}|${s.clientSecret}`;
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < DISCOVERY_TTL_MS) {
      return this.cache.config;
    }
    const issuerUrl = new URL(s.issuer);
    // http:// issuers are refused by openid-client unless explicitly allowed —
    // only relevant for lab/test IdPs; production issuers are https.
    const options =
      issuerUrl.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined;
    const config = await oidc.discovery(issuerUrl, s.clientId, s.clientSecret, undefined, options);
    this.cache = { key, config, at: Date.now() };
    return config;
  }

  /** Build the authorization redirect (PKCE S256 + state + nonce). */
  async start(s: OidcProviderSettings, redirectUri: string): Promise<OidcStart> {
    const config = await this.getConfig(s);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.href, state, nonce, codeVerifier };
  }

  /** Exchange the callback for validated ID-token claims. Throws on any
   * protocol failure (state/nonce mismatch, bad code, signature, error
   * response from the IdP). */
  async exchange(
    s: OidcProviderSettings,
    currentUrl: string,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<OidcIdentity> {
    const config = await this.getConfig(s);
    const tokens = await oidc.authorizationCodeGrant(config, new URL(currentUrl), {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
    });
    const claims = tokens.claims();
    if (!claims?.sub) throw new Error('The identity provider returned no subject claim');
    return {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
  }
}
