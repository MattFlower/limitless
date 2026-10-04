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
/** A refusal whose message is ours, so it can be logged as it is. */
class Refused extends Error {}

/**
 * Library failures are logged as a fixed reason, never their message: it quotes values the client
 * chose (challenges, credential ids, origins). The first keyword found names the check that failed.
 */
const LIBRARY_REASONS: [keyword: string, reason: string][] = [
  ["challenge", "challenge not issued or expired"],
  ["origin", "origin not allowed"],
  ["rp id", "RP ID mismatch"],
  ["user verification", "user not verified"],
  ["user present", "user not present"],
  ["signature", "signature not verified"],
  ["counter", "counter not increasing"],
  ["unique", "passkey already registered (UNIQUE)"],
];
const reason = (error: unknown) => {
  if (error instanceof Refused) return error.message;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return LIBRARY_REASONS.find(([keyword]) => message.includes(keyword))?.[1] ?? "verification error";
};

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
    private log = (reason: string) => console.warn(`passkey: ${reason}`),
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

  /**
   * Verifies and saves a new passkey. Callers see one fixed error; the reason goes to the log. After the
   * await everything runs synchronously, so re-checking the link, saving and then consuming it can't
   * interleave with a concurrent registration, and a failed save leaves the link usable.
   */
  async register(token: unknown, response: RegistrationResponseJSON, device: string): Promise<void> {
    const key = this.enrollment(token);
    try {
      const { verified, registrationInfo } = await verifyRegistrationResponse({
        response,
        expectedChallenge: this.answer,
        expectedOrigin: this.origins,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
      if (!verified) throw new Refused("registration not verified");
      if (response.clientExtensionResults?.credProps?.rk === false)
        throw new Refused("credential not discoverable");
      if ((this.enrollments.get(key) ?? 0) <= this.now())
        throw new Refused("enrollment link used or expired");
      this.store.addPasskey(registrationInfo.credential, device.slice(0, 256), this.now());
    } catch (error) {
      this.log(`registration failed: ${reason(error)}`);
      throw new Error("passkey registration failed");
    }
    this.enrollments.delete(key);
  }

  async authenticationOptions() {
    return this.issue(await generateAuthenticationOptions({ rpID: this.rpID, userVerification: "required" }));
  }

  /** Whether the assertion is a fresh signature by a registered passkey; the reason for a no goes to the log. */
  async authenticate(response: AuthenticationResponseJSON): Promise<boolean> {
    const credential = typeof response?.id === "string" ? this.store.passkey(response.id) : null;
    try {
      if (!credential) throw new Refused("unknown credential");
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response,
        expectedChallenge: this.answer,
        expectedOrigin: this.origins,
        expectedRPID: this.rpID,
        credential,
        requireUserVerification: true,
      });
      if (!verified) throw new Refused("signature not verified");
      // The credential was read before the await: it may since have been removed, or another sign-in may
      // have stored a higher counter. The conditional update refuses both.
      if (!this.store.usePasskey(credential.id, authenticationInfo.newCounter, this.now()))
        throw new Refused("passkey removed or counter not increasing");
      return true;
    } catch (error) {
      this.log(`sign-in failed: ${reason(error)}`);
      return false;
    }
  }
}
