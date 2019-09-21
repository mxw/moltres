/*
 * Custom raid bot for Valor of Boston.
 */
'use strict';

const {DateTime, Duration, IANAZone, FixedOffsetZone} = require('luxon');
const Discord = require('discord.js');
const ed = require('edit-distance');
const trie = require('trie-prefix-tree');

const mysql = require('./async-mysql.js');
const utils = require('./utils.js');

let emoji_by_name = require('./emoji.js');
let config = require('./config.js');
let channels_for_region = compute_region_channel_map();
let tz_for_region = compute_region_tz_map();
let raid_data = {};

///////////////////////////////////////////////////////////////////////////////

const moltres = new Discord.Client();

moltres.on('ready', () => {
  console.log(`Logged in as ${moltres.user.tag}.`);
});

let moltresdb;

mysql.connect({
  host: 'localhost',
  user: config.dbuser || 'moltres',
  password: config.dbpass,
  database: config.dbname || 'moltresdb',
  supportBigNumbers: true,
  bigNumberStrings: true,
})
.then(res => {
  moltresdb = res;
  console.log(`Connected as id ${moltresdb.conn.threadId}.`);

  return read_bosses_table();
})
.then(([raid_tiers, boss_defaults]) => {
  if (raid_tiers === null) {
    console.error(`Could not read raid bosses table.`);
    process.exit(1);
  }
  raid_data = {
    raid_tiers: raid_tiers,
    bosses_for_tier: compute_tier_boss_map(raid_tiers),
    raid_trie: trie(Object.keys(raid_tiers)),
    boss_defaults: boss_defaults,
  };
  moltres.login(config.moltres);
})
.catch(err => {
  console.error(`Error connecting to moltresdb: ${err.stack}`);
  process.exit(1);
});

///////////////////////////////////////////////////////////////////////////////

function cleanup() {
  moltres.destroy();
  moltresdb.end().catch(console.error);
}

function signal_handler(signal) {
  cleanup();
  console.error(`Got signal ${signal}.`);
  process.exit(128 + signal);
}

process.on('exit', cleanup);
process.on('SIGINT', signal_handler);
process.on('SIGHUP', signal_handler);
process.on('SIGTERM', signal_handler);
process.on('SIGABRT', signal_handler);
process.on('uncaughtException', (err) => {
  cleanup();
  console.error(`Caught exception: ${err}`);
  process.exit(1);
});

///////////////////////////////////////////////////////////////////////////////

/*
 * Who can use a request?
 */
const Permission = {
  ADMIN: 0,
  NONE: 1,
  WHITELIST: 2,
  BLACKLIST: 3,
};

/*
 * Where can a request be used from?
 */
const Access = {
  DM: 1 << 0,
  REGION: 1 << 1,
  EX_MAIN: 1 << 2,
  EX_ROOM: 1 << 3,
  ADMIN_DM: 1 << 4,

  // Unions.
  REGION_DM: 1 << 0 | 1 << 1,
  EX_ALL: 1 << 2 | 1 << 3,
  ALL: (1 << 5) - 1,
};

/*
 * Request modifiers.
 */
const Mod = {
  NONE: 0,
  FORCE: 1 << 0,
  ANON: 1 << 1,
};

const modifier_map = {
  '!': Mod.FORCE,
  '?': Mod.ANON,
};

const Arg = utils.Arg;
const InvalidArg = utils.InvalidArg;

/*
 * Order of display for $help.
 */
const req_order = [
  'help', null,
  'set-perm', 'ls-perms', 'add-boss', 'rm-boss', 'def-boss', null,
  'gym', 'ls-gyms', 'search-gym', 'ls-regions', null,
  'raid', 'ls-raids', 'egg', 'boss', 'update', 'scrub', 'ls-bosses', null,
  'call', 'cancel', 'change-time', 'join', 'unjoin', null,
  'ex', 'exit', 'examine', 'exact', 'exclaim', 'explore', 'expunge', 'exalt',
];

const req_to_perm = {
  'set-perm': 'perms',
  'ls-perms': 'perms',
  'add-boss': 'boss-table',
  'rm-boss':  'boss-table',
  'def-boss': 'boss-table',
  'gym':        'gym',
  'ls-gyms':    'gym',
  'search-gym': 'gym',
  'raid':       'raid',
  'ls-raids':   'raid',
  'egg':    'report',
  'boss':   'report',
  'update': 'report',
  'call':        'call',
  'cancel':      'call',
  'change-time': 'call',
};

const reqs = {
  'help': {
    perms: Permission.NONE,
    access: Access.ALL,
    usage: '[request]',
    args: [-Arg.STR],
    desc: 'Learn about our team\'s legendary avatar.',
    detail: [
      'Just `$help` will list all common requests. You can also use',
      '`$help req` or `$req help` to get more information about a specific',
      'request.',
    ],
    examples: {
      'help': 'Sends you this message in a DM.',
      'boss': 'Sends you information about the `$boss` request by DM.',
    },
  },
  'set-perm': {
    perms: Permission.WHITELIST,
    access: Access.ALL,
    usage: '<user> <request>',
    args: [Arg.STR, Arg.STR],
    desc: 'Enable others to use more (or fewer) requests.',
    detail: [
      'The user should be identified by tag.',
    ],
    examples: {
    },
  },
  'ls-perms': {
    perms: Permission.WHITELIST,
    access: Access.ALL,
    usage: '',
    args: [],
    desc: 'List all existing permissions modifiers.',
    detail: [],
    examples: {
    },
  },
  'add-boss': {
    perms: Permission.WHITELIST,
    access: Access.ALL,
    usage: '<boss> <tier>',
    args: [Arg.STR, Arg.TIER],
    desc: 'Add a raid boss to the boss database.',
    detail: [
      'Can also be used to change a boss\'s tier.',
    ],
    examples: {
      'giratina 5': 'Add a new T5 raid boss, Giratina.',
    },
  },
  'rm-boss': {
    perms: Permission.WHITELIST,
    access: Access.ALL,
    usage: '<boss>',
    args: [Arg.STR],
    desc: 'Remove a raid boss from the boss database.',
    detail: [],
    examples: {
      'wargreymon': 'You accidentally added a Digimon.  Fix your mistake.',
    },
  },
  'def-boss': {
    perms: Permission.WHITELIST,
    access: Access.ALL,
    usage: '<boss|tier>',
    args: [Arg.STR],
    desc: 'Make a raid boss the default boss for its tier.',
    detail: [
      'Passing a raid tier instead of a boss name will clear the default for',
      'that tier.',
    ],
    examples: {
      'rayquaza': 'Celebrate Rayquaza\'s return as the default T5!',
      '5': 'Alas, T5 bosses are a mystery.',
    },
  },

  'reload-config': {
    perms: Permission.ADMIN,
    access: Access.ALL,
    usage: '',
    args: [],
    desc: 'Reload the Moltres config file.',
    detail: [
      'This resets channel mappings, raid boss tiers, etc.  It is only',
      'available to Moltres admins.',
    ],
    examples: {
    },
  },
  'raidday': {
    perms: Permission.ADMIN,
    access: Access.ALL,
    usage: '<boss> <despawn>',
    args: [Arg.BOSS, Arg.HOURMIN],
    desc: 'Add a raid to every gym for a Raid Day.',
    detail: [],
    examples: {
    },
  },
  'test': {
    perms: Permission.ADMIN,
    access: Access.ALL,
    usage: '',
    args: null,
    desc: 'Flavor of the week testing command.',
    detail: [],
    examples: {
    },
  },

  'gym': {
    perms: Permission.NONE,
    access: Access.ALL,
    usage: '<gym-handle-or-name>',
    args: [Arg.VARIADIC],
    desc: 'Get information about a gym.',
    detail: [
      'A gym handle is something like `jh-john-harvard` or `newtowne`.',
      'You can use partial substring matches (like `jh` or even `ohn-harv`)',
      'as long as they don\'t match another gym.\n\nUse `$ls-gyms <region>`',
      'if you want to see all the gym handles (but they should be what you',
      'expect).',
    ],
    examples: {
      'galaxy-sph': 'Get information about **Galaxy: Earth Sphere**.',
      'laxy: Earth Sphe': 'Same as above.',
    },
  },
  'ls-gyms': {
    perms: Permission.NONE,
    access: Access.ALL,
    usage: '<region-name>',
    args: [Arg.VARIADIC],
    desc: 'List all gyms in a region.',
    detail: [
      'The region name should be any valid region role (without the `@`).',
      'Case doesn\'t matter, and uniquely-identifying prefixes are allowed,',
      'so, e.g., `harvard` will work, but `boston` will not (but `boston',
      'common` is fine).',
    ],
    examples: {
      'boston c': 'List gyms in Boston Common/Garden.',
      'boston-common': 'Same as above.',
      'boston': 'Error; ambiguous region name.',
    },
  },
  'search-gym': {
    perms: Permission.NONE,
    access: Access.ALL,
    usage: '<partial-handle-or-name>',
    args: [Arg.VARIADIC],
    desc: 'Search for gyms matching a name fragment.',
    detail: [
      'This will find all gyms with handles _and_ in-game names matching the',
      'search term.',
    ],
    examples: {
      'sprint': 'List all Sprint store gyms (or other gyms with "sprint" ' +
                'in the name).',
    },
  },
  'add-gym': {
    perms: Permission.WHITELIST,
    access: Access.REGION,
    usage: '<gym-handle> <region> <lat> <lng> <name>',
    args: [Arg.STR, Arg.STR, Arg.STR, Arg.STR, Arg.VARIADIC],
    desc: 'Add a new gym to the database.',
    detail: [
      'The region name can be any string, but it must be free of whitespace. ',
      'Hyphens in the region name will be replaced by spaces.  Note also that',
      'no verification is performed to check that a region name matches that',
      'of any existing region, so make sure you use the right capitalization',
      'and avoid typos.\n\nThe recommended method for adding gyms is to copy',
      'information over from <http://www.massmwcreaturemap.com/>.  Note that',
      'the latitude argument is allowed to contain a trailing comma, for ease',
      'of copying.',
    ],
    examples: {
      'harbor In-the-Ocean 42.3571413, -71.0418669 Spoofer Trap':
        'Add the `[harbor]` **Spoofer Trap** gym at the given coordinates ' +
        'to the "In the Ocean" region.',
    },
  },
  'ls-regions': {
    perms: Permission.NONE,
    access: Access.ALL,
    usage: '',
    args: [],
    desc: 'List all regions with registered gyms.',
    detail: [
      'Listed regions correspond to taggable server regional roles.',
    ],
    examples: {
    },
  },

  'raid': {
    perms: Permission.NONE,
    access: Access.REGION_DM,
    usage: '<gym-handle-or-name>',
    args: [Arg.VARIADIC],
    desc: 'Get information about the current raid at a gym.',
    detail: [
      'Works just like `$gym`; see `$help gym` for more information.',
    ],
    examples: {
    },
  },
  'ls-raids': {
    perms: Permission.NONE,
    access: Access.REGION_DM,
    usage: '[tier] [region-name]',
    args: [-Arg.TIER, -Arg.VARIADIC],
    desc: 'List all active raids in a region.',
    detail: [
      'The region name should be any valid region role (without the `@`).',
      'Case doesn\'t matter, and uniquely-identifying prefixes are allowed,',
      'so, e.g., `harvard` will work, but `boston` will not (but `boston',
      'common` is fine).  See `$help ls-gyms` for examples.\n\nIf no region',
      'is provided, this lists all known raids.',
    ],
    examples: {
      '': 'List all known raids.',
      '4': 'List all T4 raids.',
      '5 boston common': 'List all T5 raids in Boston Common.',
      'cambridge': 'List all known Cambridge area raids.',
    },
  },
  'egg': {
    perms: Permission.BLACKLIST,
    access: Access.REGION_DM,
    usage: '<gym-handle-or-name> <tier> <time-til-hatch [HH:]MM:SS>',
    args: [Arg.VARIADIC, Arg.TIER, Arg.TIMER],
    mod_mask: Mod.FORCE | Mod.ANON,
    desc: 'Report a raid egg.',
    detail: [
      'The tier can be any number 1–5 or things like `t3` or `T4`.  The time',
      'should be the current _**countdown timer**_, not a time of day.  See',
      '`$help gym` for details on gym handles.\n\n`$egg` also accepts two',
      'modifiers:\n\t`$egg!` allows you to override an existing raid report',
      '(e.g., if it\'s incorrect).\n\t`$egg?` prevents your username from',
      'being included in raid report messages.\n\nThe two may be used in',
      'conjunction.',
    ],
    examples: {
      'galaxy-sphere 5 3:35':
        'Report a T5 egg hatching at **Galaxy: Earth Sphere** in three ' +
        'minutes and thirty-five seconds.',
      'galaxy sphere 5 3:35': 'Invalid because `sphere` is not a raid tier.',
    },
  },
  'boss': {
    perms: Permission.BLACKLIST,
    access: Access.REGION_DM,
    usage: '<gym-handle-or-name> <boss> <time-til-despawn [HH:]MM:SS>',
    args: [Arg.VARIADIC, Arg.BOSS, Arg.TIMER],
    mod_mask: Mod.FORCE | Mod.ANON,
    desc: 'Report a hatched raid boss.',
    detail: [
      'Raid bosses with multi-word names should be hyphenated; e.g.,',
      '`alolan-exeggutor`.  Some short names are supported, like `ttar` or',
      '`tall-eggtree`.  The time should be the current _**countdown',
      'timer**_, not a time of day.  See `$help gym` for details on gym',
      'handles.\n\n`$boss` also accepts two modifiers:\n\t`$boss!` allows',
      'you to override an existing raid report (e.g., if it\'s incorrect).\n\t',
      '`$boss?` prevents your username from being included in raid report',
      'messages.\n\nThe two may be used in conjunction.',
    ],
    examples: {
      'galaxy-sphere alolan-exeggutor 3:35':
        'Report an Alolan Exeggutor at **Galaxy: Earth Sphere** that ' +
        'despawns in three minutes and thirty-five seconds.',
      'galaxy sphere latios 3:35':
        'Invalid because `sphere` is not a raid tier.',
      'galaxy 5 3:35': 'Invalid because `5` is not a Pokemon.',
    },
  },
  'update': {
    perms: Permission.BLACKLIST,
    access: Access.REGION_DM,
    usage: '<gym-handle-or-name> <tier-or-boss-or-team>',
    args: [Arg.VARIADIC, Arg.STR],
    mod_mask: Mod.ANON,
    desc: 'Modify an active raid listing.',
    detail: [
      '`$update` accepts one modifier:\n\t`$update?` prevents your username',
      'from being included in raid update messages.',
    ],
    examples: {
      'galaxy 4': 'Change the raid tier at Galaxy to 4.',
      'galaxy tyranitar': 'Set the raid boss at Galaxy to Tyranitar.',
      'galaxy valor': 'Brag about your gym control.',
    },
  },
  'scrub': {
    perms: Permission.BLACKLIST,
    access: Access.REGION | Access.ADMIN_DM,
    usage: '<gym-handle-or-name>',
    args: [Arg.VARIADIC],
    desc: 'Delete a reported raid and all associated information.',
    detail: [
      'Please use sparingly, only to undo mistakes.  To fix raid timers or',
      'raid tier information, prefer `$egg!` or `$boss!`.',
    ],
    examples: {
    },
  },
  'ls-bosses': {
    perms: Permission.NONE,
    access: Access.ALL,
    usage: '',
    args: [],
    desc: 'List all known raid bosses and tiers.',
    detail: [],
    examples: {
    },
  },

  'call': {
    perms: Permission.BLACKLIST,
    access: Access.REGION,
    usage: '<gym-handle-or-name> <HH:MM> [num-extras]',
    args: [Arg.VARIADIC, Arg.HOURMIN, -Arg.INT],
    desc: 'Call a time for a raid.',
    detail: [
      'Setting multiple call times is allowed (and encouraged!), but make',
      'sure not to double-call the same time, or Moltres will be mad at you.',
      'Be aware that calling a time will tag the region that the gym is',
      'registered in.',
    ],
    examples: {
      'galaxy 1:42': 'Tag Kendall Square to call a raid meetup time at 1:42 ' +
                     'for **Galaxy: Earth Sphere**.',
      'galaxy 1:42 2': 'Same as above, but indicate that you\'re coming ' +
                       'with +2 extra people.',
    },
  },
  'cancel': {
    perms: Permission.BLACKLIST,
    access: Access.REGION,
    usage: '<gym-handle-or-name> [HH:MM]',
    args: [Arg.VARIADIC, -Arg.HOURMIN],
    desc: 'Cancel a called raid time.',
    detail: [
      'Specifying the time is only required if the raid has multiple called',
      'times.',
    ],
    examples: {
      'galaxy': 'Cancel the raid at **Galaxy: Earth Sphere**.  This ' +
                'only works if there is only a single called time.',
      'galaxy 1:42': 'Cancel the 1:42 p.m. raid at **Galaxy: Earth Sphere**.',
    },
  },
  'change-time': {
    perms: Permission.BLACKLIST,
    access: Access.REGION,
    usage: '<gym-handle-or-name> <current-HH:MM> to <desired-HH:MM>',
    args: [Arg.VARIADIC, Arg.HOURMIN, Arg.STR, Arg.HOURMIN],
    desc: 'Change a called time for a raid.',
    detail: [
      'Make sure to include the `to`; it\'s just there to enforce the right',
      'direction.  Anyone can change a called time, not just the original',
      'caller.  Changing a time will tag everyone who joined the original',
      'time.',
    ],
    examples: {
      'galaxy 1:42 to 2:00': 'Change the 1:42 p.m. raid meetup for ' +
                             '**Galaxy: Earth Sphere** to 1:52 p.m.',
    },
  },
  'join': {
    perms: Permission.NONE,
    access: Access.REGION,
    usage: '<gym-handle-or-name> [HH:MM] [num-extras]',
    args: [Arg.VARIADIC, -Arg.HOURMIN, -Arg.INT],
    desc: 'Join a called raid time.',
    detail: [
      'You don\'t need to specify the time _unless_ the raid has multiple',
      'called times, in which case you do.',
    ],
    examples: {
      'galaxy': 'Join the raid meetup at **Galaxy: Earth Sphere**.  This ' +
                'only works if there is only a single called time.',
      'galaxy 2': 'Same as above, but indicate that you have +2 extra raiders.',
      'galaxy 1:42': 'Join the 1:42 p.m. raid at **Galaxy: Earth Sphere**.',
      'galaxy 1:42 2': 'Same as above, but indicate that you have +2 extra ' +
                       'raiders.'
    },
  },
  'unjoin': {
    perms: Permission.NONE,
    access: Access.REGION,
    usage: '<gym-handle-or-name> [HH:MM]',
    args: [Arg.VARIADIC, -Arg.HOURMIN],
    desc: 'Back out of a scheduled raid.',
    detail: [
      'As with `$join`, you don\'t need to specify the time _unless_ the',
      'raid has multiple called times, in which case you do.',
    ],
    examples: {
      'galaxy': 'Unjoin the raid at **Galaxy: Earth Sphere**.  This ' +
                'only works if there is only a single called time.',
      'galaxy 1:42': 'Unjoin the 1:42 p.m. raid at **Galaxy: Earth Sphere**.',
    },
  },

  'ex': {
    perms: Permission.BLACKLIST,
    access: Access.EX_MAIN,
    usage: '<gym-handle-or-name> [MM/DD]',
    args: [Arg.VARIADIC, -Arg.MONTHDAY],
    desc: 'Enter an EX raid room.',
    detail: [
      'This will create the room the first time it\'s used for a given EX',
      'raid, so please be careful not to abuse it or mistype the date.',
      'If a date is not provided, this just adds the user to an existing',
      'room, or fails if one hasn\'t already been created.',
    ],
    examples: {
      'jh 12/25': 'Enter (and maybe create) the EX raid room for **John ' +
                  'Harvard Statue** on the upcoming Christmas Day.',
      'jh': 'Enter the EX raid room for **John Harvard Statue**.',
    },
  },
  'exit': {
    perms: Permission.BLACKLIST,
    access: Access.EX_ROOM,
    usage: '',
    args: [],
    desc: 'Exit the EX raid room you\'re in.',
    detail: [
      'Can only be used from EX raid rooms.',
    ],
    examples: {
    },
  },
  'examine': {
    perms: Permission.BLACKLIST,
    access: Access.EX_ROOM,
    usage: '',
    args: [],
    desc: 'List all EX raiders in the current EX raid room.',
    detail: [
      'Can only be used from EX raid rooms.',
    ],
    examples: {
    },
  },
  'exact': {
    perms: Permission.BLACKLIST,
    access: Access.EX_ROOM,
    usage: '<HH:MM[am/pm]>',
    args: [Arg.HOURMIN],
    desc: 'Set the time for an EX raid.',
    detail: [
      'Can only be used from EX raid rooms.',
    ],
    examples: {
    },
  },
  'exclaim': {
    perms: Permission.BLACKLIST,
    access: Access.EX_ROOM,
    usage: '[message]',
    args: [Arg.VARIADIC],
    desc: 'Ask Moltres to tag everyone in the room.',
    detail: [
      'Can only be used from EX raid rooms.  Please don\'t spam.',
    ],
    examples: {
    },
  },
  'explore': {
    perms: Permission.BLACKLIST,
    access: Access.EX_MAIN,
    usage: '',
    args: [],
    desc: 'List all active EX raid rooms.',
    detail: [
      'Can only be used from the designated EX raid discussion channel.',
    ],
    examples: {
    },
  },
  'expunge': {
    perms: Permission.WHITELIST,
    access: Access.EX_MAIN,
    usage: '<MM/DD>',
    args: [Arg.MONTHDAY],
    desc: 'Clear all EX raid rooms for the given date.',
    detail: [],
    examples: {
    },
  },
  'exalt': {
    perms: Permission.WHITELIST,
    access: Access.EX_MAIN,
    usage: '<gym-handle-or-name>',
    args: [Arg.VARIADIC],
    desc: 'Mark a gym as EX-eligible.',
    detail: [],
    examples: {
    },
  },
};

