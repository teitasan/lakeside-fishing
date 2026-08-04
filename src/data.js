/* ===========================================================
   ゲームデータ定義（魚種・装備・実績）
   =========================================================== */

export const RARITY = [
  { key: 0, label: 'ゴミ', color: '#9aa5b1', xp: 2 },
  { key: 1, label: 'コモン', color: '#cfe0f0', xp: 8 },
  { key: 2, label: 'アンコモン', color: '#7ee0a4', xp: 18 },
  { key: 3, label: 'レア', color: '#7ec8ff', xp: 40 },
  { key: 4, label: 'エピック', color: '#d3a4ff', xp: 95 },
  { key: 5, label: 'レジェンド', color: '#ffd479', xp: 260 },
];

/* 時間帯係数のプリセット */
const T = {
  any: { dawn: 1, day: 1, dusk: 1, night: 1 },
  dayish: { dawn: 1.2, day: 1.25, dusk: 1.0, night: 0.35 },
  nightish: { dawn: 0.9, day: 0.25, dusk: 1.2, night: 1.7 },
  twilight: { dawn: 1.9, day: 0.7, dusk: 1.8, night: 0.8 },
  dawnOnly: { dawn: 2.4, day: 0.5, dusk: 1.0, night: 0.5 },
};
const W = {
  any: { clear: 1, cloudy: 1, rain: 1 },
  clear: { clear: 1.35, cloudy: 0.95, rain: 0.6 },
  rain: { clear: 0.7, cloudy: 1.15, rain: 1.8 },
  cloudy: { clear: 0.85, cloudy: 1.4, rain: 1.15 },
};

/* ===========================================================
   ファイトの型（str/sta/agg の上に薄く載せる振る舞いパターン）

   すべて既存の更新式に掛ける倍率。1.0 で従来と同じ挙動になる。
   新しい操作・新しいメーターは増やさない。
   =========================================================== */
export const FIGHT_PATTERNS = {
  dash: {
    id: 'dash', name: 'スプリンター', hint: '短い突進を繰り返す',
    runGap: 0.62, runDur: 0.70, runPull: 1.28,   // 頻繁・短く・強い
    pull: 0.92, lineOut: 1.35,                   // 走ると一気に糸が出る
    tensionGain: 1.0, tensionDecay: 1.18,        // 抜けも速い＝テンポが速い
    staminaDrain: 1.18,                          // 短距離型なのでバテやすい
    jump: 0, shake: 0,
  },
  tank: {
    id: 'tank', name: '重量級', hint: '重い引きが延々と続く',
    runGap: 1.75, runDur: 1.20, runPull: 0.85,   // 走りは稀
    pull: 1.12, lineOut: 0.85,                   // 常に重い
    tensionGain: 1.0, tensionDecay: 0.70,        // 抜けが遅い＝休めない
    staminaDrain: 0.72,                          // なかなかバテない
    jump: 0, shake: 0,
  },
  jumper: {
    id: 'jumper', name: 'ジャンパー', hint: '水面に跳ねる',
    runGap: 0.95, runDur: 1.0, runPull: 1.05,
    pull: 0.95, lineOut: 1.05,
    tensionGain: 1.0, tensionDecay: 1.05,
    staminaDrain: 1.0,
    jump: 1,                                     // 走りの途中でジャンプ（走りは跳ね終わるまで続く）
    jumpDur: 0.62,
    jumpGrace: 0.22,                             // 跳ね始めは猶予（演出が先・危険は後）
    jumpTension: 2.3,                            // 猶予後に巻いていると危険
    jumpDrain: 0.20,                             // 糸を送れば魚が消耗する
    shake: 0,
  },
  shake: {
    id: 'shake', name: '首振り', hint: '首を激しく振る',
    runGap: 1.30, runDur: 1.05, runPull: 0.95,
    pull: 1.0, lineOut: 0.95,
    tensionGain: 1.0, tensionDecay: 1.0,
    staminaDrain: 0.88,
    jump: 0,
    shake: 1,                                    // 小刻みに首を振る
    shakeOn: [0.34, 0.62],                       // 振っている時間（反応できる長さ）
    shakeOff: [0.65, 1.35],                      // 振りの合間
    shakeGrace: 0.15,                            // 振り始めは猶予
    shakeGain: 1.95,                             // 振っている間に巻くと一気に張る
    shakeReel: 0.42,                             // しかも巻き取れない
  },
  deadweight: {
    id: 'deadweight', name: '重り', hint: 'ただ重いだけ',
    runGap: 999, runDur: 1, runPull: 1,          // 走らない・跳ねない
    pull: 1.0, lineOut: 0.5,
    tensionGain: 1.0, tensionDecay: 1.15,
    staminaDrain: 1.5,
    jump: 0, shake: 0,
  },
};

/** 魚種のファイト型（未指定ならタグ・体型から自動割当） */
export function fightPattern(sp) {
  const P = FIGHT_PATTERNS;
  if (sp.fight && P[sp.fight]) return P[sp.fight];
  if (sp.rarity === 0) return P.deadweight;
  if (sp.tags.includes('trout')) return P.jumper;
  if (sp.tags.includes('carp')) return P.tank;
  if (sp.shape === 'eel') return P.shake;
  if (sp.tags.includes('predator')) return P.dash;
  return sp.str >= 1.6 ? P.tank : P.dash;
}

/**
 * shape: 'slim' | 'deep' | 'round' | 'eel' | 'wide' | 'gar' | 'sturgeon' | 'junk'
 * len: [最小cm, 最大cm]   wc: 体重係数 (kg = wc * len^3 / 1e5)
 * depth: [好む水深min, max] (m)
 * str: 引きの強さ  sta: 体力  agg: 突進頻度
 * fight: ファイトの型（省略時は fightPattern() が自動判定）
 */
