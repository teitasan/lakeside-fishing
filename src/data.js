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
    id: 'jumper', name: 'ジャンパー', hint: '水面に跳ねる — 跳んだら糸を送れ',
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
    id: 'shake', name: '首振り', hint: '首を振る — 振っている間は巻かない',
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
    id: 'moroko', name: 'モロコ', rarity: 1, tags: ['bottom', 'mid'], shape: 'slim',
    len: [7, 16], wc: 1.4, depth: [0.5, 3.5], spawn: 34, times: T.dayish, weather: W.any,
    str: 0.35, sta: 0.4, agg: 0.2, value: 14, perCm: 1.2,
    fight: 'dash',
    layer: { top: 0.5, mid: 1.0, bottom: 0.8 }, // 群れで中層〜底を回る
    colors: { top: '#6d7a5c', mid: '#a8b291', belly: '#e8e6d6', fin: '#c9c3a6' },
    flavor: '群れで泳ぐ小さな魚。佃煮がうまい。',
  },
  {
    id: 'bluegill', name: 'ブルーギル', rarity: 1, tags: ['mid', 'weed'], shape: 'deep',
    len: [9, 25], wc: 3.1, depth: [0.8, 5], spawn: 32, times: T.dayish, weather: W.any,
    str: 0.55, sta: 0.55, agg: 0.4, value: 20, perCm: 1.6,
    fight: 'dash',
    colors: { top: '#31513f', mid: '#5d8b63', belly: '#e9d98a', fin: '#2b3f38' },
    flavor: '青い頬。どこにでもいて、何にでも食いつく。',
  },
  {
    id: 'funa', name: 'マブナ', rarity: 1, tags: ['bottom', 'carp'], shape: 'deep',
    len: [14, 36], wc: 2.7, depth: [1, 6.5], spawn: 30, times: T.any, weather: W.cloudy,
    str: 0.7, sta: 0.7, agg: 0.3, value: 26, perCm: 2.0,
    fight: 'tank',
    colors: { top: '#5b5535', mid: '#9c9257', belly: '#ded7ad', fin: '#7c7143' },
    flavor: '「釣りはフナに始まりフナに終わる」。',
  },
  {
    id: 'ugui', name: 'ウグイ', rarity: 1, tags: ['mid'], shape: 'slim',
    len: [14, 42], wc: 1.35, depth: [0.5, 5.5], spawn: 28, times: T.any, weather: W.rain,
    str: 0.65, sta: 0.6, agg: 0.5, value: 24, perCm: 1.7,
    fight: 'jumper',
    colors: { top: '#4b5b6b', mid: '#8fa2ae', belly: '#f0f2f0', fin: '#c98a70' },
    flavor: '婚姻色の朱い帯が美しい。引きは意外に強い。',
  },
  {
    id: 'dojo', name: 'ドジョウ', rarity: 1, tags: ['bottom'], shape: 'eel',
    len: [8, 19], wc: 0.45, depth: [0.5, 4], spawn: 22, times: T.nightish, weather: W.rain,
    str: 0.4, sta: 0.45, agg: 0.2, value: 22, perCm: 2.4,
    fight: 'shake',
    colors: { top: '#4a3d2a', mid: '#7b6743', belly: '#d8c79a', fin: '#5b4b32' },
    flavor: '泥の中からにゅるり。にょろにょろと手強い。',
  },
  {
    id: 'oikawa', name: 'オイカワ', rarity: 1, tags: ['mid'], shape: 'slim',
    len: [8, 20], wc: 1.15, depth: [0.5, 4], spawn: 26, times: T.dayish, weather: W.clear,
    str: 0.45, sta: 0.45, agg: 0.5, value: 16, perCm: 1.4,
    fight: 'dash',
    colors: { top: '#5c6f78', mid: '#b9c6c8', belly: '#f2f0e6', fin: '#c98b9a' },
    flavor: '日中の浅場をきらきらと泳ぐ。オスは婚姻色が美しい。',
  },
  {
    id: 'tanago', name: 'タナゴ', rarity: 1, tags: ['weed', 'mid'], shape: 'deep',
    len: [5, 12], wc: 2.6, depth: [0.5, 3], spawn: 23, times: T.dayish, weather: W.any,
    str: 0.3, sta: 0.35, agg: 0.3, value: 20, perCm: 2.4,
    fight: 'dash',
    colors: { top: '#3b4a63', mid: '#8fa6c4', belly: '#f0ead8', fin: '#d98a5a' },
    flavor: '手のひらに収まる宝石。二枚貝に卵を産む。',
  },
  {
    id: 'prawn', name: 'テナガエビ', rarity: 1, tags: ['bottom', 'weed'], shape: 'shrimp',
    len: [8, 16], wc: 1.45, depth: [0.5, 4.5], spawn: 20, times: T.nightish, weather: W.any,
    str: 0.3, sta: 0.4, agg: 0.15, value: 22, perCm: 2.8,
    fight: 'dash',
    colors: { top: '#5b6470', mid: '#a9b3bd', belly: '#e8eaea', fin: '#cfd6d4' },
    flavor: '長い腕をゆらり。夜、石の間から出てくる。素揚げが最高。',
  },
  {
    id: 'crayfish', name: 'ザリガニ', rarity: 1, tags: ['bottom', 'weed'], shape: 'crayfish',
    len: [5, 15], wc: 3.5, depth: [0.4, 3], spawn: 22, times: T.any, weather: W.any,
    str: 0.5, sta: 0.7, agg: 0.1, value: 14, perCm: 1.5,
    fight: 'deadweight',
    colors: { top: '#7a2c1e', mid: '#c05334', belly: '#e8b18c', fin: '#8e3a24' },
    flavor: 'ハサミを振り上げて一歩も引かない。引くだけ引いて離さない。',
  },

  /* ---------------- アンコモン ---------------- */
  {
    id: 'rainbow', name: 'ニジマス', rarity: 2, tags: ['trout', 'mid'], shape: 'slim',
    len: [21, 54], wc: 1.3, depth: [1, 8.5], spawn: 20, times: T.twilight, weather: W.cloudy,
    str: 1.0, sta: 0.95, agg: 0.8, value: 90, perCm: 4.2,
    fight: 'jumper',
    colors: { top: '#3f6a63', mid: '#93b3a8', belly: '#f2efe4', fin: '#d97a86' },
    flavor: '横腹に虹。銀鱗を翻して跳ねる。',
  },
  {
    id: 'bass', name: 'ブラックバス', rarity: 2, tags: ['predator', 'weed'], shape: 'wide',
    len: [24, 58], wc: 1.55, depth: [1, 7.5], spawn: 19, times: T.twilight, weather: W.cloudy,
    str: 1.15, sta: 1.0, agg: 1.1, value: 110, perCm: 4.6,
    fight: 'dash',
    colors: { top: '#2f4a2c', mid: '#6f8f52', belly: '#e3e0bd', fin: '#33472b' },
    flavor: '大口を開けて小魚を襲う。エラ洗いに注意。',
  },
  {
    id: 'yamame', name: 'ヤマメ', rarity: 2, tags: ['trout'], shape: 'slim',
    len: [17, 42], wc: 1.2, depth: [0.5, 5], spawn: 16, times: T.dawnOnly, weather: W.rain,
    str: 0.95, sta: 0.9, agg: 0.9, value: 130, perCm: 5.0,
    fight: 'jumper',
    colors: { top: '#3d5560', mid: '#96a8a6', belly: '#f4f0e2', fin: '#8d9a8e' },
    flavor: 'パーマークが並ぶ渓流の女王。神経質で警戒心が強い。',
  },
  {
    id: 'namazu', name: 'ナマズ', rarity: 2, tags: ['bottom', 'predator', 'deep'], shape: 'eel',
    len: [34, 84], wc: 1.25, depth: [3.5, 15], spawn: 15, times: T.nightish, weather: W.rain,
    str: 1.35, sta: 1.3, agg: 0.6, value: 150, perCm: 4.0,
    fight: 'shake',
    colors: { top: '#3a3a2e', mid: '#6b6550', belly: '#cfc7a4', fin: '#4a463a' },
    flavor: '長いヒゲでゆらり。掛かると重量感のある首振り。',
  },
  {
    id: 'koi', name: 'コイ', rarity: 2, tags: ['carp', 'bottom'], shape: 'deep',
    len: [38, 92], wc: 2.5, depth: [1.5, 9.5], spawn: 14, times: T.any, weather: W.cloudy,
    str: 1.5, sta: 1.55, agg: 0.5, value: 170, perCm: 3.6,
    fight: 'tank',
    colors: { top: '#5a4a2c', mid: '#a3854a', belly: '#e6dcb4', fin: '#7c6234' },
    flavor: '悠然と泳ぐ湖の主候補。走り出すと止まらない。',
  },
  {
    id: 'wakasagi', name: 'ワカサギ', rarity: 2, tags: ['mid', 'deep'], shape: 'slim',
    len: [7, 16], wc: 0.85, depth: [4, 14], spawn: 15, times: T.twilight, weather: W.cloudy,
    str: 0.5, sta: 0.5, agg: 0.45, value: 70, perCm: 4.6,
    fight: 'dash',
    colors: { top: '#5b6c74', mid: '#c3ced2', belly: '#f6f4ec', fin: '#dfe3e0' },
    flavor: '深場を群れで回る細身の小魚。天ぷらの王様。',
  },
  {
    id: 'nigoi', name: 'ニゴイ', rarity: 2, tags: ['bottom', 'carp'], shape: 'slim',
    len: [26, 64], wc: 1.15, depth: [1.5, 10], spawn: 14, times: T.any, weather: W.cloudy,
    str: 1.2, sta: 1.15, agg: 0.6, value: 100, perCm: 3.8,
    fight: 'tank',
    colors: { top: '#57605c', mid: '#a7aea4', belly: '#eceade', fin: '#8b8f84' },
    flavor: 'コイに似て口先が長い。底を突きながら餌を探す。',
  },
  {
    id: 'hasu', name: 'ハス', rarity: 2, tags: ['predator', 'mid'], shape: 'slim',
    len: [22, 52], wc: 1.1, depth: [1, 7], spawn: 13, times: T.dayish, weather: W.clear,
    str: 1.1, sta: 0.95, agg: 1.35, value: 140, perCm: 5.2,
    fight: 'dash',
    colors: { top: '#41525f', mid: '#9fb0b4', belly: '#f3f1e4', fin: '#b8bfae' },
    flavor: 'コイ科なのに小魚を追う。への字の口が特徴。',
  },
  {
    id: 'mokuzugani', name: 'モクズガニ', rarity: 2, tags: ['bottom'], shape: 'crab',
    len: [6, 14], wc: 14, depth: [1, 8], spawn: 12, times: T.nightish, weather: W.rain,
    str: 0.9, sta: 1.3, agg: 0.1, value: 240, perCm: 9,
    fight: 'deadweight',
    colors: { top: '#3f4a3c', mid: '#75775e', belly: '#c9c2a4', fin: '#565a48' },
    flavor: 'ハサミに毛の生えた川のカニ。味は絶品、根掛かりのように重い。',
  },

  /* ---------------- レア ---------------- */
  {
    id: 'iwana', name: 'イワナ', rarity: 3, tags: ['trout', 'deep'], shape: 'slim',
    len: [24, 62], wc: 1.25, depth: [3, 13], spawn: 9, times: T.dawnOnly, weather: W.rain,
    str: 1.25, sta: 1.15, agg: 1.0, value: 340, perCm: 8.0,
    fight: 'shake',
    layer: { top: 0.35, mid: 1.0, bottom: 0.85 }, // 深場では底に着く
    colors: { top: '#2f4048', mid: '#7d8f8c', belly: '#f0e9d2', fin: '#c9a06d' },
    flavor: '白い斑点をまとう冷水の主。深い淵の底に潜む。',
  },
  {
    id: 'snakehead', name: 'ライギョ', rarity: 3, tags: ['predator', 'weed'], shape: 'eel',
    len: [38, 94], wc: 1.15, depth: [0.5, 4.5], spawn: 8, times: T.dayish, weather: W.clear,
    str: 1.6, sta: 1.4, agg: 1.5, value: 380, perCm: 7.2,
    fight: 'dash',
    colors: { top: '#33402a', mid: '#6d7a45', belly: '#d3cf9d', fin: '#3e4a2c' },
    flavor: '藻の陰から爆発的に襲いかかる雷魚。ドラグが鳴る。',
  },
  {
    id: 'grasscarp', name: 'ソウギョ', rarity: 3, tags: ['carp', 'weed'], shape: 'slim',
    len: [52, 118], wc: 1.7, depth: [1.5, 8], spawn: 7, times: T.dayish, weather: W.clear,
    str: 1.85, sta: 1.8, agg: 0.7, value: 420, perCm: 6.4,
    fight: 'tank',
    layer: { top: 0.9, mid: 0.85, bottom: 0.5 }, // 水面の水草を食べる
    colors: { top: '#4d5340', mid: '#95a077', belly: '#e5e3c6', fin: '#6c7452' },
    flavor: '水草を食べる巨体。一度走られたら覚悟が必要。',
  },
  {
    id: 'biwatrout', name: 'ビワマス', rarity: 3, tags: ['trout', 'deep'], shape: 'slim',
    len: [29, 68], wc: 1.35, depth: [6, 19], spawn: 7, times: T.twilight, weather: W.cloudy,
    str: 1.45, sta: 1.3, agg: 1.2, value: 460, perCm: 8.6,
    fight: 'jumper',
    layer: { top: 0.3, mid: 1.0, bottom: 0.7 }, // 深層を回遊する
    colors: { top: '#2b4a5e', mid: '#8fa8b6', belly: '#f5f1e6', fin: '#b06a72' },
    flavor: '深層を回遊する幻の鱒。銀色の魚体に淡い紅。',
  },
  {
    id: 'unagi', name: 'ウナギ', rarity: 3, tags: ['bottom', 'deep'], shape: 'eel',
    len: [40, 100], wc: 0.6, depth: [2, 12], spawn: 7, times: T.nightish, weather: W.rain,
    str: 1.5, sta: 1.75, agg: 0.5, value: 520, perCm: 9.5,
    fight: 'shake',
    colors: { top: '#2c2b28', mid: '#5a5646', belly: '#e0d8b8', fin: '#3a382e' },
    flavor: '夜、底穴から出て餌を探す。掛けてからが本当の勝負。',
  },
  {
    id: 'sakuramasu', name: 'サクラマス', rarity: 3, tags: ['trout', 'deep'], shape: 'slim',
    len: [34, 72], wc: 1.4, depth: [5, 17], spawn: 6, times: T.twilight, weather: W.rain,
    str: 1.6, sta: 1.45, agg: 1.35, value: 600, perCm: 9.5,
    fight: 'jumper',
    layer: { top: 0.5, mid: 1.0, bottom: 0.6 }, // 中層を泳ぐ
    colors: { top: '#3a5566', mid: '#c2ccd2', belly: '#faf7ee', fin: '#d98f96' },
    flavor: '海へ降りずに残った銀鱗。桜の頃に走り出す。',
  },
  {
    id: 'aouo', name: 'アオウオ', rarity: 3, tags: ['carp', 'deep'], shape: 'wide',
    len: [60, 140], wc: 1.85, depth: [4, 16], spawn: 5.5, times: T.any, weather: W.cloudy,
    str: 2.0, sta: 2.0, agg: 0.6, value: 560, perCm: 7,
    fight: 'tank',
    colors: { top: '#3b4149', mid: '#6f7a7d', belly: '#d9dcc9', fin: '#4d565a' },
    flavor: '貝を砕いて食う黒い巨体。ソウギョより重く、粘る。',
  },

  /* ---------------- エピック ---------------- */
  {
    id: 'sturgeon', name: 'チョウザメ', rarity: 4, tags: ['deep', 'bottom'], shape: 'sturgeon',
    len: [78, 168], wc: 1.05, depth: [10, 24], spawn: 3.0, times: T.nightish, weather: W.cloudy,
    str: 2.3, sta: 2.3, agg: 0.9, value: 1400, perCm: 16,
    fight: 'tank',
    colors: { top: '#3d4a55', mid: '#7d8d99', belly: '#dfe3e0', fin: '#4d5a63' },
    flavor: '古代の姿を残す魚。背の硬鱗が水中でぬめりと光る。',
  },
  {
    id: 'gar', name: 'アリゲーターガー', rarity: 4, tags: ['predator', 'deep'], shape: 'gar',
    len: [86, 196], wc: 0.9, depth: [4, 16], spawn: 2.6, times: T.nightish, weather: W.clear,
    str: 2.6, sta: 2.1, agg: 1.7, value: 1700, perCm: 17,
    fight: 'dash',
    layer: { top: 0.95, mid: 1.0, bottom: 0.5 }, // 水面で空気を吸う
    colors: { top: '#3c4433', mid: '#7c8560', belly: '#d6d3ab', fin: '#4a5238' },
    flavor: 'ワニのような顎。誰が湖に放したのか、誰も知らない。',
  },
  {
    id: 'itou', name: 'イトウ', rarity: 4, tags: ['trout', 'predator', 'deep'], shape: 'slim',
    len: [70, 150], wc: 1.1, depth: [6, 20], spawn: 2.2, times: T.twilight, weather: W.rain,
    str: 2.45, sta: 2.5, agg: 1.5, value: 2200, perCm: 20,
    fight: 'jumper',
    colors: { top: '#41504e', mid: '#9aa8a2', belly: '#f2ecdc', fin: '#b6837a' },
    flavor: '幻の巨大魚。深場の縁でゆっくりと大きな尾を振る。',
  },

  /* ---------------- レジェンド ---------------- */
  {
    id: 'nushi', name: '湖の主', rarity: 5, tags: ['deep', 'predator', 'legend'], shape: 'eel',
    len: [138, 232], wc: 1.6, depth: [14, 28], spawn: 0.32, times: T.nightish, weather: W.rain,
    str: 3.3, sta: 3.2, agg: 1.4, value: 7000, perCm: 34,
    fight: 'tank',
    colors: { top: '#22262a', mid: '#4b5157', belly: '#9aa3a6', fin: '#2c3135' },
    flavor: '湖底の岩屋に潜む巨大ナマズ。村の古老が「あれには触るな」と言った。',
  },
  {
    id: 'dragonfish', name: '白龍魚', rarity: 5, tags: ['deep', 'legend'], shape: 'gar',
    len: [118, 268], wc: 0.75, depth: [17, 30], spawn: 0.45, times: T.dawnOnly, weather: W.clear,
    str: 3.8, sta: 3.6, agg: 2.0, value: 12000, perCm: 46,
    fight: 'jumper',
    layer: { top: 0.25, mid: 1.0, bottom: 0.9 }, // 深層の主
    colors: { top: '#c9d6e2', mid: '#eef4fb', belly: '#ffffff', fin: '#9fd0e8' },
    flavor: '夜明けの霧の中、白い影が水面を割る。龍の子ともいわれる。',
  },
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map((s) => [s.id, s]));
export const REAL_FISH = SPECIES.filter((s) => s.rarity > 0);
export const JUNK = SPECIES.filter((s) => s.rarity === 0);