const req_aliases = {
  'g':            'gym',
  'gs':           'ls-gyms',
  'gyms':         'ls-gyms',
  'r':            'raid',
  'rs':           'ls-raids',
  'raids':        'ls-raids',
  'e':            'egg',
  'b':            'boss',
  'u':            'update',
  'regions':      'ls-regions',
  'search':       'search-gym',
  'search-gyms':  'search-gym',
  's':            'search-gym',
  'call-time':    'call',
  'uncall':       'cancel',
  'j':            'join',
};

const gyaoo = 'Gyaoo!';

///////////////////////////////////////////////////////////////////////////////
// Derived config state.

/*
 * Pull the entire bosses table into global data structures.
 */
async function read_bosses_table() {
  let [results, err] = await moltresdb.query(
    'SELECT * FROM bosses'
  );
  if (err) return [null, null];

  let raid_tiers = {};
  let boss_defaults = [];

  for (let row of results) {
    if (row.is_default) {
      boss_defaults[row.tier] = row.boss;
    }
    raid_tiers[row.boss] = row.tier;
  }
  return [raid_tiers, boss_defaults];
}

/*
 * Invert the boss-to-tier map and return the result.
 */
function compute_tier_boss_map(raid_tiers) {
  let ret = [];

  for (let boss in raid_tiers) {
    let tier = raid_tiers[boss];
    ret[tier] = ret[tier] || [];
    ret[tier].push(boss);
  }
  for (let list of ret) {
    if (list) list.sort();
  }
  return ret;
};

/*
 * Invert the channel-to-region map, and splat out any metaregions.
 */
function compute_region_channel_map() {
  let ret = {};

  for (let chan in config.channels) {
    let regions = config.channels[chan];
    for (let region of regions) {
      if (region in config.metaregions) {
        for (let subregion of config.metaregions[region]) {
          ret[subregion] = ret[subregion] || new Set();
          ret[subregion].add(chan);
        }
      } else {
        ret[region] = ret[region] || new Set();
        ret[region].add(chan);
      }
    }
  }
  for (let region in ret) {
    ret[region] = [...ret[region]];
  }
  return ret;
}

/*
 * Splat metaregions out into regions for the region-to-timezone map.
 *
 * Any region overrides will take precedence over overrides for any containing
 * metaregions.
 */
function compute_region_tz_map() {
  let ret = {};

  for (let region in config.timezones) {
    if (!(region in config.metaregions)) continue;

    for (let subregion of config.metaregions[region]) {
      ret[subregion] = config.timezones[region];
    }
  }
  for (let region in config.timezones) {
    if (region in config.metaregions) continue;
    ret[region] = config.timezones[region];
  }

  return ret;
}

///////////////////////////////////////////////////////////////////////////////
// Misc utilities.

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.substr(1);
}

///////////////////////////////////////////////////////////////////////////////
// Discord utilities.

/*
 * Get the main guild for bot requests.
 */
function guild() {
  return moltres.guilds.get(config.guild_id);
}

/*
 * Whether `user' is a member of `guild'.
 */
function is_member(guild, user) {
  return guild.member(user) !== null;
}

/*
 * Whether `msg' is from a DM.
 */
function from_dm(msg) {
  return msg.channel.type === 'dm';
}

/*
 * Wrapper around send() that chains messages and swallows exceptions.
 */
async function send_quiet_impl(channel, ...contents) {
  if (contents.length === 0) return;
  let [head, ...tail] = contents;

  let message = null;
  try {
    message = await channel.send(head);
    for (let item of tail) {
      message = await message.channel.send(item);
    }
  } catch (e) {
    console.error(e);
  }
  return message;
}

/*
 * Wrappers around send_quiet_impl() which perform message chunking.
 */
function send_quiet(channel, content) {
  let outvec = [];

  if (typeof content === 'string') {
    while (content.length >= 2000) {
      let split_pos = content.lastIndexOf('\n', 2000);
      if (split_pos === -1) split_pos = 2000;

      outvec.push(content.substr(0, split_pos));
      content = content.substr(split_pos);
    }
  }
  outvec.push(content);

  return send_quiet_impl(channel, ...outvec);
}
async function dm_quiet(user, content) {
  try {
    let dm = await user.createDM();
    return send_quiet(dm, content);
  } catch (e) {
    log_impl(null, `Problem sending a DM to: ${user}`);
    console.error(e);
  }
}

/*
 * Send `content' to all the channels for `region'.
 */
function send_for_region(region, content) {
  let channels = channels_for_region[region];
  if (!channels) return;

  return Promise.all(channels.map(chan_id => {
    let chan = moltres.channels.get(chan_id);
    return send_quiet(chan, content);
  }));
}

/*
 * Try to delete a message if it's not on a DM channel.
 */
async function try_delete(msg, wait = 0) {
  if (from_dm(msg)) return;
  try {
    await msg.delete(wait);
  } catch (e) {
    console.error(e);
  }
}

/*
 * Reply to a message via DM, then delete it.
 */
async function dm_reply_then_delete(msg, content, wait = 500) {
  await dm_quiet(msg.author, content);
  return try_delete(msg, wait);
}

/*
 * Re-load a message for performing further operations.
 */
function refresh(msg) {
  return msg.channel.fetchMessage(msg.id);
}

/*
 * Get an emoji by name.
 */
function get_emoji(name) {
  name = config.emoji[name] || name;
  return emoji_by_name[name] ||
         moltres.emojis.find(e => e.name === name);
}

