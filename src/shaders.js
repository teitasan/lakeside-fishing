/* ===========================================================
   カスタムシェーダ共通 GLSL
   （three の ACES トーンマップ / sRGB 変換を自前で適用して
     標準マテリアルと見た目を揃える）
   =========================================================== */

export const COMMON_GLSL = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  return vnoise(p) * 0.6667 + vnoise(p * 2.03) * 0.3333;
}

float fbm4(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

float fbm5(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.06; a *= 0.5; }
  return s;
}

vec3 rrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesToneMap(vec3 color, float exposure) {
  const mat3 ACESInputMat = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );
  const mat3 ACESOutputMat = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );
  color *= exposure / 0.6;
  color = ACESInputMat * color;
  color = rrtAndOdtFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 v) {
  return mix(
    pow(v, vec3(0.41666)) * 1.055 - vec3(0.055),
    v * 12.92,
    vec3(lessThanEqual(v, vec3(0.0031308)))
  );
}

/** 線形色 -> 画面出力色 */
vec3 encodeOutput(vec3 c, float exposure) {
  return linearToSRGB(acesToneMap(c, exposure));
}

/**
 * 線形色 -> 出力色（composer 経由対応版）。
 * lin=0 なら従来どおり ACES + sRGB を自前で適用し、
 * lin=1 のときはリニアのまま出力する（トーンマップはポスト側で 1 回だけ行う。
 * HalfFloat バッファへは three が何も焼き込まないので、ここで二重に掛けると
 * 暗く沈んだ絵になる）
 */
vec3 encodeOut(vec3 c, float exposure, float lin) {
  return mix(linearToSRGB(acesToneMap(c, exposure)), c, lin);
}
`;

/** 湖底・魚向けの手続きコースティクス（uCaust* uniform が必要） */
export const CAUSTICS_GLSL = /* glsl */ `
float caustHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float caustVnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = caustHash21(i);
  float b = caustHash21(i + vec2(1.0, 0.0));
  float c = caustHash21(i + vec2(0.0, 1.0));
  float d = caustHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float caustFbm2(vec2 p) {
  return caustVnoise(p) * 0.6667 + caustVnoise(p * 2.03) * 0.3333;
}

uniform float uCaustTime;
uniform vec3 uCaustSunDir;
uniform float uCaustNight;
uniform float uCaustRain;
uniform float uCaustCloud;
uniform float uCaustStrength;

vec3 causticLight(vec3 worldPos) {
  if (uCaustStrength < 0.001 || worldPos.y > -0.02) return vec3(0.0);
  float depth = -worldPos.y;
  vec2 sunXZ = uCaustSunDir.xz;
  float sunLen = length(sunXZ);
  vec2 sunN = sunLen > 1e-4 ? sunXZ / sunLen : vec2(0.0, 1.0);
  vec2 p = worldPos.xz * 0.38 + sunN * depth * 0.18;
  float t = uCaustTime;
  float c1 = caustFbm2(p + vec2(t * 0.42, t * 0.31));
  float c2 = caustFbm2(p * 1.65 - vec2(t * 0.51, t * 0.39));
  float caust = pow(clamp(c1 * c2 * 2.1, 0.0, 1.0), 2.4);
  float fade = smoothstep(0.08, 0.55, depth) * (1.0 - smoothstep(3.5, 20.0, depth));
  fade *= (1.0 - uCaustNight * 0.94) * (1.0 - uCaustRain * 0.78) * (1.0 - uCaustCloud * 0.62);
  fade *= smoothstep(-0.08, 0.28, uCaustSunDir.y);
  fade *= uCaustStrength;
  return vec3(0.48, 0.78, 0.92) * caust * fade * 0.42;
}
`;
