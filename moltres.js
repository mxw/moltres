/*
 * Custom raid bot for Valor of Boston.
 */
'use strict';

const Discord = require('discord.js');
const mysql = require('mysql');
const config = require('./config.js');

const moltres = new Discord.Client();

moltres.on('ready', () => {
  console.log(`Logged in as ${moltres.user.tag}.`);
});

const conn = mysql.createConnection({
  host: 'localhost',
  user: 'moltres',
  password: config.moltresdb,
  database: 'moltresdb',
  supportBigNumbers: true,
  bigNumberStrings: true,
});

conn.connect(function(err) {
  if (err) {
    console.error(`Error connecting to moltresdb: ${err.stack}`);
    process.exit(1);
  }
  console.log(`Connected as id ${conn.threadId}.`);
});

///////////////////////////////////////////////////////////////////////////////

function cleanup() {
  moltres.destroy();
  conn.end();
}

function signal_handler(signal) {
  cleanup();
  process.exit(128 + signal);
}

process.on('exit', cleanup);
process.on('uncaughtException', cleanup);
process.on('SIGINT', signal_handler);
process.on('SIGHUP', signal_handler);
process.on('SIGTERM', signal_handler);
process.on('SIGABRT', signal_handler);

///////////////////////////////////////////////////////////////////////////////

const Permission = {
  ADMIN: 0,
  NONE: 1,
  TABLE: 2,
};

/*
 * Order of display for $help.
 */
const cmd_order = [
  'help', 'set-perm', 'test', null,
  'gym', 'ls-gyms', 'add-gym', null,
  'raid', 'ls-raids', 'egg', 'boss', 'update', null,
  'call-time', 'change-time', 'join', 'unjoin',
];

const cmds = {
  'help': {
    perms: Permission.NONE,
    dm: true,
    usage: '[request]',
    args: [0, 1],
    desc: 'Learn about our team\'s legendary avatar.',
    detail: [
      'Just `$help` will list all common requests. You can also use',
      '`$help req` or `$req help` to get more information about a specific',
      'request.',
    ],
  },
  'set-perm': {
    perms: Permission.TABLE,
    dm: false,
    usage: '<user> <request>',
    args: [2, 2],
    desc: 'Enable others to use more requests.',
    detail: [
      'The user should be identified by tag.',
    ],
  },
  'test': {
    perms: Permission.ADMIN,
    dm: false,
    usage: '',
    args: [0, 100],
    desc: 'Flavor of the week testing command.',
    detail: [
      'This request is only available to me.',
    ],
  },
  'gym': {
    perms: Permission.NONE,
    dm: true,
    usage: '<handle>',
    args: [1, 1],
    desc: 'Get information about a gym.',
    detail: [
      'A gym handle is something like `jh-john-harvard` or `newtowne`.',
      'You can use partial substring matches (like `jh` or even `ohn-harv`)',
      'as long as they don\'t match another gym.\n\nUse `$ls-gyms <region>`',
      'if you want to see all the gym handles (but they should be what you',
      'expect).',
    ],
  },
  'ls-gyms': {
    perms: Permission.NONE,
    dm: true,
    usage: '<region-name>',
    args: [1, 100],
    desc: 'List all gyms in a region.',
    detail: [
      'The region name should be any valid region role (without the `@`).',
      'Case doesn\'t matter, and uniquely-identifying prefixes are allowed,',
      'so, e.g., `harvard` will work, but `boston` will not (but `boston',
      'common` is fine).',
    ],
  },
  'add-gym': {
    perms: Permission.TABLE,
    dm: false,
    usage: '<handle> <region> <lat> <lng> <name>',
    args: [5, 100],
    desc: 'Add a new gym to the database.',
    detail: [
      'The region can be either an @-tag, a numeric Discord ID, or a',
      'uniquely-identifying prefix string of the region role name. If a',
      'string name is used, it must use hyphens instead of whitespace (e.g.,',
      '`kendall-square` or `Kendall-Square` instead of `Kendall Square`).' +
      '\n\nThe recommended method for adding gyms is to copy information',
      'over from <http://www.massmwcreaturemap.com/>. Note that the latitude',
      'argument is allowed to contain a trailing comma, for ease of copying.',
    ],
  },
  'raid': {
    perms: Permission.NONE,
    dm: true,
    usage: '<gym-handle>',
    args: [1, 1],
    desc: 'Get information about the current raid at a gym.',
    detail: [
      'See `$help gym` for details on gym handles.',
    ],
  },
  'ls-raids': {
    perms: Permission.NONE,
    dm: true,
    usage: '<region-name>',
    args: [1, 100],
    desc: 'List all active raids in a region.',
    detail: [
      'The region name should be any valid region role (without the `@`).',
      'Case doesn\'t matter, and uniquely-identifying prefixes are allowed,',
      'so, e.g., `harvard` will work, but `boston` will not (but `boston',
      'common` is fine).',
    ],
  },
  'egg': {
    perms: Permission.NONE,
    dm: false,
    usage: '<gym-handle> <tier> <time-til-hatch MM:SS>',
    args: [3, 3],
    desc: 'Report a raid egg.',
    detail: [
      'The tier can be any number 1–5 or things like `t3` or `T4`. The time',
      'should be the current _**countdown timer**_, not a time of day. See',
      '`$help gym` for details on gym handles.',
    ],
  },
  'boss': {
    perms: Permission.NONE,
    dm: false,
    usage: '<gym-handle> <boss> <time-til-despawn MM:SS>',
    args: [3, 3],
    desc: 'Report a hatched raid boss.',
    detail: [
      'The time should be the current _**countdown timer**_, not a time of',
      'day. See `$help gym` for details on gym handles.',
    ],
  },
  'update': {
    perms: Permission.NONE,
    dm: false,
    usage: '<gym-handle> <tier-or-boss-or-despawn-time>',
    args: [2, 2],
    desc: 'Modify an active raid listing.',
    detail: [
      'Note that unlike `$egg` and `$boss`, times are interpreted as',
      '_despawn times_, not countdown timers.',
    ],
  },
  'call-time': {
    perms: Permission.NONE,
    dm: false,
    usage: '<gym-handle> <HH:MM> [num-extras]',
    args: [2, 3],
    desc: 'Call a time for a raid.',
    detail: [
      'Make sure not to double-call a time, or Moltres will be mad at you.',
    ],
  },
  'change-time': {
    perms: Permission.NONE,
    dm: false,
    usage: '<gym-handle> <current-HH:MM> to <desired-HH:MM>',
    args: [4, 4],
    desc: 'Change a called time for a raid.',
    detail: [
      'Make sure to include the `to`; it\'s just there to enforce the right',
      'direction.',
    ],
  },
  'join': {
    perms: Permission.NONE,
    dm: false,
    usage: '<gym-handle> [HH:MM] [num-extras]',
    args: [1, 3],
    desc: 'Join a called raid time.',
    detail: [
      'You don\'t need to specify the time _unless_ the raid has multiple',
      'called times, in which case you do.',
    ],
  },
  'unjoin': {
    perms: Permission.NONE,
    dm: false,
    usage: '<gym-handle> [HH:MM]',
    args: [1, 2],
    desc: 'Back out of a raid.',
    detail: [
      'As with `$join`, you don\'t need to specify the time _unless_ the',
      'raid has multiple called times, in which case you do.',
    ],
  },
};