/* ===========================================================
   装備
   =========================================================== */

export const RODS = [
  {
    id: 'bamboo', name: '竹の釣り竿', icon: '🎣', price: 0, level: 1,
    reel: 0.85, power: 1.0, attract: 1.0,
    desc: '祖父から受け継いだ一本。しなやかだが力不足。',
  },
  {
    id: 'glass', name: 'グラスファイバーロッド', icon: '🎣', price: 700, level: 2,
    reel: 1.0, power: 1.22, attract: 1.05,
    desc: '扱いやすい万能竿。巻き取りが少し速い。',
  },
  {
    id: 'carbon', name: 'カーボンロッド', icon: '🎣', price: 3200, level: 5,
    reel: 1.16, power: 1.48, attract: 1.12,
    desc: '軽量高弾性。魚の引きをよく吸収してくれる。',
  },
  {
    id: 'master', name: '名匠竿「渓月」', icon: '🎋', price: 11000, level: 9,
    reel: 1.32, power: 1.8, attract: 1.2,
    desc: '職人が一年かけて削り上げた逸品。大物に負けない。',
  },
  {
    id: 'legend', name: '伝説の竿「湖鳴」', icon: '🌙', price: 38000, level: 14,
    reel: 1.52, power: 2.2, attract: 1.32,
    desc: '湖の主を釣り上げるために鍛えられたという竿。',
  },
];

