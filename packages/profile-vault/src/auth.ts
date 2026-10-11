import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type StepUpKind = 'OTP' | 'THREE_DS' | 'PASSKEY';
export type MerchantAuthState =
  | 'AUTHENTICATED'
  | 'EXPIRED'
  | 'STEP_UP_REQUIRED'
  | 'NONE';

export type StepUpChallenge = {
  challengeId: string;
  kind: StepUpKind;
  principalId: string;
  expiresAt: number;
};

export type StepUpCompletion = {
  challengeId: string;
  principalId: string;
  proof: string;
};

/**
 * Verifies that the eligible human completed the challenge on the human
 * surface (approval page, issuer 3DS callback, passkey assertion). The broker
 * never accepts a proof it did not receive from this verifier.
 */
export interface HumanProofVerifier {
  verify(
    challenge: StepUpChallenge,
    completion: StepUpCompletion,
  ): Promise<boolean>;
}

/** Approval-page verifier: proofs are HMACs the human surface issues after the person completes the step. */
export class HmacHumanProofVerifier implements HumanProofVerifier {
  constructor(private readonly key: Uint8Array) {
    if (key.length < 32) throw new Error('STEP_UP_KEY_TOO_SHORT');
  }
  issue(challenge: StepUpChallenge, principalId: string): string {
    return createHmac('sha256', this.key)
      .update(`${challenge.challengeId}|${principalId}|${challenge.kind}`)
      .digest('hex');
  }
  async verify(challenge: StepUpChallenge, c: StepUpCompletion) {
    const expected = Buffer.from(this.issue(challenge, c.principalId), 'hex');
    const got = Buffer.from(
      /^[0-9a-f]{64}$/.test(c.proof) ? c.proof : '',
      'hex',
    );
    return got.length === expected.length && timingSafeEqual(got, expected);
  }
}

type Session = { ciphertextRef: string; expiresAt: number; stepUp: boolean };

/**
 * MerchantAuthBroker (Bible §88): sessions live as encrypted vault refs; the
 * Brain only sees AUTHENTICATED / EXPIRED / STEP_UP_REQUIRED. OTP, 3DS and
 * passkey step-ups are single-use challenges bound to the eligible human.
 */
export class MerchantAuthBroker {
  private readonly sessions = new Map<string, Session>();
  private readonly challenges = new Map<
    string,
    StepUpChallenge & { used: boolean; attempts: number }
  >();
  readonly events: {
    at: number;
    event: string;
    challengeId?: string;
    principalId?: string;
  }[] = [];
  constructor(
    private readonly verifier: HumanProofVerifier,
    private readonly now: () => number,
    private readonly humans: { isEligibleHuman(principalId: string): boolean },
  ) {}

  private key = (groupId: string, merchant: string) => `${groupId}|${merchant}`;

  storeSession(input: {
    groupId: string;
    merchant: string;
    vaultRef: string;
    expiresAt: number;
  }) {
    this.sessions.set(this.key(input.groupId, input.merchant), {
      ciphertextRef: input.vaultRef,
      expiresAt: input.expiresAt,
      stepUp: false,
    });
  }

  markStepUpRequired(groupId: string, merchant: string) {
    const s = this.sessions.get(this.key(groupId, merchant));
    if (s) s.stepUp = true;
  }

  state(groupId: string, merchant: string): MerchantAuthState {
    const s = this.sessions.get(this.key(groupId, merchant));
    if (!s) return 'NONE';
    if (s.expiresAt <= this.now()) return 'EXPIRED';
    return s.stepUp ? 'STEP_UP_REQUIRED' : 'AUTHENTICATED';
  }

  open(input: {
    kind: StepUpKind;
    principalId: string;
    ttlSeconds: number;
  }): StepUpChallenge {
    if (!this.humans.isEligibleHuman(input.principalId))
      throw new Error('STEP_UP_PRINCIPAL_NOT_HUMAN');
    const c: StepUpChallenge = {
      challengeId: `su_${randomBytes(12).toString('hex')}`,
      kind: input.kind,
      principalId: input.principalId,
      expiresAt: this.now() + Math.min(input.ttlSeconds, 900),
    };
    this.challenges.set(c.challengeId, { ...c, used: false, attempts: 0 });
    this.events.push({
      at: this.now(),
      event: 'OPENED',
      challengeId: c.challengeId,
      principalId: c.principalId,
    });
    return c;
  }

  async complete(
    challenge: StepUpChallenge,
    completion: StepUpCompletion,
  ): Promise<boolean> {
    const stored = this.challenges.get(completion.challengeId);
    const reject = (why: string) => {
      this.events.push({
        at: this.now(),
        event: `REJECTED:${why}`,
        challengeId: completion.challengeId,
        principalId: completion.principalId,
      });
      return false;
    };
    if (!stored || stored.challengeId !== challenge.challengeId)
      return reject('UNKNOWN');
    if (stored.used) return reject('REPLAY');
    if (stored.expiresAt <= this.now()) return reject('EXPIRED');
    if (++stored.attempts > 5) return reject('LOCKED');
    if (completion.principalId !== stored.principalId)
      return reject('WRONG_PRINCIPAL');
    if (!this.humans.isEligibleHuman(completion.principalId))
      return reject('NOT_HUMAN');
    if (!(await this.verifier.verify(stored, completion)))
      return reject('BAD_PROOF');
    stored.used = true;
    this.events.push({
      at: this.now(),
      event: 'COMPLETED',
      challengeId: stored.challengeId,
      principalId: stored.principalId,
    });
    return true;
  }
}
