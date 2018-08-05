/*
 * Ill-defined shared components.
 */

const Arg = {
  STR: 1,
  INT: 2,
  VARIADIC: 3,
  MONTHDAY: 4,
  HOURMIN: 5,
  TIMER: 6,
  TIER: 7,
  BOSS: 8,
};

/*
 * Invalid argument object.
 */
function InvalidArg(arg) {
  this.arg = arg;
}

module.exports = {
  Arg: Arg,
  InvalidArg: InvalidArg,
};