/*
 * Add reactions to `msg' in order.
 */
async function chain_reaccs(msg, ...reaccs) {
  if (reaccs.length === 0) return;
  let [head, ...tail] = reaccs;

  try {
    let emoji = get_emoji(head);
    let reaction = await msg.react(emoji);

    for (let name of tail) {
      let emoji = get_emoji(name);
      reaction = await reaction.message.react(emoji);
    }
  } catch (e) {
    console.error(e);
  }
}

/*
 * Get a Role by `name' for the global guild.
 *
 * This performs a case-insensitive prefix match of `name' against the names of
 * all roles in the guild.  If that fails, it tries again replacing all hyphens
 * with whitespace.
 */
function get_role(name) {
  let impl = function(name) {
    let role = guild().roles.find(r => r.name === name);
    if (role) return role;

    role = guild().roles.find(r => r.name === capitalize(name));
    if (role) return role;

    let matches = guild().roles.filter(
      role => role.name.toLowerCase().startsWith(name.toLowerCase())
    );
    return matches.length === 1 ? matches.first() : null;
  };

  let role = impl(name);
  if (role !== null) return role;

  return impl(name.replace(/-/g, ' '));
}

/*
 * Count all the mentions in `msg'.
 */
function total_mentions(msg) {
  return msg.mentions.channels.size +
         msg.mentions.members.size +
         msg.mentions.roles.size +
         msg.mentions.users.size +
         msg.mentions.everyone;
}

/*
 * Return whether `msg' has exactly one image attachment.
 */
function has_single_image(msg) {
  if (msg.attachments.size !== 1) return null;
  return !!msg.attachments.first().height;
}

/*
 * Pin `msg' to its containing channel if there are no other pins.
 */
async function pin_if_first(msg) {
  let pins = await msg.channel.fetchPinnedMessages();
  if (pins.size !== 0) return;
  return msg.pin();
}

///////////////////////////////////////////////////////////////////////////////
// Error logging.

/*
 * Log base function.
 */
function log_impl(msg, str, reacc = null) {
  let promises = [];

  let log = moltres.channels.get(config.log_id);
  promises.push(send_quiet(log, str));

  if (reacc) promises.push(chain_reaccs(msg, reacc));

  return Promise.all(promises);
};

/*
 * Log a successful request, an invalid request, or an internal error.
 */
function react_success(msg, reacc = null) {
  return chain_reaccs(msg, reacc || 'approved');
};
function log_error(msg, str, reacc = null) {
  return log_impl(msg, '_Error:_  ' + str, reacc || 'no_good');
};
async function log_invalid(msg, str, keep = false) {
  let orig_str = str;

  // Truncate long error messages types.
  if (str.startsWith('**Usage**')) {
    str = 'Usage: [...]';
  }
  let pos = str.indexOf('\nGyms matching');
  if (pos !== -1) {
    str = str.slice(0, pos);
  }

  await Promise.all([
    log_impl(msg, '_Error:_  ' + str, null),
    dm_quiet(msg.author, orig_str),
  ]);
  if (!keep) await try_delete(msg);
};

/*
 * Get the usage string for `req'.
 */
function usage_string(req) {
  if (!(req in reqs)) return null;
  let meta = reqs[req];

  let result = `**Usage**: \`\$${req} ${meta.usage}\`

(Arguments in \`<>\` are required; arguments in \`[]\` are optional.)

${meta.detail.join(' ')}`;

  let aliases = Object.keys(req_aliases)
    .filter(k => req_aliases[k] === req)
    .map(a => `\`\$${a}\``);
  if (aliases.length > 0) {
    result += `\n\n**Aliases**: ${aliases.join(', ')}`;
  }

  if (Object.keys(meta.examples).length === 0) return result;
  result += '\n\n**Examples**:';

  for (let ex in meta.examples) {
    result += `\n\t\`\$${req} ${ex}\`: ${meta.examples[ex]}`;
  }
  return result;
}

/*
 * Extract an array of unique gym table entries from an error-messaging query.
 *
 * The `rows' can either be nested or not, and we assume that where_one_gym
 * uniquification has not already been performed.
 */
function uniq_gyms_for_error(rows, handle) {
  let [first = {}] = rows;

  if ('gyms' in first) {
    rows = rows.map(row => row.gyms);
  }

  let found_handles = new Set();

  rows = rows.filter(gym => {
    if (found_handles.has(gym.handle)) return false;
    found_handles.add(gym.handle);
    return true;
  });

  // Account for our preference for exact handle matches.
  let maybe_unique = rows.filter(gym => gym.handle === handle);
  if (maybe_unique.length === 1) rows = maybe_unique;

  return rows;
}

/*
 * Return false and handle error responses if the gym query result `gyms'
 * doesn't uniquely match `handle'.
 *
 * Otherwise, return true.
 */
async function check_gym_match(msg, gyms, handle) {
  if (gyms.length === 0) {
    await log_invalid(msg,
      `No gyms found matching \`[${handle}]\`.`
    );
    return false;
  }
  if (gyms.length > 1) {
    await log_invalid(msg,
      `Ambiguous gym identifier \`[${handle}]\`.\n` +
      `Gyms matching \`${handle}\`:\n\n` + list_gyms(gyms)
    );
    return false;
  }
  return true;
}

/*
 * Query the full left join table of gyms, active raids, and calls.
 *
 * We then ensure there is a single best gym match (else log an error), and
 * return a tuple of the raid and call time info, along with the row for the
 * gym itself.
 */
async function query_for_error(msg, handle, now = null) {
  now = now || get_now();

  let [results, err] = await moltresdb.query({
    sql:
      'SELECT * FROM gyms ' +
      '   LEFT JOIN raids ON ( ' +
      '         gyms.id = raids.gym_id ' +
      '     AND raids.despawn > ? ' +
      '   ) ' +
      '   LEFT JOIN calls ON raids.gym_id = calls.raid_id ' +
      'WHERE gyms.handle LIKE ? OR gyms.name LIKE ? ',
    values: [now].concat(Array(2).fill(`%${handle}%`)),
    nestTables: true,
  });
  if (err) {
    await log_mysql_error(msg, err);
    return [null, null];
  }

  let gyms = uniq_gyms_for_error(results, handle);

  let pass = await check_gym_match(msg, gyms, handle);
  if (!pass) return [null, null];

  let [gym] = gyms;
  let call_rows = results.filter(row => row.gyms.handle === gym.handle);

  return [call_rows, gym];
}

/*
 * Like query_for_error(), but checks call times.
 */
async function query_for_error_call(msg, handle, call_time, req, now = null) {
  let [call_rows, gym] = await query_for_error(msg, handle);
  if (!gym) return [null, null];

  let fail = async function(...args) {
    await log_invalid(...args);
    return [null, gym];
  };

  let [first] = call_rows;

  if (first.raids.gym_id === null) {
    return fail(msg,
      `No raid has been reported at ${gym_name(gym)}.`
    );
  }
  if (first.calls.raid_id === null) {
    return fail(msg,
      `No times have been called for the raid at ${gym_name(gym)}.`
    );
  }

  if (!call_time && call_rows.length > 1) {
    return fail(msg,
      `Multiple times have been called for the raid at ${gym_name(gym)}.` +
      `  Please include the time in your post (e.g., \`$${req} ${handle} ` +
      `${time_str_short(first.calls.time, gym.region)} [...])\`.`
    );
  }

  let call = !!call_time
    ? call_rows.find(row => row.calls.time.getTime() === call_time.getTime())
    : call_rows[0];

  if (call_time && !call) {
    return fail(msg,
      `No raid at ${gym_name(gym)} has been called for ` +
      `${time_str(call_time, gym.region)}.`
    );
  }
  return [call, gym];
}

///////////////////////////////////////////////////////////////////////////////
// MySQL utilities.

/*
 * NB: The `result' for a mutation has the following structure:
 *
 * OkPacket {
 *   fieldCount: 0,
 *   affectedRows: 1,
 *   insertId: 23,
 *   serverStatus: 34,
 *   warningCount: 0,
 *   message: '&Records: 1  Duplicates: 0  Warnings: 0',
 *   protocol41: true,
 *   changedRows: 0,
 * }
 */

/*
 * Log a MySQL error.
 */
function log_mysql_error(msg, err) {
  console.error(err);
  return log_error(msg,
    `MySQL error: ${err.code} (${err.errno}): ${err.sqlMessage})`
  );
}

///////////////////////////////////////////////////////////////////////////////
// SQL snippets.

/*
 * Get a SQL WHERE clause fragment for selecting a unique gym matching `handle'.
 */
function where_one_gym(handle) {
  handle = handle.replace(/’/g, "'");

  return mysql.format(
    ' (gyms.handle = ? OR (' +
    '   (gyms.handle LIKE ? OR gyms.name LIKE ?) AND ' +
    '   (SELECT COUNT(*) FROM gyms WHERE ' +
    '     (gyms.handle LIKE ? OR gyms.name LIKE ?)) = 1 ' +
    ' ))',
    [handle].concat(Array(4).fill(`%${handle}%`))
  );
}

/*
 * Get a SQL WHERE clause fragment for selecting a region or all regions
 * belonging to a metaregion.
 */
function where_region(region) {
  let metanames = Object.keys(config.metaregions).filter(
    name => name.toLowerCase().startsWith(region.toLowerCase())
  );

  if (metanames.length !== 1) {
    return {
      meta: null,
      sql: mysql.format('gyms.region LIKE ?', [`${region}%`]),
    };
  }

  let regions = config.metaregions[metanames[0]]
  let sql = regions
    .map(r => mysql.format('gyms.region LIKE ?', [`${r}%`]))
    .join(' OR ');

  return {
    meta: metanames[0],
    sql: `(${sql})`,
  };
}

/*
 * Get a SQL WHERE clause fragment for selecting a specific call time.
 *
 * If `time' is null, instead we select for a single unique time.
 *
 * If `for_update' is true, we proxy through a temporary table because we're
 * modifying the calls table.
 */
function where_call_time(call_time, for_update = false) {
  if (!!call_time) {
    return mysql.format(' calls.time = ? ', [call_time]);
  }
  return (
    ' (SELECT COUNT(*) FROM ' +
    (for_update ? '(SELECT * FROM calls)' : 'calls') +
    '  AS calls_tmp' +
    '  WHERE raids.gym_id = calls_tmp.raid_id) = 1 '
  );
}

/*
 * Get the region for the gym uniquely given by `handle'.
 *
 * If there is no such gym, return null.  This function never errors.
 */
async function select_region(handle) {
  let [results, err] = await moltresdb.query(
    'SELECT * FROM gyms WHERE ' + where_one_gym(handle)
  );
  if (err) return log_mysql_error(msg, err);

  if (results.length !== 1) return null;
  let [gym] = results;

  return gym.region;
}

/*
 * Join table for all raid metadata.
 */
const full_join_table =
  ' gyms ' +
  '   INNER JOIN raids ON gyms.id = raids.gym_id ' +
  '   LEFT JOIN calls ON raids.gym_id = calls.raid_id ' +
  '   LEFT JOIN rsvps ON calls.id = rsvps.call_id ';

/*
 * Select all rows from the full left-join raid-rsvps table for a unique gym
 * `handle' and satisfying `xtra_where'.
 */
function select_rsvps(handle, xtra_where = null, xtra_values = []) {
  return moltresdb.query({
    sql:
      'SELECT * FROM ' + full_join_table +
      '   WHERE ' + where_one_gym(handle) +
      (xtra_where ? ` AND (${xtra_where})` : ''),
    values: xtra_values,
    nestTables: true,
  });
}

///////////////////////////////////////////////////////////////////////////////
// Time utilities.

const egg_duration = 60;
const boss_duration = 45;

/*
 * Return a Date for the current time.
 */
function get_now() {
  return new Date(Date.now());
}

/*
 * Parse a date given by MM/DD as a Date object.
 */
function parse_month_day(date) {
  let matches = date.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (matches === null) return null;

  let [, month, day] = matches;
  [month, day] = [parseInt(month), parseInt(day)];

  let now = get_now();

  return new Date(
    now.getFullYear() + (now.getMonth() === 12 && month === 1),
    month - 1,
    day
  );
}

/*
 * Parse a time given by HH:MM[am|pm].
 */
function parse_hour_minute(time) {
  let matches = time.match(/^(\d{1,2})[:.](\d\d)([aApP][mM])?$/);
  if (matches === null) return null;

  let [, hours, mins, am_pm] = matches;
  [hours, mins] = [parseInt(hours), parseInt(mins)];
  if (hours >= 24 || mins >= 60) return null;

  return {hours, mins, am_pm};
}

/*
 * Take an object returned by parse_hour_minute() and convert to a Date object.
 *
 * This function uses rough heuristics to determine whether the user meant A.M.
 * or P.M., based on the assumption that the intent is always to represent the
 * most proximal time in the future.  Users can override this with `am`/`pm`.
 */
async function interpret_time(timespec, handle = null) {
  if (timespec === null) return null;
  let {hours, mins, am_pm} = timespec;

  let now = get_now();

  let tz = await async function() {
    // Use the default timezone if we have no region or no overrides.
    if (handle === null) return config.tz_default;
    if (Object.keys(tz_for_region).length === 0) return config.tz_default;

    let region = await select_region(handle);
    // If we failed to find a region for `handle', just use the default
    // timezone.  This may not match the user's intentions, but some other
    // failure is going to be reported anyway, so it doesn't matter.
    if (region === null) return config.tz_default;

    return tz_for_region[region] || config.tz_default;
  }();

  let offset_delta = function() {
    let local_offset = -now.getTimezoneOffset();
    let local_tz = FixedOffsetZone.instance(local_offset);
    let remote_tz = IANAZone.create(tz);
    let remote_offset = remote_tz.offset(now.getTime());

    return (remote_offset - local_offset) / 60;
  }();

  hours = function() {
    if (am_pm) {
      am_pm = am_pm.toLowerCase();
      if (am_pm === 'am') return hours % 12;
      if (am_pm === 'pm') return hours % 12 + 12;
    }
    // 24-hour time; let the user use exactly that time.
    if (hours == 0 || hours >= 13) return hours;
    // Same or later morning hour.
    if (hours >= now.getHours() + offset_delta) return hours;
    // Same or later afternoon hour if we interpret as P.M.
    if (hours + 12 >= now.getHours() + offset_delta) return hours + 12;

    return hours;
  }() - offset_delta;

  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    mins
  );
}