export const SPECIES = [
  /* ---------------- ゴミ ---------------- */
  {
    id: 'boot', name: '長靴', rarity: 0, tags: ['bottom', 'junk'], shape: 'junk',
    len: [26, 30], wc: 1.0, depth: [0.4, 20], spawn: 0, times: T.any, weather: W.any,
    str: 0.25, sta: 0.3, agg: 0, value: 12, perCm: 0,
    fight: 'deadweight',
    colors: { top: '#4a4a52', mid: '#5c5c66', belly: '#3a3a42', fin: '#2e2e34' },
    flavor: 'よくある釣果。中に何か入っている気がする。',
  },
  {
    id: 'can', name: '空き缶', rarity: 0, tags: ['bottom', 'junk'], shape: 'junk',
    len: [11, 14], wc: 0.4, depth: [0.4, 20], spawn: 0, times: T.any, weather: W.any,
    str: 0.2, sta: 0.25, agg: 0, value: 8, perCm: 0,
    fight: 'deadweight',
    colors: { top: '#8f98a3', mid: '#b9c3cf', belly: '#6d757f', fin: '#5a6169' },
    flavor: '湖はきれいに使いましょう。',
  },
  {
    id: 'weeds', name: '藻の塊', rarity: 0, tags: ['weed', 'junk'], shape: 'junk',
    len: [20, 45], wc: 0.5, depth: [0.4, 12], spawn: 0, times: T.any, weather: W.any,
    str: 0.35, sta: 0.35, agg: 0, value: 5, perCm: 0,
    fight: 'deadweight',
    colors: { top: '#3f5a2c', mid: '#587a3a', belly: '#2e441f', fin: '#26381a' },
    flavor: 'ずっしり重い。魚じゃなかった。',
  },
  {
    id: 'driftwood', name: '流木', rarity: 0, tags: ['bottom', 'junk'], shape: 'junk',
    len: [40, 90], wc: 0.6, depth: [0.4, 16], spawn: 0, times: T.any, weather: W.any,
    str: 0.5, sta: 0.4, agg: 0, value: 18, perCm: 0,
    fight: 'deadweight',
    colors: { top: '#6b4f36', mid: '#8a6a49', belly: '#4d3927', fin: '#3d2d1f' },
    flavor: '見事な形。飾ればインテリアになるかも。',
  },

  /* ---------------- コモン ---------------- */
  {
    id: 'medaka', name: 'メダカ', rarity: 1, tags: ['mid', 'weed'], shape: 'slim',
    len: [2.5, 5], wc: 1.6, depth: [0.2, 0.9], spawn: 38, times: T.dayish, weather: W.any,
    str: 0.2, sta: 0.25, agg: 0.15, value: 8, perCm: 0.8,
    fight: 'dash', pref: [2, 3, 1, 0, 0, 0, 2],
    layer: { top: 1.0, mid: 0.45, bottom: 0.05 }, // 岸ぎわの水面だけ
    colors: { top: '#5a6a48', mid: '#a8b878', belly: '#f0eed8', fin: '#c4c090' },
    flavor: '水面をきらめく豆粒ほどの魚。昔ながらの池の住人。',
  },
  {
    id: 'moroko', name: 'モロコ', rarity: 1, tags: ['bottom', 'mid'], shape: 'slim',
    len: [7, 16], wc: 1.4, depth: [0.5, 3.5], spawn: 34, times: T.dayish, weather: W.any,
    str: 0.35, sta: 0.4, agg: 0.2, value: 14, perCm: 1.2,
    fight: 'dash', pref: [3, 3, 2, 1, 0, 0, 2],
    layer: { top: 0.5, mid: 1.0, bottom: 0.8 }, // 群れで中層〜底を回る
    colors: { top: '#6d7a5c', mid: '#a8b291', belly: '#e8e6d6', fin: '#c9c3a6' },
    flavor: '群れで泳ぐ小さな魚。佃煮がうまい。',
  },
  {
    id: 'bluegill', name: 'ブルーギル', rarity: 1, tags: ['mid', 'weed'], shape: 'deep',
    len: [9, 25], wc: 3.1, depth: [0.8, 5], spawn: 32, times: T.dayish, weather: W.any,
    str: 0.55, sta: 0.55, agg: 0.4, value: 20, perCm: 1.6,
    fight: 'dash', pref: [3, 2, 2, 2, 2, 1, 2],
    colors: { top: '#31513f', mid: '#5d8b63', belly: '#e9d98a', fin: '#2b3f38' },
    flavor: '青い頬。どこにでもいて、何にでも食いつく。',
  },
  {
    id: 'funa', name: 'マブナ', rarity: 1, tags: ['bottom', 'carp'], shape: 'deep',
    len: [14, 36], wc: 2.7, depth: [1, 6.5], spawn: 30, times: T.any, weather: W.cloudy,
    str: 0.7, sta: 0.7, agg: 0.3, value: 26, perCm: 2.0,
    fight: 'tank', pref: [3, 2, 3, 1, 1, 0, 2],
    diel: { dawn: -0.4, day: 0.3, dusk: -0.3, night: -0.5 }, // 夜は岸寄りの浅場へ
    colors: { top: '#5b5535', mid: '#9c9257', belly: '#ded7ad', fin: '#7c7143' },
    flavor: '「釣りはフナに始まりフナに終わる」。',
  },
  {
    id: 'ugui', name: 'ウグイ', rarity: 1, tags: ['mid'], shape: 'slim',
    len: [14, 42], wc: 1.35, depth: [0.5, 5.5], spawn: 28, times: T.any, weather: W.rain,
    str: 0.65, sta: 0.6, agg: 0.5, value: 24, perCm: 1.7,
    fight: 'jumper', pref: [3, 2, 2, 2, 2, 1, 2],
    colors: { top: '#4b5b6b', mid: '#8fa2ae', belly: '#f0f2f0', fin: '#c98a70' },
    flavor: '婚姻色の朱い帯が美しい。引きは意外に強い。',
  },
  {
    id: 'dojo', name: 'ドジョウ', rarity: 1, tags: ['bottom'], shape: 'eel',
    len: [8, 19], wc: 0.45, depth: [0.5, 4], spawn: 22, times: T.nightish, weather: W.rain,
    str: 0.4, sta: 0.45, agg: 0.2, value: 22, perCm: 2.4,
    fight: 'shake', pref: [3, 2, 1, 1, 1, 0, 2],
    colors: { top: '#4a3d2a', mid: '#7b6743', belly: '#d8c79a', fin: '#5b4b32' },
    flavor: '泥の中からにゅるり。にょろにょろと手強い。',
  },
  {
    id: 'oikawa', name: 'オイカワ', rarity: 1, tags: ['mid'], shape: 'slim',
    len: [8, 20], wc: 1.15, depth: [0.5, 4], spawn: 26, times: T.dayish, weather: W.clear,
    str: 0.45, sta: 0.45, agg: 0.5, value: 16, perCm: 1.4,
    fight: 'dash', pref: [2, 3, 1, 1, 0, 0, 2],
    colors: { top: '#5c6f78', mid: '#b9c6c8', belly: '#f2f0e6', fin: '#c98b9a' },
    flavor: '日中の浅場をきらきらと泳ぐ。オスは婚姻色が美しい。',
  },
  {
    id: 'tanago', name: 'タナゴ', rarity: 1, tags: ['weed', 'mid'], shape: 'deep',
    len: [5, 12], wc: 2.6, depth: [0.5, 3], spawn: 23, times: T.dayish, weather: W.any,
    str: 0.3, sta: 0.35, agg: 0.3, value: 20, perCm: 2.4,
    fight: 'dash', pref: [1, 3, 1, 0, 0, 0, 2],
    colors: { top: '#3b4a63', mid: '#8fa6c4', belly: '#f0ead8', fin: '#d98a5a' },
    flavor: '手のひらに収まる宝石。二枚貝に卵を産む。',
  },
  {
    id: 'prawn', name: 'テナガエビ', rarity: 1, tags: ['bottom', 'weed'], shape: 'shrimp',
    len: [8, 16], wc: 1.45, depth: [0.5, 4.5], spawn: 20, times: T.nightish, weather: W.any,
    str: 0.3, sta: 0.4, agg: 0.15, value: 22, perCm: 2.8,
    fight: 'dash', pref: [3, 2, 1, 1, 1, 0, 2],
    diel: { dawn: -0.2, day: 0.4, dusk: -0.4, night: -0.8 }, // 夜行性。暗くなると浅場へ出てくる
    colors: { top: '#5b6470', mid: '#a9b3bd', belly: '#e8eaea', fin: '#cfd6d4' },
    flavor: '長い腕をゆらり。夜、石の間から出てくる。素揚げが最高。',
  },
  {
    id: 'crayfish', name: 'ザリガニ', rarity: 1, tags: ['bottom', 'weed'], shape: 'crayfish',
    len: [5, 15], wc: 3.5, depth: [0.4, 3], spawn: 22, times: T.any, weather: W.any,
    str: 0.5, sta: 0.7, agg: 0.1, value: 14, perCm: 1.5,
    fight: 'deadweight', pref: [3, 2, 1, 2, 2, 0, 2],
    diel: { dawn: -0.2, day: 0.4, dusk: -0.4, night: -0.8 }, // 夜行性。暗くなると石の間から浅場へ出てくる
    colors: { top: '#7a2c1e', mid: '#c05334', belly: '#e8b18c', fin: '#8e3a24' },
    flavor: 'ハサミを振り上げて一歩も引かない。引くだけ引いて離さない。',
  },

  /* ---------------- アンコモン ---------------- */
  {
    id: 'rainbow', name: 'ニジマス', rarity: 2, tags: ['trout', 'mid'], shape: 'slim',
    len: [21, 54], wc: 1.3, depth: [1, 8.5], spawn: 20, times: T.twilight, weather: W.cloudy,
    str: 1.0, sta: 0.95, agg: 0.8, value: 90, perCm: 4.2,
    fight: 'jumper', pref: [2, 2, 1, 3, 2, 2, 2],
    layer: { // 朝夕は水面でライズ、日中は深い層へ落ちる
      dawn: { top: 1.0, mid: 0.9, bottom: 0.25 },
      day: { top: 0.3, mid: 0.85, bottom: 1.0 },
      dusk: { top: 1.0, mid: 0.9, bottom: 0.25 },
      night: { top: 0.6, mid: 1.0, bottom: 0.5 },
    },
    diel: { dawn: -0.6, day: 0.6, dusk: -0.6, night: -0.2 }, // 時間帯で生息水深も動く
    colors: { top: '#3f6a63', mid: '#93b3a8', belly: '#f2efe4', fin: '#d97a86' },
    flavor: '横腹に虹。銀鱗を翻して跳ねる。',
  },
  {
    id: 'bass', name: 'ブラックバス', rarity: 2, tags: ['predator', 'weed'], shape: 'wide',
    len: [24, 58], wc: 1.55, depth: [1, 7.5], spawn: 19, times: T.twilight, weather: W.cloudy,
    str: 1.15, sta: 1.0, agg: 1.1, value: 110, perCm: 4.6,
    fight: 'dash', pref: [1, 0, 0, 1, 2, 3, 2],
    layer: { // 朝夕はシャローの表層、日中はディープに落ちる。夜も浅い
      dawn: { top: 1.0, mid: 0.8, bottom: 0.2 },
      day: { top: 0.35, mid: 0.9, bottom: 1.0 },
      dusk: { top: 1.0, mid: 0.8, bottom: 0.2 },
      night: { top: 1.0, mid: 0.85, bottom: 0.35 },
    },
    diel: { dawn: -0.8, day: 0.7, dusk: -0.8, night: -0.3 }, // 時間帯で生息水深も動く
    colors: { top: '#2f4a2c', mid: '#6f8f52', belly: '#e3e0bd', fin: '#33472b' },
    flavor: '大口を開けて小魚を襲う。エラ洗いに注意。',
  },
  {
    id: 'yamame', name: 'ヤマメ', rarity: 2, tags: ['trout'], shape: 'slim',
    len: [17, 42], wc: 1.2, depth: [0.5, 5], spawn: 16, times: T.dawnOnly, weather: W.rain,
    str: 0.95, sta: 0.9, agg: 0.9, value: 130, perCm: 5.0,
    fight: 'jumper', pref: [2, 2, 1, 3, 2, 1, 2],
    layer: { // 朝マズメに水面を意識し、日中は沈む
      dawn: { top: 1.0, mid: 0.85, bottom: 0.2 },
      day: { top: 0.45, mid: 1.0, bottom: 0.7 },
      dusk: { top: 0.95, mid: 0.9, bottom: 0.25 },
      night: { top: 0.5, mid: 1.0, bottom: 0.5 },
    },
    colors: { top: '#3d5560', mid: '#96a8a6', belly: '#f4f0e2', fin: '#8d9a8e' },
    flavor: 'パーマークが並ぶ渓流の女王。神経質で警戒心が強い。',
  },
  {
    id: 'namazu', name: 'ナマズ', rarity: 2, tags: ['bottom', 'predator', 'deep'], shape: 'eel',
    len: [34, 84], wc: 1.25, depth: [3.5, 15], spawn: 15, times: T.nightish, weather: W.rain,
    str: 1.35, sta: 1.3, agg: 0.6, value: 150, perCm: 4.0,
    fight: 'shake', pref: [2, 1, 1, 1, 3, 3, 2],
    diel: { dawn: 0, day: 0.8, dusk: -0.5, night: -1 }, // 夜にシャローへ差して餌を探す。日中は深場の底
    colors: { top: '#3a3a2e', mid: '#6b6550', belly: '#cfc7a4', fin: '#4a463a' },
    flavor: '長いヒゲでゆらり。掛かると重量感のある首振り。',
  },
  {
    id: 'koi', name: 'コイ', rarity: 2, tags: ['carp', 'bottom'], shape: 'wide',
    len: [38, 92], wc: 2.5, depth: [1.5, 9.5], spawn: 14, times: T.any, weather: W.cloudy,
    str: 1.5, sta: 1.55, agg: 0.5, value: 170, perCm: 3.6,
    fight: 'tank', pref: [2, 1, 3, 1, 1, 0, 2],
    diel: { dawn: -0.6, day: 0.5, dusk: -0.4, night: -0.8 }, // 夜から朝マズメに浅場へ入って餌を漁る
    colors: { top: '#5a4a2c', mid: '#a3854a', belly: '#e6dcb4', fin: '#7c6234' },
    flavor: '悠然と泳ぐ湖の主候補。走り出すと止まらない。',
  },
  {
    id: 'wakasagi', name: 'ワカサギ', rarity: 2, tags: ['mid', 'deep'], shape: 'slim',
    len: [7, 16], wc: 0.85, depth: [4, 14], spawn: 15, times: T.twilight, weather: W.cloudy,
    str: 0.5, sta: 0.5, agg: 0.45, value: 70, perCm: 4.6,
    fight: 'dash', pref: [1, 3, 1, 0, 0, 0, 2],
    layer: { // プランクトンを追って昼は深い層、朝夕〜夜は浮く（氷上釣りでも昼は底層）
      dawn: { top: 0.95, mid: 1.0, bottom: 0.3 },
      day: { top: 0.15, mid: 0.7, bottom: 1.0 },
      dusk: { top: 0.95, mid: 1.0, bottom: 0.3 },
      night: { top: 1.0, mid: 0.9, bottom: 0.2 },
    },
    colors: { top: '#5b6c74', mid: '#c3ced2', belly: '#f6f4ec', fin: '#dfe3e0' },
    flavor: '深場を群れで回る細身の小魚。天ぷらの王様。',
  },
  {
    id: 'nigoi', name: 'ニゴイ', rarity: 2, tags: ['bottom', 'carp'], shape: 'slim',
    len: [26, 64], wc: 1.15, depth: [1.5, 10], spawn: 14, times: T.any, weather: W.cloudy,
    str: 1.2, sta: 1.15, agg: 0.6, value: 100, perCm: 3.8,
    fight: 'tank', pref: [3, 2, 2, 1, 1, 0, 2],
    colors: { top: '#57605c', mid: '#a7aea4', belly: '#eceade', fin: '#8b8f84' },
    flavor: 'コイに似て口先が長い。底を突きながら餌を探す。',
  },
  {
    id: 'hasu', name: 'ハス', rarity: 2, tags: ['predator', 'mid'], shape: 'slim',
    len: [22, 52], wc: 1.1, depth: [1, 7], spawn: 13, times: T.dayish, weather: W.clear,
    str: 1.1, sta: 0.95, agg: 1.35, value: 140, perCm: 5.2,
    fight: 'dash', pref: [1, 0, 0, 1, 2, 3, 2],
    colors: { top: '#41525f', mid: '#9fb0b4', belly: '#f3f1e4', fin: '#b8bfae' },
    flavor: 'コイ科なのに小魚を追う。への字の口が特徴。',
  },
  {
    id: 'mokuzugani', name: 'モクズガニ', rarity: 2, tags: ['bottom'], shape: 'crab',
    len: [6, 14], wc: 14, depth: [1, 8], spawn: 12, times: T.nightish, weather: W.rain,
    str: 0.9, sta: 1.3, agg: 0.1, value: 240, perCm: 9,
    fight: 'deadweight', pref: [3, 1, 1, 2, 2, 0, 2],
    diel: { dawn: -0.2, day: 0.4, dusk: -0.4, night: -0.8 }, // 夜に浅場を歩き回る
    colors: { top: '#3f4a3c', mid: '#75775e', belly: '#c9c2a4', fin: '#565a48' },
    flavor: 'ハサミに毛の生えた川のカニ。味は絶品、根掛かりのように重い。',
  },

  /* ---------------- レア ---------------- */
  {
    id: 'iwana', name: 'イワナ', rarity: 3, tags: ['trout', 'deep'], shape: 'slim',
    len: [24, 62], wc: 1.25, depth: [3, 13], spawn: 9, times: T.dawnOnly, weather: W.rain,
    str: 1.25, sta: 1.15, agg: 1.0, value: 340, perCm: 8.0,
    fight: 'shake', pref: [2, 2, 1, 3, 2, 2, 3],
    layer: { // 日中は底に張り付き、朝夕に浮いて虫を食う
      dawn: { top: 0.8, mid: 1.0, bottom: 0.5 },
      day: { top: 0.15, mid: 0.7, bottom: 1.0 },
      dusk: { top: 0.8, mid: 1.0, bottom: 0.5 },
      night: { top: 0.35, mid: 1.0, bottom: 0.85 },
    },
    diel: { dawn: -0.5, day: 0.5, dusk: -0.5, night: 0 }, // 時間帯で生息水深も動く
    colors: { top: '#2f4048', mid: '#7d8f8c', belly: '#f0e9d2', fin: '#c9a06d' },
    flavor: '白い斑点をまとう冷水の主。深い淵の底に潜む。',
  },
  {
    id: 'snakehead', name: 'ライギョ', rarity: 3, tags: ['predator', 'weed'], shape: 'eel',
    len: [38, 94], wc: 1.15, depth: [0.5, 4.5], spawn: 8, times: T.dayish, weather: W.clear,
    str: 1.6, sta: 1.4, agg: 1.5, value: 380, perCm: 7.2,
    fight: 'dash', pref: [0, 0, 0, 0, 2, 3, 3],
    layer: { // 日中は水面のカバーで浮いている。夜は沈む（他の魚と逆）
      dawn: { top: 0.9, mid: 0.9, bottom: 0.4 },
      day: { top: 1.0, mid: 0.7, bottom: 0.15 },
      dusk: { top: 0.95, mid: 0.85, bottom: 0.3 },
      night: { top: 0.4, mid: 0.9, bottom: 1.0 },
    },
    colors: { top: '#33402a', mid: '#6d7a45', belly: '#d3cf9d', fin: '#3e4a2c' },
    flavor: '藻の陰から爆発的に襲いかかる雷魚。ドラグが鳴る。',
  },
  {
    id: 'grasscarp', name: 'ソウギョ', rarity: 3, tags: ['carp', 'weed'], shape: 'slim',
    len: [52, 118], wc: 1.7, depth: [1.5, 8], spawn: 7, times: T.dayish, weather: W.clear,
    str: 1.85, sta: 1.8, agg: 0.7, value: 420, perCm: 6.4,
    fight: 'tank', pref: [1, 0, 2, 0, 0, 0, 3],
    layer: { top: 0.9, mid: 0.85, bottom: 0.5 }, // 水面の水草を食べる
    colors: { top: '#4d5340', mid: '#95a077', belly: '#e5e3c6', fin: '#6c7452' },
    flavor: '水草を食べる巨体。一度走られたら覚悟が必要。',
  },
  {
    id: 'biwatrout', name: 'ビワマス', rarity: 3, tags: ['trout', 'deep'], shape: 'slim',
    len: [29, 68], wc: 1.35, depth: [6, 19], spawn: 7, times: T.twilight, weather: W.cloudy,
    str: 1.45, sta: 1.3, agg: 1.2, value: 460, perCm: 8.6,
    fight: 'jumper', pref: [1, 1, 0, 3, 2, 3, 3],
    layer: { // 朝は浅い層に上がり、日中は深層へ（トローリングの定番）
      dawn: { top: 0.9, mid: 1.0, bottom: 0.35 },
      day: { top: 0.1, mid: 0.65, bottom: 1.0 },
      dusk: { top: 0.75, mid: 1.0, bottom: 0.5 },
      night: { top: 0.3, mid: 1.0, bottom: 0.8 },
    },
    diel: { dawn: -0.7, day: 0.7, dusk: -0.5, night: 0 }, // 時間帯で生息水深も動く
    colors: { top: '#2b4a5e', mid: '#8fa8b6', belly: '#f5f1e6', fin: '#b06a72' },
    flavor: '深層を回遊する幻の鱒。銀色の魚体に淡い紅。',
  },
  {
    id: 'unagi', name: 'ウナギ', rarity: 3, tags: ['bottom', 'deep'], shape: 'eel',
    len: [40, 100], wc: 0.6, depth: [2, 12], spawn: 7, times: T.nightish, weather: W.rain,
    str: 1.5, sta: 1.75, agg: 0.5, value: 520, perCm: 9.5,
    fight: 'shake', pref: [3, 1, 0, 1, 3, 2, 3],
    diel: { dawn: 0.2, day: 0.7, dusk: -0.4, night: -1 }, // 日中は底の穴に潜み、夜に浅場へ出てくる
    colors: { top: '#2c2b28', mid: '#5a5646', belly: '#e0d8b8', fin: '#3a382e' },
    flavor: '夜、底穴から出て餌を探す。掛けてからが本当の勝負。',
  },
  {
    id: 'sakuramasu', name: 'サクラマス', rarity: 3, tags: ['trout', 'deep'], shape: 'slim',
    len: [34, 72], wc: 1.4, depth: [5, 17], spawn: 6, times: T.twilight, weather: W.rain,
    str: 1.6, sta: 1.45, agg: 1.35, value: 600, perCm: 9.5,
    fight: 'jumper', pref: [1, 1, 0, 3, 2, 3, 3],
    layer: { // 朝夕は浮き、日中は深い層に落ちる
      dawn: { top: 1.0, mid: 0.95, bottom: 0.3 },
      day: { top: 0.25, mid: 0.8, bottom: 1.0 },
      dusk: { top: 0.95, mid: 1.0, bottom: 0.35 },
      night: { top: 0.4, mid: 1.0, bottom: 0.7 },
    },
    diel: { dawn: -0.6, day: 0.6, dusk: -0.6, night: 0 }, // 時間帯で生息水深も動く
    colors: { top: '#3a5566', mid: '#c2ccd2', belly: '#faf7ee', fin: '#d98f96' },
    flavor: '海へ降りずに残った銀鱗。桜の頃に走り出す。',
  },
  {
    id: 'aouo', name: 'アオウオ', rarity: 3, tags: ['carp', 'deep'], shape: 'wide',
    len: [60, 140], wc: 1.85, depth: [4, 16], spawn: 5.5, times: T.any, weather: W.cloudy,
    str: 2.0, sta: 2.0, agg: 0.6, value: 560, perCm: 7,
    fight: 'tank', pref: [1, 0, 1, 0, 2, 0, 3],
    colors: { top: '#3b4149', mid: '#6f7a7d', belly: '#d9dcc9', fin: '#4d565a' },
    flavor: '貝を砕いて食う黒い巨体。ソウギョより重く、粘る。',
  },

  /* ---------------- エピック ---------------- */
  {
    id: 'sturgeon', name: 'チョウザメ', rarity: 4, tags: ['deep', 'bottom'], shape: 'sturgeon',
    len: [78, 168], wc: 1.05, depth: [10, 24], spawn: 3.0, times: T.nightish, weather: W.cloudy,
    str: 2.3, sta: 2.3, agg: 0.9, value: 1400, perCm: 16,
    fight: 'tank', pref: [2, 1, 1, 2, 3, 2, 3],
    colors: { top: '#3d4a55', mid: '#7d8d99', belly: '#dfe3e0', fin: '#4d5a63' },
    flavor: '古代の姿を残す魚。背の硬鱗が水中でぬめりと光る。',
  },
  {
    id: 'gar', name: 'アリゲーターガー', rarity: 4, tags: ['predator', 'deep'], shape: 'gar',
    len: [86, 196], wc: 0.9, depth: [4, 16], spawn: 2.6, times: T.nightish, weather: W.clear,
    str: 2.6, sta: 2.1, agg: 1.7, value: 1700, perCm: 17,
    fight: 'dash', pref: [0, 0, 0, 0, 1, 3, 3],
    layer: { top: 0.95, mid: 1.0, bottom: 0.5 }, // 水面で空気を吸う
    colors: { top: '#3c4433', mid: '#7c8560', belly: '#d6d3ab', fin: '#4a5238' },
    flavor: 'ワニのような顎。誰が湖に放したのか、誰も知らない。',
  },

  /* ---------------- レジェンド ---------------- */
  {
    id: 'nushi', name: '湖の主', rarity: 5, tags: ['deep', 'predator', 'legend'], shape: 'eel',
    len: [138, 232], wc: 1.6, depth: [14, 28], spawn: 0.32, times: T.nightish, weather: W.rain,
    /* str は元 3.3 だったが、tank パターン（pull 常時 1.12 倍・resist が pull×0.75 で
       下限 0.35 に張り付く）と組み合わせると、最強装備（伝説+PE3号）でも大型個体の
       着地率が 1 桁%まで落ちる検証結果になったため 2.8 に調整。伝説の魚として
       「tank 系では最強」の地位は保ったまま、最強装備なら平均個体はほぼ確実に、
       最大個体でも 9 割前後は獲れる水準にした（同じ str=3.5 でも jumper パターンの
       イトウはほぼ 100% 獲れており、tank と jumper で必要な str のスケールが違う） */
    str: 2.8, sta: 3.2, agg: 1.4, value: 7000, perCm: 34,
    fight: 'tank', pref: [1, 0, 0, 0, 2, 3, 3],
    layer: { // 夜は中層まで上がってくる。日中は淵の底で動かない
      dawn: { top: 0.5, mid: 1.0, bottom: 0.9 },
      day: { top: 0.1, mid: 0.6, bottom: 1.0 },
      dusk: { top: 0.5, mid: 1.0, bottom: 0.9 },
      night: { top: 0.7, mid: 1.0, bottom: 0.7 },
    },
    diel: { dawn: -0.2, day: 0.5, dusk: -0.2, night: -0.5 }, // 時間帯で生息水深も動く
    colors: { top: '#22262a', mid: '#4b5157', belly: '#9aa3a6', fin: '#2c3135' },
    flavor: '湖底の岩屋に潜む巨大ナマズ。村の古老が「あれには触るな」と言った。',
  },
  {
    id: 'itou', name: 'イトウ', rarity: 5, tags: ['trout', 'predator', 'deep', 'legend'], shape: 'slim',
    len: [95, 210], wc: 1.1, depth: [10, 26], spawn: 0.38, times: T.twilight, weather: W.rain,
    str: 3.5, sta: 3.5, agg: 1.7, value: 9500, perCm: 42,
    fight: 'jumper', pref: [1, 0, 0, 2, 2, 3, 3],
    layer: { // 朝夕に浅場の表層で待ち伏せ、日中は深場の底へ
      dawn: { top: 1.0, mid: 0.9, bottom: 0.3 },
      day: { top: 0.3, mid: 0.9, bottom: 1.0 },
      dusk: { top: 1.0, mid: 0.9, bottom: 0.3 },
      night: { top: 0.6, mid: 1.0, bottom: 0.6 },
    },
    diel: { dawn: -0.8, day: 0.5, dusk: -0.8, night: -0.2 }, // 時間帯で生息水深も動く
    colors: { top: '#41504e', mid: '#9aa8a2', belly: '#f2ecdc', fin: '#b6837a' },
    flavor: '幻の巨大魚。深場の縁でゆっくりと大きな尾を振る。',
  },
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map((s) => [s.id, s]));
export const REAL_FISH = SPECIES.filter((s) => s.rarity > 0);
export const JUNK = SPECIES.filter((s) => s.rarity === 0);