export const LINES = [
  { id: 'nylon', name: 'ナイロン 2号', icon: '🧵', price: 0, level: 1, cap: 1.0, desc: '標準的な糸。切れやすいので丁寧に。' },
  { id: 'fluoro', name: 'フロロカーボン 4号', icon: '🧵', price: 600, level: 1, cap: 1.32, desc: '水中で見えにくく、強度も上がる。' },
  { id: 'pe', name: 'PEライン 1.5号', icon: '🪢', price: 2600, level: 4, cap: 1.68, desc: '伸びない高強度編組ライン。' },
  { id: 'spider', name: '特殊繊維「蜘蛛糸」', icon: '🕸️', price: 9500, level: 8, cap: 2.15, desc: '細いのに驚異的な強度を誇る。' },
  { id: 'mithril', name: 'ミスリルライン', icon: '✨', price: 30000, level: 13, cap: 2.8, desc: '銀色に輝く不思議な糸。まず切れない。' },
];

/**
 * depth: エサが到達する狙いの水深(m)
 * attract: アタリまでの速さ倍率
 * rare: レア度ボーナス
 * junk: ゴミを引く確率の倍率
 * aff: 魚のタグ別の食いつき倍率
 */
/* エサ（ルアーは廃止。放置して待つ釣りに合わないため、すべて置き餌・生き餌に統一）
   depth は持たない：狙う層（タナ）はプレイヤーが仕掛け側で決める。
   aff = タグ別の食いつき。タナ × エサの組み合わせで釣れる魚が変わる */
