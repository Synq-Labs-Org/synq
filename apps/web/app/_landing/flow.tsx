'use client';

import { useEffect, useRef, useState } from 'react';
import { useFrameLoop, useInView, useReducedMotion } from './use-motion';

export type FlowNode = {
  /** Short text drawn in the chart (typed in as the node lights). */
  label: string;
  title: string;
  detail: string;
  /** Where in the code or contracts this step lives. */
  where: string;
};

const SEG = 1900;
const HOLD = 2800;
const TYPE_MS = 48;

const H = { w: 1200, h: 170, nodeW: 164, nodeH: 58, y: 84 };
const V = { w: 360, step: 92, nodeH: 58 };

const hx = (i: number, n: number) => 104 + (i * (H.w - 208)) / (n - 1);
const vy = (i: number) => 46 + i * V.step;

/**
 * An animated flowchart. A packet travels the path, each node lights in
 * sequence and its label is typed in. Two SVG layouts are always in the DOM
 * (CSS picks one by width) so nothing shifts when the viewport changes.
 * Off-screen or with reduced motion the chart rests in its final state.
 */
export function Flow({
  id,
  nodes,
  label,
}: {
  id: string;
  nodes: FlowNode[];
  label: string;
}) {
  const n = nodes.length;
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, '0px');
  const reduced = useReducedMotion();
  const [lit, setLit] = useState(n);
  const litRef = useRef(n);
  const startRef = useRef(0);
  const svgH = useRef<SVGSVGElement>(null);
  const svgV = useRef<SVGSVGElement>(null);
  const pathsH = useRef<(SVGPathElement | null)[]>([]);
  const pathsV = useRef<(SVGPathElement | null)[]>([]);
  const packH = useRef<SVGGElement>(null);
  const packV = useRef<SVGGElement>(null);
  const textsH = useRef<(SVGTextElement | null)[]>([]);
  const textsV = useRef<(SVGTextElement | null)[]>([]);

  const running = inView && !reduced;

  const setText = (i: number, count: number) => {
    const text = nodes[i]!.label.slice(0, count);
    for (const refs of [textsH, textsV]) {
      const el = refs.current[i];
      if (el && el.textContent !== text) el.textContent = text;
    }
  };

  useEffect(() => {
    if (running) {
      startRef.current = 0;
      return;
    }
    // Resting state: everything lit, every label complete.
    litRef.current = n;
    setLit(n);
    nodes.forEach((_, i) => setText(i, 99));
    for (const p of [packH, packV])
      p.current?.setAttribute('visibility', 'hidden');
  }, [running]);

  useFrameLoop(
    running,
    (now) => {
      if (!startRef.current) startRef.current = now;
      const total = n * SEG + HOLD;
      const cycle = (now - startRef.current) % total;
      const step = Math.min(n, Math.floor(cycle / SEG) + 1);
      const within = cycle - (step - 1) * SEG;
      if (step !== litRef.current) {
        litRef.current = step;
        setLit(step);
        nodes.forEach((_, i) => {
          if (i !== step - 1) setText(i, 99);
        });
      }
      const chars = Math.floor(within / TYPE_MS);
      setText(step - 1, Math.min(chars, nodes[step - 1]!.label.length));
      const horizontal = (svgH.current?.getClientRects().length ?? 0) > 0;
      const paths = horizontal ? pathsH : pathsV;
      const pack = horizontal ? packH : packV;
      const hidden = horizontal ? packV : packH;
      hidden.current?.setAttribute('visibility', 'hidden');
      const seg = paths.current[step - 1];
      const p = (within - 520) / (SEG - 520);
      if (!pack.current) return;
      if (!seg || step >= n || p < 0 || p > 1) {
        pack.current.setAttribute('visibility', 'hidden');
        return;
      }
      const eased = p * p * (3 - 2 * p);
      const len = seg.getTotalLength();
      const pt = seg.getPointAtLength(len * eased);
      pack.current.setAttribute('visibility', 'visible');
      pack.current.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
    },
    60,
  );

  const cls = (i: number) =>
    i < lit
      ? i === lit - 1 && running
        ? 'lp-node on cur'
        : 'lp-node on'
      : 'lp-node';
  const segCls = (i: number) => (i < lit - 1 ? 'lp-seg on' : 'lp-seg');

  return (
    <div className="lp-flow" ref={root}>
      <svg
        ref={svgH}
        className="lp-flow-svg lp-flow-h"
        viewBox={`0 0 ${H.w} ${H.h}`}
        role="img"
        aria-label={label}
      >
        {nodes.slice(0, -1).map((_, i) => (
          <path
            key={i}
            ref={(el) => {
              pathsH.current[i] = el;
            }}
            className={segCls(i)}
            d={`M ${hx(i, n) + H.nodeW / 2} ${H.y} L ${hx(i + 1, n) - H.nodeW / 2} ${H.y}`}
          />
        ))}
        {nodes.map((node, i) => (
          <g key={node.label} className={cls(i)}>
            <rect
              x={hx(i, n) - H.nodeW / 2}
              y={H.y - H.nodeH / 2}
              width={H.nodeW}
              height={H.nodeH}
            />
            <text
              className="lp-node-n"
              x={hx(i, n) - H.nodeW / 2 + 10}
              y={H.y - H.nodeH / 2 - 8}
            >
              {String(i + 1).padStart(2, '0')}
            </text>
            <text
              ref={(el) => {
                textsH.current[i] = el;
              }}
              className="lp-node-t"
              x={hx(i, n)}
              y={H.y + 5}
              textAnchor="middle"
            >
              {node.label}
            </text>
          </g>
        ))}
        <g ref={packH} className="lp-packet" visibility="hidden">
          <circle r="9" className="halo" />
          <circle r="4.5" />
        </g>
      </svg>
      <svg
        ref={svgV}
        className="lp-flow-svg lp-flow-v"
        viewBox={`0 0 ${V.w} ${vy(n - 1) + 46}`}
        role="img"
        aria-label={label}
      >
        {nodes.slice(0, -1).map((_, i) => (
          <path
            key={i}
            ref={(el) => {
              pathsV.current[i] = el;
            }}
            className={segCls(i)}
            d={`M 40 ${vy(i) + V.nodeH / 2} L 40 ${vy(i + 1) - V.nodeH / 2}`}
          />
        ))}
        {nodes.map((node, i) => (
          <g key={node.label} className={cls(i)}>
            <rect x={12} y={vy(i) - V.nodeH / 2} width={336} height={V.nodeH} />
            <text className="lp-node-n" x={28} y={vy(i) + 5}>
              {String(i + 1).padStart(2, '0')}
            </text>
            <text
              ref={(el) => {
                textsV.current[i] = el;
              }}
              className="lp-node-t"
              x={62}
              y={vy(i) + 5}
            >
              {node.label}
            </text>
          </g>
        ))}
        <g ref={packV} className="lp-packet" visibility="hidden">
          <circle r="9" className="halo" />
          <circle r="4.5" />
        </g>
      </svg>
      <ol className="lp-flow-steps" aria-label={`${label}: steps`} id={id}>
        {nodes.map((node, i) => (
          <li key={node.title} className={i < lit ? 'on' : undefined}>
            <span className="lp-step-n">{String(i + 1).padStart(2, '0')}</span>
            <h4>{node.title}</h4>
            <p>{node.detail}</p>
            <code>{node.where}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}
