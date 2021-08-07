declare module 'edit-distance'
/*
 * typings for schulzch/edit-distance-js
 */

interface Result {
  a: string;
  b: string;
  distance: number;

  pairs: () => [string | null, string | null][];
  alignment: () => {
    alignmentA: (string | null)[],
    alignmentB: (string | null)[],
  };
}

declare function levenshtein(
  stringA: string,
  stringB: string,
  insert?: (char: string) => number,
  remove?: (char: string) => number,
  update?: (charA: string, charB: string) => number,
): Result;
