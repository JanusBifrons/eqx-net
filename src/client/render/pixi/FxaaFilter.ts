/**
 * FXAA post pass for the world container (graphics quality `?aa=fxaa|max`,
 * `graphicsQuality.ts`). Multisampling smooths polygon edges only; this
 * smooths every high-contrast edge on screen, including detail baked inside
 * textures (hull panel lines, rock seams), at the cost of one full-screen
 * pass and a little softness.
 *
 * The classic "FXAA lite" (Lottes / the old Pixi v4 core filter): five taps
 * to find the edge direction, then two pairs of taps along it. Works on the
 * premultiplied RGBA of the filter texture, so transparent world pixels
 * (the starfield shows through) stay transparent.
 */
import { defaultFilterVert, Filter, GlProgram } from 'pixi.js';

export const FXAA_FRAGMENT = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
// highp: the default filter vertex shader declares these highp, and a
// precision mismatch between stages fails the link (nothing draws).
uniform highp vec4 uInputSize;
uniform highp vec4 uInputClamp;

#define FXAA_REDUCE_MIN (1.0 / 128.0)
#define FXAA_REDUCE_MUL (1.0 / 8.0)
#define FXAA_SPAN_MAX 8.0

vec4 tap(vec2 uv) { return texture(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw)); }

void main(void) {
  vec2 px = uInputSize.zw;
  vec2 uv = vTextureCoord;
  const vec3 L = vec3(0.299, 0.587, 0.114);
  vec4 cM = tap(uv);
  float lNW = dot(tap(uv + vec2(-1.0, -1.0) * px).rgb, L);
  float lNE = dot(tap(uv + vec2( 1.0, -1.0) * px).rgb, L);
  float lSW = dot(tap(uv + vec2(-1.0,  1.0) * px).rgb, L);
  float lSE = dot(tap(uv + vec2( 1.0,  1.0) * px).rgb, L);
  float lM = dot(cM.rgb, L);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * (0.25 * FXAA_REDUCE_MUL), FXAA_REDUCE_MIN);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2(-FXAA_SPAN_MAX), vec2(FXAA_SPAN_MAX)) * px;

  vec4 a = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  vec4 b = a * 0.5 + 0.25 * (tap(uv + dir * -0.5) + tap(uv + dir * 0.5));
  float lB = dot(b.rgb, L);
  finalColor = (lB < lMin || lB > lMax) ? a : b;
}
`;

export class FxaaFilter extends Filter {
  /** `msaa`: also multisample the filter's own texture (`?aa=max`). */
  constructor(msaa: boolean) {
    super({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FXAA_FRAGMENT, name: 'fxaa-filter' }),
      resources: {},
      // Full screen density: the default (1) would render the world at CSS
      // px and blur it on every high-DPR screen.
      resolution: 'inherit',
      antialias: msaa ? 'on' : 'off',
    });
  }
}
