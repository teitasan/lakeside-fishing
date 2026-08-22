import { SPECIES_BY_ID } from '../data.js';
import { speciesName } from '../i18n.js';

/** 内部 species ID をユーザー向け表示名へ（メッセージ境界用）。未知 ID はそのまま返す。 */
export function speciesDisplayNameById(id) {
  const species = SPECIES_BY_ID[id];
  return species ? speciesName(species) : id;
}

/** マルチプレイの釣果システムメッセージ（サーバー側・日本語固定）。 */
export function formatCatchSystemMessage(playerName, lengthCm, speciesId) {
  const fish = speciesDisplayNameById(speciesId);
  return `${playerName} が ${lengthCm.toFixed(1)}cm の ${fish} を釣り上げた`;
}