export const BAITS = [
  {
    id: 'worm', name: 'ミミズ', icon: '🪱', price: 0, level: 1,
    attract: 1.0, rare: 1.0, junk: 1.0,
    aff: { bottom: 1.7, carp: 1.4, mid: 1.0, predator: 0.6, trout: 0.8, weed: 0.9, deep: 1.0 },
    desc: '万能の置き餌。底を突く魚に強い。',
  },
  {
    id: 'akamushi', name: 'アカムシ', icon: '🧵', price: 180, level: 1,
    attract: 1.14, rare: 0.88, junk: 0.9,
    aff: { mid: 1.6, bottom: 1.3, weed: 1.2, carp: 1.0, trout: 0.9, predator: 0.3, deep: 0.7 },
    desc: '極小の赤い虫。小物のアタリが速いが、大物は寄らない。',
  },
  {
    id: 'dough', name: '練り餌', icon: '🍡', price: 250, level: 1,
    attract: 1.08, rare: 1.05, junk: 0.8,
    aff: { carp: 1.9, bottom: 1.2, mid: 1.2, predator: 0.4, trout: 0.7, weed: 1.0, deep: 0.8 },
    desc: 'フナ・コイの大好物。練り込んで針に付ける。',
  },
  {
    id: 'roe', name: 'イクラ', icon: '🍥', price: 900, level: 2,
    attract: 1.16, rare: 1.15, junk: 0.6,
    aff: { trout: 2.0, mid: 1.2, deep: 1.1, predator: 0.9, bottom: 0.8, weed: 0.8, carp: 0.6 },
    desc: '鱒が目の色を変える一粒。流れの中で映える。',
  },
  {
    id: 'shrimp', name: '川エビ', icon: '🦐', price: 1600, level: 3,
    attract: 1.2, rare: 1.25, junk: 0.5,
    aff: { predator: 1.9, deep: 1.4, bottom: 1.3, trout: 1.2, weed: 1.2, mid: 1.0, carp: 0.6 },
    desc: '生きたまま付ける定番の生き餌。何にでも効く。',
  },
  {
    id: 'minnow', name: '小魚（泳がせ）', icon: '🐟', price: 3800, level: 6,
    attract: 1.22, rare: 1.45, junk: 0.4,
    aff: { predator: 2.2, deep: 1.8, trout: 1.3, mid: 1.0, bottom: 0.9, weed: 1.0, carp: 0.4 },
    desc: '生きた小魚を泳がせる大物狙い。小物は寄りつかない。',
  },
  {
    id: 'secret', name: '秘伝の撒き餌', icon: '🍶', price: 12000, level: 10,
    attract: 1.7, rare: 2.2, junk: 0.25,
    aff: { deep: 1.6, legend: 2.6, predator: 1.4, trout: 1.4, carp: 1.4, bottom: 1.4, mid: 1.4, weed: 1.2 },
    desc: '老人が「主を呼ぶ」と言って売ってくれた壺。何かがおかしい匂い。',
  },
];

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