/* ===========================================================
   装備
   =========================================================== */

/* cast = 狙える最大距離（m）。遠くへ投げられる竿ほど深い場所に届く＝釣れる魚が増える。
   湖の生成（lakefield）はこの配列から検証距離を決める：
     一番飛ぶ竿（84m）… この距離までに全魚種の生息層があることを保証する
     最初の竿（26m）  … 深い淵はこの距離の外に置く（＝竿を買い替える動機にする）
   最初の竿を伸ばせば淵も一緒に遠ざかるので、どう変えても詰みにはならない */
export const RODS = [
  {
    id: 'bamboo', name: '竹の釣り竿', icon: 'rod-bamboo', price: 0, level: 1,
    reel: 0.85, power: 1.0, attract: 1.0, cast: 10,
    desc: '祖父から受け継いだ一本。足元にしか届かず、沖の深みには遠く及ばない。',
  },
  {
    id: 'glass', name: 'グラスファイバーロッド', icon: 'rod-glass', price: 700, level: 2,
    reel: 1.0, power: 1.22, attract: 1.05, cast: 38,
    desc: '扱いやすい万能竿。ひと回り遠く、かけあがりの先まで届く。',
  },
  {
    id: 'carbon', name: 'カーボンロッド', icon: 'rod-carbon', price: 3200, level: 5,
    reel: 1.16, power: 1.48, attract: 1.12, cast: 52,
    desc: '軽量高弾性。沖の淵が射程に入り、魚の引きもよく吸収してくれる。',
  },
  {
    id: 'master', name: '名匠竿「渓月」', icon: 'rod-master', price: 11000, level: 9,
    reel: 1.32, power: 1.8, attract: 1.2, cast: 68,
    desc: '職人が一年かけて削り上げた逸品。岸に立ったままでも深場を叩ける。',
  },
  {
    id: 'legend', name: '伝説の竿「湖鳴」', icon: 'rod-legend', price: 38000, level: 14,
    reel: 1.52, power: 2.2, attract: 1.32, cast: 84,
    desc: '湖の主を釣り上げるために鍛えられたという竿。どこに立っても淵に届く。',
  },
];