/*
 * Stringify a Date object according to our whims.
 */
function date_str(date, region) {
  return date.toLocaleString('en-US', {
    timeZone: tz_for_region[region] || config.tz_default,
    month: 'short',
    day: '2-digit',
  });
}
function time_str(date, region) {
  return date.toLocaleString('en-US', {
    timeZone: tz_for_region[region] || config.tz_default,
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  });
}
function time_str_short(date, region) {
  let str = time_str(date, region);
  let pos = str.indexOf(' ');
  if (pos === -1) return str;
  return str.substr(0, pos);
}

/*
 * Get the raid pop or hatch time from a despawn time.
 */
function pop_from_despawn(despawn) {
  let pop = new Date(despawn.getTime());
  pop.setMinutes(pop.getMinutes() - egg_duration - boss_duration);
  return pop;
}
function hatch_from_despawn(despawn) {
  let hatch = new Date(despawn.getTime());
  hatch.setMinutes(hatch.getMinutes() - boss_duration);
  return hatch;
}

///////////////////////////////////////////////////////////////////////////////
// Argument parsing.

/*
 * Extract the minutes and seconds from a raid countdown timer.
 */
function parse_timer(timer) {
  let matches = timer.match(/^(\d{1,2}[:.])?(\d{1,2})[:.](\d\d)$/);
  if (matches === null) return null;

  let [, hrs = 0, mins, secs] = matches;
  if (secs >= 60) return null;

  return {
    mins: 60 * parseInt(hrs) + parseInt(mins),
    secs: parseInt(secs),
  };
}

/*
 * Pull the integer tier from a tier string (e.g., '5' or 'T5'), or return null
 * if the string is not tier-like.
 */
function parse_tier(tier) {
  if (tier.startsWith('T') || tier.startsWith('t')) {
    tier = tier.substr(1);
  }
  let t = parseInt(tier);
  if ('' + t !== tier) return null;
  return (t >= 1 && t <= 5) ? t : null;
}

/*
 * Return the unique boss name matching `input', else return null.
 *
 * The match rules are as follows:
 *    1/ Apply boss aliases to the input.
 *    2/ If the input is a prefix of a single boss name, return it.
 *    3/ Get all the boss names that start with input[0].  If there is a unique
 *       boss with edit distance 1 from the input, return it.
 */
function parse_boss(input) {
  input = input.toLowerCase();
  input = config.boss_aliases[input] || input;

  let wrap = boss => ({boss: boss, orig: input});

  if (input.length === 0) return null;

  let matches = raid_data.raid_trie.getPrefix(input);
  if (matches.length === 1) return wrap(matches[0]);

  matches = raid_data.raid_trie.getPrefix(input[0])
    .map(boss => ({
      boss: boss,
      lev: ed.levenshtein(input, boss, _ => 1, _ => 1, (x, y) => x !== y),
    }))
    .filter(meta => meta.lev.distance <= 2);
  if (matches.length === 1) return wrap(matches[0].boss);

  return null;
}

/*
 * Extract the boss name from the output of parse_boss(), DM-ing the user if
 * the match was inexact.
 */
async function extract_boss(msg, boss) {
  if (boss === null) return null;

  if (!boss.boss.startsWith(boss.orig)) {
    await dm_quiet(msg.author,
      `Assuming \`${boss.orig}\` is the British spelling of \`${boss.boss}\`.`
    );
  }
  return boss.boss;
}

/*
 * Parse a single argument `input' according to `kind'.
 */
function parse_one_arg(input, kind) {
  switch (kind) {
    case Arg.STR:
      return input;
    case Arg.INT: {
      let i = parseInt(input);
      return '' + i === input ? i : null;
    }
    case Arg.VARIADIC:
      return input;
    case Arg.MONTHDAY:
      return parse_month_day(input);
    case Arg.HOURMIN:
      return parse_hour_minute(input);
    case Arg.TIMER:
      return parse_timer(input);
    case Arg.TIER:
      return parse_tier(input);
    case Arg.BOSS:
      return parse_boss(input);
    default: break;
  }
  return null;
}

/*
 * Parse the `input' string using `spec'.
 *
 * Returns an array of extracted arguments.  Individual arguments may be
 * InvalidArg if they were invalid in `input', or null if they were optional
 * and not found.  If `input' has more or fewer space-separated arguments than
 * `spec' requires, returns null.
 */
function parse_args(input, spec) {
  input = input.trim();
  if (spec === null) return [input];

  let required = spec.filter(a => a >= 0).length;

  if (input.length === 0) {
    if (required > 0) return null;
    return new Array(spec.length).fill(null);
  }

  let re = /\s+/g;
  let splits = [{start: 0}];

  // Construct an array of {start, end} records representing all the space-
  // separated components of `input'.
  while (true) {
    let match = re.exec(input);
    if (match === null) break;

    splits[splits.length - 1].end = match.index;
    splits.push({start: re.lastIndex});
  }
  splits[splits.length - 1].end = input.length;

  if (splits.length < required) return null;

  let argv = [];
  let spec_idx = 0;
  let split_idx = 0;

  let vmeta = null;

  // We're going to jump through a lot of hoops to avoid writing a backtracking
  // regex matcher to support both * and ?, since we know we have at most one
  // variadic.
  let backtrack = function() {
    if (vmeta !== null && ++vmeta.split_end <= vmeta.split_limit) {
      argv = argv.slice(0, vmeta.argv_idx);
      spec_idx = vmeta.spec_idx;
      split_idx = vmeta.split_idx;
      return true;
    }
    return false;
  };

  while (true) {
    let num_invalid = 0;

    while (spec_idx < spec.length) {
      let kind = spec[spec_idx++];

      // Too few arguments.
      if (split_idx >= splits.length) {
        // Order of match interpretation priority is:
        //    1/ all non-variadic arguments over variadic arguments
        //    2/ variadic absorption over missing optionals
        //    3/ missing optionals
        //
        // The order of 2 and 3 is handled by our non-greedy variadic
        // absorption logic below, so we need to prefer passing on missing
        // optionals here.
        if (kind < 0) {
          argv.push(null);
          continue;
        }
        if (backtrack()) continue;
        return null;
      }

      let info = splits[split_idx++];

      if (Math.abs(kind) === Arg.VARIADIC) {
        if (vmeta === null) {
          vmeta = {
            // Indexes of the variadic argument.
            argv_idx: argv.length,
            spec_idx: spec_idx - 1,
            split_idx: split_idx - 1,
            // Index of the positional argument after the variadic is matched.
            // We'll push this out one further if we fail to match as is, until
            // we run out of optional arguments we could potentially bypass.
            split_end: splits.length - (spec.length - spec_idx),
          };
          vmeta.split_end_orig = vmeta.split_end;
          // Threshold for how far we can push split_end out to.
          vmeta.split_limit = vmeta.split_end +
            spec.slice(spec_idx).filter(a => a < 0).length;
        }

        // Get the variadic component exactly as the user input it.
        split_idx = Math.max(split_idx, vmeta.split_end);
        let arg = input.substring(info.start, splits[split_idx - 1].end);
        argv.push(arg);
        continue;
      }

      let raw = input.substring(info.start, info.end);
      let arg = parse_one_arg(raw, Math.abs(kind));
      num_invalid += arg === null;

      if (kind >= 0 || spec_idx === spec.length) {
        argv.push(arg !== null ? arg : new InvalidArg(raw));
      } else {
        // If the argument was optional and failed to parse, assume the user
        // intended to skip it and try to parse it again as the next argument.
        argv.push(arg);
        if (arg === null) --split_idx;
      }
    }

    if (vmeta !== null &&
        num_invalid > vmeta.split_end - vmeta.split_end_orig
        && backtrack()) {
      continue;
    }

    if (split_idx < splits.length) {
      // Too many arguments.
      if (backtrack()) continue;
      return null;
    }
    break;
  }
  return argv;
}

///////////////////////////////////////////////////////////////////////////////
// General handlers.

function handle_help(msg, req) {
  let out = null;

  if (req === null) {
    out = get_emoji('team') +
          '  Please choose your request from the following:\n\n';
    for (let req of req_order) {
      if (req !== null) {
        out += `\`\$${req}\`:  ${reqs[req].desc}\n`;
      } else {
        out += '\n';
      }
    }
    out += [
      '\nMake sure you prefix the request name with a dollar sign, with no',
      'space in-between.\n\nMost requests can be made via DM in addition to',
      'in regional channels.  Please be thoughtful about where you make your',
      'requests.  If you\'re pubbing some recently reported raids, trying to',
      'get numbers, answering a question for someone, etc., use the channel. ',
      'If you just got free and want to check on the current raid landscape,',
      'do that in a DM.\n\nUse `$help <req>` (e.g., `$help ls-gyms`) to learn',
      'more about a specific request.\n\nMoltres\'s trainer is @mxawng#8480. ',
      'You can help out at: <https://github.com/mxw/moltres>',
    ].join(' ');
  } else {
    req = req_aliases[req] || req;

    if (!(req in reqs)) {
      return log_invalid(msg, `Invalid request \`${req}\`.`);
    }
    out = `\`\$${req}\`:  ${reqs[req].desc}\n\n${usage_string(req)}`;
  }
  out = out.trim();

  if (config.admin_ids.has(msg.author.id)) {
    return send_quiet(msg.channel, out.trim());
  } else {
    return dm_reply_then_delete(msg, out);
  }
}

///////////////////////////////////////////////////////////////////////////////
// Config handlers.

async function handle_set_perm(msg, user_tag, req) {
  if (!user_tag.match(Discord.MessageMentions.USERS_PATTERN) ||
      msg.mentions.users.size !== 1) {
    return log_invalid(msg, `Invalid user tag \`${user_tag}\`.`);
  }
  let user = msg.mentions.users.first();

  let [result, err] = await moltresdb.query(
    'INSERT INTO permissions SET ?',
    { cmd: req,
      user_id: user.id, }
  );
  if (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      [result, err] = await moltresdb.query(
        'DELETE FROM permissions WHERE ?',
        { cmd: req,
          user_id: user.id, }
      );
      if (err) {
        return log_mysql_error(msg, err);
      }
    }
    return log_mysql_error(msg, err);
  }

  if (result.affectedRows === 0) {
    return log_invalid(msg, 'Unknown failure.');
  }
  return react_success(msg);
}

async function handle_ls_perms(msg) {
  let [results, err] = await moltresdb.query(
    'SELECT * FROM permissions'
  );
  if (err) return log_mysql_error(msg, err);

  let perms = {};

  for (let row of results) {
    perms[row.cmd] = perms[row.cmd] || [];

    let member = guild().members.get(row.user_id);
    if (!member) continue;

    perms[row.cmd].push(member.nickname || member.user.username);
  }

  let outvec = [];

  for (let req in perms) {
    if (perms[req].length === 0) continue;
    perms[req].sort();

    let example_req = req;

    // Just loop through the permissions alias table to find an example.
    for (let ex in req_to_perm) {
      if (req_to_perm[ex] === req) {
        example_req = ex;
        break;
      }
    }
    let perm = reqs[example_req].perms;
    let perm_str = perm === Permission.WHITELIST ? 'whitelist' :
                   perm === Permission.BLACKLIST ? 'blacklist' :
                   'unknown';

    outvec.push(`\`${req}\` [${perm_str}]:\t` + perms[req].join(', '));
  }
  return send_quiet(msg.channel,
    `**Permissions:**\n\n` + outvec.join('\n')
  );
}

async function handle_add_boss(msg, boss, tier) {
  if (tier instanceof InvalidArg) {
    return log_invalid(msg, `Invalid raid tier \`${tier.arg}\`.`);
  }
  boss = boss.toLowerCase();

  let old_tier = raid_data.raid_tiers[boss];

  let [, err] = await moltresdb.query(
    'REPLACE INTO bosses SET ?',
    { boss: boss, tier: tier }
  );
  if (err) return log_mysql_error(msg, err);

  if (!!old_tier) {
    raid_data.bosses_for_tier[old_tier] =
      raid_data.bosses_for_tier[old_tier].filter(b => b !== boss);
  }
  raid_data.raid_tiers[boss] = tier;
  raid_data.bosses_for_tier[tier].push(boss);
  raid_data.bosses_for_tier[tier].sort();
  raid_data.raid_trie = trie(Object.keys(raid_data.raid_tiers));

  return react_success(msg);
}

async function handle_rm_boss(msg, boss) {
  if (!(boss in raid_data.raid_tiers)) {
    return log_invalid(msg, `Unregistered raid boss \`${boss}\`.`);
  }
  let tier = raid_data.raid_tiers[boss];

  let [, err] = await moltresdb.query(
    'DELETE FROM bosses WHERE `boss` = ?',
    [boss]
  );
  if (err) return log_mysql_error(msg, err);

  delete raid_data.raid_tiers[boss];
  raid_data.bosses_for_tier[tier] =
    raid_data.bosses_for_tier[tier].filter(b => b !== boss);
  raid_data.raid_trie = trie(Object.keys(raid_data.raid_tiers));

  return react_success(msg);
}

