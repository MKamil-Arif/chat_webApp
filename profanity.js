// Bad-word filter for visitor messages (English + Roman Urdu/Hindi).
// Add words to the list below; matching is whole-word and case-insensitive,
// and stretched spellings ("fuuuck") are caught too.

const WORDS = [
  // English
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bitch', 'bastard', 'asshole',
  'dick', 'pussy', 'cunt', 'slut', 'whore', 'wtf', 'stfu',
  // Roman Urdu / Hindi
  'chutiya', 'chutia', 'chootiya', 'madarchod', 'maderchod', 'mc', 'behenchod', 'bhenchod',
  'benchod', 'bc', 'bhosdike', 'bhosdi', 'bhosda', 'gandu', 'gaandu', 'lund', 'lun', 'lauda',
  'lavda', 'lavde', 'lodu', 'randi', 'harami', 'haramzada', 'haramzadi', 'kanjar', 'kanjri',
  'kutti', 'kamina', 'kamini', 'tatte', 'gashti', 'dalla',
];

// "fuck" -> /\bf+u+c+k+\b/: each letter may repeat.
const pattern = new RegExp(
  `\\b(?:${WORDS.map((w) => w.split('').map((c) => `${c}+`).join('')).join('|')})\\b`,
  'gi'
);

// Keep the first letter so the message still reads naturally: "f***".
function maskProfanity(text) {
  return text.replace(pattern, (word) => word[0] + '*'.repeat(word.length - 1));
}

module.exports = { maskProfanity };