/* ラインは「素材（ナイロン／フロロ／PE）× 号数（1〜3号）」の組み合わせ。
   号数は同じ素材内での強度の階段（1号<2号<3号）だけを動かし、素材が強度以外の
   性格（一長一短）を決める：
     ナイロン: よく伸びて衝撃を逃がす＝テンションが上がりにくく寛容。その代わり強度は
               控えめで、アタリを感じにくいぶんアワセの猶予も短い
     フロロ  : 水中で見えにくくアタリが速い。強度・寛容さ・アワセ猶予は標準的な中間型
     PE      : 同じ太さなら圧倒的な強度で、伸びがほぼ無いぶんアタリが直に伝わり
               アワセの猶予は一番長い。ただし糸が目立ちやすくアタリはやや遅く、
               テンションが急に上がる（＝寛容さは最低）ので巻き方が雑だとすぐ切れる
   attract: アタリまでの速さ倍率（bait.attract 等と同じ意味）
   shock  : ファイト中のテンション増加倍率（低いほど衝撃を逃がして粘る＝寛容）
   biteWindow: アワセ猶予（アタリ本番の反応時間）の倍率 */
export const LINES = [
  { id: 'nylon1', name: 'ナイロン 1号', icon: 'line-nylon', price: 0, level: 1,
    cap: 0.72, attract: 1.08, shock: 0.9, biteWindow: 0.85,
    desc: '最も手頃な一本。細く目立たないぶんアタリは速いが、すぐ切れる。' },
  { id: 'nylon2', name: 'ナイロン 2号', icon: 'line-nylon', price: 0, level: 1,
    cap: 1.0, attract: 1.0, shock: 0.9, biteWindow: 0.85,
    desc: '標準的な太さの万能糸。伸びが衝撃を逃がすので粘り強い。' },
  { id: 'nylon3', name: 'ナイロン 3号', icon: 'line-nylon', price: 300, level: 2,
    cap: 1.35, attract: 0.92, shock: 0.9, biteWindow: 0.85,
    desc: '太くして強度を底上げした一本。太いぶんアタリはやや遅い。' },
  { id: 'fluoro1', name: 'フロロカーボン 1号', icon: 'line-fluoro', price: 260, level: 1,
    cap: 1.12, attract: 1.24, shock: 1.0, biteWindow: 1.0,
    desc: '水中で見えにくい細糸。食いつきは抜群だが心もとない太さ。' },
  { id: 'fluoro2', name: 'フロロカーボン 2号', icon: 'line-fluoro', price: 850, level: 3,
    cap: 1.55, attract: 1.15, shock: 1.0, biteWindow: 1.0,
    desc: '見えにくさと強さのバランスが良い定番。' },
  { id: 'fluoro3', name: 'フロロカーボン 3号', icon: 'line-fluoro', price: 1900, level: 6,
    cap: 2.09, attract: 1.06, shock: 1.0, biteWindow: 1.0,
    desc: '見えにくさはそのままに強度を底上げした一本。' },
  { id: 'pe1', name: 'PEライン 1号', icon: 'line-pe', price: 1400, level: 4,
    cap: 1.66, attract: 0.95, shock: 1.1, biteWindow: 1.2,
    desc: '伸びない高強度糸。アタリは直に伝わるが目立ちやすい。' },
  { id: 'pe2', name: 'PEライン 2号', icon: 'line-pe', price: 4200, level: 8,
    cap: 2.3, attract: 0.88, shock: 1.1, biteWindow: 1.2,
    desc: '扱いやすい太さの高強度ライン。伸びない分すぐ張り詰める。' },
  { id: 'pe3', name: 'PEライン 3号', icon: 'line-pe', price: 9500, level: 12,
    cap: 3.11, attract: 0.81, shock: 1.1, biteWindow: 1.2,
    desc: 'とにかく強いが、伸びず目立つ玄人向けの一本。太くて最もアタリが遅い。' },
];
/** 旧セーブ（素材だけでサイズの無かった頃）からの読み替え */
export const LINE_ALIAS = { nylon: 'nylon2', fluoro: 'fluoro2', pe: 'pe2', spider: 'pe3', mithril: 'pe3' };