async function handle_def_boss(msg, boss) {
  let tier = raid_data.raid_tiers[boss];
  if (!tier) {
    tier = parse_tier(boss);
    boss = null;
    if (tier === null) {
      return log_invalid(msg, `Unregistered raid boss \`${boss}\`.`);
    }
  }

  let [, err] = await moltresdb.query(
    'UPDATE bosses ' +
    '  SET `is_default` = CASE WHEN `boss` = ? THEN 1 ELSE 0 END ' +
    '  WHERE `tier` = ?',
    [boss, tier]
  );
  if (err) return log_mysql_error(msg, err);

  raid_data.boss_defaults[tier] = boss;

  return react_success(msg);
}

///////////////////////////////////////////////////////////////////////////////
// Developer handlers.

function handle_reload_config(msg) {
  delete require.cache[require.resolve('./config.js')];
  delete require.cache[require.resolve('./emoji.js')];

  emoji_by_name = require('./emoji.js');
  config = require('./config.js');
  channels_for_region = compute_region_channel_map();
  tz_for_region = compute_region_tz_map();

  return react_success(msg);
}

async function handle_raidday(msg, boss, despawn) {
  if (boss instanceof InvalidArg) {
    return log_invalid(msg, `Invalid raid boss \`${boss.arg}\`.`);
  }
  if (despawn instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${despawn.arg}\`.`);
  }
  despawn = await interpret_time(despawn);

  return moltresdb.query(
    'REPLACE INTO raids (`gym_id`, `tier`, `boss`,  `despawn`, `spotter`) ' +
    '   SELECT `id`, ?, ?, ?, ? FROM gyms',
    [raid_data.raid_tiers[boss], boss, despawn, msg.author.id]
  );
}

async function handle_test(msg, args) {
  let tests = require('./tests.js');

  let argv_equals = function(l, r) {
    if (r === null) return l === null;
    if (l.length !== r.length) return false;

    for (let i = 0; i < l.length; ++i) {
      if (l[i] === r[i]) continue;

      if (l[i] instanceof Date) {
        let d = parse_hour_minute(r[i]);
        if (l[i].getTime() === d.getTime()) continue;
      }
      if (l[i].mins && l[i].secs &&
          l[i].mins === r[i].mins &&
          l[i].secs === r[i].secs) {
        continue;
      }
      if (l[i] instanceof InvalidArg &&
          r[i] instanceof InvalidArg &&
          l[i].arg === r[i].arg) {
        continue;
      }
      return false;
    }
    return true;
  }

  for (let test of tests.parse_args) {
    let spec = test.spec;
    if (typeof spec === 'string') spec = reqs[spec].args;

    let result = parse_args(test.args, spec);
    console.assert(
      argv_equals(result, test.expect),
      `parse_args(): failed on input ${test.args} with ${spec}
  expected: ${test.expect}
  got: ${result}`
    );
  }
  console.log('$test: parse_args() tests passed.');
}

///////////////////////////////////////////////////////////////////////////////
// Gym handlers.

/*
 * Helper for error-handling cases where zero or multiple gyms are found.
 *
 * Returns true if we have a single result, else false.
 */
async function check_one_gym(msg, handle, results) {
  if (results.length < 1) {
    await send_quiet(msg.channel,
      `Zero or multiple gyms found matching \`[${handle}]\`.` +
      '  Please use a more accurate or specific search term.'
    );
    return false;
  } else if (results.length > 1) {
    await send_quiet(msg.channel,
      `Multiple gyms found matching \`[${handle}]\`.` +
      '  Please use a more specific search term.'
    );
    return false;
  }
  return true;
}

/*
 * Canonical display of a gym's name when we have a whole table row.
 */
function gym_name(gym) {
  let name = `\`[${gym.handle}]\` **${gym.name}**`;
  if (gym.ex) name += ' (EX!)';
  return name;
}

/*
 * Stringify a row from the gyms table.
 */
function gym_row_to_string(gym) {
  return `\`[${gym.handle}]\`
name: **${gym.name}**${gym.ex ? ' (EX!)' : ''}
region: ${gym.region}
coords: <https://maps.google.com/maps?q=${gym.lat},${gym.lng}>`;
}

/*
 * Canonically list an array of gyms in string form.
 *
 * If `is_valid' is supplied, we verify that it returns true for each gym, and
 * return null if it ever fails.
 */
function list_gyms(gyms, incl_region = true, is_valid = null) {
  let output = [];

  for (let gym of gyms) {
    if (is_valid !== null && !is_valid(gym)) return null;

    let str = `\`[${gym.handle}]\` ${gym.name}`;
    if (gym.ex) str += ' **(EX!)**';
    if (incl_region) str += ` — _${gym.region}_`;
    output.push(str);
  }
  return output.join('\n');
}

async function handle_gym(msg, handle) {
  let [results, err] = await moltresdb.query(
    'SELECT * FROM gyms WHERE ' + where_one_gym(handle)
  );
  if (err) return log_mysql_error(msg, err);

  let found_one = await check_one_gym(msg, handle, results);
  if (!found_one) return;
  let [gym] = results;

  return send_quiet(msg.channel, gym_row_to_string(gym));
}

async function handle_ls_gyms(msg, region) {
  let region_clause = where_region(region);

  let [results, err] = await moltresdb.query(
    'SELECT * FROM gyms WHERE ' + region_clause.sql
  );
  if (err) return log_mysql_error(msg, err);

  if (results.length === 0) {
    return log_invalid(msg, `Invalid region name \`${region}\`.`);
  }
  let is_meta = region_clause.meta !== null;
  let out_region = is_meta ? region_clause.meta : results[0].region;

  let gym_list = list_gyms(results, false,
    gym => (is_meta || gym.region === out_region)
  );
  if (gym_list === null) {
    return log_invalid(msg, `Ambiguous region name \`${region}\`.`);
  }

  let output = `Gyms in **${out_region}**:\n\n` + gym_list;
  return send_quiet(msg.channel, output);
}

async function handle_search_gym(msg, name) {
  let handle = name.replace(/ /g, '-');

  let [results, err] = await moltresdb.query(
    'SELECT * FROM gyms WHERE handle LIKE ? OR name LIKE ?',
    [`%${handle}%`, `%${name}%`]
  );
  if (err) return log_mysql_error(msg, err);

  if (results.length === 0) {
    return send_quiet(msg.channel,
      `No gyms with handle or name matching ${name}.`
    );
  }
  let output = `Gyms matching \`${name}\`:\n\n` + list_gyms(results);
  return send_quiet(msg.channel, output);
}

async function handle_add_gym(msg, handle, region, lat, lng, name) {
  handle = handle.toLowerCase();

  if (lat.charAt(lat.length - 1) === ',') {
    lat = lat.substr(0, lat.length - 1);
  }

  region = region.replace(/-/g, ' ');

  let [result, err] = await moltresdb.query(
    'INSERT INTO gyms SET ?',
    { handle: handle,
      name: name,
      region: region,
      lat: lat,
      lng: lng, }
  );
  if (err) return log_mysql_error(msg, err);

  if (result.affectedRows === 0) {
    return log_invalid(msg, 'Unknown failure.');
  }
  return react_success(msg);
}

async function handle_ls_regions(msg) {
  let [results, err] = await moltresdb.query(
    'SELECT region FROM gyms GROUP BY region'
  );
  if (err) return log_mysql_error(msg, err);

  if (results.length === 0) {
    return send_quiet(msg.channel, 'No gyms have been registered.');
  }
  let regions = new Set(results.map(gym => gym.region));

  let region_strs = Object.keys(config.metaregions).map(meta => {
    let subregions = config.metaregions[meta];
    for (let sr of subregions) regions.delete(sr);
    return `**${meta}** (_${subregions.join(', ')}_)`
  }).concat(
    [...regions].map(r => `**${r}**`)
  ).sort();

  let output = 'List of **regions** with **registered gyms**:\n\n' +
               region_strs.join('\n');
  return send_quiet(msg.channel, output);
}

///////////////////////////////////////////////////////////////////////////////
// Raid handlers.

/*
 * Whether call times should be displayed in response to `msg'.
 */
function should_display_calls(msg) {
  return !config.call_check || config.call_check(msg, guild());
}

/*
 * Canonicalize a raid boss name.
 */
function fmt_boss(boss) {
  return boss.split('-').map(capitalize).join(' ');
}

/*
 * Canonical string for displaying a raid boss from a raids table row.
 */
function fmt_tier_boss(raid) {
  let tier = raid.tier;

  let boss = raid.boss !== null
    ? fmt_boss(raid.boss)
    : (tier < raid_data.bosses_for_tier.length &&
       raid_data.boss_defaults[tier])
        ? fmt_boss(raid_data.boss_defaults[tier])
        : 'unknown';

  return `T${tier} ${boss}`;
}

/*
 * Get a canonical notification string for a report for `raid'.
 */
function raid_report_notif(raid) {
  let now = get_now();
  let hatch = hatch_from_despawn(raid.despawn);

  if (now < hatch) {
    return `${get_emoji('raidegg')} **T${raid.tier} egg** ` +
           `hatches at ${gym_name(raid)} at ${time_str(hatch, raid.region)}`;
  }
  return `${get_emoji('boss')} **${fmt_tier_boss(raid)} raid** despawns ` +
         `at ${gym_name(raid)} at ${time_str(raid.despawn, raid.region)}`;
}

/*
 * Fetch and send a raid report notification for `msg' at `handle'.
 */
async function send_raid_report_notif(msg, handle, verbed, anon = false) {
  let [results, err] = await moltresdb.query(
    'SELECT * FROM gyms ' +
    '   INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle)
  );
  if (err) return log_mysql_error(msg, err);

  let found_one = await check_one_gym(msg, handle, results);
  if (!found_one) return;
  let [raid] = results;

  let output =
    raid_report_notif(raid) + ` (${verbed} ` +
    (anon
      ? 'anonymously'
      : `by ${is_member(guild(), msg.author) ? msg.author : msg.author.tag}`
    ) + ').';

  await send_for_region(raid.region, output);

  if (from_dm(msg)) {
    return dm_quiet(msg.author, output);
  }
  return try_delete(msg, 10000);
}

async function handle_raid(msg, handle) {
  let now = get_now();

  let [results, err] = await select_rsvps(handle);
  if (err) return log_mysql_error(msg, err);

  if (results.length < 1) {
    await chain_reaccs(msg, 'no_entry_sign', 'raidegg');
    return send_quiet(msg.channel,
      `No unique raid found for \`[${handle}]\`.`
    );
  }
  let [{gyms, raids, calls}] = results;

  if (raids.despawn < now) {
    // Clean up expired raids.
    let gen_cleanup = async() => {
      let [result, err] = await moltresdb.query(
        'DELETE FROM raids WHERE gym_id = ?',
        [raids.gym_id]
      );
      if (err) return log_mysql_error(msg, err);
    };
    return Promise.all([
      gen_cleanup(),
      chain_reaccs(msg, 'no_entry_sign', 'raidegg'),
    ]);
  }

  let hatch = hatch_from_despawn(raids.despawn);

  let output = gym_row_to_string(gyms) + '\n';
  if (now >= hatch) {
    output +=`
raid: **${fmt_tier_boss(raids)}**
despawn: ${time_str(raids.despawn, gyms.region)}`;
  } else {
    output +=`
raid egg: **T${raids.tier}**
hatch: ${time_str(hatch, gyms.region)}`;
  }

  if (raids.team) {
    output += `\nlast known team: ${get_emoji(raids.team)}`;
  }

  if (calls.time !== null && should_display_calls(msg)) {
    output += '\n\ncall time(s):';

    let times = [];
    let rows_by_time = {};

    // Order and de-dup the call times and bucket rows by those times.
    for (let row of results) {
      let t = row.calls.time.getTime();

      if (!(t in rows_by_time)) {
        times.push(t);
        rows_by_time[t] = [];
      }
      rows_by_time[t].push(row);
    }
    times.sort();

    // Append details for each call time.
    for (let t of times) {
      let [{calls}] = rows_by_time[t];

      let caller_rsvp = null;
      let total = 0;

      // Get an array of attendee strings, removing the raid time caller.
      let attendees = rows_by_time[t].map(row => {
        let member = guild().members.get(row.rsvps.user_id);
        if (!member) return null;

        total += (row.rsvps.extras + 1);

        if (member.user.id === calls.caller) {
          caller_rsvp = row.rsvps;
          return null;
        }

        let extras = row.rsvps.extras !== 0
          ? ` +${row.rsvps.extras}`
          : '';
        return `${member.nickname || member.user.username}${extras}`
      }).filter(a => a !== null);

      let caller_str = '';

      if (caller_rsvp !== null) {
        let caller = guild().members.get(calls.caller);
        caller_str =
          `${caller.nickname || caller.user.username} _(caller)_` +
          (caller_rsvp.extras !== 0 ? ` +${caller_rsvp.extras}` : '') +
          (attendees.length !== 0 ? ', ' : '');
      }
      output += `\n- **${time_str(calls.time, gyms.region)}** ` +
                `(${total} raiders)—${caller_str}${attendees.join(', ')}`;
    }
  }

  return send_quiet(msg.channel, output);
}