const cmd_aliases = {
  'gyms':         'ls-gyms',
  'raids':        'ls-raids',
  'spot-egg':     'egg',
  'spot-raid':    'boss',
  'update-raid':  'update',
};

const raid_tiers = {
  magikarp: 1,
  duskull: 1,
  shuppet: 1,
  snorunt: 1,
  swablu: 1,
  wailmer: 1,

  electabuzz: 2,
  exeggutor: 2,
  manectric: 2,
  mawile: 2,
  misdreavus: 2,
  sableye: 2,
  sneasel: 2,

  gengar: 3,
  granbull: 3,
  jolteon: 3,
  jynx: 3,
  machamp: 3,
  piloswine: 3,
  pinsir: 3,

  absol: 4,
  aggron: 4,
  golem: 4,
  houndoom: 4,
  tyranitar: 4,
  walrein: 4,

  latios: 5,
};

///////////////////////////////////////////////////////////////////////////////
// Discord utilities.

/*
 * Get the main guild for bot requests.
 */
function guild() {
  return moltres.guilds.get(config.guild_id);
}

/*
 * Wrappers around send() that swallow exceptions.
 */
function send_quiet(channel, content) {
  return channel.send(content).catch(console.error);
}
function dm_quiet(user, content) {
  return user.createDM()
    .then(dm => dm.send(content))
    .catch(console.error);
}

/*
 * Try to delete a message if it's not on a DM channel.
 */
function try_delete(msg, timeout = 0) {
  if (msg.channel.type === 'dm') return;
  msg.delete(timeout).catch(console.error);
}

/*
 * Re-load a message for performing further operations.
 */
function refresh(msg) {
  return msg.channel.fetchMessage(msg.id);
}

/*
 * Avoid polluting the rest of the file with emoji.
 */
const emoji_by_name = {
  cry: '😢',
  no_entry_sign: '🚫',
  no_good: '🙅',
  thinking: '🤔',
};

/*
 * Get a custom emoji by name.
 */
function get_emoji(name) {
  return moltres.emojis.find('name', name);
}

/*
 * Add reactions to `msg' in order.
 */
function chain_reaccs(msg, ...reaccs) {
  if (reaccs.length === 0) return;
  let [head, ...tail] = reaccs;

  let emoji = emoji_by_name[head] || get_emoji(head);
  let promise = msg.react(emoji);

  for (let name of tail) {
    let emoji = emoji_by_name[name] || get_emoji(name);
    promise = promise.then(r => r.message.react(emoji));
  }
  promise.catch(console.error);
}

/*
 * Get a Role by `name' for the guild `msg' belongs to.
 */
