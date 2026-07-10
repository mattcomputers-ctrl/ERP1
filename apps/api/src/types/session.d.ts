import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    actorLabel?: string;
    mustChangePassword?: boolean;
    /** TOTP enrollment parked between enroll and confirm (server-side only):
     * the fresh secret plus the mfaSecret observed when it was authorized —
     * confirm's conditional write refuses to land on any other state. */
    mfaEnroll?: { secret: string; priorSecret: string | null };
    /** In-flight OIDC authorization-code handshake (single use). */
    oidc?: {
      state: string;
      nonce: string;
      codeVerifier: string;
      redirectUri: string;
    };
  }
}