/**
 * depth: エサが到達する狙いの水深(m)
 * attract: アタリまでの速さ倍率
 * rare: レア度ボーナス
 * junk: ゴミを引く確率の倍率
 */
/* エサ（ルアーは廃止。放置して待つ釣りに合わないため、すべて置き餌・生き餌に統一）
   depth は持たない：狙う層（タナ）はプレイヤーが仕掛け側で決める。
   食いつきはタグの相性平均ではなく、魚種ごとに直接持たせた好き嫌い表
   （SPECIES の pref、後述の baitPrefMult）で決まる */
export const BAITS = [
  {
    id: 'worm', name: 'ミミズ', icon: 'bait-worm', price: 0, level: 1, pack: 10,
    attract: 1.0, rare: 1.0, junk: 1.0,
    desc: '万能の置き餌。底を突く魚に強い。',
  },
  {
    id: 'akamushi', name: 'アカムシ', icon: 'bait-akamushi', price: 180, level: 1, pack: 20,
    attract: 1.14, rare: 0.88, junk: 0.9,
    desc: '極小の赤い虫。小物のアタリが速いが、大物は寄らない。',
  },
  {
    id: 'dough', name: '練り餌', icon: 'bait-dough', price: 250, level: 1, pack: 20,
    attract: 1.08, rare: 1.05, junk: 0.8,
    desc: 'フナ・コイの大好物。練り込んで針に付ける。',
  },
  {
    id: 'roe', name: 'イクラ', icon: 'bait-roe', price: 900, level: 2, pack: 15,
    attract: 1.16, rare: 1.15, junk: 0.6,
    desc: '鱒が目の色を変える一粒。流れの中で映える。',
  },
  {
    id: 'shrimp', name: '川エビ', icon: 'bait-shrimp', price: 1600, level: 3, pack: 12,
    attract: 1.2, rare: 1.25, junk: 0.5,
    desc: '生きたまま付ける定番の生き餌。何にでも効く。',
  },
  {
    id: 'minnow', name: '小魚（泳がせ）', icon: 'bait-minnow', price: 3800, level: 6, pack: 10,
    attract: 1.22, rare: 1.45, junk: 0.4,
    desc: '生きた小魚を泳がせる大物狙い。小魚（ワカサギ・メダカ等）は絶対に食いつかない。',
  },
  {
    id: 'secret', name: '秘伝の撒き餌', icon: 'bait-secret', price: 12000, level: 10, pack: 3,
    attract: 1.7, rare: 2.2, junk: 0.25,
    desc: '老人が「主を呼ぶ」と言って売ってくれた壺。何かがおかしい匂い。',
  },
];

