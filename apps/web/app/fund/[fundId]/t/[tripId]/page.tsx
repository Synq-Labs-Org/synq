'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { api, describeError } from '../../../../../lib/api';

const TripSchema = z.looseObject({
  tripId: z.string(),
  origin: z.string(),
  destination: z.string(),
  departureDate: z.string(),
  travelers: z.number(),
  state: z.string(),
  options: z.array(
    z.looseObject({
      optionId: z.string(),
      title: z.string(),
      detail: z.string(),
      total: z.string(),
      currency: z.string(),
      votes: z.number(),
    }),
  ),
  myVote: z.string().nullable(),
  chosen: z.string().nullable(),
  booking: z.object({ reference: z.string().nullable() }).nullable(),
  error: z.string().nullable(),
  label: z.string(),
});
type Trip = z.output<typeof TripSchema>;

/** One anonymous id per browser for non-binding trip votes. */
function voterId(): string {
  try {
    const existing = window.localStorage.getItem('synq.voter.v1');
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem('synq.voter.v1', id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Browser view of a trip card shared from Messages: options, votes and status. */
export default function TripPage({
  params,
}: {
  params: Promise<{ fundId: string; tripId: string }>;
}) {
  const { fundId, tripId } = use(params);
  const [key, setKey] = useState('');
  const [voter, setVoter] = useState('');
  const [trip, setTrip] = useState<Trip | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(
    async (k: string, v: string) => {
      try {
        setTrip(
          await api.get(
            `/v1/funds/${fundId}/trips/${tripId}?k=${encodeURIComponent(k)}&v=${encodeURIComponent(v)}`,
            TripSchema,
          ),
        );
      } catch (e) {
        setMessage(describeError(e));
      }
    },
    [fundId, tripId],
  );

  useEffect(() => {
    const k = new URLSearchParams(window.location.hash.slice(1)).get('k') ?? '';
    const v = voterId();
    setKey(k);
    setVoter(v);
    void load(k, v);
  }, [load]);

  async function vote(optionId: string) {
    try {
      setTrip(
        await api.post(
          `/v1/funds/${fundId}/trips/${tripId}/votes`,
          TripSchema,
          {
            key,
            voterId: voter,
            optionId,
          },
        ),
      );
    } catch (e) {
      setMessage(describeError(e));
    }
  }

  if (!trip)
    return (
      <>
        <h1>Group trip</h1>
        <p className="lead">{message ?? 'Loading…'}</p>
      </>
    );
  return (
    <>
      <h1>
        {trip.origin} → {trip.destination}
      </h1>
      <p className="lead">
        {trip.departureDate} · {trip.travelers} traveller
        {trip.travelers === 1 ? '' : 's'} ·{' '}
        {trip.state.toLowerCase().replace('_', ' ')}
      </p>
      <ul>
        {trip.options.map((o) => (
          <li key={o.optionId}>
            <strong>{o.title}</strong> · {o.detail} · {o.total} {o.currency} ·{' '}
            {o.votes} vote{o.votes === 1 ? '' : 's'}
            {trip.state === 'VOTING' && (
              <>
                {' '}
                <button className="link" onClick={() => void vote(o.optionId)}>
                  {trip.myVote === o.optionId ? 'Your vote ✓' : 'Vote'}
                </button>
              </>
            )}
            {trip.chosen === o.optionId && ' · chosen'}
          </li>
        ))}
      </ul>
      {trip.state === 'BOOKED' && (
        <div className="status ok">
          Booked
          {trip.booking?.reference ? ` · ref ${trip.booking.reference}` : ''}
        </div>
      )}
      {trip.error && <div className="status bad">{trip.error}</div>}
      <p className="lead">{trip.label}</p>
      {message && <div className="status bad">{message}</div>}
    </>
  );
}