async function handle_ls_raids(msg, tier, region) {
  let now = get_now();

  let region_clause = {meta: config.area, sql: 'TRUE'};
  let is_meta = true;

  if (region !== null) {
    region_clause = where_region(region);
    is_meta = region_clause.meta !== null;
  }

  let [results, err] = await moltresdb.query({
    sql:
      'SELECT * FROM gyms ' +
      '   INNER JOIN raids ON gyms.id = raids.gym_id ' +
      '   LEFT JOIN calls ON raids.gym_id = calls.raid_id ' +
      'WHERE ' + region_clause.sql +
      '   AND raids.despawn > ?' +
      'ORDER BY gyms.region',
    values: [now],
    nestTables: true,
  });
  if (err) return log_mysql_error(msg, err);

  if (results.length === 0) {
    return chain_reaccs(msg, 'no_entry_sign', 'raidegg');
  }

  let out_region = is_meta ? region_clause.meta : results[0].gyms.region;
  let rows_by_raid = {};

  for (let row of results) {
    if (!is_meta && row.gyms.region !== out_region) {
      return log_invalid(msg, `Ambiguous region name \`${region}\`.`);
    }
    if (tier && row.raids.tier !== tier) continue;

    let handle = row.gyms.handle;
    rows_by_raid[handle] = rows_by_raid[handle] || [];
    rows_by_raid[handle].push(row);
  }

  let raids_expr = tier ? `**T${tier} raids**` : 'raids';
  let output = `Active ${raids_expr} in **${out_region}**:\n`;

  for (let handle in rows_by_raid) {
    let [{gyms, raids, calls}] = rows_by_raid[handle];

    let hatch = hatch_from_despawn(raids.despawn);
    let boss = hatch > now ? `T${raids.tier} egg` : fmt_tier_boss(raids);
    let timer_str = hatch > now
      ? `hatches at ${time_str(hatch, gyms.region)}`
      : `despawns at ${time_str(raids.despawn, gyms.region)}`

    output += `\n\`[${handle}]\` **${boss}** ${timer_str}`;
    if (is_meta) {
      output += ` — _${gyms.region}_`;
    }

    if (calls.time !== null && should_display_calls(msg)) {
      let times = rows_by_raid[handle]
        .map(row => time_str(row.calls.time, gyms.region))
        .join(', ');
      output += `\n\tcalled time(s): ${times}`;
    }
  }
  if (region !== null || config.admin_ids.has(msg.author.id)) {
    return send_quiet(msg.channel, output);
  } else {
    return dm_reply_then_delete(msg, output);
  }
}

async function handle_report(msg, handle, tier, boss, timer, mods) {
  if (tier instanceof InvalidArg) {
    return log_invalid(msg, `Invalid raid tier \`${tier.arg}\`.`);
  }
  if (boss instanceof InvalidArg) {
    return log_invalid(msg, `Invalid raid boss \`${boss.arg}\`.`);
  }
  if (timer instanceof InvalidArg) {
    return log_invalid(msg, `Invalid [HH:]MM:SS timer \`${timer.arg}\`.`);
  }

  boss = await extract_boss(msg, boss);

  let egg_adjust = boss === null ? boss_duration : 0;

  let despawn = get_now();
  despawn.setMinutes(despawn.getMinutes() + timer.mins + egg_adjust);
  despawn.setSeconds(despawn.getSeconds() + timer.secs);

  let pop = pop_from_despawn(despawn);

  let [result, err] = await moltresdb.query(
    'REPLACE INTO raids (gym_id, tier, boss, despawn, spotter) ' +
    '   SELECT gyms.id, ?, ?, ?, ? FROM gyms ' +
    '   WHERE ' + where_one_gym(handle) +
    ((mods & Mod.FORCE) ? '' :
      ' AND ' +
      '   NOT EXISTS ( ' +
      '     SELECT * FROM raids ' +
      '       WHERE gym_id = gyms.id ' +
      '       AND despawn > ? ' +
      '   ) '
    ),
    [tier, boss, despawn, msg.author.id, pop]
  );
  if (err) return log_mysql_error(msg, err);

  if (result.affectedRows === 0) {
    let [call_rows, gym] = await query_for_error(msg, handle);
    if (!gym) return;

    return log_invalid(msg,
      `Raid already reported for ${gym_name(gym)}.`
    );
  }
  return send_raid_report_notif(msg, handle, 'reported', mods & Mod.ANON);
}

function handle_egg(msg, handle, tier, timer, mods) {
  return handle_report(msg, handle, tier, null, timer, mods);
}

function handle_boss(msg, handle, boss, timer, mods) {
  if (boss === null) {
    return log_invalid(msg, `Unrecognized raid boss \`${boss}\`.`);
  }
  return handle_report(
    msg, handle, raid_data.raid_tiers[boss.boss], boss, timer, mods
  );
}

async function handle_update(msg, handle, data, mods) {
  let data_lower = data.toLowerCase();

  let now = get_now();

  let assignment = await (async() => {
    let boss = await extract_boss(msg, parse_boss(data_lower));
    if (boss !== null) {
      return {
        tier: raid_data.raid_tiers[boss],
        boss: boss,
      };
    }

    let tier = parse_tier(data);
    if (tier !== null) {
      return { tier: tier };
    }

    if (data_lower === 'valor' ||
        data_lower === 'mystic' ||
        data_lower === 'instinct') {
      return { team: data_lower };
    }

    return null;
  })();

  if (assignment === null) {
    return log_invalid(msg, `Invalid update parameter \`${data}\`.`);
  }

  let [result, err] = await moltresdb.query(
    'UPDATE raids INNER JOIN gyms ON raids.gym_id = gyms.id ' +
    '   SET ? ' +
    '   WHERE ' + where_one_gym(handle) +
    '     AND raids.despawn > ? ',
    [assignment, now]
  );
  if (err) return log_mysql_error(msg, err);

  if (result.affectedRows === 0) {
    let [call_rows, gym] = await query_for_error(msg, handle);
    if (!gym) return;

    let [{raids}] = call_rows;
    if (raids.gym_id === null) {
      return log_invalid(msg,
        `No raid has been reported at ${gym_name(gym)}.`
      );
    }
    return log_invalid(msg, 'An unknown error occurred.');
  }

  if (result.changedRows === 0) {
    return send_quiet(msg.channel, 'Your update made no changes.');
  }
  if ('tier' in assignment) {
    return send_raid_report_notif(msg, handle, 'updated', mods & Mod.ANON);
  }
  return react_success(msg);
}

async function handle_scrub(msg, handle) {
  let [results, err] = await moltresdb.query(
    'SELECT * FROM ' +
    '   gyms INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle)
  );
  if (err) return log_mysql_error(msg, err);

  let found_one = await check_one_gym(msg, handle, results);
  if (!found_one) return;
  let [raid] = results;

  if (raid.spotter !== msg.author.id &&
      !config.admin_ids.has(msg.author.id)) {
    return log_invalid(msg, 'Raids can only be scrubbed by their reporter.');
  }

  [, err] = await moltresdb.query(
    'DELETE FROM raids WHERE gym_id = ?',
    [raid.gym_id]
  );
  if (err) return log_mysql_error(msg, err);

  let spotter = guild().members.get(raid.spotter);
  if (!spotter) spotter = '[unknown user]';

  return send_for_region(raid.region,
    `${get_emoji('banned')} Raid reported by ${spotter} ` +
    `at ${gym_name(raid)} was scrubbed.`
  );
}

function handle_ls_bosses(msg) {
  let outvec = [];

  for (let tier = 1; tier <= 5; ++tier) {
    let fmt_boss_with_default = function(boss) {
      let formatted = fmt_boss(boss);
      return raid_data.boss_defaults[tier] === boss
        ? formatted + ' _(default)_'
        : formatted;
    };
    outvec.push(`**T${tier}:**\t` +
      raid_data.bosses_for_tier[tier].map(fmt_boss_with_default).join(', ')
    );
  }
  return send_quiet(msg.channel, outvec.join('\n\n'));
}

///////////////////////////////////////////////////////////////////////////////
// Raid call handlers.

/*
 * Get all the users (and associated metadata) attending the raid at `handle'
 * at `time'.
 *
 * Returns a [{gyms, raids, calls}, raiders_array] tuple.
 */
async function get_all_raiders(msg, handle, time) {
  let [results, err] = await select_rsvps(handle, where_call_time(time));
  if (err) {
    await log_mysql_error(msg, err);
    return [null, []];
  }

  if (results.length < 1) return [null, []];

  let raiders = [];

  for (let row of results) {
    let member = guild().members.get(row.rsvps.user_id);
    if (member) raiders.push({
      member: member,
      extras: row.rsvps.extras,
    });
  }
  return [results[0], raiders];
}

/*
 * Set a delayed event for clearing the join cache for `handle' at `call_time'.
 */
function delay_join_cache_clear(handle, call_time) {
  let delay = call_time - get_now();
  if (delay <= 0) delay = 1;

  setTimeout(() => { join_cache_set(handle, call_time, null); }, delay);
}

/*
 * Make the raid alarm message.
 */
async function make_raid_alarm(msg, gym, call_time) {
  if (!config.raid_alarm) return null;

  let [row, raiders] = await get_all_raiders(msg, gym.handle, call_time);

  // The call time might have changed, or everyone may have unjoined.
  if (row === null || raiders.length === 0) return null;

  let output =
    `${gyaoo} ${get_emoji('alarm_clock')} ` +
    `Raid call for ${gym_name(gym)} at ` +
    `\`${time_str(call_time, gym.region)}\` is in ` +
    `${config.raid_alarm} minutes!` +
    `\n\n${raiders.map(r => r.member.user).join(' ')} ` +
    `(${raiders.reduce((sum, r) => sum + 1 + r.extras, 0)} raiders)`;

  return output;
}

/*
 * Set a timeout to ping raiders for `gym' before `call_time'.
 */
function set_raid_alarm(msg, gym, call_time) {
  // This doesn't really belong here, but we set alarms every time we modify a
  // call time, which is exactly when we want to make this guarantee.
  delay_join_cache_clear(gym.handle, call_time);

  let alarm_time = new Date(call_time.getTime());
  alarm_time.setMinutes(alarm_time.getMinutes() - config.raid_alarm);

  let delay = alarm_time - get_now();
  if (delay <= 0) return;

  setTimeout(async function() {
    let output = await make_raid_alarm(msg, gym, call_time);
    let alarm_msgs = await send_for_region(gym.region, output);

    // The join cache might not have been populated if nobody else joined...
    let j_ent = join_cache_get(gym.handle, call_time);
    if (!j_ent) return;

    join_cache_set(gym.handle, call_time, {
      joins: j_ent.joins,
      alarms: alarm_msgs,
    });
  }, delay);

  return log_impl(msg,
    `Setting alarm for \`[${gym.handle}]\` at ` +
    `\`${time_str(alarm_time, gym.region)}\` (server time).`
  );
}

/*
 * Cache for join messages.
 *
 * Maps a handle+time string to a {joins: [msgs], alarms: [msgs]}.
 */
let join_cache = {};

function join_cache_get(handle, time) {
  return join_cache[handle + time.getTime()];
}
function join_cache_set(handle, time, val) {
  if (val) {
    join_cache[handle + time.getTime()] = val;
  } else {
    delete join_cache[handle + time.getTime()];
  }
}

async function handle_call(msg, handle, call_time, extras) {
  if (call_time instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time.arg}\`.`);
  }
  call_time = await interpret_time(call_time, handle);

  if (extras instanceof InvalidArg) {
    return log_invalid(msg, `Invalid +1 count \`${extras.arg}\`.`);
  }
  extras = extras || 0;

  let now = get_now();

  // This is a janky way to allow for raids at exactly hatch.  The main
  // shortcoming is that if a raid's despawn is at an exact minute, this will
  // let users call a raid time a minute before hatch.
  //
  // In practice, this is extremely unlikely, and to avoid this situation for
  // manual hatch/despawn time changes, we add a dummy second to all explicit
  // user-declared raid despawn times.
  let later = new Date(call_time.getTime());
  later.setMinutes(later.getMinutes() + boss_duration + 1);

  let [result, err] = await moltresdb.query(
    'INSERT INTO calls (raid_id, caller, time) ' +
    '   SELECT raids.gym_id, ?, ? FROM gyms INNER JOIN raids ' +
    '     ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle) +
    '     AND ? > ? ' +
    '     AND raids.despawn > ? ' +
    '     AND raids.despawn <= ? ',
    [msg.author.id, call_time, call_time, now, call_time, later]
  );
  if (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      let [, gym] = await query_for_error(msg, handle);
      if (!gym) return; // should never happen

      return log_invalid(msg,
        `A raid has already been called for \`[${handle}]\` ` +
        `at \`${time_str(call_time, gym.region)}\`.`
      );
    }
    return log_mysql_error(msg, err);
  }

  if (result.affectedRows === 0) {
    let [call_rows, gym] = await query_for_error(msg, handle);
    if (!gym) return;

    if (call_time <= now) {
      return log_invalid(msg,
        `Cannot call a time in the past ` +
        `\`${time_str_short(call_time, gym.region)}\`.`
      );
    }

    let [{raids}] = call_rows;
    if (raids.gym_id === null) {
      return log_invalid(msg,
        `No raid has been reported at ${gym_name(gym)}.`
      );
    }
    if (call_time >= raids.despawn) {
      return log_invalid(msg,
        `Cannot call a raid after despawn ` +
        `(${time_str(raids.despawn, gym.region)}).`
      );
    }
    if (later < raids.despawn) {
      return log_invalid(msg,
        `Cannot call a raid before hatch ` +
        `(${time_str(hatch_from_despawn(raids.despawn), gym.region)}).`
      );
    }
    return log_invalid(msg, 'An unknown error occurred.');
  }

  let call_id = result.insertId;

  [result, err] = await moltresdb.query(
    'INSERT INTO rsvps SET ?',
    { call_id: call_id,
      user_id: msg.author.id,
      extras: extras,
      maybe: false }
  );
  if (err) return log_mysql_error(msg, err);

  let results;

  // Grab the raid information just for reply purposes.
  [results, err] = await moltresdb.query(
    'SELECT * FROM gyms INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle)
  );
  if (err) return log_mysql_error(msg, err);

  let found_one = await check_one_gym(msg, handle, results);
  if (!found_one) return;
  let [raid] = results;

  let region_str = function() {
    let role_id = config.regions[raid.region];
    if (!role_id) return raid.region;

    let role = msg.guild.roles.get(role_id);
    if (!role) return raid.region;

    return raid.silent ? role.name : role.toString();
  }();

  let output = get_emoji('clock230') + ' ' +
    `${region_str} **${fmt_tier_boss(raid)}** raid ` +
    `at ${gym_name(raid)} ` +
    `called for ${time_str(call_time, raid.region)} ` +
    `by ${msg.author}.  ${gyaoo}` +
    `\n\nTo join this raid time, enter ` +
    `\`$join ${raid.handle} ${time_str_short(call_time, raid.region)}\`.`;

  return Promise.all([
    send_for_region(raid.region, output),
    set_raid_alarm(msg, raid, call_time),
  ]);
}

