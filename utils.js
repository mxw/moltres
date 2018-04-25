/*
 * Ill-defined shared components.
 */

const Arg = {
  STR: 1,
  INT: 2,
  VARIADIC: 3,
  HOURMIN: 4,
  TIMER: 5,
  TIER: 6,
  BOSS: 7,
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