/* ===========================================================
   エサの好き嫌い（0〜3 の整数表 → 倍率）
   タグの相性平均だと、無関係な理由（例：同じ深場タグを持つだけ）で
   食いつきが薄まったり水増しされたりする（例：ワカサギが泳がせ餌に
   寄ってしまう問題）。魚種ごとに「このエサをどれだけ好むか」を直接
   持たせることで、そういう事故を起こさず、生態に合わない組み合わせを
   確実に 0（絶対に食いつかない）にできる。
     0 = 食べない（絶対に釣れない）　1 = 苦手だが食べなくはない
     2 = ふつう　3 = 好物
   BAITS の並び（worm, akamushi, dough, roe, shrimp, minnow, secret）と
   同じ順で SPECIES 側に pref: [n,n,n,n,n,n,n] を持たせる */
export const PREF_MULT = [0, 0.5, 1.0, 1.6];
export const BAIT_ORDER = ['worm', 'akamushi', 'dough', 'roe', 'shrimp', 'minnow', 'secret'];

/** 魚種 sp が、エサ bait にどれだけ食いつくか（倍率）。pref 未設定の魚（ゴミ等）は 1 固定 */
export function baitPrefMult(sp, bait) {
  if (!sp.pref) return 1;
  const i = BAIT_ORDER.indexOf(bait.id);
  const p = i >= 0 ? sp.pref[i] : 2;
  return PREF_MULT[p] ?? 1;
}

/* ===========================================================
   タナ（狙う層）— 3 択。実際の深さは着水地点の水深に対する比率で決まる
   =========================================================== */
export const RIG_LAYERS = [
  { id: 'top', name: '表層', short: '水面近く', ratio: 0.15, desc: '水面直下。小物と、水面を意識する魚' },
  { id: 'mid', name: '中層', short: '真ん中', ratio: 0.5, desc: '真ん中。回遊してくる魚に広く当たる' },
  { id: 'bottom', name: '底層', short: '底べた', ratio: 0.88, desc: '底べた。大物と底モノ。ゴミも増える' },
];
export const rigLayerOf = (id) => RIG_LAYERS.find((l) => l.id === id) || RIG_LAYERS[1];

/* ===========================================================
   遊泳層（水中のどの層で食うか）と 生息水深（どの水深の場所に居るか）

   sp.depth は「その魚が居る場所の水深」だけを表す。水中のどの層で
   食いつくかは別軸で、下の重み（表層/中層/底層）で表す。
   両方を掛けるので「水深 20m の表層でドジョウ」「浅場の表層で底物」が
   起きなくなる。未指定ならタグ・体型から自動で決まる。
   =========================================================== */
const SWIM = {
  bottom: { top: 0.05, mid: 0.40, bottom: 1.00 },   // 底物・ヒゲ物・甲殻類
  carp: { top: 0.15, mid: 0.70, bottom: 1.00 },     // コイ科（底を漁る）
  surface: { top: 1.00, mid: 0.85, bottom: 0.30 },  // 藻場の肉食魚（水面を襲う）
  trout: { top: 0.80, mid: 1.00, bottom: 0.45 },    // 鱒（中層〜表層）
  midwater: { top: 0.90, mid: 1.00, bottom: 0.35 }, // 中層を群れで回る小物
  deepPred: { top: 0.30, mid: 0.85, bottom: 1.00 }, // 深場の底に着く大型肉食魚
  any: { top: 0.55, mid: 1.00, bottom: 0.75 },
};

/** タグから決まる既定の遊泳層 */
function defaultSwim(sp) {
  if (sp.rarity === 0) return SWIM.bottom;                       // ゴミは底に沈んでいる
  const t = sp.tags;
  if (t.includes('weed') && t.includes('predator')) return SWIM.surface;
  if (t.includes('bottom')) return SWIM.bottom;
  if (t.includes('carp')) return SWIM.carp;
  if (t.includes('trout')) return SWIM.trout;
  if (t.includes('predator') && t.includes('deep')) return SWIM.deepPred;
  if (t.includes('mid')) return SWIM.midwater;
  return SWIM.any;
}

/**
 * 魚の遊泳層。
 * sp.layer は {top,mid,bottom} か、時間帯ごとの {dawn:{...}, day:{...}, ...}。
 * 後者は日周鉛直移動（昼は深い層／朝夕は浮く など）を表す。
 * band を渡さない場合は 4 時間帯の平均（図鑑の表示用）。
 */
export function swimLayer(sp, band = null) {
  const raw = sp.layer || defaultSwim(sp);
  if (raw.top !== undefined) return raw;
  if (band && raw[band]) return raw[band];
  const bands = ['dawn', 'day', 'dusk', 'night'];
  const out = { top: 0, mid: 0, bottom: 0 };
  for (const b of bands) for (const k of ['top', 'mid', 'bottom']) out[k] += raw[b][k] / bands.length;
  return out;
}

/** 図鑑・表に出す遊泳層の短い名前（重み 0.8 以上の層を拾う） */
export function swimLayerLabel(sp, band = null) {
  const L = swimLayer(sp, band);
  const on = RIG_LAYERS.filter((x) => L[x.id] >= 0.8).map((x) => x.name.replace('層', ''));
  if (!on.length) return RIG_LAYERS.reduce((a, x) => (L[x.id] > L[a.id] ? x : a), RIG_LAYERS[1]).name;
  return on.length === 3 ? '全層' : on.join('〜') + '層';
}

/* ---------------- 底質・ストラクチャー ----------------
   底質は底を釣るときだけ強く効く（表層で泥か砂かは関係ない）。
   値はタグごとの「増減」で、平均を取って 1 + delta として掛ける */
const BED_AFF = {
  sand: { bottom: 1.30, carp: 1.15, deep: 1.10, trout: 1.05, predator: 0.90, weed: 0.70 },
  rock: { predator: 1.50, weed: 1.35, trout: 1.25, bottom: 1.10, deep: 0.95, carp: 0.70 },
  mud: { carp: 1.50, bottom: 1.45, deep: 1.10, weed: 1.05, predator: 0.80, trout: 0.75 },
};
export const BED_LABEL = { sand: '砂地', rock: '岩場', mud: '泥底' };

/**
 * 底質の効き（タグ平均の倍率）。
 * bottomness = その層がどれだけ底に近いか（底層 1 / 中層 0.35 / 表層 0.1）で
 * 効きを弱めるので、表層では底が砂か泥かはほとんど関係しない
 */
export function bedAffinity(sp, bedKind, bottomness = 1) {
  const t = BED_AFF[bedKind];
  if (!t) return 1;
  let sum = 0, n = 0;
  for (const tag of sp.tags) if (t[tag] !== undefined) { sum += t[tag]; n++; }
  if (!n) return 1;
  return Math.pow(sum / n, bottomness);
}

/** 水中ストラクチャー（沈み岩・立ち枯れ）が近いときの倍率 */
export function structureBonus(sp) {
  const t = sp.tags;
  if (t.includes('predator') || t.includes('weed')) return 1.45;
  if (t.includes('bottom')) return 1.3;
  if (t.includes('trout')) return 1.15;
  return 0.95;                                  // 開けた水域を回る魚は少し落ちる
}

/* ---------------- 日周移動（時間帯で釣れる深さが変わる） ---------------- */
/** sp.diel[band]：−1 で浅場寄り / +1 で深場寄り。生息水深の帯をずらす量に使う */
export const dielShift = (sp, band) => (sp.diel && band ? sp.diel[band] ?? 0 : 0);

/** その時間帯の生息水深帯（日周移動で上下にずれる。ずれ幅は帯の 35%） */
export function depthBandAt(sp, band = null) {
  const [d0, d1] = sp.depth;
  const s = dielShift(sp, band);
  if (!s) return [d0, d1];
  const amp = (d1 - d0) * 0.35 * s;
  return [Math.max(0.4, d0 + amp), Math.max(0.9, d1 + amp)];
}

/** 「その時間帯にどのくらい深い所に居るか」0（表層）〜1（底）の目安 */
function depthScore(sp, band) {
  const L = swimLayer(sp, band);
  const sum = L.top + L.mid + L.bottom || 1;
  const rel = (L.mid * 0.5 + L.bottom) / sum;              // 層の好み
  return rel + dielShift(sp, band) * 0.22;                 // 場所の深浅も足す
}

const BAND_NAME = { dawn: '朝', day: '日中', dusk: '夕', night: '夜' };

/** 図鑑に出す一言（例「日中は深く・朝夕は浅く」）。動きが小さい魚は null */
export function dielNote(sp) {
  const bands = ['dawn', 'day', 'dusk', 'night'];
  const sc = bands.map((b) => [b, depthScore(sp, b)]);
  const lo = sc.reduce((a, x) => (x[1] < a[1] ? x : a));
  const hi = sc.reduce((a, x) => (x[1] > a[1] ? x : a));
  if (hi[1] - lo[1] < 0.1) return null;
  const near = (v) => sc.filter(([, x]) => Math.abs(x - v) < 0.045).map(([b]) => b);
  const nm = (list) => {
    const l = [...list];
    if (l.includes('dawn') && l.includes('dusk')) {                // 朝と夕はまとめる
      return ['朝夕', ...l.filter((b) => b !== 'dawn' && b !== 'dusk').map((b) => BAND_NAME[b])].join('・');
    }
    return l.map((b) => BAND_NAME[b]).join('・');
  };
  return `${nm(near(hi[1]))}は深く・${nm(near(lo[1]))}は浅く`;
}

