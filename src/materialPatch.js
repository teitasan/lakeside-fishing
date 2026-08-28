/* ===========================================================
   マテリアルへのシェーダ注入を重ねて当てるための小物

   three のマテリアルは onBeforeCompile が 1 つしか持てないので、
   風揺れ・caustics・法線の扱いのように «複数の注入» を素直に呼ぶと
   最後に当てたものだけが効く。置換の目印（#include <...>）は置換後も
   残るので、コンパイル時に順番に呼べば全部効く。
   =========================================================== */

/**
 * 複数のパッチを 1 つのマテリアルへ重ねて当てる。
 * @param {THREE.Material} mat
 * @param {Array<((m: THREE.Material) => void)|null>} patches
 */
export function applyPatches(mat, patches) {
  const fns = [];
  const keys = [];
  for (const patch of patches) {
    if (!patch) continue;
    patch(mat);
    if (mat.onBeforeCompile) fns.push(mat.onBeforeCompile);
    keys.push(mat.customProgramCacheKey ? mat.customProgramCacheKey() : '');
  }
  mat.onBeforeCompile = (shader, renderer) => {
    for (const f of fns) f(shader, renderer);
  };
  const key = keys.join('|');
  mat.customProgramCacheKey = () => key;
  return mat;
}

/**
 * 頂点に持たせた法線を、面の表裏で反転させない。
 *
 * DoubleSide のとき three は
 *   float faceDirection = gl_FrontFacing ? 1.0 : -1.0;  normal *= faceDirection;
 * を入れる。«面の向き» ではなく «どちら側から見ているか» で決まるので、
 * 葉カードのように «株の外向き» を自分で入れた法線だと、裏から見えている
 * カードの法線が反転して手前を向く。結果、樹冠の奥側の葉が手前側と同じだけ
 * 太陽を向いてしまい、樹冠の暗い側が消えて葉群ぜんたいが白っぽく飛ぶ。
 *
 * 葉は «自分で決めた向き» で陰影を付けたいので、反転を取り消して
 * 補間した法線をそのまま使う（滑らかシェーディング前提。flatShading では
 * vNormal が無いので使えない）。
 * @param {THREE.Material} mat
 */
export function keepAuthoredNormals(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      // 表裏による法線反転を取り消す（materialPatch.keepAuthoredNormals）
      normal = normalize( vNormal );`
    );
  };
  mat.customProgramCacheKey = () => 'keep-authored-normals';
  return mat;
}

/**
 * 葉の «光が透ける» ぶんを足す。
 *
 * 法線の反転を止めると樹冠に暗い側が戻るが、フィルが半球光だけなので
 * 日陰側がほぼ黒に落ちる。実際の葉は薄いので裏から光が抜け、
 * 日陰の葉は «暗い» のではなく «濃い緑» になる。
 * 透過は本来 -N·L に比例するが、three の直接光ループへ割り込むのは
 * バージョン差が大きいので、アルベドに比例した一定量を足す近似にする。
 * @param {THREE.Material} mat
 * @param {number} amount アルベドに対する割合
 */
export function foliageTranslucency(mat, amount = 0.14) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      // 葉を透ける光（materialPatch.foliageTranslucency）
      totalEmissiveRadiance += diffuseColor.rgb * ${amount.toFixed(3)};`
    );
  };
  mat.customProgramCacheKey = () => `foliage-translucency-${amount}`;
  return mat;
}
