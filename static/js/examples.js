/* Free-play example circuits (optional starting points, not missions). Same format as share links. */
(function (root) {
  'use strict';
  root.Examples = [
    { name: 'Coin flip', set: 'H.', note: 'One H: a fair 50/50 coin. Drop it a few times.' },
    { name: 'Dice roll', set: 'HH', note: 'Two H gates: all 4 songs equally likely, like a four-sided die.' },
    { name: 'Interference', set: 'H.|Z.|H.', note: 'H, Z, H: the |00⟩ paths cancel, only |10⟩ is left. Step through it!' },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