function get_role(name) {
  let role = guild().roles.find('name', name);
  if (role) return role;

  let matches = guild().roles.filterArray(
    role => role.name.toLowerCase().startsWith(name.toLowerCase())
  );
  return matches.length === 1 ? matches[0] : null;
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
 * Log base function.
 */
function log_impl(msg, str, reacc = null) {
  if (str) {
    let log = moltres.channels.get(config.log_id);
    send_quiet(log, `    ${str}`);
  }
  if (reacc) chain_reaccs(msg, reacc);
};

/*
 * Log a successful request, an invalid request, or an internal error.
 */
function react_success(msg, reacc = null) {
  chain_reaccs(msg, reacc || 'approved');
};
function log_error(msg, str, reacc = null) {
  log_impl(msg, str, reacc || 'no_good');
};
function log_invalid(msg, str, keep = false) {
  log_impl(msg, str, null);

  msg.author.createDM()
    .then(dm => dm.send(str))
    .catch(console.error);

  if (!keep) try_delete(msg);
};

/*
 * Get the usage string for `cmd'.
 */
function usage_string(cmd) {
  if (!(cmd in cmds)) return null;
  return `Usage: \`\$${cmd} ${cmds[cmd].usage}\`

${cmds[cmd].detail.join(' ')}

Arguments in \`<>\` are required; arguments in \`[]\` are optional.`;
}

///////////////////////////////////////////////////////////////////////////////
// MySQL utilities.

/*
 * MySQL handler which logs any error, or otherwise delegates to a callback.
 */
function errwrap(msg, fn = null) {
  return function (err, ...rest) {
    if (err) {
      console.error(err);
      return log_error(msg, `MySQL error: ${err.code}.`);
    }
    if (fn !== null) {
      refresh(msg)
        .then(m => fn(m, ...rest))
        .catch(console.error);
    }
  };
}

/*
 * Wrapper around common handling for mutation requests.
 */
function mutation_handler(msg, failure = null, success = null) {
  return errwrap(msg, function (msg, result) {
    /*
     * The `result' for a mutation has the following structure:
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
    if (result.affectedRows === 0) {
      if (failure !== null) failure(msg, result);
    } else {
      if (success !== null) {
        success(msg, result);
      } else {
        react_success(msg);
      }
    }
  })
}

///////////////////////////////////////////////////////////////////////////////
// SQL snippets.

/*
 * Get a SQL WHERE clause fragment for selecting a unique gym matching `handle'.
 */
function where_one_gym(handle) {
  return mysql.format(
    ' gyms.handle LIKE ? AND ' +
    ' (SELECT COUNT(*) FROM gyms WHERE gyms.handle LIKE ?) = 1 ',
    [`%${handle}%`, `%${handle}%`]
  );
}

/*
 * Get a SQL WHERE clause fragment for selecting a specific call time.
 *
 * If `time' is null, instead we select for a single unique time.
 */
function where_call_time(call_time = null) {
  if (call_time !== null) {
    return mysql.format(' calls.time = ? ', [call_time]);
  }
  return ' (SELECT COUNT(*) FROM calls ' +
         '  WHERE raids.gym_id = calls.raid_id) = 1 ';
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
 *
 * Call `fn' to handle the result of the query.
 */
function select_rsvps(xtra_where, xtra_values, handle, fn) {
  conn.query({
    sql:
      'SELECT * FROM ' + full_join_table +
      '   WHERE ' + where_one_gym(handle) + xtra_where,
    values: xtra_values,
    nestTables: true,
  }, fn);
}

///////////////////////////////////////////////////////////////////////////////
// Time utilities.

/*
 * Return a Date for the current time.
 */
function get_now() {
  return new Date(Date.now());
}

/*
 * Extract the minutes and seconds from a raid countdown timer.
 */
function parse_timer(timer) {
  let matches = timer.match(/^(\d{1,2})[:.](\d\d)$/);
  if (matches === null) return null;

  let [_, mins, secs] = matches;
  if (secs >= 60) return null;

  return { mins: parseInt(mins), secs: parseInt(secs) };
}

/*
 * Parse a time given by HH:MM as a Date object.
 *
 * This function uses rough heuristics to determine whether the user meant A.M.
 * or P.M., based on the assumption that the intent is always to represent the
 * most proximal time in the future.
 */
function parse_hour_minute(time) {
  let matches = time.match(/^(\d{1,2})[:.](\d\d)$/);
  if (matches === null) return null;

  let [_, hours, mins] = matches;
  [hours, mins] = [parseInt(hours), parseInt(mins)];
  if (hours >= 24 || mins >= 60) return null;

  let now = get_now();

  hours = function() {
    // 24-hour time; let the user use exactly that time.
    if (hours >= 13) return hours;
    // Same or later morning hour.
    if (hours >= now.getHours()) return hours;
    // Same or later afternoon hour if we interpret as P.M.
    if (hours + 12 >= now.getHours()) return hours + 12;

    return hours;
  }();

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
function time_str(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  });
}

/*
 * Get the raid pop or hatch time from a despawn time.
 */
function pop_from_despawn(despawn) {
  let pop = new Date(despawn.getTime());
  pop.setMinutes(pop.getMinutes() - 60 - 45);
  return pop;
}
function hatch_from_despawn(despawn) {
  let hatch = new Date(despawn.getTime());
  hatch.setMinutes(hatch.getMinutes() - 45);
  return hatch;
}

///////////////////////////////////////////////////////////////////////////////
// General handlers.

function handle_help(msg, args) {
  let out = null;

  if (args.length === 0) {
    out = get_emoji('valor') +
          '  Please choose your request from the following:\n\n';
    for (let cmd of cmd_order) {
      if (cmd !== null) {
        out += `\`\$${cmd}\`:  ${cmds[cmd].desc}\n`;
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
    let [cmd] = args;
    cmd = cmd_aliases[cmd] || cmd;

    if (!(cmd in cmds)) {
      return log_invalid(msg, `Invalid request \`${cmd}\`.`);
    }
    out = `\`${cmd}\`:  ${cmds[cmd].desc}\n\n${usage_string(cmd)}`;
  }

  if (config.admin_ids.has(msg.author.id)) {
    send_quiet(msg.channel, out.trim());
  } else {
    dm_quiet(msg.author, out.trim());
    try_delete(msg, 500);
  }
}

function handle_set_perm(msg, args) {
  let [user_tag, request] = args;

  if (!user_tag.match(Discord.MessageMentions.USERS_PATTERN) ||
      msg.mentions.users.size !== 1) {
    return log_invalid(msg, `Invalid user tag \`${user_tag}\`.`);
  }
  let user_id = msg.mentions.users.first().id;

  conn.query(
    'INSERT INTO permissions SET ?',
    { cmd: request,
      user_id: user_id, },
    mutation_handler(msg)
  );
}

function handle_test(msg, args) {
  chain_reaccs(msg, 'cry', 'no_good', 'approved', 'RaidEgg');
}

///////////////////////////////////////////////////////////////////////////////
// Gym handlers.

/*
 * Helper for error-handling cases where zero or multiple gyms are found.
 *
 * Returns true if we have a single result, else false.
 */
function check_one_gym(msg, handle, results) {
  if (results.length < 1) {
    chain_reaccs(msg, 'cry');
    send_quiet(msg.channel,
      `No unique gym match found for \`[${handle}]\`.`
    );
    return false;
  } else if (results.length > 1) {
    log_invalid(msg, `Multiple gyms matching \`[${handle}]\`.`);
    return false;
  }
  return true;
}

/*
 * Stringify a row from the gyms table.
 */
function gym_row_to_string(msg, gym) {
  return `\`[${gym.handle}]\`
name: **${gym.name}**
region: ${guild().roles.get(gym.region).name}
coords: <https://maps.google.com/maps?q=${gym.lat},${gym.lng}>`;
}

function handle_gym(msg, args) {
  let [handle] = args;
  handle = handle.toLowerCase();

  conn.query(
    'SELECT * FROM gyms WHERE handle LIKE ?',
    [`%${handle}%`],

    errwrap(msg, function (msg, results) {
      if (!check_one_gym(msg, handle, results)) return;
      let [gym] = results;

      send_quiet(msg.channel, gym_row_to_string(msg, gym));
    })
  );
}

function handle_ls_gyms(msg, args) {
  let role_name = args.join(' ');
  let role = get_role(role_name);
  if (role === null) {
    return log_invalid(msg, `Invalid region name \`${role_name}\`.`);
  }

  conn.query(
    'SELECT * FROM gyms WHERE region = ?', [role.id],

    errwrap(msg, function (msg, results) {
      if (results.length === 0) {
        return chain_reaccs(msg, 'no_entry_sign');
      }

      let output = `Gyms in **${role.name}**:\n`;
      for (let gym of results) {
        output += `\n\`[${gym.handle}]\` ${gym.name}`;
      }
      send_quiet(msg.channel, output);
    })
  );
}

function handle_add_gym(msg, args) {
  let [handle, region_in, lat, lng, ...name] = args;
  handle = handle.toLowerCase();

  if (lat.charAt(lat.length - 1) === ',') {
    lat = lat.substr(0, lat.length - 1);
  }

  let region = function() {
    // Maybe it's a mention.
    if (region_in.match(Discord.MessageMentions.ROLES_PATTERN) &&
        msg.mentions.roles.size === 1) {
      return msg.mentions.roles.first().id;
    }

    // Maybe it's a prefix.
    let region = get_role(region_in.replace(/-/g, ' '));
    if (region) return region.id;

    // Maybe it's an ID.
    region = guild().roles.get(region_in);
    return region ? region.id : null;
  }();
  if (region === null) {
    return log_invalid(msg, `Invalid region \`${region_in}\`.`);
  }

  name = name.join(' ');

  conn.query(
    'INSERT INTO gyms SET ?',
    { handle: handle,
      name: name,
      region: region,
      lat: lat,
      lng: lng, },
    mutation_handler(msg)
  );
}

///////////////////////////////////////////////////////////////////////////////
// Raid handlers.

/*
 * Pull the integer tier from a tier string (e.g., '5' or 'T5'), or return null
 * if the string is not tier-like.
 */
function parse_tier(tier) {
  tier = '' + tier;

  if (tier.startsWith('T') || tier.startsWith('t')) {
    tier = tier.substr(1);
  }
  tier = parseInt(tier);
  return (tier >= 1 && tier <= 5) ? tier : null;
}

/*
 * Capitalize the first letter of a raid boss's name, or return 'unknown' if
 * the boss is null.
 */
function fmt_boss(boss) {
  return boss !== null
    ? boss.charAt(0).toUpperCase() + boss.substr(1)
    : 'unknown';
}

function handle_raid(msg, args) {
  let [handle] = args;
  handle = handle.toLowerCase();

  let now = get_now();

  select_rsvps('', [], handle, errwrap(msg, function (msg, results) {
    if (results.length < 1) {
      chain_reaccs(msg, 'no_entry_sign');
      return send_quiet(msg.channel,
        `No unique raid found for \`[${handle}]\`.`
      );
    }
    let [{gyms, raids, calls}] = results;

    if (raids.despawn < now) {
      // Clean up expired raids.
      conn.query(
        'DELETE FROM raids WHERE gym_id = ?',
        [raids.gym_id],
        errwrap(msg)
      );
      return chain_reaccs(msg, 'no_entry_sign', 'RaidEgg');
    }

    let hatch = hatch_from_despawn(raids.despawn);

    let output = gym_row_to_string(msg, gyms) + '\n';
    if (now >= hatch) {
      output +=`
raid: **${fmt_boss(raids.boss)}** (T${raids.tier})
despawn: ${time_str(raids.despawn)}`;
    } else {
      output +=`
raid egg: **T${raids.tier}**
hatch: ${time_str(hatch)}`;
    }

    if (calls.time !== null) {
      output += '\n\ncall times:';

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

        let caller_found = false;
        let total = 0;

        // Get an array of attendee strings, removing the raid time caller.
        let attendees = rows_by_time[t].map(row => {
          let member = guild().members.get(row.rsvps.user_id);
          if (!member) return null;

          total += (row.rsvps.extras + 1);

          if (member.user.id === calls.caller) {
            caller_found = true;
            return null;
          }

          let extras = row.rsvps.extras !== 0
            ? ` +${row.rsvps.extras}`
            : '';
          return `${member.nickname || member.user.username}${extras}`
        }).filter(a => a !== null);

        let caller_str = '';

        if (caller_found) {
          let caller = guild().members.get(calls.caller);
          caller_str =
            `${caller.nickname || caller.user.username} _(caller)_` +
            (attendees.length !== 0 ? ', ' : '');
        }
        output += `\n- **${time_str(calls.time)}** (${total} raiders)—` +
                  `${caller_str}${attendees.join(', ')}`;
      }
    }

    send_quiet(msg.channel, output);
  }));
}

function handle_ls_raids(msg, args) {
  let role_name = args.join(' ');
  let role = get_role(role_name);
  if (role === null) {
    return log_invalid(msg, `Invalid region name \`${role_name}\`.`);
  }

  let now = get_now();

  conn.query(
    'SELECT * FROM gyms INNER JOIN raids ' +
    'ON gyms.id = raids.gym_id ' +
    'WHERE gyms.region = ? AND raids.despawn > ?',
    [role.id, now],

    errwrap(msg, function (msg, results) {
      if (results.length === 0) {
        return chain_reaccs(msg, 'no_entry_sign', 'RaidEgg');
      }

      let output = `Active raids in **${role.name}**:\n`;
      for (let raid of results) {
        let hatch = hatch_from_despawn(raid.despawn);
        let boss = hatch > now ? 'egg' : fmt_boss(raid.boss);
        let timer_str = hatch > now
          ? `hatches at ${time_str(hatch)}`
          : `despawns at ${time_str(raid.despawn)}`

        output +=
          `\n\`[${raid.handle}]\` **T${raid.tier} ${boss}** ${timer_str}`;
      }
      send_quiet(msg.channel, output);
    })
  );
}

function handle_report(msg, handle, tier_in, boss, timer_in) {
  handle = handle.toLowerCase();

  let tier = parse_tier(tier_in);
  if (tier === null) {
    return log_invalid(msg, `Invalid raid tier \`${tier_in}\`.`);
  }

  let timer = parse_timer(timer_in);
  if (timer === null) {
    return log_invalid(msg, `Invalid MM:SS timer \`${timer_in}\`.`);
  }

  let egg_adjust = boss === null ? 45 : 0;

  let despawn = get_now();
  despawn.setMinutes(despawn.getMinutes() + timer.mins + egg_adjust);
  despawn.setSeconds(despawn.getSeconds() + timer.secs);

  let pop = pop_from_despawn(despawn);

  conn.query(
    'REPLACE INTO raids (gym_id, tier, boss, despawn, spotter) ' +
    '   SELECT gyms.id, ?, ?, ?, ? FROM gyms ' +
    '   WHERE ' + where_one_gym(handle) +
    '   AND ' +
    '     NOT EXISTS ( ' +
    '       SELECT * FROM raids ' +
    '         WHERE gym_id = gyms.id ' +
    '         AND despawn > ? ' +
    '     ) ',
    [tier, boss, despawn, msg.author.id, pop],

    mutation_handler(msg, function (msg, result) {
      log_invalid(msg,
        `No unique gym match found for \`[${handle}]\` that doesn't ` +
        'already have an active raid.'
      );
    }, function (msg, result) {
      let output = `**T${tier} `;
      if (boss === null) {
        let hatch = hatch_from_despawn(despawn);
        output += `egg** hatches at \`[${handle}]\` at ${time_str(hatch)} `;
      } else {
        output += `${fmt_boss(boss)} raid** despawns at \`[${handle}]\` ` +
                  `at ${time_str(despawn)} `;
      }
      output += `(reported by ${msg.author}).`;

      send_quiet(msg.channel, output);
    })
  );
}

function handle_egg(msg, args) {
  let [handle, tier, timer] = args;

  handle_report(msg, handle, tier, null, timer);
}

function handle_boss(msg, args) {
  let [handle, boss, timer] = args;
  boss = boss.toLowerCase();

  if (!(boss in raid_tiers)) {
    return log_invalid(msg, `Unrecognized raid boss \`${boss}\`.`);
  }

  handle_report(msg, handle, raid_tiers[boss], boss, timer);
}

function handle_update(msg, args) {
  let [handle, data] = args;
  handle = handle.toLowerCase();

  let assignment = function() {
    let boss = data.toLowerCase();
    if (boss in raid_tiers) {
      return {
        tier: raid_tiers[boss],
        boss: boss,
      };
    }

    let now = get_now();
    let despawn = parse_hour_minute(data);
    if (despawn !== null && despawn > now &&
        pop_from_despawn(despawn) <= now) {
      // See the comment in handle_call_time() for the reason behind adding
      // this extra second.
      despawn.setSeconds(despawn.getSeconds());
      return { despawn: despawn };
    }

    let tier = parse_tier(data);
    if (tier !== null) {
      return { tier: tier };
    }

    return null;
  }();

  if (assignment === null) {
    return log_invalid(msg, `Invalid update parameter \`${data}\`.`);
  }

  conn.query(
    'UPDATE raids INNER JOIN gyms ON raids.gym_id = gyms.id ' +
    'SET ? WHERE ' + where_one_gym(handle),
    [assignment],

    mutation_handler(msg, function (msg, result) {
      log_invalid(msg,
        `No unique gym match found for \`[${handle}]\` with an active raid.`
      );
    })
  );
}

///////////////////////////////////////////////////////////////////////////////
// Raid call handlers.

/*
 * Get an array of all the users attending the raid at `handle' at `time'.
 */
function get_all_raiders(msg, handle, time, fn) {
  select_rsvps('AND ' + where_call_time(time), [], handle,
    errwrap(msg, function (msg, results) {
      if (results.length < 1) return fn(msg, null, []);

      let raiders = [];

      for (let row of results) {
        let member = guild().members.get(row.rsvps.user_id);
        if (member) raiders.push(member);
      }
      fn(msg, results[0], raiders);
    })
  );
}

/*
 * Set a timeout to ping raiders for `handle' `before' minutes before
 * `call_time'.
 */
function set_raid_alarm(msg, handle, call_time, before = 7) {
  let alarm_time = new Date(call_time.getTime());
  alarm_time.setMinutes(alarm_time.getMinutes() - before);

  let delay = alarm_time - get_now();
  if (delay <= 0) return;

  log_impl(msg,
    `Setting alarm for \`[${handle}]\` at \`${time_str(alarm_time)}\`.`
  );

  setTimeout(function() {
    get_all_raiders(msg, handle, call_time, function (msg, row, raiders) {
      // The call time might have changed, or everyone may have unjoined.
      if (row === null || raiders.length === 0) return;
      let handle = row.gyms.handle;

      let output =
        `Raid call for \`[${handle}]\` at \`${time_str(call_time)}\` ` +
        `is in ${before} minutes!\n\n${raiders.map(m => m.user).join(' ')}`;
      send_quiet(msg.channel, output);
    });
  }, delay);

  delay = call_time - get_now();
  if (delay <= 0) delay = 1;

  // Make sure we don't leak cached join messages.
  //
  // This doesn't really belong here, but we set alarms every time we modify a
  // call time, which is exactly when we want to make this guarantee.
  setTimeout(() => { join_cache_set(handle, call_time, null); }, delay);
}

/*
 * Cache for join messages.
 */
let join_cache = {};

function join_cache_get(handle, time) {
  return join_cache[handle + time.getTime()];
}
function join_cache_set(handle, time, msg) {
  if (msg) {
    join_cache[handle + time.getTime()] = msg;
  } else {
    delete join_cache[handle + time.getTime()];
  }
}

function handle_call_time(msg, args) {
  let [handle, time, extras] = args;
  handle = handle.toLowerCase();

  let call_time = parse_hour_minute(time);
  if (call_time === null) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${time}\`.`);
  }

  let now = get_now();
  if (call_time < now) {
    return log_invalid(msg, `Can't call a time in the past \`${time}\`.`);
  }

  extras = extras || 0;

  // This is a janky way to allow for raids at exactly hatch.  The main
  // shortcoming is that if a raid's despawn is at an exact minute, this will
  // let users call a raid time a minute before hatch.
  //
  // In practice, this is extremely unlikely, and to avoid this situation for
  // manual hatch/despawn time changes, we add a dummy second to all explicit
  // user-declared raid despawn times.
  let later = new Date(call_time.getTime());
  later.setMinutes(later.getMinutes() + 46);

  conn.query(
    'INSERT INTO calls (raid_id, caller, time) ' +
    '   SELECT raids.gym_id, ?, ? FROM gyms INNER JOIN raids ' +
    '     ON gyms.id = raids.gym_id ' +
    '   WHERE ' + where_one_gym(handle) +
    '     AND raids.despawn > ? ' +
    '     AND raids.despawn <= ? ',
    [msg.author.id, call_time, call_time, later],

    mutation_handler(msg, function (msg, result) {
      log_invalid(msg,
        `Could not find a unique raid for \`[${handle}]\` with call time ` +
        `\`${time_str(call_time)}\` after hatch and before despawn ` +
        `(or this time has already been called).`
      );
    }, function (msg, result) {
      let call_id = result.insertId;

      conn.query(
        'INSERT INTO rsvps SET ?',
        { call_id: call_id,
          user_id: msg.author.id,
          extras: extras,
          maybe: false },
        errwrap(msg)
      );

      // Grab the raid information just for reply purposes.
      conn.query(
        'SELECT * FROM gyms INNER JOIN raids ON gyms.id = raids.gym_id ' +
        '   WHERE handle LIKE ?',
        [`%${handle}%`],

        errwrap(msg, function (msg, results) {
          if (!check_one_gym(msg, handle, results)) return;
          let [raid] = results;

          let role = msg.guild.roles.get(raid.region);
          if (!role) {
            return log_error(msg, `Malformed gym entry for ${raid.handle}.`);
          }

          let role_str = raid.silent ? role.name : role.toString();
          role_str = role.name;

          let output =
            `${role_str} **T${raid.tier} ${fmt_boss(raid.boss)}** raid ` +
            `at \`[${raid.handle}]\` ` +
            `called for ${time_str(call_time)} by ${msg.author}\n\n` +
            `To join this raid time, enter \`$join ${raid.handle}\`.`;
          send_quiet(msg.channel, output);

          set_raid_alarm(msg, raid.handle, call_time);
        })
      );
    })
  );
}