async function handle_cancel(msg, handle, call_time) {
  if (call_time instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time.arg}\`.`);
  }
  call_time = await interpret_time(call_time, handle);

  let fail = async function(msg) {
    let [call_row, gym] =
      await query_for_error_call(msg, handle, call_time, 'cancel');
    if (!call_row) return;

    if (call_row.calls.caller !== msg.author.id) {
      return log_invalid(msg, 'Raids can only be cancelled by their caller.');
    }
    return log_invalid(msg, 'An unknown error occurred.');
  };

  let [row, raiders] = await get_all_raiders(msg, handle, call_time);
  if (row === null) return fail(msg);

  let {gyms, raids, calls} = row;

  let [result, err] = await moltresdb.query(
    'DELETE calls FROM calls ' +
    '   INNER JOIN raids ON calls.raid_id = raids.gym_id ' +
    '   INNER JOIN gyms ON raids.gym_id = gyms.id ' +
    'WHERE ' + where_one_gym(handle) +
    '  AND ' + where_call_time(call_time, true) +
    '  AND calls.caller = ? ',
    [msg.author.id]
  );
  if (err) return log_mysql_error(msg, err);

  if (result.affectedRows === 0) return fail(msg);

  raiders = raiders
    .map(r => r.member.user)
    .filter(user => user.id != msg.author.id);

  let output = get_emoji('no_entry_sign') + ' ' +
    `Raid at ${time_str(calls.time, gyms.region)} for ${gym_name(gyms)} ` +
    `was cancelled by ${msg.author}.  ${gyaoo}`;

  if (raiders.length !== 0) {
    output += `\n\nPaging other raiders: ${raiders.join(' ')}.`;
  }
  return send_for_region(gyms.region, output);
}

async function handle_change_time(msg, handle, current, to, desired) {
  if (current instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${current.arg}\`.`);
  }
  if (desired instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${desired.arg}\`.`);
  }
  if (to !== 'to') {
    return log_invalid(msg, usage_string('change-time'));
  }
  current = await interpret_time(current, handle);
  desired = await interpret_time(desired, handle);

  // See comment in handle_call().
  let later = new Date(desired.getTime());
  later.setMinutes(later.getMinutes() + boss_duration + 1);

  let assignment = {
    caller: msg.author.id,
    time: desired,
  };

  let [result, err] = await moltresdb.query(
    'UPDATE calls ' +
    '   INNER JOIN raids ON calls.raid_id = raids.gym_id ' +
    '   INNER JOIN gyms ON raids.gym_id = gyms.id ' +
    'SET ? ' +
    'WHERE ' + where_one_gym(handle) +
    '   AND raids.despawn > ? ' +
    '   AND raids.despawn <= ? ' +
    '   AND calls.time = ? ',
    [assignment, desired, later, current]
  );
  if (err) return log_mysql_error(msg, err);

  if (result.affectedRows === 0) {
    let [call_row, gym] =
      await query_for_error_call(msg, handle, current, 'change-time');
    if (!call_row) return;

    let {raids} = call_row;

    if (desired >= raids.despawn) {
      return log_invalid(msg,
        `Cannot change a time to after despawn ` +
        `(${time_str(raids.despawn, gym.region)}).`
      );
    }
    if (later < raids.despawn) {
      return log_invalid(msg,
        `Cannot change a time to before hatch ` +
        `(${time_str(hatch_from_despawn(raids.despawn), gym.region)}).`
      );
    }

    return log_invalid(msg, 'An unknown error occurred.');
  }

  let [row, raiders] = await get_all_raiders(msg, handle, desired);

  // No raiders is weird, but it could happen if everyone unjoins and
  // someone decides to change the raid time for no meaningful reason.
  if (row === null || raiders.length === 0) return;
  let {gyms} = row;
  handle = gyms.handle;

  // Move the join message cache entry.
  join_cache_set(handle, desired, join_cache_get(handle, current));
  join_cache_set(handle, current, null);

  raiders = raiders
    .map(r => r.member.user)
    .filter(user => user.id != msg.author.id);

  let output =
    `Raid time changed for ${gym_name(gyms)} ` +
    `from ${time_str(current, gyms.region)} ` +
    `to ${time_str(desired, gyms.region)} ` +
    `by ${msg.author}.  ${gyaoo}`;

  if (raiders.length !== 0) {
    output += `\n\nPaging other raiders: ${raiders.join(' ')}.`;
  }
  return Promise.all([
    send_for_region(gyms.region, output),
    set_raid_alarm(msg, gyms, desired),
  ]);
}

async function handle_join(msg, handle, call_time, extras) {
  if (call_time instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time.arg}\`.`);
  }
  call_time = await interpret_time(call_time, handle);

  if (extras instanceof InvalidArg) {
    return log_invalid(msg, `Invalid +1 count \`${extras.arg}\`.`);
  }
  extras = extras || 0;

  let [result, err] = await moltresdb.query(
    'INSERT INTO rsvps (call_id, user_id, extras, maybe) ' +
    '   SELECT calls.id, ?, ?, ? ' +
    '     FROM gyms ' +
    '       INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '       INNER JOIN calls ON raids.gym_id = calls.raid_id ' +
    '   WHERE ' + where_one_gym(handle) +
    '     AND raids.despawn > ? ' +
    '     AND ' + where_call_time(call_time),
    [msg.author.id, extras, false, get_now()]
  );
  if (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      let [, gym] = await query_for_error(msg, handle);
      if (!gym) return; // should never happen

      return log_invalid(msg,
        `You have already joined the raid call for \`[${handle}]\`` +
        (!!call_time
          ? ` at ${time_str(call_time, gym.region)}.`
          : '.')
      );
    }
    return log_mysql_error(msg, err);
  }

  if (result.affectedRows === 0) {
    let [call_row, ] =
      await query_for_error_call(msg, handle, call_time, 'join');
    if (!call_row) return;

    return log_invalid(msg, 'An unknown error occurred.');
  }

  let [row, raiders] = await get_all_raiders(msg, handle, call_time);

  // The call time might have changed, or everyone may have unjoined.
  if (row === null || raiders.length === 0) return;

  let {gyms, raids, calls} = row;
  handle = gyms.handle;

  raiders = raiders.filter(r => r.member.id != msg.author.id);

  let joining = extras > 0 ? `joining with +${extras}` : 'joining';

  let output = get_emoji('team') + '  ' +
    `${msg.author} is ${joining} at ${time_str(calls.time, gyms.region)} ` +
    `for the **${fmt_tier_boss(raids)}** raid at ${gym_name(gyms)}`;

  if (raiders.length !== 0) {
    let names = raiders.map(
      r => r.member.nickname || r.member.user.username
    );
    let others = raiders.length === 1 ? 'other' : 'others';
    output += ` (with ${raiders.length} ${others}: ${names.join(', ')}).`;
  } else {
    output += '.';
  }

  output += '\n\nTo join this raid time, enter ';
  if (!!call_time) {
    output += `\`$join ${handle} ${time_str_short(calls.time, gyms.region)}\`.`;
  } else {
    output += `\`$join ${handle}\`.`;
  }

  let join_msgs = await send_for_region(gyms.region, output);

  // Clear any existing join message for this raid.
  let replace_prev_msg = async function() {
    let prev = join_cache_get(handle, calls.time);
    join_cache_set(handle, calls.time, {
      joins: join_msgs,
      alarms: prev ? prev.alarms : [],
    });
    if (prev) {
      let dels = prev.joins.map(join => try_delete(join));
      if (prev.alarms.length === 0) return dels;

      // If it's past the alarm time, we want to edit the alarm messages...
      let content = await make_raid_alarm(msg, gyms, calls.time);
      let edits = prev.alarms.map(alarm => alarm.edit(content));

      // ...and DM the raid caller.
      let caller = await moltres.fetchUser(calls.caller);
      let dms = [dm_quiet(caller,
        `${get_emoji('rollsafe')} ${msg.author} has joined the raid late at ` +
        `${gym_name(gyms)} at ${time_str(calls.time, gyms.region)}.`
      )];

      return Promise.all(dms.concat(dels).concat(edits));
    }
  };

  // Delete the $join request, delete any previous join message, and
  // cache this one for potential later deletion.
  return Promise.all([
    replace_prev_msg(),
    try_delete(msg, 3000),
  ]);
}

async function handle_unjoin(msg, handle, call_time) {
  if (call_time instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time.arg}\`.`);
  }
  call_time = await interpret_time(call_time, handle);

  let [result, err] = await moltresdb.query(
    'DELETE rsvps FROM ' + full_join_table +
    '   WHERE ' + where_one_gym(handle) +
    '     AND ' + where_call_time(call_time) +
    '     AND rsvps.user_id = ? ',
    [msg.author.id]
  );
  if (err) return log_mysql_error(msg, err);

  if (result.affectedRows === 0) {
    let [call_row, gym] =
      await query_for_error_call(msg, handle, call_time, 'unjoin');
    if (!call_row) return;

    return log_invalid(msg,
      `You have not joined the raid call for ${gym_name(gym)}` +
      (!!call_time
        ? ` at ${time_str(call_time, gym.region)}.`
        : '.')
    );
  }
  return react_success(msg, 'cry');
}

///////////////////////////////////////////////////////////////////////////////
// EX raid handlers.

const ex_room_regex = /^.*-\w+-\d\d/;
const ex_room_capture = /^(.*)-(\w+)-(\d\d)/;

const ex_topic_capture =
  /^(EX raid coordination for .* on [A-Z][a-z]+ \d+)(.*)\./;

/*
 * Build a canonical EX raid room name using a gym `handle' and raid `date'.
 */
function ex_room_name(handle, date) {
  return (handle + '-' + date_str(date)).toLowerCase().replace(/\W/g, '-');
}

/*
 * Extract the gym handle, month, and day from an EX raid room name.
 */
function ex_room_components(room_name) {
  let [, handle, month, day] = room_name.match(ex_room_capture);
  return {
    handle: handle,
    month: capitalize(month),
    day: parseInt(day),
  };
}

/*
 * Extract `date' into a format compatible with the output of
 * ex_room_components().
 */
function ex_format_date(date) {
  let str = date_str(date);
  return {
    month: str.slice(0, str.indexOf(' ')),
    day: date.getDate(),
  };
}

/*
 * Whether the date for the EX raid `room_name' matches `ex_date', a date
 * formatted by ex_format_date().
 */
function ex_room_matches_date(room_name, ex_date) {
  let info = ex_room_components(room_name);
  return ex_date.month === info.month && ex_date.day === info.day;
}

/*
 * Create a channel `room_name' for an EX raid at `gym' on `date'.
 */
async function create_ex_room(room_name, gym, date) {
  let permissions = config.ex.permissions
    .concat([
      { // Make sure Moltres can modify the channel.
        id: moltres.user.id,
        allow: [
          'VIEW_CHANNEL',
          'MANAGE_CHANNELS',
          'MANAGE_ROLES',
          'MANAGE_MESSAGES',
        ],
      },
      { // Hide the channel from members who haven't entered this EX room.
        id: guild().id,
        deny: ['VIEW_CHANNEL'],
      },
    ]);

  let room = await guild().createChannel(room_name, 'text', permissions);
  room = await room.setTopic(
    `EX raid coordination for ${gym.name} on ${date_str(date)}.`
  );
  if ('category' in config.ex) {
    room = await room.setParent(config.ex.category);
  }
  return room;
}

/*
 * Add or remove `user' to/from the EX raid room `room'.
 */
async function enter_ex_room(uid, room) {
  room = await room.overwritePermissions(uid, {VIEW_CHANNEL: true});
  let user = await moltres.fetchUser(uid);
  return send_quiet(room, `Welcome ${user} to the room!`);
}
function exit_ex_room(uid, room) {
  return room.permissionOverwrites.get(uid).delete();
}

/*
 * Return whether `channel' is an EX raid room.
 */
function is_ex_room(channel) {
  if (channel.type === 'dm') return false;

  if ('category' in config.ex) {
    return channel.parentID === config.ex.category;
  }
  // Guess based on the format of EX room names.
  return !!channel.name.match(ex_room_regex);
}

/*
 * Obtain a list of everyone who has entered an EX raid room.
 *
 * This is done by inspecting all the permission overwrites for users who were
 * not added to the room by Moltres configuration.
 */
function ex_raiders(room) {
  let uids = new Set([...room.permissionOverwrites.keys()]);

  for (let overwrite of config.ex.permissions) {
    uids.delete(overwrite.id);
  }
  uids.delete(guild().id);
  uids.delete(moltres.user.id);

  uids = [...uids].filter(id => !guild().roles.get(id));

  return Promise.all([...uids].map(id => moltres.fetchUser(id)));
}

/*
 * Cache for pending EX raid rooms.
 */
let ex_cache = {};

function ex_cache_found(room_name) {
  return room_name in ex_cache;
}
function ex_cache_insert(room_name, user) {
  ex_cache[room_name] = ex_cache[room_name] || new Set();
  ex_cache[room_name].add({
    id: user.id,
    mention: user.toString(),
  });
}
function ex_cache_take(room_name) {
  let users = ex_cache[room_name];
  delete ex_cache[room_name];
  return [...users];
}

