// The Yept mark: a Y whose arm becomes a Send arrow, on an arrow-shaped tile. Same drawing as build/yept-icon.svg;
// at small sizes it uses build/yept-icon-small.svg (wider Y, larger arrow) so it stays legible.
const TILE = 'M 60 0 H 420 Q 441 0 455 20 L 585 195 Q 605 220 585 245 L 455 435 Q 440 460 416 460 H 63 Q 20 460 35 425 L 133 268 L 8 78 Q -10 30 24 8 Q 40 0 60 0 Z';
const FULL = {
  arrow: 'M 307 188 H 426 Q 432 188 432 182 V 131 Q 432 115 444 127 L 526 209 Q 536 219 526 229 L 444 311 Q 432 323 432 307 V 266 Q 432 260 426 260 H 257 Z',
  y: 'M 80 80 H 145 L 240 180 L 350 80 H 400 L 170 410 H 90 L 200 265 Z'
};
const SMALL = {
  arrow: 'M 310 178 H 420 V 115 Q 420 103 431 113 L 544 218 L 431 328 Q 420 338 420 325 V 277 H 244 Z',
  y: 'M 67 72 H 147 L 239 166 L 340 72 H 421 L 180 415 H 83 L 197 264 Z'
};

export function BrandMark({ size = 28 }: { size?: number }): React.JSX.Element {
  const { arrow, y } = size <= 32 ? SMALL : FULL;
  return (
    <svg width={size} height={size} viewBox="0 0 640 640" role="img" aria-label="Yept mark" xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(20 90)">
        <path fill="#4930D4" d={TILE} />
        <path fill="#06BFAE" d={arrow} />
        <path fill="#FFFFFF" d={y} />
      </g>
    </svg>
  );
}