function handle_change_time(msg, args) {
  let [handle, current_in, to, desired_in] = args;
  handle = handle.toLowerCase();

  let current = parse_hour_minute(current_in);
  if (current === null) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${current_in}\`.`);
  }

  let desired = parse_hour_minute(desired_in);
  if (desired === null) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${desired_in}\`.`);
  }

  // See comment in handle_call_time().
  let later = new Date(desired.getTime());
  later.setMinutes(later.getMinutes() + 46);

  let assignment = {
    caller: msg.author.id,
    time: desired,
  };

  conn.query(
    'UPDATE calls ' +
    '   INNER JOIN raids ON calls.raid_id = raids.gym_id ' +
    '   INNER JOIN gyms ON raids.gym_id = gyms.id ' +
    'SET ? ' +
    'WHERE ' + where_one_gym(handle) +
    '   AND raids.despawn > ? ' +
    '   AND raids.despawn <= ? ' +
    '   AND calls.time = ? ',
    [assignment, desired, later, current],

    mutation_handler(msg, function (msg, result) {
      log_invalid(msg,
        `No raid at \`${time_str(current)}\` found for \`[${handle}]\` ` +
        `(or \`${time_str(desired)}\` is not a valid raid time).`
      );
    }, function (msg, result) {
      get_all_raiders(msg, handle, desired, function (msg, row, raiders) {
        // No raiders is weird, but it could happen if everyone unjoins and
        // someone decides to change the raid time for no meaningful reason.
        if (row === null || raiders.length === 0) return;
        let handle = row.gyms.handle;

        // Move the join message cache entry.
        join_cache_set(handle, desired, join_cache_get(handle, current));
        join_cache_set(handle, current, null);

        raiders = raiders
          .map(member => member.user)
          .filter(user => user.id != msg.author.id);

        let output =
          `Raid time changed for \`${row.gyms.name}\` ` +
          `from ${time_str(current)} to ${time_str(desired)} ` +
          `by ${msg.author}.  CA-CAAW!`;

        if (raiders.length !== 0) {
          output += `\n\nPaging other raiders: ${raiders.join(' ')}.`;
        }
        send_quiet(msg.channel, output);

        set_raid_alarm(msg, handle, desired);
      });
    })
  );
}