/** 魚の遊泳層（sp.layer があればそれ。無ければタグから） */
export function swimLayer(sp) {
  if (sp.layer) return sp.layer;
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

/** 図鑑・表に出す遊泳層の短い名前（重み 0.8 以上の層を拾う） */
export function swimLayerLabel(sp) {
  const L = swimLayer(sp);
  const on = RIG_LAYERS.filter((x) => L[x.id] >= 0.8).map((x) => x.name.replace('層', ''));
  if (!on.length) return RIG_LAYERS.reduce((a, x) => (L[x.id] > L[a.id] ? x : a), RIG_LAYERS[1]).name;
  return on.length === 3 ? '全層' : on.join('〜') + '層';
}

/**
 * 生息水深との適合（その場所の水深が、その魚が居る水深か）
 * 帯の中 1.0 → 外れるほど線形に 0 まで落ちる。
 *  浅い側は d0 の 35%（最低 1m）だけ許す ＝ 深場の魚は浅場に出て来ない
 *  深い側は帯の幅の 90%（最低 2.5m）だけ許す ＝ 少し深いだけなら居る
 * 例）ドジョウ [0.5, 4] → 水深 7.2m 以上で 0（20m の場所には居ない）
 *     湖の主 [14, 28] → 水深 9.1m 未満で 0
 */
export function depthFit(sp, depth) {
  const [d0, d1] = sp.depth;
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

/** エサが得意な魚（aff の上位）を短く並べる */
export function baitStrengths(bait, n = 3) {
  return Object.entries(bait.aff)
    .filter(([, v]) => v >= 1.2)
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

/** 全長(cm) から重さ(kg) */
export function weightOf(sp, len) {
  return (sp.wc * len * len * len) / 100000;
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

export const rarityInfo = (sp) => RARITY[sp.rarity];
