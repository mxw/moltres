/*
 * Custom raid bot for Valor of Boston.
 */
import * as Discord from 'discord.js';
import * as mysql from 'async-mysql';

import { DateTime, Duration, IANAZone, FixedOffsetZone } from 'luxon';

import * as ed from 'edit-distance';

import { default as trie } from 'trie-prefix-tree';
type Trie = ReturnType<typeof trie>;

import {
  Arg, InvalidArg, TimeSpec, Timer,
  get_now, parse_month_day, parse_hour_minute, parse_timer
} from 'args';

import { Result, OK, Err, isOK, isErr } from 'util/result'

import * as Config from 'moltres-config'

///////////////////////////////////////////////////////////////////////////////

let config: typeof Config = require('moltres-config');
let { emoji_by_name } = require('util/emoji');
let channels_for_region = compute_region_channel_map();
let channels_for_boss = compute_boss_channel_map();
let tz_for_region = compute_region_tz_map();

interface RaidData {
  raid_tiers: Record<string, number>;
  boss_roles: Record<string, string>;
  bosses_for_tier: string[][];
  raid_trie: Trie;
  boss_defaults: Record<number, string>;
}
let raid_data: RaidData;

///////////////////////////////////////////////////////////////////////////////

const moltres = new Discord.Client({
  intents: [
    Discord.Intents.FLAGS.GUILDS,
    Discord.Intents.FLAGS.GUILD_MESSAGES,
    Discord.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Discord.Intents.FLAGS.DIRECT_MESSAGES,
    Discord.Intents.FLAGS.DIRECT_MESSAGE_REACTIONS,
  ],
  partials: [
    'CHANNEL',
    'USER',
  ],
});

moltres.on('ready', () => {
  console.log(`Logged in as ${moltres.user.tag}.`);
});

let moltresdb: mysql.AsyncConnection;