function handle_join(msg, args) {
  let [handle, time, extras] = args;
  handle = handle.toLowerCase();

  let call_time = null;

  let ok = function() {
    if (!time) return true;

    call_time = parse_hour_minute(time);
    if (call_time !== null) return true;

    if (!extras) {
      let matches = time.match(/^(\d+)$/);
      if (matches !== null) {
        extras = matches[1];
        return true;
      }
    }
    return false;
  }();
  if (!ok) {
    return log_invalid(msg, `Unrecognized HH:MM time \`${time}\`.`);
  }

  extras = parseInt(extras || 0);

  conn.query(
    'INSERT INTO rsvps (call_id, user_id, extras, maybe) ' +
    '   SELECT calls.id, ?, ?, ? ' +
    '     FROM gyms ' +
    '       INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '       INNER JOIN calls ON raids.gym_id = calls.raid_id ' +
    '   WHERE ' + where_one_gym(handle) +
    '     AND ' + where_call_time(call_time),
    [msg.author.id, extras, false],

    mutation_handler(msg, function (msg, result) {
      log_invalid(msg,
        `Could not find a raid time to join for \`[${handle}]\`` +
        (call_time !== null
          ? ` with called time \`${time_str(call_time)}\`.`
          : '.')
      );
    }, function (msg, result) {
      get_all_raiders(msg, handle, call_time, function (msg, row, raiders) {
        // The call time might have changed, or everyone may have unjoined.
        if (row === null || raiders.length === 0) return;
        let handle = row.gyms.handle;

        // Clear any existing join message for this raid.
        let clear_join_msg = function() {
          let prev = join_cache_get(handle, row.calls.time);
          if (prev) {
            try_delete(prev);
            join_cache_set(handle, row.calls.time, null);
          }
        };
        clear_join_msg();

        raiders = raiders.filter(user => user.id != msg.author.id);

        let output = get_emoji('valor') +
          `  ${msg.author} is joining at ${time_str(row.calls.time)} ` +
          `for the raid at \`[${handle}]\``;

        if (raiders.length !== 0) {
          let names = raiders.map(memb => memb.nickname || memb.user.username);
          output += ` (with ${names.join(', ')}).`;
        } else {
          output += '.';
        }

        msg.channel.send(output)
          .then(join_msg => {
            // Delete the $join request, delete any previous join message, and
            // cache this one for potential later deletion.
            try_delete(msg, 3000);
            clear_join_msg();
            join_cache_set(handle, row.calls.time, join_msg);
          })
          .catch(console.error);
      });
    })
  );
}

