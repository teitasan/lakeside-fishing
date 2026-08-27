/* Planar reflection用の純粋な行列処理。配列はThree.jsと同じcolumn-major。 */

/**
 * camera.matrixWorld を y=0 平面で鏡映し、カメラ用のproper rotationへ戻す。
 * 鏡映したforward/upを保ったまま右手系にするため、反射後のlocal X軸だけを反転する。
 */
export function reflectCameraMatrixY(input, output) {
  if (!input || !output || input.length < 16 || output.length < 16) {
    throw new TypeError('reflectCameraMatrixY requires two 16-element arrays');
  }
  for (let col = 0; col < 4; col++) {
    const i = col * 4;
    output[i] = input[i];
    output[i + 1] = -input[i + 1];
    output[i + 2] = input[i + 2];
    output[i + 3] = input[i + 3];
  }
  output[0] *= -1;
  output[1] *= -1;
  output[2] *= -1;
  return output;
}
