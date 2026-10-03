import { createHash, randomBytes } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Config } from "../config.ts";
import type { Store } from "../db/store.ts";

const ENROLL_MS = 10 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
/** Unanswered challenges kept at once; the oldest goes first, so option requests can't grow memory. */
const MAX_CHALLENGES = 1000;
/** The one user: a stable handle so authenticators keep one passkey per device for this site. */
const USER = { userName: "limitless", userID: new TextEncoder().encode("limitless") };

const sha256 = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * WebAuthn passkeys for the first public origin (its host is the relying party). Registration needs a
 * one-time enrollment link from loopback; challenges and links live in memory and expire.
 */
export class Passkeys {
  private enrollments = new Map<string, number>();
  private challenges = new Map<string, number>();
  constructor(
    private store: Store,
    private cfg: Pick<Config, "publicOrigins">,
    private now = Date.now,
  ) {}

  private get origins(): string[] {
    return this.cfg.publicOrigins;
  }

  private get origin(): string {
    const origin = this.origins[0];
    if (!origin) throw new Error("passkeys need server.public_origins");
    return origin;
  }

  private get rpID(): string {
    return new URL(this.origin).hostname;
  }

  private issue<T extends { challenge: string }>(options: T): T {
    this.challenges.set(options.challenge, this.now() + CHALLENGE_MS);
    for (const [challenge, expiry] of this.challenges)
      if (expiry <= this.now() || this.challenges.size > MAX_CHALLENGES) this.challenges.delete(challenge);
    return options;
  }

  /** Accepts each issued challenge once, before it expires. */
  private answer = (challenge: string): boolean => {
    const expiry = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    return expiry !== undefined && expiry > this.now();
  };

  private enrollment(token: unknown): string {
    const key = typeof token === "string" ? sha256(token) : "";
    if ((this.enrollments.get(key) ?? 0) <= this.now()) throw new Error("enrollment link invalid or expired");
    return key;
  }

  /** A link that registers one passkey, valid for 10 minutes. The token rides in the fragment, out of logs. */
  enrollLink(): string {
    const token = randomBytes(32).toString("base64url");
    const link = `${this.origin}/enroll#${token}`;
    this.enrollments.set(sha256(token), this.now() + ENROLL_MS);
    return link;
  }

  async registrationOptions(token: unknown) {
    this.enrollment(token);
    const excludeCredentials = this.store.listPasskeys().map(({ id }) => ({ id }));
    const authenticatorSelection = { residentKey: "required", userVerification: "required" } as const;
    const options = {
      rpName: "Limitless",
      rpID: this.rpID,
      ...USER,
      excludeCredentials,
      authenticatorSelection,
    };
    return this.issue(await generateRegistrationOptions(options));
  }

  async register(token: unknown, response: RegistrationResponseJSON, device: string): Promise<void> {
    const key = this.enrollment(token);
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response,
      expectedChallenge: this.answer,
      expectedOrigin: this.origins,
      expectedRPID: this.rpID,
    });
    // Checked again after the await: two registrations racing on one link must not both land.
    if (!verified || !this.enrollments.delete(key)) throw new Error("passkey registration failed");
    this.store.addPasskey(registrationInfo.credential, device.slice(0, 256), this.now());
  }

  async authenticationOptions() {
    return this.issue(await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required" }));
  }

  /** Whether the assertion is a fresh signature by a registered passkey. */
  async authenticate(response: AuthenticationResponseJSON): Promise<boolean> {
    const credential = typeof response?.id === "string" ? this.store.passkey(response.id) : null;
    if (!credential) return false;
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: this.answer,
      expectedOrigin: this.origins,
      expectedRPID: this.rpID,
      credential,
    });
    if (verified) this.store.usePasskey(credential.id, authenticationInfo.newCounter, this.now());
    return verified;
  }
}
