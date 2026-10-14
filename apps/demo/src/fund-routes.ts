import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FundError, type FundService } from './fund-service.js';
import type { FundAssistant } from './fund-assistant.js';
import type { TripService } from './fund-trips.js';

const FundId = z.string().regex(/^fnd_[0-9a-f]{20}$/);
const Key = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const Hex = z.string().regex(/^0x[0-9a-fA-F]+$/) as z.ZodType<`0x${string}`>;
const PrincipalId = z.string().min(1).max(128);

const CreateBody = z.strictObject({ name: z.string().max(200) });
const JoinBody = z.strictObject({
  key: Key,
  principalId: PrincipalId,
  name: z.string().max(200),
  issuedAt: z.number().int().positive(),
  signature: Hex,
});
const LaunchBody = z.strictObject({ adminKey: Key });
const ChallengeBody = z.strictObject({ key: Key, principalId: PrincipalId });
const ActivateBody = z.strictObject({
  key: Key,
  principalId: PrincipalId,
  joinSignature: Hex.nullable(),
  safeSignatures: z
    .array(z.strictObject({ safeTxHash: Hex, signature: Hex }))
    .max(4),
});
const KeyBody = z.strictObject({ key: Key });
const AskBody = z.strictObject({ key: Key, text: z.string().min(1).max(500) });
const VoterId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const TripId = z.string().regex(/^trp_[0-9a-f]{16}$/);
const OptionId = z.string().regex(/^[0-9a-f]{12}$/);
const TripBody = z.strictObject({
  key: Key,
  origin: z.string().min(3).max(3),
  destination: z.string().min(3).max(3),
  departureDate: z.string().max(10),
  travelers: z.number().int(),
});
const GiftBody = z.strictObject({
  key: Key,
  query: z.string().min(1).max(80),
  maxPrice: z.string().max(8),
});
const VoteBody = z.strictObject({
  key: Key,
  voterId: VoterId,
  optionId: OptionId,
});
const ChooseBody = z.strictObject({ key: Key, optionId: OptionId });
const ReadQuery = z.object({ k: Key, v: VoterId.optional() });

const MESSAGES: Record<FundError['code'], string> = {
  INVALID_REQUEST: 'That request is not valid.',
  FUND_NOT_FOUND: 'This fund does not exist.',
  FORBIDDEN: 'This link is not valid for the fund.',
  WRONG_STATE: 'The fund is not at that step.',
  FUND_FULL: 'The fund is full.',
  NOT_ENOUGH_MEMBERS: 'At least two people need to join before launch.',
  ALREADY_MEMBER: 'You have already joined this fund.',
  NOT_A_MEMBER: 'This passkey is not a member of the fund.',
  PRINCIPAL_NOT_ELIGIBLE: 'This passkey account cannot join funds.',
  BAD_SIGNATURE: 'The passkey signature did not verify.',
  STALE_SIGNATURE: 'The signature expired; try again.',
  RATE_LIMITED: 'Too many funds today; try again tomorrow.',
  FAUCET_LIMIT: 'This fund has received all the test money it can.',
  OPERATOR_OUT_OF_GAS:
    'The Synq operator is out of testnet gas; try again later.',
};

async function handle(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    const body = await run();
    reply.header('cache-control', 'no-store');
    return reply.send(body ?? { status: 'OK' });
  } catch (error) {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: 'INVALID_REQUEST', message: MESSAGES.INVALID_REQUEST });
    if (error instanceof FundError)
      return reply
        .code(error.status)
        .send({ error: error.code, message: MESSAGES[error.code] });
    reply.log.error({ err: error }, 'fund route failed');
    return reply
      .code(500)
      .send({ error: 'INTERNAL', message: 'Something went wrong.' });
  }
}

/**
 * Group-fund routes for the Messages app and the /fund web page. Reads and
 * joins are gated by the fund key carried in the chat's cards; launching needs
 * the creator's admin key; joining and activating also need the member's
 * passkey signatures, verified by the service.
 */
