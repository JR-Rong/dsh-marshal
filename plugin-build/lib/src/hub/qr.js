import { renderSVG } from 'uqr';
/** 配对页用的二维码。纠错级别 L，白边留足，方便手机相机识别。 */
export function qrSvg(text) {
    const svg = renderSVG(text, { ecc: 'L', border: 2, pixelSize: 4 });
    return svg.replace('<svg ', '<svg role="img" aria-label="配对二维码" width="280" height="280" ');
}
