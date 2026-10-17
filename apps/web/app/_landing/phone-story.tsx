'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Phone } from './phone';

export type StoryStep = {
  kicker: string;
  title: string;
  body: ReactNode;
  screenLabel: string;
};

/**
 * Sticky storytelling: the phone stays pinned while the steps scroll past and
 * its screen swaps to match the step in the middle of the viewport.
 */
export function PhoneStory({
  steps,
  screens,
}: {
  steps: StoryStep[];
  screens: ReactNode[];
}) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = refs.current.indexOf(e.target as HTMLLIElement);
            if (i >= 0) setActive(i);
          }
        }
      },
      { rootMargin: '-42% 0px -42% 0px' },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="lp-story" data-phone-track>
      <div className="lp-story-pin">
        <Phone
          screens={screens}
          active={active}
          label={`Phone showing: ${steps[active]?.screenLabel ?? ''}. Sample data on testnet.`}
        />
        <p className="lp-caption" aria-hidden="true">
          Sample data · testnet USDC
        </p>
      </div>
      <ol className="lp-story-steps">
        {steps.map((s, i) => (
          <li
            key={s.title}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className="lp-story-step"
            data-active={i === active ? 'true' : 'false'}
          >
            <p className="lp-kicker">{s.kicker}</p>
            <h3>{s.title}</h3>
            <div className="lp-prose">{s.body}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