/**
 * 生息水深との適合（その場所の水深が、その魚が居る水深か）
 * 帯の中 1.0 → 外れるほど線形に 0 まで落ちる。
 *  浅い側は d0 の 35%（最低 1m）だけ許す ＝ 深場の魚は浅場に出て来ない
 *  深い側は帯の幅の 90%（最低 2.5m）だけ許す ＝ 少し深いだけなら居る
 * 例）ドジョウ [0.5, 4] → 水深 7.2m 以上で 0（20m の場所には居ない）
 *     湖の主 [14, 28] → 水深 9.1m 未満で 0
 */
export function depthFit(sp, depth, band = null) {
  const [d0, d1] = depthBandAt(sp, band);
  if (depth >= d0 && depth <= d1) return 1;
  const tol = depth < d0 ? Math.max(1.0, d0 * 0.35) : Math.max(2.5, (d1 - d0) * 0.9);
  const out = depth < d0 ? d0 - depth : depth - d1;
  return Math.max(0, 1 - out / tol);
}

/** 旧セーブ（ルアー）からの読み替え */
export const BAIT_ALIAS = { spoon: 'roe', frog: 'shrimp', crank: 'minnow' };

/** タグの日本語名（ショップ・マニュアルの表示用） */
export const TAG_LABEL = {
  bottom: '底物', mid: '中層', weed: '藻場', carp: 'コイ科',
  trout: '鱒', predator: '肉食魚', deep: '深場', legend: '伝説',
};

/* ===========================================================
   ショップの表示（内部数値は出さず、同じ種類の中での相対位置を言葉にする）
   =========================================================== */
const STAT_WORDS = {
  cast: ['短い', 'やや短い', 'ふつう', '遠い', 'とても遠い'],
  reel: ['ゆっくり', 'やや遅い', 'ふつう', '速い', 'とても速い'],
  power: ['弱い', 'やや弱い', 'ふつう', '強い', 'とても強い'],
  attractRod: ['ふつう', 'やや高い', '高い', 'かなり高い', '抜群'],
  cap: ['弱い', 'やや弱い', 'ふつう', '強い', 'とても強い'],
  attractBait: ['ふつう', 'やや速い', '速い', 'かなり速い', '抜群'],
  rare: ['出にくい', 'ふつう', 'やや出やすい', '出やすい', 'かなり出やすい'],
  junk: ['多い', 'やや多い', 'ふつう', '少ない', 'とても少ない'],
  shock: ['よく粘る', '粘る', 'ふつう', 'やや硬い', '直に伝わる'],
  biteWindow: ['短い', 'やや短い', 'ふつう', 'やや長い', '長い'],
  attractLine: ['遅い', 'やや遅い', 'ふつう', 'やや速い', '速い'],
};

/** 同種アイテム内での順位を言葉に（invert = 小さいほど良い） */
function rankWord(items, get, it, words, invert = false) {
  const vals = [...new Set(items.map(get))].sort((a, b) => a - b);
  const i = vals.indexOf(get(it));
  let t = vals.length > 1 ? i / (vals.length - 1) : 0.5;
  if (invert) t = 1 - t;
  return words[Math.round(t * (words.length - 1))];
}

/** しきい値で言葉を選ぶ（1.0 が基準の倍率パラメータ用） */
function cutWord(v, cuts, words) {
  for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return words[i];
  return words[words.length - 1];
}

/** ショップに出す「ラベル＋言葉」の一覧。数値（内部パラメータ）は出さない */
export function gearStats(kind, it) {
  if (kind === 'rod') {
    // ロッド・ラインは価格順の階段なので、同種の中での順位を言葉にする
    return [
      ['飛距離', `${rankWord(RODS, (r) => r.cast, it, STAT_WORDS.cast)}（${it.cast}m）`],
      ['巻き取り', rankWord(RODS, (r) => r.reel, it, STAT_WORDS.reel)],
      ['竿の力', rankWord(RODS, (r) => r.power, it, STAT_WORDS.power)],
      ['集魚力', rankWord(RODS, (r) => r.attract, it, STAT_WORDS.attractRod)],
    ];
  }
  if (kind === 'line') {
    return [
      ['強度', rankWord(LINES, (l) => l.cap, it, STAT_WORDS.cap)],
      ['アタリ', rankWord(LINES, (l) => l.attract, it, STAT_WORDS.attractLine)],
      ['粘り', rankWord(LINES, (l) => l.shock, it, STAT_WORDS.shock)],
      ['アワセ猶予', rankWord(LINES, (l) => l.biteWindow, it, STAT_WORDS.biteWindow)],
    ];
  }
  // エサは 1.0 を基準にした倍率なので、しきい値で「ふつう」を基準に置く
  return [
    ['得意', baitStrengths(it).join('・')],
    ['アタリ', cutWord(it.attract, [1.01, 1.12, 1.21, 1.4], STAT_WORDS.attractBait)],
    ['大物', cutWord(it.rare, [0.95, 1.06, 1.2, 1.6], STAT_WORDS.rare)],
    ['ゴミ', cutWord(it.junk, [0.3, 0.5, 0.75, 1.0], [...STAT_WORDS.junk].reverse())],
  ];
}

/** エサが得意な魚（pref の高い魚が多いタグ）を短く並べる。
    aff テーブルは廃止したので、pref 表からタグごとの平均好感度を集計して求める */
export function baitStrengths(bait, n = 3) {
  const sum = {}, count = {};
  for (const sp of REAL_FISH) {
    if (!sp.pref) continue;
    const p = baitPrefMult(sp, bait);
    for (const t of sp.tags) {
      sum[t] = (sum[t] || 0) + p;
      count[t] = (count[t] || 0) + 1;
    }
  }
  return Object.keys(sum)
    .map((t) => [t, sum[t] / count[t]])
    .filter(([, avg]) => avg >= 1.05)   // 1.0（ふつう）より明確に高いタグだけ拾う
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => TAG_LABEL[k] || k);
}

export const GEAR = { rod: RODS, line: LINES, bait: BAITS };
export const GEAR_LABEL = { rod: 'ロッド', line: 'ライン', bait: 'エサ' };

/* ===========================================================
   実績
   =========================================================== */
export const ACHIEVEMENTS = [
  { id: 'first', name: 'はじめの一匹', desc: '最初の魚を釣り上げる', test: (s) => s.totalCaught >= 1 },
  { id: 'ten', name: '常連', desc: '合計10匹釣る', test: (s) => s.totalCaught >= 10 },
  { id: 'fifty', name: '湖の顔', desc: '合計50匹釣る', test: (s) => s.totalCaught >= 50 },
  { id: 'big50', name: 'ちょっとした自慢', desc: '50cm以上を釣る', test: (s) => s.maxLen >= 50 },
  { id: 'big100', name: 'メーターオーバー', desc: '100cm以上を釣る', test: (s) => s.maxLen >= 100 },
  { id: 'species10', name: '観察者', desc: '図鑑に10種登録', test: (s) => s.speciesCount >= 10 },
  { id: 'legend', name: '伝説と対峙する者', desc: 'レジェンドを釣り上げる', test: (s) => s.legendCaught >= 1 },
  { id: 'rich', name: '道具にはお金をかける', desc: '累計 20,000 G を稼ぐ', test: (s) => s.totalEarned >= 20000 },
  { id: 'complete', name: '湖畔の全て', desc: '図鑑コンプリート', test: (s) => s.speciesCount >= SPECIES.length },
];

/* ===========================================================
   計算ヘルパー
   =========================================================== */

/** 全長(cm) から標準体重(kg) */
export function weightOf(sp, len) {
  return (sp.wc * len * len * len) / 100000;
}

/**
 * 標準体重に対してぶれを付けた体重。
 * 端が出ると釣果カードで「痩せた／太った」が付く。
 */
export function rollWeight(sp, len) {
  const base = weightOf(sp, len);
  const u = Math.random();
  let f;
  if (u < 0.14) f = 0.78 + Math.random() * 0.10;       // 痩せ寄り 0.78–0.88
  else if (u > 0.86) f = 1.12 + Math.random() * 0.16;  // 太り寄り 1.12–1.28
  else f = 0.90 + Math.random() * 0.20;                  // ふつう 0.90–1.10
  return Math.round(base * f * 1000) / 1000;
}