mysql.connect({
  host: 'localhost',
  user: config.dbuser ?? 'moltres',
  password: config.dbpass,
  database: config.dbname ?? 'moltresdb',
  supportBigNumbers: true,
  bigNumberStrings: true,
})
.then(res => {
  moltresdb = res;
  console.log(`Connected as id ${moltresdb.conn.threadId}.`);

  return read_bosses_table();
})
.then((result) => {
  if (isErr(result)) {
    console.error(`Could not read raid bosses table.`);
    process.exit(1);
  }
  const {raid_tiers, boss_roles, boss_defaults} = result.ok;

  raid_data = {
    raid_tiers,
    boss_roles,
    bosses_for_tier: compute_tier_boss_map(raid_tiers),
    raid_trie: trie(Object.keys(raid_tiers)),
    boss_defaults,
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

function signal_handler(signal: NodeJS.Signals) {
  cleanup();
  console.error(`Got signal ${signal}.`);

  process.removeListener(signal, signal_handler);
  process.kill(process.pid, signal);
}

process.on('SIGINT', signal_handler);
process.on('SIGHUP', signal_handler);
process.on('SIGTERM', signal_handler);
process.on('SIGABRT', signal_handler);
process.on('uncaughtException', (err: Error) => {
  cleanup();
  console.error(`Caught exception: ${err}`);
  process.exit(1);
});
process.on('exit', cleanup);

///////////////////////////////////////////////////////////////////////////////

/*
 * Who can use a request?
 */
enum Permission {
  ADMIN,
  NONE,
  WHITELIST,
  BLACKLIST,
};

/*
 * Where can a request be used from?
 */
enum Access {
  DM = 1 << 0,
  REGION = 1 << 1,
  EX_MAIN = 1 << 2,
  EX_ROOM = 1 << 3,
  ADMIN_DM = 1 << 4,

  // Unions.
  REGION_DM = 1 << 0 | 1 << 1,
  EX_ALL = 1 << 2 | 1 << 3,
  ALL = (1 << 5) - 1,
};

/*
 * Request modifiers.
 */
enum Mod {
  NONE = 0,
  FORCE = 1 << 0,     // force override
  ANON = 1 << 1,      // anonymous
  PRESERVE = 1 << 2,  // preserve user message
};

const modifier_map: Record<string, Mod> = {
  '!': Mod.FORCE,
  '?': Mod.ANON,
};

type Req =
    'help'
  | 'set-perm'
  | 'ls-perms'

  | 'add-boss'
  | 'rm-boss'
  | 'def-boss'
  | 'set-boss-role'

  | 'add-gym'
  | 'edit-gym'
  | 'mv-gym'

  | 'reload-config'
  | 'raidday'
  | 'test'

  | 'gym'
  | 'ls-gyms'
  | 'ls-regions'

  | 'raid'
  | 'ls-raids'
  | 'egg'
  | 'boss'
  | 'update'
  | 'scrub'
  | 'ls-bosses'

  | 'call'
  | 'cancel'
  | 'change'
  | 'join'
  | 'unjoin'
  | 'ping'

  | 'ex'
  | 'exit'
  | 'examine'
  | 'exact'
  | 'exclaim'
  | 'explore'
  | 'expunge'
  | 'exalt';

/*
 * Order of display for $help.
 */
const req_order: (Req | null)[] = [
  'help', null,
  'set-perm', 'ls-perms', null,
  'add-boss', 'rm-boss', 'def-boss', 'set-boss-role', null,
  'add-gym', 'edit-gym', 'mv-gym', null,
  'gym', 'ls-gyms', 'ls-regions', null,
  'raid', 'ls-raids', 'egg', 'boss', 'update', 'scrub', 'ls-bosses', null,
  'call', 'cancel', 'change', 'join', 'unjoin', 'ping', null,
  'ex', 'exit', 'examine', 'exact', 'exclaim', 'explore', 'expunge', 'exalt',
];

const req_to_perm: Partial<Record<Req, string>> = {
  'set-perm': 'perms',
  'ls-perms': 'perms',
  'add-boss': 'boss-table',
  'rm-boss':  'boss-table',
  'def-boss': 'boss-table',
  'set-boss-role': 'boss-table',
  'add-gym':  'gym-table',
  'edit-gym': 'gym-table',
  'mv-gym':   'gym-table',
  'gym':        'gym',
  'ls-gyms':    'gym',
  'raid':       'raid',
  'ls-raids':   'raid',
  'egg':    'report',
  'boss':   'report',
  'update': 'report',
  'call':   'call',
  'cancel': 'call',
  'change': 'call',
};

interface ReqDesc {
  perms: Permission;
  access: Access;
  usage: string;
  args: Arg[];
  mod_mask?: Mod;
  desc: string;
  detail: string[];
  examples: Record<string, string>;
}

const reqs: Record<Req, ReqDesc> = {
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
    usage: '<@user> <request>',
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
  'set-boss-role': {
    perms: Permission.WHITELIST,
    access: Access.ALL,
    usage: '<boss> <@role>',
    args: [Arg.STR, -Arg.STR],
    desc: 'Make a raid boss the default boss for its tier.',
    detail: [],
    examples: {
      'yveltal @Yveltal': 'Pretty self-explanatory.',
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
  'edit-gym': {
    perms: Permission.WHITELIST,
    access: Access.REGION,
    usage: '<gym-handle> <region> <lat> <lng> <name>',
    args: [Arg.STR, Arg.STR, Arg.STR, Arg.STR, Arg.VARIADIC],
    desc: 'Edit a gym entry in the database.',
    detail: [
      'Like `$add-gym`, but overwrites an existing entry.  The gym handle',
      'cannot be edited.',
    ],
    examples: {
    },
  },
  'mv-gym': {
    perms: Permission.WHITELIST,
    access: Access.REGION,
    usage: '<current-handle> <new-handle>',
    args: [Arg.STR, Arg.STR],
    desc: 'Change the short-name handle for an existing gym.',
    detail: [
    ],
    examples: {
      'test test2': 'Rename the gym `test` to `test2`.',
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
      'as long as they don\'t match another gym.\n\nIf more than one gym',
      'matches, the list of matches is displayed.',
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
    usage: '<gym-handle-or-name> <tier> <time-til-hatch [HH:]MM:SS> [HH:MM]',
    args: [Arg.VARIADIC, Arg.TIER, Arg.TIMER, -Arg.HOURMIN],
    mod_mask: Mod.FORCE | Mod.ANON,
    desc: 'Report a raid egg.',
    detail: [
      'The tier can be any number 1–5 or things like `t3` or `T4`.  The time',
      'should be the current _**countdown timer**_, not a time of day.  See',
      '`$help gym` for details on gym handles.\n\n`$egg` also accepts two',
      'modifiers:\n\t`$egg!` allows you to override an existing raid report',
      '(e.g., if it\'s incorrect).\n\t`$egg?` prevents your username from',
      'being included in raid report messages.\n\nThe two may be used in',
      'conjunction.\n\nIt\'s possible to attach a `$call` to a raid report',
      'using an additional HH:MM argument for your desired time _after_ the',
      'countdown timer.  Use `$help call` for more information.',
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
    usage: '<gym-handle-or-name> <boss> <time-til-despawn [HH:]MM:SS> [HH:MM]',
    args: [Arg.VARIADIC, Arg.BOSS, Arg.TIMER, -Arg.HOURMIN],
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
      'messages.\n\nThe two may be used in conjunction.\n\nIt\'s possible',
      'to attach a `$call` to a raid report using an additional HH:MM',
      'argument for your desired time _after_ the countdown timer.  Use',
      '`$help call` for more information.',
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
    access: Access.REGION | Access.ADMIN_DM as Access,
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
      'galaxy hatch': 'As above, but set the time as whenever the egg hatches.',
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
  'change': {
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
  'ping': {
    perms: Permission.NONE,
    access: Access.REGION,
    usage: '<gym-handle-or-name> [HH:MM]',
    args: [Arg.VARIADIC, -Arg.HOURMIN],
    desc: 'Mention everyone attending a raid.',
    detail: [
      'As with `$join`, you don\'t need to specify the time _unless_ the',
      'raid has multiple called times, in which case you do.',
    ],
    examples: {
      'galaxy': 'Ping attendees of the raid at **Galaxy: Earth Sphere**.  ' +
                'This only works if there is only a single called time.',
      'galaxy 1:42': 'Ping the 1:42 p.m. raiders at **Galaxy: Earth Sphere**.',
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

const req_aliases: Record<string, Req> = {
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
  'call-time':    'call',
  'change-time':  'change',
  'uncall':       'cancel',
  'j':            'join',
};

const gyaoo = 'Gyaoo!';

///////////////////////////////////////////////////////////////////////////////
// Derived config state.

/*
 * Pull the entire bosses table into global data structures.
 */
async function read_bosses_table(): Promise<Result<{
  raid_tiers: Record<string, number>,
  boss_roles: Record<string, string>,
  boss_defaults: Record<number, string>,
}, mysql.QueryError>> {
  const result = await moltresdb.query<Boss>(
    'SELECT * FROM bosses'
  );
  if (isErr(result)) return result;

  const raid_tiers: RaidData['raid_tiers'] = {};
  const boss_roles: RaidData['boss_roles'] = {};
  const boss_defaults: RaidData['boss_defaults'] = [];

  for (const row of result.ok) {
    if (row.is_default) {
      boss_defaults[row.tier] = row.boss;
    }
    if (row.role_id) {
      boss_roles[row.boss] = row.role_id;
    }
    raid_tiers[row.boss] = row.tier;
  }
  return OK({raid_tiers, boss_roles, boss_defaults});
}

/*
 * Invert the boss-to-tier map and return the result.
 */
function compute_tier_boss_map(
  raid_tiers: Record<string, number>
): string[][] {
  const ret: string[][] = [];

  for (const boss in raid_tiers) {
    const tier = raid_tiers[boss];
    ret[tier] = ret[tier] ?? [];
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
function compute_region_channel_map(): Record<string, Discord.Snowflake[]> {
  const ret: Record<string, Set<Discord.Snowflake>> = {};

  for (const chan in config.channels) {
    const regions = config.channels[chan];
    for (const region of regions) {
      if (region in config.metaregions) {
        for (const subregion of config.metaregions[region]) {
          ret[subregion] = ret[subregion] ?? new Set();
          ret[subregion].add(chan);
        }
      } else {
        ret[region] = ret[region] ?? new Set();
        ret[region].add(chan);
      }
    }
  }

  const out: Record<string, Discord.Snowflake[]> = {};
  for (const region in ret) {
    out[region] = [...ret[region]];
  }
  return out;
}

/*
 * Invert the boss-to-region map.
 */
function compute_boss_channel_map(): Record<string, Discord.Snowflake[]> {
  const ret: Record<string, Set<Discord.Snowflake>> = {};

  for (const chan in config.boss_channels) {
    const bosses = config.boss_channels[chan];
    for (const boss of bosses) {
      ret[boss] = ret[boss] ?? new Set();
      ret[boss].add(chan);
    }
  }

  const out: Record<string, Discord.Snowflake[]> = {};
  for (const boss in ret) {
    out[boss] = [...ret[boss]];
  }
  return out;
}

/*
 * Splat metaregions out into regions for the region-to-timezone map.
 *
 * Any region overrides will take precedence over overrides for any containing
 * metaregions.
 */
function compute_region_tz_map(): Record<string, string> {
  const ret: Record<string, string> = {};

  for (const region in config.timezones) {
    if (!(region in config.metaregions)) continue;

    for (const subregion of config.metaregions[region]) {
      ret[subregion] = config.timezones[region];
    }
  }
  for (const region in config.timezones) {
    if (region in config.metaregions) continue;
    ret[region] = config.timezones[region];
  }

  return ret;
}

///////////////////////////////////////////////////////////////////////////////
// String utilities.

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.substr(1);
}

///////////////////////////////////////////////////////////////////////////////
// Discord utilities.

/*
 * Get the main guild for bot requests.
 */
function guild(): Discord.Guild {
  return moltres.guilds.cache.get(config.guild_id);
}

/*
 * Whether `user' is a member of `guild'.
 */
async function is_member(
  guild: Discord.Guild,
  user: Discord.User,
): Promise<boolean> {
  const member = await guild.members.fetch(user.id);
  return !!member;
}

/*
 * Whether `msg' is from a DM.
 */
function from_dm(msg: Discord.Message): boolean {
  return msg.channel.type === 'DM';
}

type MessageContent = string | (Discord.MessageOptions & { split?: false })

/*
 * Wrapper around send() that chains messages and swallows exceptions.
 */
async function send_quiet_impl(
  channel: Discord.TextBasedChannels,
  reply_parent: Discord.Message | null,
  ...contents: MessageContent[]
): Promise<Discord.Message> {
  if (contents.length === 0) return;
  const [head, ...tail] = contents;

  let message: Discord.Message;
  try {
    if (reply_parent) {
      message = await reply_parent.reply(head);
      for (const item of tail) {
        message = await message.reply(item);
      }
    } else {
      message = await channel.send(head);
      for (const item of tail) {
        message = await message.channel.send(item);
      }
    }
  } catch (e) {
    // @ts-ignore
    const chan_name = channel.name ?? channel.recipient?.tag ?? '<unknown>';
    log_impl(`Problem sending a message to ${chan_name}.`);
    console.error(e);
  }
  return message;
}

/*
 * Wrappers around send_quiet_impl() which perform message chunking.
 */
function send_quiet(
  channel: Discord.TextBasedChannels,
  content: MessageContent,
  reply_parent?: Discord.Message,
): Promise<Discord.Message> {
  const outvec = [];

  if (typeof content === 'string') {
    while (content.length >= 2000) {
      let split_pos = content.lastIndexOf('\n', 2000);
      if (split_pos === -1) split_pos = 2000;

      outvec.push(content.substr(0, split_pos));
      content = content.substr(split_pos);
    }
  }
  outvec.push(content);

  return send_quiet_impl(channel, reply_parent, ...outvec);
}
async function dm_quiet(
  user: Discord.User,
  content: string,
): Promise<Discord.Message> {
  try {
    const dm = await user.createDM();
    return send_quiet(dm, content);
  } catch (e) {
    log_impl(`Problem sending a message to ${user.tag}.`);
    console.error(e);
  }
}

/*
 * Try to delete a message if it's not on a DM channel.
 */
async function try_delete(
  msg: Discord.Message,
  wait: number = 0,
): Promise<void> {
  if (from_dm(msg)) return;
  try {
    setTimeout(() => msg.delete(), wait);
  } catch (e) {
    console.error(e);
  }
}

/*
 * Reply to a message via DM, then delete it.
 */
async function dm_reply_then_delete(
  msg: Discord.Message,
  content: string,
  wait: number = 500,
): Promise<void> {
  await dm_quiet(msg.author, content);
  return try_delete(msg, wait);
}

/*
 * Get an emoji by name.
 */
function get_emoji(name: string, by_id: boolean = false): string {
  name = config.emoji[name as Config.EmojiAlias] ?? name;

  const extract: (e: Discord.Emoji) => string =
    by_id ? (e => e.id) : (e => e.toString());

  return emoji_by_name[name] ??
         extract(moltres.emojis.cache.find(e => e.name === name));
}

/*
 * Add reactions to `msg' in order.
 */
async function chain_reaccs(
  msg: Discord.Message,
  ...reaccs: string[]
): Promise<void> {
  if (reaccs.length === 0) return;
  const [head, ...tail] = reaccs;

  try {
    const emoji = get_emoji(head, true);
    let reaction = await msg.react(emoji);

    for (const name of tail) {
      const emoji = get_emoji(name, true);
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
function get_role(name: string): Discord.Role | null {
  const impl = (name: string): Discord.Role | null => {
    let role = guild().roles.cache.find(r => r.name === name);
    if (role) return role;

    role = guild().roles.cache.find(r => r.name === capitalize(name));
    if (role) return role;

    const matches = guild().roles.cache.filter(
      role => role.name.toLowerCase().startsWith(name.toLowerCase())
    );
    return matches.size === 1 ? matches.first() : null;
  };

  const role = impl(name);
  if (role !== null) return role;

  return impl(name.replace(/-/g, ' '));
}

/*
 * Count all the mentions in `msg'.
 */
function total_mentions(msg: Discord.Message): number {
  return msg.mentions.channels.size +
         msg.mentions.members.size +
         msg.mentions.roles.size +
         msg.mentions.users.size +
         +msg.mentions.everyone;
}

/*
 * Return whether `msg' has exactly one image attachment.
 */
function has_single_image(msg: Discord.Message): boolean | null {
  if (msg.attachments.size !== 1) return null;
  return !!msg.attachments.first().height;
}

/*
 * Pin `msg' to its containing channel if there are no other pins.
 */
async function pin_if_first(msg: Discord.Message): Promise<any> {
  const pins = await msg.channel.messages.fetchPinned();
  if (pins.size !== 0) return;
  return msg.pin();
}

///////////////////////////////////////////////////////////////////////////////
// Error logging.

interface ReqOrigin {
  author: Discord.User;
}

/*
 * Log base function.
 */
async function log_impl(str: string): Promise<Discord.Message> {
  const log = await moltres.channels.fetch(config.log_id);
  return send_quiet(log as Discord.TextChannel, str);
};

/*
 * React to a successful request.
 */
function react_success(
  msg: Discord.Message,
  reacc?: string,
): Promise<void> {
  return chain_reaccs(msg, reacc ?? 'approved');
};

/*
 * Log an internal error.
 */
function log_error(
  str: string,
  origin: ReqOrigin | null,
  reacc?: string,
): Promise<any> {
  return Promise.all([
    log_impl('_Error:_  ' + str),
    async() => {
      if (origin && origin instanceof Discord.Message) {
        chain_reaccs(origin, reacc ?? 'no_good');
      }
    },
  ]);
};

/*
 * Handle an invalid request by logging, DMing the user, and possibly deleting
 * the request message.
 */
async function log_invalid(
  origin: ReqOrigin,
  str: string,
  keep: boolean = false,
): Promise<void> {
  const orig_str = str;

  // Truncate long error messages types.
  if (str.startsWith('**Usage**')) {
    str = 'Usage: [...]';
  }
  const pos = str.indexOf('\nGyms matching');
  if (pos !== -1) {
    str = str.slice(0, pos);
  }

  await Promise.all([
    log_impl('_Error:_  ' + str),
    dm_quiet(origin.author, orig_str),
  ]);
  if (!keep && origin instanceof Discord.Message) {
    await try_delete(origin);
  }
};

/*
 * Get the usage string for `req'.
 */
function usage_string(req: Req): string {
  if (!(req in reqs)) return null;
  const meta = reqs[req];

  let result = `**Usage**: \`\$${req} ${meta.usage}\`

(Arguments in \`<>\` are required; arguments in \`[]\` are optional.)

${meta.detail.join(' ')}`;

  const aliases = Object.keys(req_aliases)
    .filter(k => req_aliases[k] === req)
    .map(a => `\`\$${a}\``);
  if (aliases.length > 0) {
    result += `\n\n**Aliases**: ${aliases.join(', ')}`;
  }

  if (Object.keys(meta.examples).length === 0) return result;
  result += '\n\n**Examples**:';

  for (const ex in meta.examples) {
    result += `\n\t\`\$${req} ${ex}\`: ${meta.examples[ex]}`;
  }
  return result;
}

///////////////////////////////////////////////////////////////////////////////
// DB datatypes.

enum Team {
  Valor = 'valor',
  Mystic = 'mystic',
  Instinct = 'instinct',
}

interface Gym {
  id: number;
  handle: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  ex: boolean;
  silent: boolean;
}

interface Raid {
  gym_id: number;
  tier: number;
  boss: string | null;
  despawn: Date;
  spotter: Discord.Snowflake;
  team: Team;
}

interface Call {
  id: number;
  raid_id: number;
  caller: Discord.Snowflake;
  time: Date;
}

interface Join {
  call_id: number;
  user_id: Discord.Snowflake;
  extras: number;
  maybe: boolean;
}

interface Boss {
  boss: string;
  tier: number;
  is_default: boolean;
  role_id: Discord.Snowflake;
}

interface PermissionRow {
  cmd: Req;
  user_id: Discord.Snowflake;
}

interface FullJoinTableRow {
  gyms: Gym;
  raids: Raid;
  calls: Call;
  rsvps: Join;
};
type CallJoinTableRow = Omit<FullJoinTableRow, 'rsvps'>

///////////////////////////////////////////////////////////////////////////////
// DB error logging.

/*
 * Extract an array of unique gym table entries from an error-messaging query.
 *
 * The `rows' can either be nested or not, and we assume that where_one_gym
 * uniquification has not already been performed.
 */
function uniq_gyms_for_error(
  rows: Gym[] | {gyms: Gym}[],
  handle: string
): Gym[] {
  const [first = {}] = rows;

  if ('gyms' in first) {
    rows = (rows as {gyms: Gym}[]).map(row => row.gyms);
  }
  rows = rows as Gym[]; // blarg

  const found_handles: Set<string> = new Set();

  rows = rows.filter(gym => {
    if (found_handles.has(gym.handle)) return false;
    found_handles.add(gym.handle);
    return true;
  });

  // Account for our preference for exact handle matches.
  const maybe_unique = rows.filter(gym => gym.handle === handle);
  if (maybe_unique.length === 1) rows = maybe_unique;

  return rows;
}

/*
 * Return false and handle error responses if the gym query result `gyms'
 * doesn't uniquely match `handle'.
 *
 * Otherwise, return true.
 */
async function check_gym_match(
  origin: ReqOrigin,
  gyms: Gym[],
  handle: string,
): Promise<boolean> {
  if (gyms.length === 0) {
    await log_invalid(origin,
      `No gyms found matching \`[${handle}]\`.`
    );
    return false;
  }
  if (gyms.length > 1) {
    await log_invalid(origin,
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
async function query_for_error(
  origin: ReqOrigin,
  handle: string,
  now?: Date,
): Promise<{
  call_rows: CallJoinTableRow[],
  gym: Gym | null
}> {
  now = now ?? get_now();

  const result = await moltresdb.query<CallJoinTableRow>({
    sql:
      'SELECT * FROM gyms ' +
      '   LEFT JOIN raids ON ( ' +
      '         gyms.id = raids.gym_id ' +
      '     AND raids.despawn > ? ' +
      '   ) ' +
      '   LEFT JOIN calls ON raids.gym_id = calls.raid_id ' +
      'WHERE gyms.handle LIKE ? OR gyms.name LIKE ? ',
    values: [now as any].concat(Array(2).fill(`%${handle}%`)),
    nestTables: true,
  });
  if (isErr(result)) {
    await log_mysql_error(origin, result.err);
    return {call_rows: [], gym: null};
  }

  const gyms = uniq_gyms_for_error(result.ok, handle);

  const pass = await check_gym_match(origin, gyms, handle);
  if (!pass) return {call_rows: [], gym: null};

  const [gym] = gyms;
  const call_rows = result.ok.filter(row => row.gyms.handle === gym.handle);
  return {call_rows, gym};
}

/*
 * Like query_for_error(), but checks call times.
 */
async function query_for_error_call(
  origin: ReqOrigin,
  handle: string,
  call_time: Date,
  req: Req,
): Promise<{
  call_row: CallJoinTableRow | null,
  gym: Gym | null
}> {
  const {call_rows, gym} = await query_for_error(origin, handle);
  if (!gym) return {call_row: null, gym: null};

  const fail = async function(...args: Parameters<typeof log_invalid>) {
    await log_invalid(...args);
    return {call_row: null as (CallJoinTableRow | null), gym};
  };

  const [first] = call_rows;

  if (first.raids.gym_id === null) {
    return fail(origin,
      `No raid has been reported at ${gym_name(gym)}.`
    );
  }
  if (first.calls.raid_id === null) {
    return fail(origin,
      `No times have been called for the raid at ${gym_name(gym)}.`
    );
  }

  if (!call_time && call_rows.length > 1) {
    return fail(origin,
      `Multiple times have been called for the raid at ${gym_name(gym)}.` +
      `  Please include the time in your post (e.g., \`$${req} ${handle} ` +
      `${time_str_short(first.calls.time, gym.region)} [...])\`.`
    );
  }

  const call = !!call_time
    ? call_rows.find(row => row.calls.time.getTime() === call_time.getTime())
    : call_rows[0];

  if (call_time && !call) {
    return fail(origin,
      `No raid at ${gym_name(gym)} has been called for ` +
      `${time_str(call_time, gym.region)}.`
    );
  }
  return {call_row: call, gym};
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
function log_mysql_error(
  origin: ReqOrigin | null,
  err: mysql.QueryError,
): Promise<any> {
  console.error(err);
  return log_error(
    `MySQL error: ${err.code} (${err.errno}): ${err.sqlMessage})`,
    origin
  );
}

///////////////////////////////////////////////////////////////////////////////
// SQL snippets.

/*
 * Get a SQL WHERE clause fragment for selecting a unique gym matching `handle'.
 */
function where_one_gym(handle: string): string {
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
function where_region(
  region: string,
): {
  meta: string;
  sql: string;
} {
  const metanames = Object.keys(config.metaregions).filter(
    name => name.toLowerCase().startsWith(region.toLowerCase())
  );

  if (metanames.length !== 1) {
    return {
      meta: null,
      sql: mysql.format('gyms.region LIKE ?', [`${region}%`]),
    };
  }

  const regions = config.metaregions[metanames[0]]
  const sql = regions
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
function where_call_time(
  call_time: Date | null,
  for_update: boolean = false,
): string {
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
async function select_region(
  handle: string,
): Promise<string> {
  const result = await moltresdb.query<Gym>(
    'SELECT * FROM gyms WHERE ' + where_one_gym(handle)
  );
  if (isErr(result)) return log_mysql_error(null, result.err);

  if (result.ok.length !== 1) return null;
  const [gym] = result.ok;

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
function select_rsvps(
  handle: string,
  xtra_where: string | null = null,
  xtra_values: any[] = []
): Promise<mysql.QueryResult<FullJoinTableRow>> {
  return moltresdb.query<FullJoinTableRow>({
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
 * Take an object returned by parse_hour_minute() and convert to a Date object.
 *
 * This function uses rough heuristics to determine whether the user meant A.M.
 * or P.M., based on the assumption that the intent is always to represent the
 * most proximal time in the future.  Users can override this with `am`/`pm`.
 */
async function interpret_time(
  timespec: TimeSpec | null,
  handle?: string
): Promise<Date | null> {
  if (timespec === null) return null;

  if (timespec === 'hatch') {
    if (handle === null) return null;

    const result = await moltresdb.query<Gym & Raid>(
      'SELECT * FROM gyms INNER JOIN raids ON gyms.id = raids.gym_id' +
      '   WHERE ' + where_one_gym(handle)
    );
    if (isErr(result) || result.ok.length !== 1) return null;

    const [raid] = result.ok;
    return hatch_from_despawn(raid.despawn);
  }

  let {hours, mins, am_pm} = timespec;

  const now = get_now();

  const tz = await async function(): Promise<string> {
    // Use the default timezone if we have no region or no overrides.
    if (handle === null) return config.tz_default;
    if (Object.keys(tz_for_region).length === 0) return config.tz_default;

    const region = await select_region(handle);
    // If we failed to find a region for `handle', just use the default
    // timezone.  This may not match the user's intentions, but some other
    // failure is going to be reported anyway, so it doesn't matter.
    if (region === null) return config.tz_default;

    return tz_for_region[region] ?? config.tz_default;
  }();

  const offset_delta = function() {
    const local_offset = -now.getTimezoneOffset();
    const local_tz = FixedOffsetZone.instance(local_offset);
    const remote_tz = IANAZone.create(tz);
    const remote_offset = remote_tz.offset(now.getTime());

    return (remote_offset - local_offset) / 60;
  }();

  hours = function() {
    if (am_pm) {
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
function date_str(date: Date, region: string = ''): string {
  return date.toLocaleString('en-US', {
    timeZone: tz_for_region[region] ?? config.tz_default,
    month: 'short',
    day: '2-digit',
  });
}
function time_str(date: Date, region: string = ''): string {
  return date.toLocaleString('en-US', {
    timeZone: tz_for_region[region] ?? config.tz_default,
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  });
}
function time_str_short(date: Date, region: string = ''): string {
  const str = time_str(date, region);
  const pos = str.indexOf(' ');
  if (pos === -1) return str;
  return str.substr(0, pos);
}

/*
 * Get the raid pop or hatch time from a despawn time.
 */
function pop_from_despawn(despawn: Date): Date {
  const pop = new Date(despawn.getTime());
  pop.setMinutes(pop.getMinutes() - egg_duration - boss_duration);
  return pop;
}
function hatch_from_despawn(despawn: Date): Date {
  const hatch = new Date(despawn.getTime());
  hatch.setMinutes(hatch.getMinutes() - boss_duration);
  return hatch;
}

///////////////////////////////////////////////////////////////////////////////
// Argument parsing.

type BossResult = {
  boss: string,
  orig: string
};

/*
 * Pull the integer tier from a tier string (e.g., '5' or 'T5'), or return null
 * if the string is not tier-like.
 */
function parse_tier(tier: string): number | null {
  if (tier.startsWith('T') || tier.startsWith('t')) {
    tier = tier.substr(1);
  }
  const lower = tier.toLowerCase();
  if (lower === 'm' || lower === 'mega') return 6;

  const t = parseInt(tier);
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
 *       boss with minimal edit distance from the input, return it.
 *    4/ Repeat step 3 but for all bosses.
 */
function parse_boss(input: string): BossResult | null {
  input = input.toLowerCase();
  input = config.boss_aliases[input] ?? input;

  const wrap = (boss: string) => ({boss: boss, orig: input});

  if (input.length === 0) return null;

  const matches = raid_data.raid_trie.getPrefix(input);
  if (matches.length === 1) return wrap(matches[0]);

  const find_match = (bosses: string[]) => {
    const matches = bosses.map(boss => ({
      boss: boss,
      substr: (() => {
        if (boss.includes(input)) return true;

        const boss_parts = boss.split('-');
        const input_parts = input.split('-');

        if (boss_parts.length !== input_parts.length) return false;

        for (let i = 0; i < boss_parts.length; ++i) {
          if (!boss_parts[i].includes(input_parts[i])) return false;
        }
        return true;
      })(),
      lev: ed.levenshtein(
        input,
        boss,
        (_: string) => 1,
        (_: string) => 1,
        (x: string, y: string) => 2 * +(x !== y)
      ),
    }));

    const choose_best = (options: typeof matches) => {
      const min_dist = Math.min(...options.map(meta => meta.lev.distance));
      options = options.filter(meta => meta.lev.distance === min_dist);

      return options.length === 1 ? wrap(options[0].boss) : null;
    };

    const substrs = matches.filter(meta => meta.substr);
    if (substrs.length > 0) return choose_best(substrs);
    return choose_best(matches);
  };

  let match = find_match(raid_data.raid_trie.getPrefix(input[0]));
  if (match) return match;

  match = find_match(Object.keys(raid_data.raid_tiers));
  if (match) return match;

  return null;
}

/*
 * Extract the boss name from the output of parse_boss(), DM-ing the user if
 * the match was inexact.
 */
async function extract_boss(
  msg: Discord.Message,
  boss: BossResult | null,
): Promise<string | null> {
  if (boss === null) return null;

  if (!boss.boss.startsWith(boss.orig)) {
    await dm_quiet(msg.author,
      `Assuming \`${boss.orig}\` is the British spelling of \`${boss.boss}\`.`
    );
  }
  return boss.boss;
}

type ArgUnion = string | number | Date | TimeSpec | Timer | BossResult

/*
 * Parse a single argument `input' according to `kind'.
 */
function parse_one_arg(
  input: string,
  kind: Arg
): ArgUnion | null {
  switch (kind) {
    case Arg.STR:
      return input;
    case Arg.INT: {
      const i = parseInt(input);
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
  }
}

/*
 * Parse the `input' string using `spec'.
 *
 * Returns an array of extracted arguments.  Individual arguments may be
 * InvalidArg if they were invalid in `input', or null if they were optional
 * and not found.  If `input' has more or fewer space-separated arguments than
 * `spec' requires, returns null.
 */
function parse_args(
  input: string,
  spec: Arg[]
): (ArgUnion | InvalidArg | null)[] | null {
  input = input.trim();
  if (spec === null) return [input];

  const required = spec.filter(a => a >= 0).length;

  if (input.length === 0) {
    if (required > 0) return null;
    return new Array(spec.length).fill(null);
  }

  const re = /\s+/g;
  const splits = [{start: 0, end: -1}];

  // Construct an array of {start, end} records representing all the space-
  // separated components of `input'.
  while (true) {
    const match = re.exec(input);
    if (match === null) break;

    splits[splits.length - 1].end = match.index;
    splits.push({start: re.lastIndex, end: -1});
  }
  splits[splits.length - 1].end = input.length;

  if (splits.length < required) return null;

  let argv: (ArgUnion | InvalidArg | null)[] = [];
  let spec_idx = 0;
  let split_idx = 0;

  let vmeta: {
    argv_idx: number,
    spec_idx: number,
    split_idx: number,
    split_end: number,
    split_end_orig: number,
    split_limit: number,
  };

  // We're going to jump through a lot of hoops to avoid writing a backtracking
  // regex matcher to support both * and ?, since we know we have at most one
  // variadic.
  const backtrack = function() {
    if (vmeta && ++vmeta.split_end <= vmeta.split_limit) {
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
      const kind = spec[spec_idx++];

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

      const info = splits[split_idx++];

      if (Math.abs(kind) === Arg.VARIADIC) {
        if (!vmeta) {
          vmeta = {
            // Indexes of the variadic argument.
            argv_idx: argv.length,
            spec_idx: spec_idx - 1,
            split_idx: split_idx - 1,
            // Index of the positional argument after the variadic is matched.
            // We'll push this out one further if we fail to match as is, until
            // we run out of optional arguments we could potentially bypass.
            split_end: splits.length - (spec.length - spec_idx),
            split_end_orig: -1,
            split_limit: -1,
          };
          vmeta.split_end_orig = vmeta.split_end;
          // Threshold for how far we can push split_end out to.
          vmeta.split_limit = vmeta.split_end +
            spec.slice(spec_idx).filter(a => a < 0).length;
        }

        // Get the variadic component exactly as the user input it.
        split_idx = Math.max(split_idx, vmeta.split_end);
        const arg = input.substring(info.start, splits[split_idx - 1].end);
        argv.push(arg);
        continue;
      }

      const raw = input.substring(info.start, info.end);
      const arg = parse_one_arg(raw, Math.abs(kind));
      num_invalid += +(arg === null);

      if (kind >= 0 || spec_idx === spec.length) {
        argv.push(arg !== null ? arg : new InvalidArg(raw));
      } else {
        // If the argument was optional and failed to parse, assume the user
        // intended to skip it and try to parse it again as the next argument.
        argv.push(arg);
        if (arg === null) --split_idx;
      }
    }

    if (vmeta &&
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

function handle_help(
  msg: Discord.Message,
  req: Req | null,
): Promise<any> {
  let out: string;

  if (req === null) {
    out = get_emoji('team') +
          '  Please choose your request from the following:\n\n';
    for (const req of req_order) {
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
      'more about a specific request.\n\nMoltres\'s trainer is @mxawng#0042. ',
      'You can help out at: <https://github.com/mxw/moltres>',
    ].join(' ');
  } else {
    req = req_aliases[req] ?? req;

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

async function handle_set_perm(
  msg: Discord.Message,
  user_tag: string,
  req: string,
): Promise<any> {
  if (!user_tag.match(Discord.MessageMentions.USERS_PATTERN) ||
      msg.mentions.users.size !== 1) {
    return log_invalid(msg, `Invalid user tag \`${user_tag}\`.`);
  }
  const user = msg.mentions.users.first();

  const result = await moltresdb.query<mysql.UpdateResult>(
    'INSERT INTO permissions SET ?',
    { cmd: req, user_id: user.id, }
  );
  if (isErr(result)) {
    if (result.err.code === 'ER_DUP_ENTRY') {
      const result = await moltresdb.query<mysql.UpdateResult>(
        'DELETE FROM permissions WHERE ?',
        { cmd: req, user_id: user.id, }
      );
      if (isErr(result)) {
        return log_mysql_error(msg, result.err);
      }
    }
    return log_mysql_error(msg, result.err);
  }

  if (result.ok.affectedRows === 0) {
    return log_invalid(msg, 'Unknown failure.');
  }
  return react_success(msg);
}

async function handle_ls_perms(msg: Discord.Message): Promise<any> {
  const result = await moltresdb.query<PermissionRow>(
    'SELECT * FROM permissions'
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  const perms: Partial<Record<Req, Discord.Snowflake[]>> = {};

  for (const row of result.ok) {
    perms[row.cmd] = perms[row.cmd] ?? [];

    try {
      const member = await guild().members.fetch(row.user_id);
      if (!member) continue;

      perms[row.cmd].push(member.nickname ?? member.user.username);
    } catch (e) {
      continue;
    }
  }

  const outvec = [];

  for (const req_ in perms) {
    const req = req_ as Req;
    if (perms[req].length === 0) continue;
    perms[req].sort();

    let example_req = req;

    // Just loop through the permissions alias table to find an example.
    for (const ex_ in req_to_perm) {
      const ex = ex_ as Req;
      if (req_to_perm[ex] === req) {
        example_req = ex;
        break;
      }
    }
    const perm = reqs[example_req].perms;
    const perm_str = perm === Permission.WHITELIST ? 'whitelist' :
                     perm === Permission.BLACKLIST ? 'blacklist' :
                     'unknown';

    outvec.push(`\`${req}\` [${perm_str}]:\t` + perms[req].join(', '));
  }
  return send_quiet(msg.channel,
    `**Permissions:**\n\n` + outvec.join('\n')
  );
}

async function handle_add_boss(
  msg: Discord.Message,
  boss: string,
  tier: number | InvalidArg,
): Promise<any> {
  if (tier instanceof InvalidArg) {
    return log_invalid(msg, `Invalid raid tier \`${tier.arg}\`.`);
  }
  boss = boss.toLowerCase();

  const old_tier = raid_data.raid_tiers[boss];

  const result = await moltresdb.query<mysql.UpdateResult>(
    'REPLACE INTO bosses SET ?',
    { boss: boss, tier: tier }
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (!!old_tier) {
    raid_data.bosses_for_tier[old_tier] =
      raid_data.bosses_for_tier[old_tier].filter(b => b !== boss);
  }
  raid_data.raid_tiers[boss] = tier;
  raid_data.bosses_for_tier[tier] = raid_data.bosses_for_tier[tier] ?? [];
  raid_data.bosses_for_tier[tier].push(boss);
  raid_data.bosses_for_tier[tier].sort();
  raid_data.raid_trie = trie(Object.keys(raid_data.raid_tiers));

  return react_success(msg);
}

async function handle_rm_boss(
  msg: Discord.Message,
  boss: string,
): Promise<any> {
  if (!(boss in raid_data.raid_tiers)) {
    return log_invalid(msg, `Unregistered raid boss \`${boss}\`.`);
  }
  const tier = raid_data.raid_tiers[boss];

  const result = await moltresdb.query<mysql.UpdateResult>(
    'DELETE FROM bosses WHERE `boss` = ?',
    [boss]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  delete raid_data.raid_tiers[boss];
  raid_data.bosses_for_tier[tier] =
    raid_data.bosses_for_tier[tier].filter(b => b !== boss);
  raid_data.raid_trie = trie(Object.keys(raid_data.raid_tiers));

  return react_success(msg);
}

async function handle_def_boss(
  msg: Discord.Message,
  boss_or_tier: string,
): Promise<any> {
  let tier = raid_data.raid_tiers[boss_or_tier];
  let boss = boss_or_tier;

  if (!tier) {
    tier = parse_tier(boss_or_tier);
    boss = null;
    if (tier === null) {
      return log_invalid(msg, `Unregistered raid boss \`${boss_or_tier}\`.`);
    }
  }

  const result = await moltresdb.query<mysql.UpdateResult>(
    'UPDATE bosses ' +
    '  SET `is_default` = CASE WHEN `boss` = ? THEN 1 ELSE 0 END ' +
    '  WHERE `tier` = ?',
    [boss, tier]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  raid_data.boss_defaults[tier] = boss;

  return react_success(msg);
}

async function handle_set_boss_role(
  msg: Discord.Message,
  boss: string,
  role_tag: string | null,
): Promise<any> {
  if (!(boss in raid_data.raid_tiers)) {
    return log_invalid(msg, `Unregistered raid boss \`${boss}\`.`);
  }

  if (role_tag !== null && (
        !role_tag.match(Discord.MessageMentions.ROLES_PATTERN) ||
        msg.mentions.roles.size !== 1
      )) {
    return log_invalid(msg, `Invalid user tag \`${role_tag}\`.`);
  }

  const role_id = role_tag !== null
    ? msg.mentions.roles.first().id
    : null;

  const result = await moltresdb.query<mysql.UpdateResult>(
    'UPDATE bosses SET `role_id` = ? WHERE `boss` = ?',
    [role_id, boss]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.affectedRows === 0) {
    return log_invalid(msg, 'Unknown failure.');
  }

  if (role_id) {
    raid_data.boss_roles[boss] = role_id;
  } else {
    delete raid_data.boss_roles[boss];
  }

  return react_success(msg);
}

///////////////////////////////////////////////////////////////////////////////
// Developer handlers.

function handle_reload_config(msg: Discord.Message): Promise<any> {
  delete require.cache[require.resolve('moltres-config')];
  delete require.cache[require.resolve('util/emoji')];

  config = require('moltres-config');
  emoji_by_name = require('util/emoji').emoji_by_name;
  channels_for_region = compute_region_channel_map();
  channels_for_boss = compute_boss_channel_map();
  tz_for_region = compute_region_tz_map();

  return react_success(msg);
}

async function handle_raidday(
  msg: Discord.Message,
  boss_: BossResult | InvalidArg,
  despawn_: TimeSpec | InvalidArg,
): Promise<any> {
  if (boss_ instanceof InvalidArg) {
    return log_invalid(msg, `Invalid raid boss \`${boss_.arg}\`.`);
  }
  if (despawn_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${despawn_.arg}\`.`);
  }
  if (despawn_ === 'hatch') {
    return log_invalid(msg, `Unrecognized HH:MM time \`hatch\`.`);
  }
  const boss = await extract_boss(msg, boss_);
  const despawn = await interpret_time(despawn_);

  return moltresdb.query<mysql.UpdateResult>(
    'REPLACE INTO raids (`gym_id`, `tier`, `boss`,  `despawn`, `spotter`) ' +
    '   SELECT `id`, ?, ?, ?, ? FROM gyms',
    [raid_data.raid_tiers[boss], boss, despawn, msg.author.id]
  );
}

async function handle_test(
  msg: Discord.Message,
  args: string,
): Promise<any> {
  /*
  const tests = require('./tests.js');

  const argv_equals = function(
    l: (ArgUnion | InvalidArg)[],
    r: (ArgUnion | InvalidArg)[],
  ): boolean {
    if (r === null) return l === null;
    if (l.length !== r.length) return false;

    for (let i = 0; i < l.length; ++i) {
      if (l[i] === r[i]) continue;

      if (l[i] instanceof Date) {
        const d = parse_month_day(r[i] as string);
        if ((l[i] as Date).getTime() === d.getTime()) continue;
      }
      // @ts-ignore
      if (l[i] === 'hatch' || (l[i].hours && l[i].mins)) {
        const l_i = l[i] as TimeSpec;
        const r_i = r[i] as TimeSpec;

        if (l_i === 'hatch' && r_i === 'hatch') continue;
        if (l_i !== 'hatch' && r_i !== 'hatch') {
          if (l_i.mins === r_i.mins && l_i.secs === r_i.secs) continue;
        }
      }
      // @ts-ignore
      if (l[i] === 'hatch' || (l[i].mins && l[i].secs)) {
        const l_i = l[i] as TimeSpec;
        const r_i = r[i] as TimeSpec;

        if (l_i === 'hatch' && r_i === 'hatch') continue;
        if (l_i !== 'hatch' && r_i !== 'hatch') {
          if (l_i.mins === r_i.mins && l_i.secs === r_i.secs) continue;
        }
      }
      if (l[i] instanceof InvalidArg &&
          r[i] instanceof InvalidArg &&
          (l[i] as InvalidArg).arg === (r[i] as InvalidArg).arg) {
        continue;
      }
      return false;
    }
    return true;
  }

  for (const test of tests.parse_args) {
    let spec = test.spec;
    if (typeof spec === 'string') spec = reqs[spec].args;

    const result = parse_args(test.args, spec);
    console.assert(
      argv_equals(result, test.expect),
      `parse_args(): failed on input ${test.args} with ${spec}
  expected: ${test.expect}
  got: ${result}`
    );
  }
  console.log('$test: parse_args() tests passed.');
  */
}

///////////////////////////////////////////////////////////////////////////////
// Gym handlers.

/*
 * Helper for error-handling cases where zero or multiple gyms are found.
 *
 * Returns true if we have a single result, else false.
 */
async function check_one_gym(
  msg: Discord.Message,
  handle: string,
  results: Gym[],
): Promise<boolean> {
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
function gym_name(gym: Gym): string {
  let name = `\`[${gym.handle}]\` **${gym.name}**`;
  if (gym.ex) name += ' (EX!)';
  return name;
}

/*
 * Stringify a row from the gyms table.
 */
function gym_row_to_string(gym: Gym): string {
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
function list_gyms(
  gyms: Gym[],
  incl_region: boolean = true,
  is_valid?: (gym: Gym) => boolean,
): string | null {
  const output = [];

  for (const gym of gyms) {
    if (is_valid && !is_valid(gym)) return null;

    let str = `\`[${gym.handle}]\` ${gym.name}`;
    if (gym.ex) str += ' **(EX!)**';
    if (incl_region) str += ` — _${gym.region}_`;
    output.push(str);
  }
  return output.join('\n');
}

async function handle_gym(
  msg: Discord.Message,
  name: string,
): Promise<any> {
  let result = await moltresdb.query<Gym>(
    'SELECT * FROM gyms WHERE ' + where_one_gym(name)
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.length === 1) {
    const [gym] = result.ok;
    return send_quiet(msg.channel, gym_row_to_string(gym));
  }

  const handle = name.replace(/ /g, '-');

  result = await moltresdb.query<Gym>(
    'SELECT * FROM gyms WHERE handle LIKE ? OR name LIKE ?',
    [`%${handle}%`, `%${name}%`]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.length === 0) {
    return send_quiet(msg.channel,
      `No gyms with handle or name matching ${name}.`
    );
  }
  const output = `Gyms matching \`${name}\`:\n\n` + list_gyms(result.ok);
  return send_quiet(msg.channel, output);
}

async function handle_ls_gyms(
  msg: Discord.Message,
  region: string,
): Promise<any> {
  const region_clause = where_region(region);

  const result = await moltresdb.query<Gym>(
    'SELECT * FROM gyms WHERE ' + region_clause.sql
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);
  const rows = result.ok;

  if (rows.length === 0) {
    return log_invalid(msg, `Invalid region name \`${region}\`.`);
  }
  const is_meta = region_clause.meta !== null;
  const out_region = is_meta ? region_clause.meta : rows[0].region;

  const gym_list = list_gyms(rows, false,
    gym => (is_meta || gym.region === out_region)
  );
  if (gym_list === null) {
    return log_invalid(msg, `Ambiguous region name \`${region}\`.`);
  }

  const output = `Gyms in **${out_region}**:\n\n` + gym_list;
  return send_quiet(msg.channel, output);
}

/*
 * Preprocess inputs for $add-gym and $edit-gym.
 */
function fixup_gym_params(
  handle: string,
  region: string,
  lat: string,
  lng: string,
  name: string,
) {
  return {
    handle: handle.toLowerCase(),
    name: name,
    region: region.replace(/-/g, ' '),
    lat: (lat.slice(-1) === ',' ? lat.slice(0, -1) : lat),
    lng: lng,
  };
}

/*
 * Shared error handling for gym table mutations.
 */
function log_gym_table_error(
  msg: Discord.Message,
  result: mysql.QueryResult<mysql.UpdateResult>,
): Promise<any> {
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.affectedRows === 0) {
    return log_invalid(msg, 'Unknown failure.');
  }
  return react_success(msg);
}

async function handle_add_gym(
  msg: Discord.Message,
  ...params: [string, string, string, string, string]
): Promise<any> {
  const assignment = fixup_gym_params(...params);

  const result = await moltresdb.query<mysql.UpdateResult>(
    'INSERT INTO gyms SET ?',
    assignment
  );
  return log_gym_table_error(msg, result);
}

async function handle_edit_gym(
  msg: Discord.Message,
  handle: string,
  ...params: [string, string, string, string]
): Promise<any> {
  const assignment = fixup_gym_params(handle, ...params);
  delete assignment.handle;

  const result = await moltresdb.query<mysql.UpdateResult>(
    'UPDATE gyms SET ? WHERE handle = ?',
    [assignment, handle.toLowerCase()]
  );
  return log_gym_table_error(msg, result);
}

async function handle_mv_gym(
  msg: Discord.Message,
  old_handle: string,
  new_handle: string,
): Promise<any> {
  old_handle = old_handle.toLowerCase();
  new_handle = new_handle.toLowerCase();

  const result = await moltresdb.query<mysql.UpdateResult>(
    'UPDATE gyms SET handle = ? WHERE handle = ?',
    [new_handle, old_handle]
  );
  return log_gym_table_error(msg, result);
}

async function handle_ls_regions(msg: Discord.Message): Promise<any> {
  const result = await moltresdb.query<Pick<Gym, 'region'>>(
    'SELECT region FROM gyms GROUP BY region'
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);
  const rows = result.ok;

  if (rows.length === 0) {
    return send_quiet(msg.channel, 'No gyms have been registered.');
  }
  const regions = new Set(rows.map(gym => gym.region));

  const region_strs = Object.keys(config.metaregions).map(meta => {
    regions.delete(meta);
    const subregions = config.metaregions[meta];
    for (const sr of subregions) regions.delete(sr);
    return `**${meta}** (_${subregions.join(', ')}_)`
  }).concat(
    [...regions].map(r => `**${r}**`)
  ).sort();

  const output = 'List of **regions** with **registered gyms**:\n\n' +
                 region_strs.join('\n');
  return send_quiet(msg.channel, output);
}

///////////////////////////////////////////////////////////////////////////////
// Raid handlers.

/*
 * Whether call times should be displayed in response to `msg'.
 */
function should_display_calls(msg: Discord.Message): boolean {
  return !config.call_check || config.call_check(msg, guild());
}

/*
 * Canonicalize a tier for display.
 */
function fmt_tier(tier: number): string {
  return tier === 6 ? 'Mega' : `T${tier}`;
}

/*
 * Canonicalize a raid boss name.
 */
function fmt_boss(boss: string): string {
  return boss.split('-').map(capitalize).join(' ');
}

/*
 * Canonical string for displaying a raid boss from a raids table row.
 */
function fmt_tier_boss(raid: Raid): string {
  const tier = raid.tier;
  const boss = raid.boss ?? raid_data.boss_defaults[tier] ?? null;

  return `${fmt_tier(tier)} ${boss ? fmt_boss(boss) : 'unknown'}`;
}

/*
 * Broadcast `content' to all the channels for `raid' at `gym`.
 */
function broadcast_for_raid(
  gym: Gym,
  raid: Raid | null,
  content: string,
  alt_content: string = content,
): Promise<Discord.Message[]> {
  const channels = channels_for_region[gym.region];

  const boss = raid.boss ?? raid_data.boss_defaults[raid.tier];
  const boss_channels = channels_for_boss[boss];

  if (!channels && !boss_channels) return;

  const region_sends = (channels ?? []).map(async (chan_id) => {
    const chan = await moltres.channels.fetch(chan_id);
    return send_quiet(chan as Discord.TextChannel, content);
  });

  const boss_sends = (boss_channels ?? []).map(async (chan_id) => {
    const chan = await moltres.channels.fetch(chan_id);
    return send_quiet(chan as Discord.TextChannel, alt_content);
  });

  return Promise.all(region_sends.concat(boss_sends));
}

/*
 * Get a canonical notification string for a report for `raid'.
 */
function raid_report_notif(raid: Gym & Raid): string {
  const now = get_now();
  const hatch = hatch_from_despawn(raid.despawn);

  if (now < hatch) {
    return `${get_emoji('raidegg')} **${fmt_tier(raid.tier)} egg** ` +
           `hatches at ${gym_name(raid)} at ${time_str(hatch, raid.region)}`;
  }
  return `${get_emoji('boss')} **${fmt_tier_boss(raid)} raid** despawns ` +
         `at ${gym_name(raid)} at ${time_str(raid.despawn, raid.region)}`;
}

/*
 * Fetch and send a raid report notification for `msg' at `handle'.
 */
async function send_raid_report_notif(
  msg: Discord.Message,
  handle: string,
  verbed: string,
  mods: Mod,
): Promise<any> {
  const result = await moltresdb.query<Gym & Raid>(
    'SELECT * FROM gyms ' +
    '   INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle)
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);
  const rows = result.ok;

  const found_one = await check_one_gym(msg, handle, rows);
  if (!found_one) return;
  const [raid] = rows;

  const is_m = await is_member(guild(), msg.author);

  const output =
    raid_report_notif(raid) + ` (${verbed} ` +
    (!!(mods & Mod.ANON)
      ? 'anonymously'
      : `by ${is_m ? msg.author : msg.author.tag}`
    ) + ').';

  await broadcast_for_raid(raid, raid, output);

  return from_dm(msg)
    ? dm_quiet(msg.author, output)
    : !(mods & Mod.PRESERVE)
      ? try_delete(msg, 10000)
      : null;
}

async function handle_raid(
  msg: Discord.Message,
  handle: string,
): Promise<any> {
  const now = get_now();

  const result = await select_rsvps(handle);
  if (isErr(result)) return log_mysql_error(msg, result.err);
  const rows = result.ok;

  if (rows.length < 1) {
    await chain_reaccs(msg, 'no_entry_sign', 'raidegg');
    return send_quiet(msg.channel,
      `No unique raid found for \`[${handle}]\`.`
    );
  }
  const [{gyms, raids, calls}] = rows;

  if (raids.despawn < now) {
    return chain_reaccs(msg, 'no_entry_sign', 'raidegg');
  }

  const hatch = hatch_from_despawn(raids.despawn);

  let output = gym_row_to_string(gyms) + '\n';
  if (now >= hatch) {
    output +=`
raid: **${fmt_tier_boss(raids)}**
despawn: ${time_str(raids.despawn, gyms.region)}`;
  } else {
    output +=`
raid egg: **${fmt_tier(raids.tier)}**
hatch: ${time_str(hatch, gyms.region)}`;
  }

  if (raids.team) {
    output += `\nlast known team: ${get_emoji(raids.team)}`;
  }

  if (calls.time !== null && should_display_calls(msg)) {
    output += '\n\ncall time(s):';

    const times: number[] = [];
    const rows_by_time: Record<number, FullJoinTableRow[]> = {};

    // Order and de-dup the call times and bucket rows by those times.
    for (const row of rows) {
      const t = row.calls.time.getTime();

      if (!(t in rows_by_time)) {
        times.push(t);
        rows_by_time[t] = [];
      }
      rows_by_time[t].push(row);
    }
    times.sort();

    // Append details for each call time.
    for (const t of times) {
      const [{calls}] = rows_by_time[t];

      let caller_rsvp: Join;
      let total = 0;

      // Get an array of attendee strings, removing the raid time caller.
      let attendees = await Promise.all(rows_by_time[t].map(
        async (row: FullJoinTableRow): Promise<string | null> => {
          const member = await guild().members.fetch(row.rsvps.user_id);
          if (!member) return null;

          total += (row.rsvps.extras + 1);

          if (member.user.id === calls.caller) {
            caller_rsvp = row.rsvps;
            return null;
          }

          const extras = row.rsvps.extras !== 0
            ? ` +${row.rsvps.extras}`
            : '';
          return `${member.nickname ?? member.user.username}${extras}`
        }
      ));
      attendees = attendees.filter(a => a !== null);

      let caller_str = '';

      if (caller_rsvp) {
        const caller = await guild().members.fetch(calls.caller);
        caller_str =
          `${caller.nickname ?? caller.user.username} _(caller)_` +
          (caller_rsvp.extras !== 0 ? ` +${caller_rsvp.extras}` : '') +
          (attendees.length !== 0 ? ', ' : '');
      }
      output += `\n- **${time_str(calls.time, gyms.region)}** ` +
                `(${total} raiders)—${caller_str}${attendees.join(', ')}`;
    }
  }

  return send_quiet(msg.channel, output);
}

async function handle_ls_raids(
  msg: Discord.Message,
  tier: number,
  region: string | null,
): Promise<any> {
  const now = get_now();

  let region_clause = {meta: config.area, sql: 'TRUE'};
  let is_meta = true;

  if (region !== null) {
    region_clause = where_region(region);
    is_meta = region_clause.meta !== null;
  }

  const result = await moltresdb.query<CallJoinTableRow>({
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
  if (isErr(result)) return log_mysql_error(msg, result.err);
  const rows = result.ok;

  if (rows.length === 0) {
    return chain_reaccs(msg, 'no_entry_sign', 'raidegg');
  }

  const out_region = is_meta ? region_clause.meta : rows[0].gyms.region;
  const rows_by_raid: Record<string, CallJoinTableRow[]> = {};

  for (const row of rows) {
    if (!is_meta && row.gyms.region !== out_region) {
      return log_invalid(msg, `Ambiguous region name \`${region}\`.`);
    }
    if (tier && row.raids.tier !== tier) continue;

    const handle = row.gyms.handle;
    rows_by_raid[handle] = rows_by_raid[handle] ?? [];
    rows_by_raid[handle].push(row);
  }

  const raids_expr = tier ? `**${fmt_tier(tier)} raids**` : 'raids';
  let output = `Active ${raids_expr} in **${out_region}**:\n`;

  for (const handle in rows_by_raid) {
    const [{gyms, raids, calls}] = rows_by_raid[handle];

    const hatch = hatch_from_despawn(raids.despawn);
    const boss = hatch > now
      ? `${fmt_tier(raids.tier)} egg`
      : fmt_tier_boss(raids);
    const timer_str = hatch > now
      ? `hatches at ${time_str(hatch, gyms.region)}`
      : `despawns at ${time_str(raids.despawn, gyms.region)}`

    output += `\n\`[${handle}]\` **${boss}** ${timer_str}`;
    if (is_meta) {
      output += ` — _${gyms.region}_`;
    }

    if (calls.time !== null && should_display_calls(msg)) {
      const times = rows_by_raid[handle]
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

async function handle_report(
  msg: Discord.Message,
  handle: string,
  tier: number | InvalidArg,
  boss_: BossResult | null,
  timer: Timer | InvalidArg,
  mods: Mod,
): Promise<any> {
  if (tier instanceof InvalidArg) {
    return log_invalid(msg, `Invalid raid tier \`${tier.arg}\`.`);
  }
  if (timer instanceof InvalidArg) {
    return log_invalid(msg, `Invalid [HH:]MM:SS timer \`${timer.arg}\`.`);
  }

  const boss = await extract_boss(msg, boss_);

  const egg_adjust = boss === null ? boss_duration : 0;

  const now = get_now();
  const despawn = now;
  despawn.setMinutes(despawn.getMinutes() + timer.mins + egg_adjust);
  despawn.setSeconds(despawn.getSeconds() + timer.secs);

  const hatch = hatch_from_despawn(despawn);
  hatch.setMinutes(hatch.getMinutes() + 1);

  const result = await moltresdb.query<mysql.UpdateResult>(
    'REPLACE INTO raids (gym_id, tier, boss, despawn, spotter) ' +
    '   SELECT gyms.id, ?, ?, ?, ? FROM gyms ' +
    '   WHERE ' + where_one_gym(handle) +
    ((mods & Mod.FORCE) ? '' :
      ' AND ' +
      '   NOT EXISTS ( ' +
      '     SELECT * FROM raids ' +
      '       WHERE gym_id = gyms.id ' +
      '       AND (despawn > ? OR despawn > ?) ' +
      '   ) '
    ),
    [tier, boss, despawn, msg.author.id, hatch, now]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.affectedRows === 0) {
    const {call_rows, gym} = await query_for_error(msg, handle);
    if (!gym) return;

    return log_invalid(msg,
      `Raid already reported for ${gym_name(gym)}.`
    );
  }
  return send_raid_report_notif(msg, handle, 'reported', mods);
}

async function handle_egg(
  msg: Discord.Message,
  handle: string,
  tier: number | InvalidArg,
  timer: Timer | InvalidArg,
  call_time: TimeSpec | InvalidArg | null,
  mods: Mod,
): Promise<any> {
  if (call_time === null) {
    return handle_report(msg, handle, tier, null, timer, mods);
  }
  await handle_report(msg, handle, tier, null, timer, mods | Mod.PRESERVE);
  return handle_call(msg, handle, call_time, null);
}

async function handle_boss(
  msg: Discord.Message,
  handle: string,
  boss: BossResult | InvalidArg,
  timer: Timer | InvalidArg,
  call_time: TimeSpec | InvalidArg | null,
  mods: Mod,
): Promise<any> {
  if (boss instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized raid boss \`${boss.arg}\`.`);
  }
  const tier = raid_data.raid_tiers[boss.boss];

  if (call_time === null) {
    return handle_report(msg, handle, tier, boss, timer, mods);
  }
  await handle_report(msg, handle, tier, boss, timer, mods | Mod.PRESERVE);
  return handle_call(msg, handle, call_time, null);
}

async function handle_update(
  msg: Discord.Message,
  handle: string,
  data: string,
  mods: Mod,
): Promise<any> {
  const data_lower = data.toLowerCase();

  const now = get_now();

  const assignment = await (async () => {
    if (data_lower === 'valor' ||
        data_lower === 'mystic' ||
        data_lower === 'instinct') {
      return { team: data_lower };
    }

    const tier = parse_tier(data);
    if (tier !== null) {
      return { tier: tier };
    }

    const boss = await extract_boss(msg, parse_boss(data_lower));
    if (boss !== null) {
      return {
        tier: raid_data.raid_tiers[boss],
        boss: boss,
      };
    }
    return null;
  })();

  if (assignment === null) {
    return log_invalid(msg, `Invalid update parameter \`${data}\`.`);
  }

  const result = await moltresdb.query<mysql.UpdateResult>(
    'UPDATE raids INNER JOIN gyms ON raids.gym_id = gyms.id ' +
    '   SET ? ' +
    '   WHERE ' + where_one_gym(handle) +
    '     AND raids.despawn > ? ',
    [assignment, now]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.affectedRows === 0) {
    const {call_rows, gym} = await query_for_error(msg, handle);
    if (!gym) return;

    const [{raids}] = call_rows;
    if (raids.gym_id === null) {
      return log_invalid(msg,
        `No raid has been reported at ${gym_name(gym)}.`
      );
    }
    return log_invalid(msg, 'An unknown error occurred.');
  }

  if (result.ok.changedRows === 0) {
    return send_quiet(msg.channel, 'Your update made no changes.');
  }
  if ('tier' in assignment) {
    return send_raid_report_notif(msg, handle, 'updated', mods);
  }
  return react_success(msg);
}

async function handle_scrub(
  msg: Discord.Message,
  handle: string,
): Promise<any> {
  const result = await moltresdb.query<Gym & Raid>(
    'SELECT * FROM ' +
    '   gyms INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle)
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);
  const rows = result.ok;

  const found_one = await check_one_gym(msg, handle, rows);
  if (!found_one) return;
  const [raid] = rows;

  if (raid.spotter !== msg.author.id &&
      !config.admin_ids.has(msg.author.id)) {
    return log_invalid(msg, 'Raids can only be scrubbed by their reporter.');
  }

  const del_res = await moltresdb.query<mysql.UpdateResult>(
    'DELETE FROM raids WHERE gym_id = ?',
    [raid.gym_id]
  );
  if (isErr(del_res)) return log_mysql_error(msg, del_res.err);

  const spotter = await guild().members.fetch(raid.spotter);
  const spotter_name = spotter ? spotter.toString() : '[unknown user]';

  return broadcast_for_raid(raid, raid,
    `${get_emoji('banned')} Raid reported by ${spotter_name} ` +
    `at ${gym_name(raid)} was scrubbed.`
  );
}

function handle_ls_bosses(msg: Discord.Message): Promise<any> {
  const outvec = [];

  for (let tier = 1; tier <= 6; ++tier) {
    if (!raid_data.bosses_for_tier[tier]) continue;

    const fmt_boss_with_default = function(boss: string): string {
      const formatted = fmt_boss(boss);
      return raid_data.boss_defaults[tier] === boss
        ? formatted + ' _(default)_'
        : formatted;
    };
    outvec.push(`**${fmt_tier(tier)}:**\t` +
      raid_data.bosses_for_tier[tier].map(fmt_boss_with_default).join(', ')
    );
  }
  return send_quiet(msg.channel, outvec.join('\n\n'));
}

///////////////////////////////////////////////////////////////////////////////
// Raid call handlers.

interface Raider {
  member: Discord.GuildMember;
  extras: number;
}

/*
 * Get all the users (and associated metadata) attending the raid at `handle'
 * at `time'.
 */
async function get_all_raiders(
  origin: ReqOrigin,
  handle: string,
  time: Date,
): Promise<[CallJoinTableRow | null, Raider[]]> {
  const result = await select_rsvps(handle, where_call_time(time));
  if (isErr(result)) {
    await log_mysql_error(origin, result.err);
    return [null, []];
  }
  const rows = result.ok;

  if (rows.length < 1) return [null, []];

  const raiders = await Promise.all(rows.map(async (row) => {
    const member = await guild().members.fetch(row.rsvps.user_id);
    return member ? { member, extras: row.rsvps.extras } : null;
  }));
  return [rows[0], raiders.filter(m => m !== null)];
}

/*
 * Return the number of raiders (including +1's) from a raiders array.
 */
function count_raiders(raiders: Raider[]): number {
  return raiders.reduce((sum, r) => sum + 1 + r.extras, 0);
}

type RaidKey = string;

function raid_cache_key(
  handle: string,
  time: Date,
): RaidKey {
  return handle + time.getTime();
}

/*
 * Cache for call messages.
 *
 * Maps call message ID to a {raid, call_time}.
 */
let call_cache: Record<
  Discord.Snowflake,
  {raid: Gym & Raid, call_time: Date}
> = {};
/*
 * Maps a raid key to a list of call messages.
 */
let call_cache_rev: Record<RaidKey, Discord.Message[]> = {};

/*
 * Cache for join messages.
 *
 * Maps a raid key to a {joins: [msgs], alarms: [msgs]}.
 */
interface JoinCacheEnt {
  joins: Discord.Message[];
  alarms: Discord.Message[];
}
let join_cache: Record<RaidKey, JoinCacheEnt> = {};

function join_cache_get(handle: string, time: Date): JoinCacheEnt {
  return join_cache[raid_cache_key(handle, time)];
}
function join_cache_set(handle: string, time: Date, val: JoinCacheEnt | null) {
  if (val) {
    join_cache[raid_cache_key(handle, time)] = val;
  } else {
    delete join_cache[raid_cache_key(handle, time)];
  }
}

/*
 * Set a delayed event for clearing the join cache for `handle' at `call_time'.
 */
function delay_join_cache_clear(handle: string, call_time: Date): void {
  const delay = Math.max(+call_time - +get_now(), 1);
  setTimeout(() => { join_cache_set(handle, call_time, null); }, delay);
}

/*
 * Make the raid alarm message.
 */
async function make_raid_alarm(
  origin: ReqOrigin,
  gym: Gym,
  call_time: Date,
): Promise<string | null> {
  if (!config.raid_alarm) return null;

  const [row, raiders] = await get_all_raiders(origin, gym.handle, call_time);

  // The call time might have changed, or everyone may have unjoined.
  if (row === null || raiders.length === 0) return null;

  const output =
    `${gyaoo} ${get_emoji('alarm_clock')} ` +
    `Raid call for ${gym_name(gym)} at ` +
    `\`${time_str(call_time, gym.region)}\` is in ` +
    `${config.raid_alarm} minutes!` +
    `\n\n${raiders.map(r => r.member.user).join(' ')} ` +
    `(${count_raiders(raiders)} raiders)`;

  return output;
}

/*
 * Set a timeout to ping raiders for `raid' at `gym` before `call_time'.
 */
function set_raid_alarm(
  msg: Discord.Message,
  gym: Gym,
  raid: Raid,
  call_time: Date,
): Promise<any> {
  // This doesn't really belong here, but we set alarms every time we modify a
  // call time, which is exactly when we want to make this guarantee.
  delay_join_cache_clear(gym.handle, call_time);

  const alarm_time = new Date(call_time.getTime());
  alarm_time.setMinutes(alarm_time.getMinutes() - config.raid_alarm);

  const delay = +alarm_time - +get_now();
  if (delay <= 0) return;

  setTimeout(async function() {
    const output = await make_raid_alarm(msg, gym, call_time);
    const alarm_msgs = await broadcast_for_raid(gym, raid, output);

    // The join cache might not have been populated if nobody else joined...
    const j_ent = join_cache_get(gym.handle, call_time);
    if (!j_ent) return;

    join_cache_set(gym.handle, call_time, {
      joins: j_ent.joins,
      alarms: alarm_msgs,
    });
  }, delay);

  return log_impl(
    `Setting alarm for \`[${gym.handle}]\` at ` +
    `\`${time_str(alarm_time, gym.region)}\` (server time).`
  );
}

/*
 * Format a join instruction string.
 */
function make_join_instrs(
  gym: Gym,
  raid: Raid,
  call_time: Date | null,
): string {
  const time_snippet = (() => {
    if (!call_time) return '';

    const hatch = hatch_from_despawn(raid.despawn);
    return call_time.getTime() === hatch.getTime()
      ? ' hatch'
      : ' ' + time_str_short(call_time, gym.region);
  })();

  return `\n\nTo join this raid time, enter ` +
         `\`$join ${gym.handle}${time_snippet}\` ` +
         `or react with ${get_emoji('join')} to the call message.`;
}

async function handle_call(
  msg: Discord.Message,
  handle: string,
  call_time_: TimeSpec | InvalidArg,
  extras: number | InvalidArg | null,
): Promise<any> {
  if (call_time_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time_.arg}\`.`);
  }
  const call_time = await interpret_time(call_time_, handle);

  if (extras instanceof InvalidArg) {
    return log_invalid(msg, `Invalid +1 count \`${extras.arg}\`.`);
  }
  extras = extras ?? 0;

  const now = get_now();

  // This is a janky way to allow for raids at exactly hatch.  The main
  // shortcoming is that if a raid's despawn is at an exact minute, this will
  // let users call a raid time a minute before hatch.
  //
  // In practice, this is extremely unlikely, and to avoid this situation for
  // manual hatch/despawn time changes, we add a dummy second to all explicit
  // user-declared raid despawn times.
  const later = new Date(call_time.getTime());
  later.setMinutes(later.getMinutes() + boss_duration + 1);

  let result = await moltresdb.query<mysql.UpdateResult>(
    'INSERT INTO calls (raid_id, caller, time) ' +
    '   SELECT raids.gym_id, ?, ? FROM gyms INNER JOIN raids ' +
    '     ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle) +
    '     AND ? > ? ' +
    '     AND raids.despawn > ? ' +
    '     AND raids.despawn <= ? ',
    [msg.author.id, call_time, call_time, now, call_time, later]
  );
  if (isErr(result)) {
    if (result.err.code === 'ER_DUP_ENTRY') {
      const {gym} = await query_for_error(msg, handle);
      if (!gym) return; // should never happen

      return log_invalid(msg,
        `A raid has already been called for \`[${handle}]\` ` +
        `at \`${time_str(call_time, gym.region)}\`.`
      );
    }
    return log_mysql_error(msg, result.err);
  }

  if (result.ok.affectedRows === 0) {
    const {call_rows, gym} = await query_for_error(msg, handle);
    if (!gym) return;

    if (call_time <= now) {
      return log_invalid(msg,
        `Cannot call a time in the past ` +
        `\`${time_str_short(call_time, gym.region)}\`.`
      );
    }

    const [{raids}] = call_rows;
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

  const call_id = result.ok.insertId;

  result = await moltresdb.query<mysql.UpdateResult>(
    'INSERT INTO rsvps SET ?',
    { call_id: call_id,
      user_id: msg.author.id,
      extras: extras,
      maybe: false }
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  // Grab the raid information just for reply purposes.
  const reply_res = await moltresdb.query<Gym & Raid>(
    'SELECT * FROM gyms INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle)
  );
  if (isErr(reply_res)) return log_mysql_error(msg, reply_res.err);
  const rows = reply_res.ok;

  const found_one = await check_one_gym(msg, handle, rows);
  if (!found_one) return;
  const [raid] = rows;

  const region_role = await function() {
    const role_id = config.regions[raid.region];
    return role_id ? msg.guild.roles.fetch(role_id) : null;
  }();

  const prefix = get_emoji('clock230');
  const suffix =
    `at ${gym_name(raid)} ` +
    `called for ${time_str(call_time, raid.region)} ` +
    `by ${msg.author}.  ${gyaoo}` +
    make_join_instrs(raid, raid, call_time);

  const content_with_mentions = async (
    mention_region: boolean,
    mention_boss: boolean
  ) => {
    const region_str = region_role
      ? mention_region
        ? region_role.toString()
        : region_role.name
      : raid.region;

    const boss = raid.boss ?? raid_data.boss_defaults[raid.tier] ?? null;
    const boss_str = await async function() {
      if (boss === null) return 'unknown';
      if (!mention_boss) return fmt_boss(boss);

      const role_id = raid_data.boss_roles[boss];
      const role = role_id ? await msg.guild.roles.fetch(role_id) : null;

      return role?.toString() ?? fmt_boss(boss);
    }();

    const raid_str = `**${fmt_tier(raid.tier)} ${boss_str}** raid`;

    return `${prefix} ${region_str} ${raid_str} ${suffix}`;
  };

  const broadcast_call = async function() {
    const call_msgs = await broadcast_for_raid(
      raid, raid,
      await content_with_mentions(!raid.silent, false),
      await content_with_mentions(false, true),
    );
    await Promise.all(call_msgs.map(m => m.react(get_emoji('join', true))));

    const call_ids = call_msgs.map(m => m.id);
    for (const id of call_ids) call_cache[id] = {raid, call_time};

    const key = raid_cache_key(raid.handle, call_time);
    call_cache_rev[key] = call_msgs;

    setTimeout(
      () => {
        for (const id of call_ids) delete call_cache[id];
        delete call_cache_rev[key];
      },
      +raid.despawn - +now
    );
  };

  return Promise.all([
    broadcast_call(),
    set_raid_alarm(msg, raid, raid, call_time),
  ]);
}

async function handle_cancel(
  msg: Discord.Message,
  handle: string,
  call_time_: TimeSpec | InvalidArg | null,
): Promise<any> {
  if (call_time_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time_.arg}\`.`);
  }
  const call_time = await interpret_time(call_time_, handle);

  const fail = async function(msg: Discord.Message) {
    const {call_row, gym} =
      await query_for_error_call(msg, handle, call_time, 'cancel');
    if (!call_row) return;

    if (call_row.calls.caller !== msg.author.id) {
      return log_invalid(msg, 'Raids can only be cancelled by their caller.');
    }
    return log_invalid(msg, 'An unknown error occurred.');
  };

  const [row, raiders] = await get_all_raiders(msg, handle, call_time);
  if (row === null) return fail(msg);

  const {gyms, raids, calls} = row;

  const result = await moltresdb.query<mysql.UpdateResult>(
    'DELETE calls FROM calls ' +
    '   INNER JOIN raids ON calls.raid_id = raids.gym_id ' +
    '   INNER JOIN gyms ON raids.gym_id = gyms.id ' +
    'WHERE ' + where_one_gym(handle) +
    '  AND ' + where_call_time(call_time, true) +
    '  AND calls.caller = ? ',
    [msg.author.id]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.affectedRows === 0) return fail(msg);

  const users = raiders
    .map(r => r.member.user)
    .filter(user => user.id !== msg.author.id);

  let output = get_emoji('no_entry_sign') + ' ' +
    `Raid at ${time_str(calls.time, gyms.region)} for ${gym_name(gyms)} ` +
    `was cancelled by ${msg.author}.  ${gyaoo}`;

  if (users.length !== 0) {
    output += `\n\nPaging other raiders: ${users.join(' ')}.`;
  }
  return broadcast_for_raid(gyms, raids, output);
}

async function handle_change(
  msg: Discord.Message,
  handle: string,
  current_: TimeSpec | InvalidArg,
  to: string,
  desired_: TimeSpec | InvalidArg,
): Promise<any> {
  if (current_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${current_.arg}\`.`);
  }
  if (desired_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${desired_.arg}\`.`);
  }
  if (to !== 'to') {
    return log_invalid(msg, usage_string('change'));
  }
  const current = await interpret_time(current_, handle);
  const desired = await interpret_time(desired_, handle);

  // See comment in handle_call().
  const later = new Date(desired.getTime());
  later.setMinutes(later.getMinutes() + boss_duration + 1);

  const assignment = {
    caller: msg.author.id,
    time: desired,
  };

  const result = await moltresdb.query<mysql.UpdateResult>(
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
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.affectedRows === 0) {
    const {call_row, gym} =
      await query_for_error_call(msg, handle, current, 'change');
    if (!call_row) return;

    const {raids} = call_row;

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

  const [row, raiders] = await get_all_raiders(msg, handle, desired);

  // No raiders is weird, but it could happen if everyone unjoins and
  // someone decides to change the raid time for no meaningful reason.
  if (row === null || raiders.length === 0) return;
  const {gyms} = row;
  handle = gyms.handle;

  // Rewrite the join and call message cache entries.
  join_cache_set(handle, desired, join_cache_get(handle, current));
  join_cache_set(handle, current, null);

  const old_key = raid_cache_key(handle, current);
  const new_key = raid_cache_key(handle, desired);
  call_cache_rev[new_key] = call_cache_rev[old_key];
  delete call_cache_rev[old_key];

  for (const call_msg of call_cache_rev[new_key]) {
    call_cache[call_msg.id].call_time = desired;
  }

  const users = raiders
    .map(r => r.member.user)
    .filter(user => user.id !== msg.author.id);

  let output =
    `Raid time changed for ${gym_name(gyms)} ` +
    `from ${time_str(current, gyms.region)} ` +
    `to ${time_str(desired, gyms.region)} ` +
    `by ${msg.author}.  ${gyaoo}`;

  if (users.length !== 0) {
    output += `\n\nPaging other raiders: ${users.join(' ')}.`;
  }
  return Promise.all([
    broadcast_for_raid(gyms, row.raids, output),
    set_raid_alarm(msg, gyms, row.raids, desired),
  ]);
}

async function handle_join(
  msg: ReqOrigin,
  handle: string,
  call_time: TimeSpec | Date | InvalidArg | null,
  extras: number | InvalidArg | null,
): Promise<any> {
  if (call_time instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time.arg}\`.`);
  }
  if (!(call_time instanceof Date)) {
    call_time = await interpret_time(call_time, handle);
  }

  if (extras instanceof InvalidArg) {
    return log_invalid(msg, `Invalid +1 count \`${extras.arg}\`.`);
  }
  extras = extras ?? 0;

  const result = await moltresdb.query<mysql.UpdateResult>(
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
  if (isErr(result)) {
    if (result.err.code === 'ER_DUP_ENTRY') {
      const {gym} = await query_for_error(msg, handle);
      if (!gym) return; // should never happen

      return log_invalid(msg,
        `You have already joined the raid call for \`[${handle}]\`` +
        (!!call_time
          ? ` at ${time_str(call_time, gym.region)}.`
          : '.')
      );
    }
    return log_mysql_error(msg, result.err);
  }

  if (result.ok.affectedRows === 0) {
    const {call_row} =
      await query_for_error_call(msg, handle, call_time, 'join');
    if (!call_row) return;

    return log_invalid(msg, 'An unknown error occurred.');
  }

  let [row, raiders] = await get_all_raiders(msg, handle, call_time);

  // The call time might have changed, or everyone may have unjoined.
  if (row === null || raiders.length === 0) return;

  const {gyms, raids, calls} = row;
  handle = gyms.handle;

  raiders = raiders.filter(r => r.member.id !== msg.author.id);

  const joining = extras > 0 ? `joining with +${extras}` : 'joining';

  let output = get_emoji('team') + '  ' +
    `${msg.author} is ${joining} at ${time_str(calls.time, gyms.region)} ` +
    `for the **${fmt_tier_boss(raids)}** raid at ${gym_name(gyms)}`;

  if (raiders.length !== 0) {
    const names = raiders.map(
      r => r.member.nickname ?? r.member.user.username
    );
    const num_raiders = count_raiders(raiders);
    const others = num_raiders === 1 ? 'other' : 'others';
    output += ` (with ${num_raiders} ${others}: ${names.join(', ')}).`;
  } else {
    output += '.';
  }

  output += make_join_instrs(gyms, raids, !!call_time ? calls.time : null);

  const join_msgs = await (() => {
    const call_msgs = call_cache_rev[raid_cache_key(gyms.handle, calls.time)];
    if (call_msgs) {
      return Promise.all(call_msgs.map(
        target => send_quiet(target.channel, output, target)
      ));
    }
    return broadcast_for_raid(gyms, raids, output);
  })();

  // Clear any existing join message for this raid.
  const replace_prev_msg = async function() {
    const prev = join_cache_get(handle, calls.time);
    join_cache_set(handle, calls.time, {
      joins: join_msgs,
      alarms: prev ? prev.alarms : [],
    });
    if (prev) {
      const dels = prev.joins.map(join => try_delete(join));
      if (prev.alarms.length === 0) return dels;

      // If it's past the alarm time, we want to edit the alarm messages...
      const content = await make_raid_alarm(msg, gyms, calls.time);
      const edits = prev.alarms.map(alarm => alarm.edit(content));

      // ...and DM the raid caller.
      const caller = await moltres.users.fetch(calls.caller);
      const dms: Promise<any>[] = [dm_quiet(caller,
        `${get_emoji('rollsafe')} ${msg.author.tag} has joined the raid late ` +
        `at ${gym_name(gyms)} at ${time_str(calls.time, gyms.region)}.`
      )];

      return Promise.all(dms.concat(dels).concat(edits));
    }
  };

  // Delete the $join request, delete any previous join message, and
  // cache this one for potential later deletion.
  return Promise.all([
    replace_prev_msg(),
    () => { if (msg instanceof Discord.Message) try_delete(msg, 3000); },
  ]);
}

async function handle_unjoin(
  msg: Discord.Message,
  handle: string,
  call_time_: TimeSpec | InvalidArg | null,
): Promise<any> {
  if (call_time_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time_.arg}\`.`);
  }
  const call_time = await interpret_time(call_time_, handle);

  const result = await moltresdb.query<mysql.UpdateResult>(
    'DELETE rsvps FROM ' + full_join_table +
    '   WHERE ' + where_one_gym(handle) +
    '     AND ' + where_call_time(call_time) +
    '     AND rsvps.user_id = ? ',
    [msg.author.id]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.affectedRows === 0) {
    const {call_row, gym} =
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

async function handle_ping(
  msg: Discord.Message,
  handle: string,
  call_time_: TimeSpec | InvalidArg | null,
): Promise<any> {
  if (call_time_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${call_time_.arg}\`.`);
  }
  const call_time = await interpret_time(call_time_, handle);

  const [row, raiders] = await get_all_raiders(msg, handle, call_time);
  if (row === null) {
    return query_for_error_call(msg, handle, call_time, 'ping');
  }
  const {gyms, raids, calls} = row;

  const tags = raiders
    .filter(r => r.member.user.id !== msg.author.id)
    .map(r => r.member.user.toString())
    .join(' ');

  const content = get_emoji('point_up') +
    ` Ping from ${msg.author} about the ${gym_name(gyms)} raid` +
    ` at ${time_str(calls.time, gyms.region)}: ${tags}`;

  return Promise.all([
    send_quiet(msg.channel, content),
    try_delete(msg),
  ]);
}

///////////////////////////////////////////////////////////////////////////////
// EX raid handlers.

const ex_room_regex = /^.*-\w+-\d\d/;
const ex_room_capture = /^(.*)-(\w+)-(\d\d)/;

const ex_topic_capture =
  /^(EX raid coordination for .* on [A-Z][a-z]+ \d+)(.*)\./;

interface EXDate {
  month: string;
  day: number;
}
type EXInfo = { handle: string; } & EXDate

/*
 * Build a canonical EX raid room name using a gym `handle' and raid `date'.
 */
function ex_room_name(handle: string, date: Date): string {
  return (handle + '-' + date_str(date)).toLowerCase().replace(/\W/g, '-');
}

/*
 * Extract the gym handle, month, and day from an EX raid room name.
 */
function ex_room_components(room_name: string): EXInfo {
  const [, handle, month, day] = room_name.match(ex_room_capture);
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
function ex_format_date(date: Date): EXDate {
  const str = date_str(date);
  return {
    month: str.slice(0, str.indexOf(' ')),
    day: date.getDate(),
  };
}

/*
 * Whether the date for the EX raid `room_name' matches `ex_date', a date
 * formatted by ex_format_date().
 */
function ex_room_matches_date(room_name: string, ex_date: EXDate): boolean {
  const info = ex_room_components(room_name);
  return ex_date.month === info.month && ex_date.day === info.day;
}

/*
 * Create a channel `room_name' for an EX raid at `gym' on `date'.
 */
async function create_ex_room(
  room_name: string,
  gym: Gym,
  date: Date,
): Promise<Discord.TextChannel> {
  const permissions = config.ex.permissions
    .concat([
      { // Make sure Moltres can modify the channel.
        id: moltres.user.id,
        allow: [
          Discord.Permissions.FLAGS.VIEW_CHANNEL,
          Discord.Permissions.FLAGS.MANAGE_CHANNELS,
          Discord.Permissions.FLAGS.MANAGE_ROLES,
          Discord.Permissions.FLAGS.MANAGE_MESSAGES,
        ],
      },
      { // Hide the channel from members who haven't entered this EX room.
        id: guild().id,
        deny: [Discord.Permissions.FLAGS.VIEW_CHANNEL],
      },
    ]);

  let room = await guild().channels.create(room_name, {
    type: 'GUILD_TEXT',
    permissionOverwrites: permissions,
  });
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
async function enter_ex_room(
  uid: Discord.Snowflake,
  room: Discord.TextChannel,
): Promise<any> {
  room = await room.permissionOverwrites.edit(
    uid, {VIEW_CHANNEL: true}
  ) as Discord.TextChannel;

  const user = await moltres.users.fetch(uid);
  return send_quiet(room, `Welcome ${user} to the room!`);
}
function exit_ex_room(
  uid: Discord.Snowflake,
  room: Discord.TextChannel,
): Promise<any> {
  return room.permissionOverwrites.delete(uid);
}

/*
 * Return whether `channel' is an EX raid room.
 */
function is_ex_room(
  channel_: Discord.Channel | Discord.TextBasedChannels
): boolean {
  if (channel_.type !== 'GUILD_TEXT') return false;
  const channel = channel_ as Discord.GuildChannel;

  if ('category' in config.ex) {
    return channel.parentId === config.ex.category;
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
function ex_raiders(room: Discord.TextChannel): Promise<Discord.User[]> {
  const uids = new Set([...room.permissionOverwrites.cache.keys()]);

  for (const overwrite of config.ex.permissions) {
    uids.delete(overwrite.id);
  }
  uids.delete(guild().id);
  uids.delete(moltres.user.id);

  return Promise.all([...uids]
    .filter(id => !guild().roles.cache.get(id))
    .map(id => moltres.users.cache.get(id))
  );
}

/*
 * Cache for pending EX raid rooms.
 */
interface EXPending {
  id: Discord.Snowflake;
  mention: string;
}
let ex_cache: Record<string, Set<EXPending>> = {};

function ex_cache_found(room_name: string): boolean {
  return room_name in ex_cache;
}
function ex_cache_insert(room_name: string, user: Discord.User): void {
  ex_cache[room_name] = ex_cache[room_name] ?? new Set();
  ex_cache[room_name].add({
    id: user.id,
    mention: user.toString(),
  });
}
function ex_cache_take(room_name: string): EXPending[] {
  const users = ex_cache[room_name];
  delete ex_cache[room_name];
  return [...users];
}

async function handle_ex(
  msg: Discord.Message,
  handle: string,
  date: Date | InvalidArg | null,
): Promise<any> {
  if (date instanceof InvalidArg) {
    return log_invalid(msg, `Invalid MM/DD date \`${date.arg}\`.`);
  }

  const result = await moltresdb.query<Gym>(
    'SELECT * FROM gyms WHERE ' + where_one_gym(handle)
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);
  const rows = result.ok;

  const found_one = await check_one_gym(msg, handle, rows);
  if (!found_one) return;
  const [gym] = rows;

  if (!gym.ex) {
    return log_invalid(msg, `${gym_name(gym)} is not an EX raid location.`);
  }

  const room_re = new RegExp(`^${gym.handle}-\\w+-\\d\\d$`);

  // We'd prefer to only search the channels in the category, but a bug in
  // the current version of discord.js prevents the list of children from
  // getting updated.
  //
  // let chan_list = 'category' in config.ex
  //   ? moltres.channels.fetch(config.ex.category).children
  //   : guild().channels;
  const chan_list = guild().channels.cache;

  let room =
    chan_list.find(c => !!c.name.match(room_re)) as Discord.TextChannel;

  if (room !== null) {
    if (date !== null) {
      // Check for a mismatched date.
      const room_name = ex_room_name(gym.handle, date);
      if (room.name !== room_name) {
        const ex = ex_room_components(room.name);
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
  const room_name = ex_room_name(gym.handle, date);

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

  const users = ex_cache_take(room_name);
  await Promise.all(users.map(({id}) => enter_ex_room(id, room)));

  const out = get_emoji('pushpin') +
    `  ${users[0].mention}, please post a screenshot of your EX raid pass ` +
    `and use \`$exact\` to set the raid time.  (Anyone can do this, but you ` +
    `created the room.)`;
  return send_quiet(room, out);
}

async function handle_explore(msg: Discord.Message): Promise<any> {
  const room_info = new Map(guild().channels.cache
    .filter((chan, ..._) => is_ex_room(chan))
    .map(room_ => {
      const room = room_ as Discord.TextChannel;
      const [, , time] = room.topic.match(ex_topic_capture);
      return Object.assign(ex_room_components(room.name), {time: time});
    })
    .map(info => [info.handle, info])
  );

  const result = await moltresdb.query<Gym>(
    'SELECT * FROM gyms WHERE handle IN (' +
        Array(room_info.size).fill('?').join(',') +
    ')',
    [...room_info.keys()]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  const month_str = ex_format_date(get_now()).month;

  const output = 'Active EX raid rooms:\n\n' + result.ok
    .sort((l_, r_) => {
      const l = room_info.get(l_.handle);
      const r = room_info.get(r_.handle);
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
      const r = room_info.get(gym.handle);
      const end = ' (EX!)'.length;
      return `${gym_name(gym).slice(0, -end)} (${r.month} ${r.day}${r.time})`;
    })
    .join('\n');

  return send_quiet(msg.channel, output);
}

async function handle_exit(msg: Discord.Message): Promise<any> {
  // If a user has a permission overwrite, they're in the room.
  const channel = msg.channel as Discord.TextChannel;
  const in_room = !!channel.permissionOverwrites.resolve(msg.author.id);

  if (!in_room) {
    return log_invalid(msg,
      `You have not entered the EX room #${channel.name}`
    );
  }

  if (config.ex.exit_strict &&
      ex_room_matches_date(channel.name, ex_format_date(get_now()))) {
    const out = get_emoji('upside_down') +
      `  ${gyaoo}  It's rude to exit an EX raid room the day of the raid,` +
      ` ${msg.author}!`;
    return send_quiet(channel, out);
  }

  await exit_ex_room(msg.author.id, channel);
  return chain_reaccs(msg, 'door', 'walking', 'dash');
}

async function handle_examine(msg: Discord.Message): Promise<any> {
  const channel = msg.channel as Discord.TextChannel;
  const ex = ex_room_components(channel.name);

  const users = await ex_raiders(channel);

  return send_quiet(channel, {
    embeds: [new Discord.MessageEmbed()
      .setTitle(
        `**List of EX raiders** for \`${ex.handle}\` on ${ex.month} ${ex.day}`
      )
      .setDescription(users.map(user => user.tag).join('\n'))
      .setColor('RED')
    ]
  });
}

async function handle_exact(
  msg: Discord.Message,
  time_: TimeSpec | InvalidArg,
): Promise<any> {
  const channel = msg.channel as Discord.TextChannel;

  if (time_ instanceof InvalidArg) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${time_.arg}\`.`);
  }
  if (time_ === 'hatch') {
    return log_invalid(msg, `Unrecognized HH:MM time \`hatch\`.`);
  }
  const time = await interpret_time(time_);

  const [, topic] = channel.topic.match(ex_topic_capture);

  const {handle} = ex_room_components(channel.name);
  const region = await select_region(handle);

  return Promise.all([
    channel.setTopic(`${topic} at ${time_str(time, region)}.`),
    react_success(msg),
  ]);
}

async function handle_exclaim(msg: Discord.Message): Promise<any> {
  const users = await ex_raiders(msg.channel as Discord.TextChannel);
  const tags = users.map(u => u.toString()).join(' ');
  const content = get_emoji('point_up') +
    ` ${msg.author} used \`$exclaim\`!  It's super effective: ${tags}`;

  return send_quiet(msg.channel, content);
}

function handle_expunge(
  msg: Discord.Message,
  date: Date | InvalidArg,
): Promise<any> {
  if (date instanceof InvalidArg) {
    return log_invalid(msg, `Invalid MM/DD date \`${date.arg}\`.`);
  }
  const expected = ex_format_date(date);

  const rooms = guild().channels.cache
    .filter((chan, ..._) => is_ex_room(chan))
    .filter(room => ex_room_matches_date(room.name, expected));

  return Promise.all(rooms.map(room => room.delete()));
}

async function handle_exalt(
  msg: Discord.Message,
  handle: string
): Promise<any> {
  const result = await moltresdb.query<mysql.UpdateResult>(
    'UPDATE gyms SET `ex` = 1 WHERE `handle` IN ( ' +
    '   SELECT `handle` FROM ( ' +
    '     SELECT `handle` FROM gyms WHERE ' + where_one_gym(handle) +
    '   ) AS gyms_ ' +
    ')'
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  if (result.ok.changedRows === 0) {
    return send_quiet(msg.channel, 'Gym already marked EX-eligible.');
  }
  return react_success(msg);
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Check whether `msg' is from a source with access to `request'.
 */
function has_access(msg: Discord.Message, request: Req): boolean {
  const access = reqs[request].access;

  if (from_dm(msg)) {
    return !!(access & Access.DM) || (
      !!(access & Access.ADMIN_DM) &&
      config.admin_ids.has(msg.author.id)
    );
  }
  if (msg.channel.id in config.channels ||
      msg.channel.id in config.boss_channels) {
    if (access & Access.REGION) return true;
  }
  if (config.ex.channels.has(msg.channel.id)) {
    if (access & Access.EX_MAIN) return true;
  }
  if (is_ex_room(msg.channel)) {
    return !!(access & Access.EX_ROOM);
  }
  return false;
}

/*
 * Parse `req' and extract the request name and any modifiers.
 *
 * Returns a tuple of nulls if the request or its modifiers are invalid.
 */
function parse_req_str(input: string): [Req | null, Mod | null] {
  let mods = Mod.NONE;

  for (
    let mod_char = input.charAt(input.length - 1);
    mod_char in modifier_map;
    input = input.slice(0, -1), mod_char = input.charAt(input.length - 1)
  ) {
    mods |= modifier_map[mod_char];
  }

  const req = (req_aliases[input] ?? input) as Req;
  if (!(req in reqs)) return [null, mods];

  const mod_mask = reqs[req].mod_mask ?? Mod.NONE;

  if ((mods | mod_mask) !== mod_mask) return [req, null];
  return [req, mods];
}

/*
 * Do the work of `request'.
 */
async function handle_request(
  msg: Discord.Message,
  request: Req,
  mods: Mod,
  argv: any[],
): Promise<any> {
  if (argv.length === 1 && argv[0] === 'help') {
    return handle_help(msg, request);
  }

  switch (request) {
    // @ts-ignore
    case 'help':      return handle_help(msg, ...argv);
    // @ts-ignore
    case 'set-perm':  return handle_set_perm(msg, ...argv);
    // @ts-ignore
    case 'ls-perms':  return handle_ls_perms(msg, ...argv);
    // @ts-ignore
    case 'add-boss':  return handle_add_boss(msg, ...argv);
    // @ts-ignore
    case 'rm-boss':   return handle_rm_boss(msg, ...argv);
    // @ts-ignore
    case 'def-boss':  return handle_def_boss(msg, ...argv);
    // @ts-ignore
    case 'set-boss-role': return handle_set_boss_role(msg, ...argv);

    // @ts-ignore
    case 'reload-config': return handle_reload_config(msg, ...argv);
    // @ts-ignore
    case 'raidday':   return handle_raidday(msg, ...argv);
    // @ts-ignore
    case 'test':      return handle_test(msg, ...argv);

    // @ts-ignore
    case 'add-gym':   return handle_add_gym(msg, ...argv);
    // @ts-ignore
    case 'edit-gym':  return handle_edit_gym(msg, ...argv);
    // @ts-ignore
    case 'mv-gym':    return handle_mv_gym(msg, ...argv);

    // @ts-ignore
    case 'gym':       return handle_gym(msg, ...argv);
    // @ts-ignore
    case 'ls-gyms':   return handle_ls_gyms(msg, ...argv);
    // @ts-ignore
    case 'ls-regions':  return handle_ls_regions(msg, ...argv);

    // @ts-ignore
    case 'raid':      return handle_raid(msg, ...argv);
    // @ts-ignore
    case 'ls-raids':  return handle_ls_raids(msg, ...argv);
    // @ts-ignore
    case 'egg':       return handle_egg(msg, ...argv, mods);
    // @ts-ignore
    case 'boss':      return handle_boss(msg, ...argv, mods);
    // @ts-ignore
    case 'update':    return handle_update(msg, ...argv, mods);
    // @ts-ignore
    case 'scrub':     return handle_scrub(msg, ...argv);
    // @ts-ignore
    case 'ls-bosses': return handle_ls_bosses(msg, ...argv);

    // @ts-ignore
    case 'call':      return handle_call(msg, ...argv);
    // @ts-ignore
    case 'cancel':    return handle_cancel(msg, ...argv);
    // @ts-ignore
    case 'change':    return handle_change(msg, ...argv);
    // @ts-ignore
    case 'join':      return handle_join(msg, ...argv);
    // @ts-ignore
    case 'unjoin':    return handle_unjoin(msg, ...argv);
    // @ts-ignore
    case 'ping':      return handle_ping(msg, ...argv);

    // @ts-ignore
    case 'ex':        return handle_ex(msg, ...argv);
    // @ts-ignore
    case 'exit':      return handle_exit(msg, ...argv);
    // @ts-ignore
    case 'examine':   return handle_examine(msg, ...argv);
    // @ts-ignore
    case 'exact':     return handle_exact(msg, ...argv);
    // @ts-ignore
    case 'exclaim':   return handle_exclaim(msg, ...argv);
    // @ts-ignore
    case 'explore':   return handle_explore(msg, ...argv);
    // @ts-ignore
    case 'expunge':   return handle_expunge(msg, ...argv);
    // @ts-ignore
    case 'exalt':     return handle_exalt(msg, ...argv);
    default:
      return log_invalid(msg, `Invalid request \`${request}\`.`, true);
  }
}

/*
 * Check whether the user who sent `msg' has the proper permissions to make
 * `request', and make it if so.
 */
async function handle_request_with_check(
  msg: Discord.Message,
  request: Req,
  mods: Mod,
  argv: any[],
) {
  const req_meta = reqs[request];

  if (!has_access(msg, request)) {
    const dm = from_dm(msg);
    const output = `\`\$${request}\` can't be handled ` +
                   (dm ? 'via DM' : `from ${msg.channel}.`);
    return log_invalid(msg, output, dm);
  }

  if (config.admin_ids.has(msg.author.id) ||
      req_meta.perms === Permission.NONE) {
    return handle_request(msg, request, mods, argv);
  }

  const result = await moltresdb.query<PermissionRow>(
    'SELECT * FROM permissions WHERE (cmd = ? AND user_id = ?)',
    [req_to_perm[request] ?? request, msg.author.id]
  );
  if (isErr(result)) return log_mysql_error(msg, result.err);

  const permitted =
    (result.ok.length === 1 && req_meta.perms === Permission.WHITELIST) ||
    (result.ok.length === 0 && req_meta.perms === Permission.BLACKLIST);

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
async function process_request(msg: Discord.Message) {
  if (msg.content.charAt(0) !== '$') return;
  let args = msg.content.substr(1);
  let req_str: string;

  const match = /\s+/.exec(args);
  if (match === null) {
    req_str = args;
    args = '';
  } else {
    req_str = args.substr(0, match.index);
    args = args.substr(match.index + match[0].length);
  }

  const log =
    await moltres.channels.fetch(config.log_id) as Discord.TextChannel;

  const output = `\`\$${req_str}\` ${args}
_Time:_  ${get_now().toLocaleString('en-US')}
_User:_  ${msg.author.tag}
_Channel:_  #${from_dm(msg)
  ? '[dm]'
  : (msg.channel as Discord.TextChannel).name
}`;
  await send_quiet(log, output);

  const [req, mods] = parse_req_str(req_str);

  if (req === null) {
    return log_invalid(msg, `Invalid request \`${req_str}\`.`, true);
  }
  if (mods === null) {
    return log_invalid(msg,
      `Request string \`${req_str}\` has invalid modifiers.`
    );
  }

  const argv = parse_args(args, reqs[req].args);
  if (argv === null) {
    return log_invalid(msg, usage_string(req));
  }

  return handle_request_with_check(msg, req, mods, argv);
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Main reader event.
 */
moltres.on('messageCreate', async (msg: Discord.Message) => {
  if (msg.channel.id in config.channels ||
      msg.channel.id in config.boss_channels ||
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

/*
 * Process reacc joins.
 */
moltres.on('messageReactionAdd', async (
  reacc: Discord.MessageReaction,
  user: Discord.User,
) => {
  if (user.id === moltres.user.id) return;

  const call = call_cache[reacc.message.id];
  if (!call) return;

  if (reacc.emoji.id !== get_emoji('join', true)) return;
  await handle_join({author: user}, call.raid.handle, call.call_time, 0);
});
