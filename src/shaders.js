/* ===========================================================
   カスタムシェーダ共通 GLSL
   （three の ACES トーンマップ / sRGB 変換を自前で適用して
     標準マテリアルと見た目を揃える）
   =========================================================== */
import { waveGLSL } from './waveField.js?v=20260828-wavefield3';

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

/**
 * 湖底・魚向けのコースティクス（uCaust* uniform が必要）。
 *
 * fbm の掛け算は「にじみ」しか作れないので、ボロノイ境界の明線を焼いた
 * タイル可能テクスチャ（uCaustTex）を 2 枚スクロールさせて干渉させる。
 * さらに投影点を Snell の屈折角でずらし、実際の波面の傾き（csWaveD）で
 * 歪めるので、水面の波と網目の動きが同期する。
 * RGB には微妙にずらした同じ模様が入っているので、掛け算で色収差が付く。
 */
export const CAUSTICS_GLSL = /* glsl */ `
uniform float uCaustTime;
uniform vec3 uCaustSunDir;
uniform float uCaustNight;
uniform float uCaustRain;
uniform float uCaustCloud;
uniform float uCaustStrength;
uniform sampler2D uCaustTex;

${waveGLSL({ prefix: 'cs', slim: true })}

vec3 causticLight(vec3 worldPos, vec3 viewNormal) {
  if (uCaustStrength < 0.001 || worldPos.y > -0.02) return vec3(0.0);
  float depth = -worldPos.y;

  /* 湖底のこの点を照らす光は、真上ではなく太陽と反対側の水面から入る。
     水中の傾きは Snell（sinθw = sinθa / 1.333）で空気中よりかなり浅い */
  vec3 sd = normalize(uCaustSunDir);
  float ca = max(sd.y, 0.08);
  float sa = sqrt(max(0.0, 1.0 - ca * ca));
  float sw = sa / 1.333;
  float tw = sw / max(sqrt(max(0.0, 1.0 - sw * sw)), 1e-3);
  float sl = length(sd.xz);
  vec2 sunN = sl > 1e-4 ? sd.xz / sl : vec2(0.0, 1.0);
  vec2 surf = worldPos.xz + sunN * depth * tw;

  /* 水面の傾きで網目を歪める＝波と同期して揺れる */
  vec2 slope = csWaveD(surf, uCaustTime);
  vec2 q = surf + slope * (depth * 1.15 + 0.6);

  float t = uCaustTime;
  vec3 a = texture2D(uCaustTex, q * 0.155 + vec2( 0.011, 0.007) * t).rgb;
  vec3 b = texture2D(uCaustTex, q * 0.245 + vec2(-0.008, 0.012) * t + vec2(0.37, 0.61)).rgb;
  vec3 net = a * b * 3.6;
  net = min(net * net, vec3(1.15));    // 太い部分を削って細い明線だけ残す

  /* 2 枚の積を二乗しているので mipmap の平均では帯域が落ちない。
     遠景をそのまま出すとギラギラした砂目になるため距離で消す
     （実際の水でも 20m 以上先のコースティクスは見えない） */
  float viewDist = length(worldPos - cameraPosition);
  float fade = (1.0 - smoothstep(16.0, 46.0, viewDist));
  fade *= smoothstep(0.07, 0.60, depth) * (1.0 - smoothstep(6.0, 26.0, depth));
  /* 上を向いた面ほど強い。これが無いと水際の岩の側面まで青白く光り、
     低ポリの岩が氷の塊に見えてしまう */
  vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  fade *= smoothstep(0.15, 0.72, dot(normalize(viewNormal), upView));
  fade *= (1.0 - uCaustNight * 0.94) * (1.0 - uCaustRain * 0.72) * (1.0 - uCaustCloud * 0.62);
  fade *= smoothstep(-0.05, 0.30, sd.y);
  vec3 sunView = normalize((viewMatrix * vec4(sd, 0.0)).xyz);
  float facing = max(dot(normalize(viewNormal), sunView), 0.0);
  fade *= smoothstep(0.02, 0.38, facing);
  fade *= uCaustStrength;
  return vec3(0.62, 0.88, 0.95) * net * fade * 0.24;
}
`;