function handle_unjoin(msg, args) {
  let [handle, time] = args;
  handle = handle.toLowerCase();

  let call_time = null;
  if (time) {
    call_time = parse_hour_minute(time);
    if (call_time === null) {
      return log_invalid(msg, `Unrecognized HH:MM time \`${time}\`.`);
    }
  }

  conn.query(
    'DELETE rsvps FROM ' + full_join_table +
    '   WHERE ' + where_one_gym(handle) +
    '     AND ' + where_call_time(call_time) +
    '     AND rsvps.user_id = ? ',
    [msg.author.id],

    mutation_handler(msg, function (msg, result) {
      log_invalid(msg,
        `Couldn't find a unique raid for \`[${handle}]\` that you joined.`
      );
    }, function (msg, result) {
      react_success(msg, 'cry');
    })
  );
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Do the work of `request'.
 */
function handle_request(msg, request, args) {
  if (args.length === 1 && args[0] === 'help') {
    return handle_help(msg, [request]);
  }

  let params_range = cmds[request].args;

  if (args.length < params_range[0] || args.length > params_range[1]) {
    return log_invalid(msg, usage_string(request));
  }

  switch (request) {
    case 'help':      return handle_help(msg, args);
    case 'set-perm':  return handle_set_perm(msg, args);
    case 'test':      return handle_test(msg, args);

    case 'gym':       return handle_gym(msg, args);
    case 'ls-gyms':   return handle_ls_gyms(msg, args);
    case 'add-gym':   return handle_add_gym(msg, args);

    case 'raid':      return handle_raid(msg, args);
    case 'ls-raids':  return handle_ls_raids(msg, args);
    case 'egg':       return handle_egg(msg, args);
    case 'boss':      return handle_boss(msg, args);
    case 'update':    return handle_update(msg, args);

    case 'call-time': return handle_call_time(msg, args);
    case 'change-time': return handle_change_time(msg, args);
    case 'join':      return handle_join(msg, args);
    case 'unjoin':    return handle_unjoin(msg, args);
    default:
      return log_invalid(msg, `Invalid request \`${request}\`.`);
  }
}

