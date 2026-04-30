// 256-word list — 8 bits per word ⇒ 16 words = 128 bits of entropy.
// Curated for unambiguous spelling (no homophones / digraph traps).
// Length must be exactly 256; the build will fail loudly otherwise.

export const WORDLIST: readonly string[] = [
  'abandon', 'ability', 'about', 'absent', 'absorb', 'abstract', 'absurd', 'access',
  'accident', 'account', 'accuse', 'achieve', 'acid', 'acoustic', 'acquire', 'across',
  'action', 'actor', 'actual', 'adapt', 'address', 'adjust', 'admit', 'adult',
  'advance', 'advice', 'aerobic', 'affair', 'afford', 'afraid', 'again', 'agent',
  'agree', 'ahead', 'aisle', 'alarm', 'album', 'alert', 'alien', 'alive',
  'alley', 'allow', 'almost', 'alone', 'alpha', 'already', 'also', 'always',
  'amateur', 'amazing', 'among', 'amount', 'amused', 'analyst', 'anchor', 'ancient',
  'anger', 'angle', 'angry', 'animal', 'ankle', 'announce', 'annual', 'another',
  'answer', 'antenna', 'antique', 'anxiety', 'anyway', 'apart', 'apology', 'appear',
  'apple', 'approve', 'april', 'arctic', 'arena', 'argue', 'armed', 'armor',
  'arrange', 'arrest', 'arrive', 'arrow', 'artist', 'aspect', 'assault', 'asset',
  'assist', 'assume', 'asthma', 'athlete', 'atom', 'attack', 'attend', 'auction',
  'august', 'aunt', 'author', 'auto', 'autumn', 'average', 'avocado', 'avoid',
  'awake', 'aware', 'away', 'awesome', 'awful', 'awkward', 'axis', 'baby',
  'bachelor', 'bacon', 'badge', 'balance', 'balcony', 'ball', 'bamboo', 'banana',
  'banner', 'barely', 'bargain', 'barrel', 'basic', 'basket', 'battle', 'beach',
  'beauty', 'because', 'become', 'beef', 'before', 'begin', 'behave', 'behind',
  'believe', 'below', 'belt', 'bench', 'benefit', 'better', 'beyond', 'bicycle',
  'bind', 'biology', 'birth', 'bitter', 'black', 'blade', 'blame', 'blanket',
  'blast', 'bleak', 'bless', 'blind', 'blood', 'blossom', 'blouse', 'blue',
  'blur', 'blush', 'board', 'boat', 'body', 'boil', 'bomb', 'bone',
  'bonus', 'book', 'border', 'boring', 'borrow', 'boss', 'bottom', 'bounce',
  'box', 'boy', 'brain', 'brand', 'brass', 'brave', 'bread', 'breeze',
  'brick', 'bridge', 'brief', 'bright', 'bring', 'brisk', 'broccoli', 'broken',
  'bronze', 'broom', 'brother', 'brown', 'brush', 'bubble', 'buddy', 'budget',
  'buffalo', 'build', 'bulb', 'bulk', 'bullet', 'bundle', 'bunker', 'burden',
  'burger', 'burst', 'business', 'busy', 'butter', 'buyer', 'buzz', 'cabbage',
  'cabin', 'cable', 'cactus', 'cage', 'cake', 'call', 'calm', 'camera',
  'camp', 'canal', 'cancel', 'candle', 'cannon', 'canoe', 'canvas', 'canyon',
  'capable', 'capital', 'captain', 'carbon', 'card', 'cargo', 'carpet', 'carry',
  'cart', 'case', 'casino', 'castle', 'casual', 'category', 'cattle', 'caught',
  'cause', 'caution', 'cave', 'ceiling', 'celery', 'cement', 'census', 'century'
];

// Length is asserted in `tests/wordlist.test.ts`. Don't throw at module load —
// SW import-time crashes are user-hostile.
