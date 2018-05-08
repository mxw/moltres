/*
 * Unit test configs for Moltres.
 */

const utils = require('./utils.js');
const Arg = utils.Arg;
const InvalidArg = utils.InvalidArg;

module.exports = {
  parse_args: [
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [ Arg.STR, Arg.INT, Arg.HOURMIN,
              Arg.TIMER, Arg.TIER, Arg.BOSS ],
      expect: ['foo', 12, '1:42', { mins: 1, secs: 42 }, 5, 'tyranitar'],
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.VARIADIC, Arg.STR, Arg.STR],
      expect: ['foo \t12 1:42 1:42', 't5', 'ttar'],
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.STR, Arg.VARIADIC, Arg.STR],
      expect: ['foo', '12 1:42 1:42  t5', 'ttar'],
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.STR, Arg.STR, Arg.VARIADIC],
      expect: ['foo', '12', '1:42 1:42  t5 ttar'],
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.STR, Arg.INT, Arg.HOURMIN, Arg.TIMER],
      expect: null,
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.STR, Arg.INT, Arg.HOURMIN, Arg.TIMER,
             Arg.TIER, Arg.BOSS, Arg.STR, Arg.STR],
      expect: null,
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.STR, Arg.INT, Arg.HOURMIN, Arg.TIMER,
             Arg.TIER, Arg.BOSS, Arg.VARIADIC],
      expect: null,
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.STR, Arg.INT, -Arg.INT, Arg.HOURMIN, -Arg.TIER,
             Arg.TIMER, -Arg.BOSS, Arg.TIER, -Arg.TIMER, Arg.BOSS],
      expect: ['foo', 12, null, '1:42', null,
               { mins: 1, secs: 42 }, null, 5, null, 'tyranitar'],
    },
    { args: 'foo \t12 1:42 1:42  t5 ttar',
      spec: [Arg.STR, Arg.VARIADIC, -Arg.TIER,
             Arg.TIMER, -Arg.BOSS, Arg.TIER, -Arg.TIMER, Arg.BOSS],
      expect: ['foo', '12 1:42', null,
               { mins: 1, secs: 42 }, null, 5, null, 'tyranitar'],
    },

    { args: '', spec: 'help', expect: [null] },
    { args: 'help', spec: 'help', expect: ['help'] },

    { args: 'Galaxy: Earth Sphere',
      spec: 'gym',
      expect: ['Galaxy: Earth Sphere'],
    },

    { args: 'Galaxy: Earth Sphere latios 1:42',
      spec: 'egg',
      expect: ['Galaxy: Earth Sphere', new InvalidArg('latios'),
               { mins: 1, secs : 42 }],
    },
    { args: 'Galaxy: Earth Sphere T5 hatch',
      spec: 'egg',
      expect: ['Galaxy: Earth Sphere', 5, new InvalidArg('hatch')],
    },
    { args: 'Galaxy: Earth Sphere T5',
      spec: 'egg',
      expect: null,
      expect: ['Galaxy: Earth', new InvalidArg('Sphere'),
               new InvalidArg('T5')],
    },
    { args: 'Galaxy: Earth Sphere T5 1:42',
      spec: 'egg',
      expect: null,
      expect: ['Galaxy: Earth Sphere', 5, { mins: 1, secs: 42 }],
    },

    { args: 'Galaxy: Earth Sphere 1',
      spec: 'call-time',
      expect: ['Galaxy: Earth Sphere', new InvalidArg('1'), null],
    },
    { args: 'Galaxy: Earth Sphere 1:42',
      spec: 'call-time',
      expect: ['Galaxy: Earth Sphere', '1:42', null],
    },
    { args: 'Galaxy: Earth Sphere 1:42 1',
      spec: 'call-time',
      expect: ['Galaxy: Earth Sphere', '1:42', 1],
    },

    { args: 'Galaxy: Earth Sphere',
      spec: 'join',
      expect: ['Galaxy: Earth Sphere', null, null],
    },
    { args: 'Galaxy: Earth Sphere 1:42',
      spec: 'join',
      expect: ['Galaxy: Earth Sphere', '1:42', null],
    },
    { args: 'Galaxy: Earth Sphere 1',
      spec: 'join',
      expect: ['Galaxy: Earth Sphere', null, 1],
    },
    { args: 'Galaxy: Earth Sphere 1:42 1',
      spec: 'join',
      expect: ['Galaxy: Earth Sphere', '1:42', 1],
    },
  ],
};