/*
 * Check whether the user who sent `msg' has the proper permissions to make
 * `request', and make it if so.
 */
function handle_request_with_check(msg, request, args) {
  let user_id = msg.author.id;

  let log = moltres.channels.get(config.log_id);
  let output = `[${msg.author.tag}] \`\$${request}\` ${args.join(' ')}`;
  send_quiet(log, output);

  request = cmd_aliases[request] || request;

  if (!(request in cmds)) {
    return log_invalid(msg, `Invalid request \`${request}\`.`);
  }

  if (!cmds[request].dm && msg.channel.type === 'dm') {
    return log_invalid(msg, `\`\$${request}\` can't be handled via DM`, true);
  }

  if (config.admin_ids.has(user_id) ||
      cmds[request].perms === Permission.NONE) {
    return handle_request(msg, request, args);
  }

  conn.query(
    'SELECT * FROM permissions WHERE (cmd = ? AND user_id = ?)',
    [request, user_id],

    errwrap(msg, function (msg, results) {
      if (results.length === 1) {
        return handle_request(msg, request, args);
      }

      return log_invalid(
        msg,
        `User ${msg.author.tag} does not have permissions for ${request}.`,
        'dealwithit'
      );
    })
  );
}

/*
 * Process a user request.
 */
function process_request(msg) {
  if (msg.content.charAt(0) !== '$') return;
  let [request, ...rest] = msg.content.substr(1).split(/\s+/);

  handle_request_with_check(msg, request, rest);
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Main reader event.
 */
moltres.on('message', msg => {
  if (config.channels.has(msg.channel.id) ||
      msg.channel.type === 'dm') {
    try {
      process_request(msg);
    } catch (e) {
      console.error(e);
    }
  }
});

moltres.login(config.moltres);
