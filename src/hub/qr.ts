import { renderSVG } from 'uqr'

export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: 'L', border: 2, pixelSize: 4 }).replace(
    '<svg ',
    '<svg role="img" aria-label="pairing" width="280" height="280" ',
  )
}