export function registerFundRoutes(
  app: FastifyInstance,
  funds: FundService,
  extras: { assistant?: FundAssistant; trips?: TripService } = {},
) {
  const fundIdOf = (request: { params: unknown }) =>
    FundId.parse((request.params as { fundId: string }).fundId);
  const { assistant, trips } = extras;
  if (assistant)
    app.post('/v1/funds/:fundId/ask', (request, reply) =>
      handle(reply, async () => {
        const fundId = fundIdOf(request);
        const body = AskBody.parse(request.body);
        return assistant.ask(
          await funds.view(fundId, body.key),
          body.text,
          funds.ports.now(),
        );
      }),
    );
  if (trips) {
    app.post('/v1/funds/:fundId/trips', (request, reply) =>
      handle(reply, () =>
        trips.start(fundIdOf(request), TripBody.parse(request.body)),
      ),
    );
    app.post('/v1/funds/:fundId/gifts', (request, reply) =>
      handle(reply, () =>
        trips.startGift(fundIdOf(request), GiftBody.parse(request.body)),
      ),
    );
    app.get('/v1/funds/:fundId/trips', (request, reply) =>
      handle(reply, async () => {
        const q = ReadQuery.parse(request.query);
        return { trips: await trips.list(fundIdOf(request), q.k, q.v ?? null) };
      }),
    );
    app.get('/v1/funds/:fundId/trips/:tripId', (request, reply) =>
      handle(reply, () => {
        const q = ReadQuery.parse(request.query);
        const tripId = TripId.parse(
          (request.params as { tripId: string }).tripId,
        );
        return trips.get(fundIdOf(request), q.k, tripId, q.v ?? null);
      }),
    );
    app.post('/v1/funds/:fundId/trips/:tripId/votes', (request, reply) =>
      handle(reply, () => {
        const tripId = TripId.parse(
          (request.params as { tripId: string }).tripId,
        );
        return trips.vote(fundIdOf(request), {
          ...VoteBody.parse(request.body),
          tripId,
        });
      }),
    );
    app.post('/v1/funds/:fundId/trips/:tripId/choose', (request, reply) =>
      handle(reply, () => {
        const tripId = TripId.parse(
          (request.params as { tripId: string }).tripId,
        );
        return trips.choose(fundIdOf(request), {
          ...ChooseBody.parse(request.body),
          tripId,
        });
      }),
    );
  }
  app.post('/v1/funds', (request, reply) =>
    handle(reply.code(201), () => funds.create(CreateBody.parse(request.body))),
  );
  app.get('/v1/funds/:fundId', (request, reply) =>
    handle(reply, async () => {
      const { fundId } = z.object({ fundId: FundId }).parse(request.params);
      const { k } = z.object({ k: Key }).parse(request.query);
      return funds.view(fundId, k);
    }),
  );
  app.post('/v1/funds/:fundId/members', (request, reply) =>
    handle(reply, () =>
      funds.join(
        FundId.parse((request.params as { fundId: string }).fundId),
        JoinBody.parse(request.body),
      ),
    ),
  );
  app.post('/v1/funds/:fundId/launch', (request, reply) =>
    handle(reply.code(202), async () => {
      const fundId = FundId.parse(
        (request.params as { fundId: string }).fundId,
      );
      await funds.launch(fundId, LaunchBody.parse(request.body).adminKey);
      return { status: 'LAUNCHING' };
    }),
  );
  app.post('/v1/funds/:fundId/activation-challenges', (request, reply) =>
    handle(reply, () =>
      funds.activationChallenge(
        FundId.parse((request.params as { fundId: string }).fundId),
        ChallengeBody.parse(request.body),
      ),
    ),
  );
  app.post('/v1/funds/:fundId/activations', (request, reply) =>
    handle(reply, () =>
      funds.activate(
        FundId.parse((request.params as { fundId: string }).fundId),
        ActivateBody.parse(request.body),
      ),
    ),
  );
  app.post('/v1/funds/:fundId/test-funds', (request, reply) =>
    handle(reply, () =>
      funds.requestTestFunds(
        FundId.parse((request.params as { fundId: string }).fundId),
        KeyBody.parse(request.body).key,
      ),
    ),
  );
}