async function handle_ex(msg, handle, date) {
  if (date instanceof InvalidArg) {
    return log_invalid(msg, `Invalid MM/DD date \`${date.arg}\`.`);
  }

  let [results, err] = await moltresdb.query(
    'SELECT * FROM gyms WHERE ' + where_one_gym(handle)
  );
  if (err) return log_mysql_error(msg, err);

  let found_one = await check_one_gym(msg, handle, results);
  if (!found_one) return;
  let [gym] = results;

  if (!gym.ex) {
    return log_invalid(msg, `${gym_name(gym)} is not an EX raid location.`);
  }

  let room_re = new RegExp(`^${gym.handle}-\\w+-\\d\\d$`);

  // We'd prefer to only search the channels in the category, but a bug in
  // the current version of discord.js prevents the list of children from
  // getting updated.
  //
  // let chan_list = 'category' in config.ex
  //   ? moltres.channels.get(config.ex.category).children
  //   : guild().channels;
  let chan_list = guild().channels;

  let room = chan_list.find(c => !!c.name.match(room_re));

  if (room !== null) {
    if (date !== null) {
      // Check for a mismatched date.
      let room_name = ex_room_name(gym.handle, date);
      if (room.name !== room_name) {
        let ex = ex_room_components(room.name);
        return log_invalid(msg,
          `Incorrect EX raid date ${date_str(date)} for ` +
          `${gym_name(gym)}.  A room has already been created for ` +
          `${ex.month} ${ex.day}.`
        );
      }
    }
    return enter_ex_room(msg.author.id, room);
  }
  // Otherwise, we need to create a room.

  if (date === null) {
    return log_invalid(msg,
      `Must provide a date for new EX raid at ${gym_name(gym)}.`
    );
  }
  let room_name = ex_room_name(gym.handle, date);

  // Check to see if anyone is already creating this room.  If so, we
  // should just add ourselves to the ex_cache entry and move on.
  if (ex_cache_found(room_name)) {
    return ex_cache_insert(room_name, msg.author);
  }

  // Create an entry in the ex_cache representing our initiation of room
  // creation.  Anyone who attempts to create the same room before the API
  // call completes adds themselves above to the cache entry instead of
  // racing and creating a room of the same name.
  ex_cache_insert(room_name, msg.author);
  room = await create_ex_room(room_name, gym, date);

  let users = ex_cache_take(room_name);
  await Promise.all(users.map(({id}) => enter_ex_room(id, room)));

  let out = get_emoji('pushpin') +
    `  ${users[0].mention}, please post a screenshot of your EX raid pass ` +
    `and use \`$exact\` to set the raid time.  (Anyone can do this, but you ` +
    `created the room.)`;
  return send_quiet(room, out);
}

async function handle_explore(msg) {
  let room_info = new Map(guild().channels
    .filter(is_ex_room)
    .map(room => {
      let [, , time] = room.topic.match(ex_topic_capture);
      return Object.assign(ex_room_components(room.name), {time: time});
    })
    .map(info => [info.handle, info])
  );

  let [results, err] = await moltresdb.query(
    'SELECT * FROM gyms WHERE handle IN (' +
        Array(room_info.size).fill('?').join(',') +
    ')',
    [...room_info.keys()]
  );
  if (err) return log_mysql_error(msg, err);

  let month_str = ex_format_date(get_now()).month;

  let output = 'Active EX raid rooms:\n\n' + results
    .sort((l, r) => {
      l = room_info.get(l.handle);
      r = room_info.get(r.handle);
      // Rather than trying to map month names back to indices and deal with
      // ordering December and January in the absence of explicit years,
      // instead we just compare the month to the current month.  Since EX
      // raids are only ever a week or two away, an EX raid whose month is not
      // this month must be next month.
      if (l.month === month_str && r.month !== month_str) return -1;
      if (r.month === month_str && l.month !== month_str) return 1;
      if (l.day !== r.day) return Math.sign(l.day - r.day);
      return l.handle.localeCompare(r.handle);
    })
    .map(gym => {
      let r = room_info.get(gym.handle);
      const end = ' (EX!)'.length;
      return `${gym_name(gym).slice(0, -end)} (${r.month} ${r.day}${r.time})`;
    })
    .join('\n');

  return send_quiet(msg.channel, output);
}

async function handle_exit(msg) {
  // If a user has a permission overwrite, they're in the room.
  let in_room = !!msg.channel.permissionOverwrites.get(msg.author.id);

  if (!in_room) {
    return log_invalid(msg,
      `You have not entered the EX room #${msg.channel.name}`
    );
  }

  if (config.ex.exit_strict &&
      ex_room_matches_date(msg.channel.name, ex_format_date(get_now()))) {
    let out = get_emoji('upside_down') +
      `  ${gyaoo}  It's rude to exit an EX raid room the day of the raid,` +
      ` ${msg.author}!`;
    return send_quiet(msg.channel, out);
  }

  await exit_ex_room(msg.author.id, msg.channel);
  return chain_reaccs(msg, 'door', 'walking', 'dash');
}

async function handle_examine(msg) {
  let ex = ex_room_components(msg.channel.name);

  let users = await ex_raiders(msg.channel);

  return send_quiet(msg.channel, {
    embed: new Discord.RichEmbed()
      .setTitle(
        `**List of EX raiders** for \`${ex.handle}\` on ${ex.month} ${ex.day}`
      )
      .setDescription(users.map(user => user.tag).join('\n'))
      .setColor('RED')
  });
}

async function handle_exact(msg, time) {
  if (time instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${time.arg}\`.`);
  }
  time = await interpret_time(time);

  let [, topic] = msg.channel.topic.match(ex_topic_capture);

  let {handle} = ex_room_components(msg.channel.name);
  let region = await select_region(handle);

  return Promise.all([
    msg.channel.setTopic(`${topic} at ${time_str(time, region)}.`),
    react_success(msg),
  ]);
}

async function handle_exclaim(msg) {
  let users = await ex_raiders(msg.channel);
  let tags = users.map(u => u.toString()).join(' ');
  let content = get_emoji('point_up') +
    ` ${msg.author} used \`$exclaim\`!  It's super effective: ${tags}`;

  return send_quiet(msg.channel, content);
}

function handle_expunge(msg, date) {
  if (date instanceof InvalidArg) {
    return log_invalid(msg, `Invalid MM/DD date \`${date.arg}\`.`);
  }
  let expected = ex_format_date(date);

  let rooms = guild().channels
    .filter(is_ex_room)
    .filter(room => ex_room_matches_date(room.name, expected));

  return Promise.all(rooms.map(room => room.delete()));
}

async function handle_exalt(msg, handle) {
  let [result, err] = await moltresdb.query(
    'UPDATE gyms SET `ex` = 1 WHERE `handle` IN ( ' +
    '   SELECT `handle` FROM ( ' +
    '     SELECT `handle` FROM gyms WHERE ' + where_one_gym(handle) +
    '   ) AS gyms_ ' +
    ')'
  );
  if (err) return log_mysql_error(msg, err);

  if (result.changedRows === 0) {
    return send_quiet(msg.channel, 'Gym already marked EX-eligible.');
  }
  return react_success(msg);
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Check whether `msg' is from a source with access to `request'.
 */
function has_access(msg, request) {
  let access = reqs[request].access;

  if (from_dm(msg)) {
    return access & Access.DM ||
          (access & Access.ADMIN_DM && config.admin_ids.has(msg.author.id));
  }
  if (msg.channel.id in config.channels) {
    if (access & Access.REGION) return true;
  }
  if (config.ex.channels.has(msg.channel.id)) {
    if (access & Access.EX_MAIN) return true;
  }
  if (is_ex_room(msg.channel)) {
    return access & Access.EX_ROOM;
  }
  return false;
}

/*
 * Parse `req' and extract the request name and any modifiers.
 *
 * Returns a tuple of nulls if the request or its modifiers are invalid.
 */
function parse_req_str(req) {
  let mods = Mod.NONE;

  for (
    let mod_char = req.charAt(req.length - 1);
    mod_char in modifier_map;
    req = req.slice(0, -1), mod_char = req.charAt(req.length - 1)
  ) {
    mods |= modifier_map[mod_char];
  }

  req = req_aliases[req] || req;
  if (!(req in reqs)) return [null, mods];

  let mod_mask = reqs[req].mod_mask || Mod.NONE;

  if ((mods | mod_mask) !== mod_mask) return [req, null];
  return [req, mods];
}

/*
 * Do the work of `request'.
 */
async function handle_request(msg, request, mods, argv) {
  if (argv.length === 1 && argv[0] === 'help') {
    return handle_help(msg, [request]);
  }

  switch (request) {
    case 'help':      return handle_help(msg, ...argv);
    case 'set-perm':  return handle_set_perm(msg, ...argv);
    case 'ls-perms':  return handle_ls_perms(msg, ...argv);
    case 'add-boss':  return handle_add_boss(msg, ...argv);
    case 'rm-boss':   return handle_rm_boss(msg, ...argv);
    case 'def-boss':  return handle_def_boss(msg, ...argv);

    case 'reload-config': return handle_reload_config(msg, ...argv);
    case 'raidday':   return handle_raidday(msg, ...argv);
    case 'test':      return handle_test(msg, ...argv);

    case 'gym':       return handle_gym(msg, ...argv);
    case 'ls-gyms':   return handle_ls_gyms(msg, ...argv);
    case 'search-gym':  return handle_search_gym(msg, ...argv);
    case 'add-gym':   return handle_add_gym(msg, ...argv);
    case 'ls-regions':  return handle_ls_regions(msg, ...argv);

    case 'raid':      return handle_raid(msg, ...argv);
    case 'ls-raids':  return handle_ls_raids(msg, ...argv);
    case 'egg':       return handle_egg(msg, ...argv, mods);
    case 'boss':      return handle_boss(msg, ...argv, mods);
    case 'update':    return handle_update(msg, ...argv, mods);
    case 'scrub':     return handle_scrub(msg, ...argv);
    case 'ls-bosses': return handle_ls_bosses(msg, ...argv);

    case 'call':      return handle_call(msg, ...argv);
    case 'cancel':    return handle_cancel(msg, ...argv);
    case 'change-time': return handle_change_time(msg, ...argv);
    case 'join':      return handle_join(msg, ...argv);
    case 'unjoin':    return handle_unjoin(msg, ...argv);

    case 'ex':        return handle_ex(msg, ...argv);
    case 'exit':      return handle_exit(msg, ...argv);
    case 'examine':   return handle_examine(msg, ...argv);
    case 'exact':     return handle_exact(msg, ...argv);
    case 'exclaim':   return handle_exclaim(msg, ...argv);
    case 'explore':   return handle_explore(msg, ...argv);
    case 'expunge':   return handle_expunge(msg, ...argv);
    case 'exalt':     return handle_exalt(msg, ...argv);
    default:
      return log_invalid(msg, `Invalid request \`${request}\`.`, true);
  }
}

/*
 * Check whether the user who sent `msg' has the proper permissions to make
 * `request', and make it if so.
 */
async function handle_request_with_check(msg, request, mods, argv) {
  let req_meta = reqs[request];

  if (!has_access(msg, request)) {
    let dm = from_dm(msg);
    let output = `\`\$${request}\` can't be handled ` +
                 (dm ? 'via DM' : `from ${msg.channel}.`);
    return log_invalid(msg, output, dm);
  }

  if (config.admin_ids.has(msg.author.id) ||
      req_meta.perms === Permission.NONE) {
    return handle_request(msg, request, mods, argv);
  }

  let [results, err] = await moltresdb.query(
    'SELECT * FROM permissions WHERE (cmd = ? AND user_id = ?)',
    [req_to_perm[request] || request, msg.author.id]
  );
  if (err) return log_mysql_error(msg, err);

  let permitted =
    (results.length === 1 && req_meta.perms === Permission.WHITELIST) ||
    (results.length === 0 && req_meta.perms === Permission.BLACKLIST);

  if (permitted) {
    return handle_request(msg, request, mods, argv);
  }
  return log_invalid(msg,
    `User ${msg.author.tag} does not have permissions for ${request} ` +
    get_emoji('dealwithit') + '.'
  );
}

/*
 * Process a user request.
 */
async function process_request(msg) {
  if (msg.content.charAt(0) !== '$') return;
  let args = msg.content.substr(1);

  let req_str = null;

  let match = /\s+/.exec(args);
  if (match === null) {
    req_str = args;
    args = '';
  } else {
    req_str = args.substr(0, match.index);
    args = args.substr(match.index + match[0].length);
  }

  let log = moltres.channels.get(config.log_id);
  let output = `\`\$${req_str}\` ${args}
_Time:_  ${get_now().toLocaleString('en-US')}
_User:_  ${msg.author.tag}
_Channel:_  #${from_dm(msg) ? '[dm]' : msg.channel.name}`;

  await send_quiet(log, output);

  let [req, mods] = parse_req_str(req_str);

  if (req === null) {
    return log_invalid(msg, `Invalid request \`${req_str}\`.`, true);
  }
  if (mods === null) {
    return log_invalid(msg,
      `Request string \`${req_str}\` has invalid modifiers.`
    );
  }

  let argv = parse_args(args, reqs[req].args);
  if (argv === null) {
    return log_invalid(msg, usage_string(req));
  }

  return handle_request_with_check(msg, req, mods, argv);
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Main reader event.
 */
moltres.on('message', async msg => {
  if (msg.channel.id in config.channels ||
      config.ex.channels.has(msg.channel.id) ||
      from_dm(msg) || is_ex_room(msg.channel)) {
    try {
      if (has_single_image(msg) &&
          is_ex_room(msg.channel)) {
        await pin_if_first(msg);
      }
      await process_request(msg);
    } catch (e) {
      console.error(e);
    }
  }
});