/** 売値 */
export function valueOf(sp, len) {
  const t = (len - sp.len[0]) / Math.max(1, sp.len[1] - sp.len[0]);
  return Math.round(sp.value + sp.perCm * len * (0.75 + 0.5 * t));
}

/** 獲得経験値 */
export function xpOf(sp, len) {
  const r = RARITY[sp.rarity].xp;
  return Math.round(r + len * 0.45 * (1 + sp.rarity * 0.22));
}

/** 全長の抽選（大物は出にくい） */
export function rollLength(sp, luck = 0) {
  const bias = Math.pow(Math.random(), 2.1 - Math.min(1.2, luck));
  const [a, b] = sp.len;
  return Math.round((a + (b - a) * bias) * 10) / 10;
}

/**
 * 釣果カード用の接頭詞（図鑑は素の名前のまま）。
 * 体長帯・標準体重比・アルビノから自動付与。
 */
export function catchDisplayPrefix(sp, len, weight, albino = false) {
  const parts = [];
  if (albino) parts.push('アルビノ');

  const [lo, hi] = sp.len;
  const t = hi > lo ? (len - lo) / (hi - lo) : 0.5;
  if (t >= 0.92) parts.push('巨大な');       // 種内上位 roughly 8%
  else if (t >= 0.75) parts.push('大きな'); // 上位 25%（巨大を除く）
  else if (t <= 0.22) parts.push('小さな'); // 下位 roughly 22%

  if (sp.rarity > 0) {
    const base = weightOf(sp, len);
    const ratio = base > 1e-9 ? weight / base : 1;
    if (ratio >= 1.14) parts.push('太った');
    else if (ratio <= 0.88) parts.push('痩せた');
  }

  return parts.join('');
}

/** 接頭詞＋名前（ログ等用） */
export function catchDisplayName(sp, len, weight, albino = false) {
  return catchDisplayPrefix(sp, len, weight, albino) + sp.name;
}

/** 同種のレア個体（アルビノ）。魚種確定後に 1% */
export const ALBINO_CHANCE = 0.01;
export const ALBINO_COLORS = {
  top: '#f2f0ea', mid: '#faf9f5', belly: '#ffffff', fin: '#ebe6dc',
};
export const ALBINO_EYE = '#c41e3a';

export function rollAlbino(sp) {
  if (!sp || sp.rarity === 0) return false;
  return Math.random() < ALBINO_CHANCE;
}

export function colorsOf(sp, albino = false) {
  return albino ? ALBINO_COLORS : sp.colors;
}

export const rarityInfo = (sp) => RARITY[sp.rarity];

/* ===========================================================
   地形図鑑
   ------------------------------------------------------------
   初めてそこに投げたときに登録される。1 回のキャストで
   「水深帯 + 底質 + 地形の特徴」が同時に埋まることもある。
   match() に渡す ctx は game.js の terrainCtxAt() が作る
   =========================================================== */
export const TERRAIN_GROUPS = {
  depth: '水深帯',
  bed: '底質',
  feature: '地形',
  struct: 'ストラクチャー',
};

export const TERRAIN_KINDS = [
  /* --- 水深帯 --- */
  {
    id: 'shallow', group: 'depth', name: '浅場', rule: '水深 4.5m まで',
    desc: '岸寄りの明るい棚。水温も光もよく届き、小物と浅場の魚が集まる。',
    fish: '小物・浅場の魚。表層〜底層まで距離が短いので、タナはどれでも当たりやすい',
  },
  {
    id: 'midwater', group: 'depth', name: '中場', rule: '水深 4.5〜11.5m',
    desc: '浅場から落ちた先の中間帯。回遊してくる魚の通り道になる。',
    fish: '中層を泳ぐ回遊魚。浅場と深場の魚がどちらも顔を出す',
  },
  {
    id: 'deep', group: 'depth', name: '深場', rule: '水深 11.5m 以上',
    desc: '光の届きにくい沖の底。大型が身を寄せるが、アタリは少なくなる。',
    fish: '深場の大型。底層に落とすほど本命に近づく',
  },
  /* --- 底質 --- */
  {
    id: 'bed-sand', group: 'bed', name: '砂地', rule: '底質 = 砂',
    desc: '波と流れで洗われた明るい砂。起伏が少なく、餌を見つけてもらいやすい。',
    fish: '底物にプラス（×1.15 前後）。障害物が無いので根掛かりの心配もない',
  },
  {
    id: 'bed-rock', group: 'bed', name: '岩場', rule: '底質 = 岩',
    desc: '転石がゴロゴロ散らばる硬い底。エビやカニ、岩陰につく魚の住処。',
    fish: '甲殻類・肉食魚・岩につく魚にプラス。コイ科はやや落ちる',
  },
  {
    id: 'bed-mud', group: 'bed', name: '泥底', rule: '底質 = 泥',
    desc: '深みに溜まった柔らかい泥。虫が湧き、底を掘って餌を探す魚が好む。',
    fish: 'ドジョウ・ナマズ・コイ科などの底物にプラス。鱒類はやや落ちる',
  },
  /* --- 地形 --- */
  {
    id: 'break', group: 'feature', name: 'かけあがり', rule: '沖へ 8m で 2.4m 以上落ちる所',
    desc: '一段落ちる斜面。水深が急に変わる境目で、魚が身を寄せて餌を待つ。',
    fish: '深場の魚が浅場へ出てくる通り道。上下のタナを試す価値がある',
  },
  {
    id: 'shelf', group: 'feature', name: '浅棚', rule: '水深 1.5〜8m でほぼ平ら（傾き 0.12 以下）',
    desc: 'かけあがりの上にできた平らな棚。日中は静かだが、朝夕に魚が差してくる。',
    fish: '回遊してくる魚。夜と朝夕に浅場へ寄る魚がねらい目',
  },
  {
    id: 'weedbed', group: 'feature', name: '藻場', rule: '浅い平場（湖に 3〜4 か所）',
    desc: '水草が茂る浅い平場。小魚が身を隠し、それを狙う魚が待ち構える。沖にできたものは水草の少ない盛り上がり（ハンプ）になる。',
    fish: '藻場の魚・肉食魚。表層で食う魚も多い',
  },
  {
    id: 'hole', group: 'feature', name: '深い淵', rule: '19m 超の窪み（湖に 2〜3 か所）',
    desc: '湖の一番深い窪み。冷たく暗く、めったに姿を見せない大物が沈んでいる。',
    fish: 'レジェンド級。夜・雨・高級エサと重ねると確率が上がる',
  },
  {
    id: 'edge', group: 'feature', name: '葦際', rule: '水深 1.5m 以下の岸ぎわ',
    desc: '葦が生えた岸のすぐ際。虫が落ち、浅場の魚がひっきりなしに出入りする。',
    fish: '小物と浅場の魚。ただしゴミが増える（浅い所は ×1.8）',
  },
  /* --- ストラクチャー --- */
  {
    id: 'sunkrock', group: 'struct', name: '沈み岩', rule: '沈み岩の 4.5m 以内',
    desc: '水中に寄り集まった大岩（シモリ）。流れを遮り、魚の付き場になる。',
    fish: '肉食魚・藻場の魚 ×1.45／底物 ×1.3 の集魚効果',
  },
  {
    id: 'snag', group: 'struct', name: '立ち枯れ', rule: '立ち枯れの 4.5m 以内',
    desc: '沈んだまま立っている枯れ木。枝の陰に小魚が溜まる。',
    fish: '肉食魚・藻場の魚 ×1.45／底物 ×1.3 の集魚効果',
  },
  {
    id: 'dock', group: 'struct', name: '桟橋際', rule: '桟橋から 5m 以内',
    desc: '桟橋の脚が作る日陰。人工物でも立派なストラクチャーで、魚は影を好む。',
    fish: '影に付く魚。足元なので短い距離のファイトになる',
  },
];

export const TERRAIN_BY_ID = Object.fromEntries(TERRAIN_KINDS.map((t) => [t.id, t]));

/** ctx（terrainCtxAt の戻り）に当てはまる地形 id の配列 */
export function terrainMatches(ctx) {
  const out = [];
  const d = ctx.depth;
  if (d <= 4.5) out.push('shallow');
  else if (d <= 11.5) out.push('midwater');
  else out.push('deep');
  if (ctx.bed === 'sand') out.push('bed-sand');
  else if (ctx.bed === 'rock') out.push('bed-rock');
  else if (ctx.bed === 'mud') out.push('bed-mud');
  if (ctx.grad >= 0.30) out.push('break');
  if (Math.abs(ctx.grad) <= 0.12 && d >= 1.5 && d <= 8) out.push('shelf');
  if (ctx.inFlat) out.push('weedbed');
  if (ctx.inHole) out.push('hole');
  if (d <= 1.5) out.push('edge');
  if (ctx.struct === 'rock') out.push('sunkrock');
  if (ctx.struct === 'snag') out.push('snag');
  if (ctx.dockDist <= 5) out.push('dock');
  return out;
}
