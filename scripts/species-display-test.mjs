import assert from 'node:assert/strict';
import { SPECIES_BY_ID } from '../src/data.js';
import { speciesName } from '../src/i18n.js';
import {
  speciesDisplayNameById,
  formatCatchSystemMessage,
} from '../src/fishing/speciesDisplay.js';

assert.equal(speciesDisplayNameById('koi'), 'コイ', 'koi は日本語名コイ');
assert.equal(speciesDisplayNameById('yamame'), 'ヤマメ', 'yamame は日本語名ヤマメ');
assert.equal(speciesDisplayNameById('koi'), speciesName(SPECIES_BY_ID.koi), '釣果表示と同じ魚名を使う');
assert.equal(speciesDisplayNameById('unknown_fish_xyz'), 'unknown_fish_xyz', '未知 ID はフォールバック');

const msg = formatCatchSystemMessage('つりびと', 42.3, 'koi');
assert.match(msg, /つりびと が 42\.3cm の コイ を釣り上げた/, '釣果システムメッセージに日本語名');

const msgYamame = formatCatchSystemMessage('angler', 28.0, 'yamame');
assert.match(msgYamame, /28\.0cm の ヤマメ を釣り上げた/, 'ヤマメの釣果メッセージ');

console.log('OK species display: koi/yamame Japanese names and unknown-id fallback');
