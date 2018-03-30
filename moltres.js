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

const cmd_order = [
  'help',
  'gym', 'ls-gyms', 'add-gym',
  'raid', 'ls-raids', 'spot-egg', 'spot-raid',
  'call-time', //'join', 'unjoin',
];

const cmds = {
  help: {
    perms: Permission.NONE,
    usage: '[request]',
    args: [0, 1],
    desc: 'Learn about our team\'s legendary avatar.',
  },
  gym: {
    perms: Permission.NONE,
    usage: '<handle>',
    args: [1, 1],
    desc: 'Get information about a gym.',
  },
  'ls-gyms': {
    perms: Permission.NONE,
    usage: '<region-name>',
    args: [1, 100],
    desc: 'List all gyms in a region.',
  },
  'add-gym': {
    perms: Permission.TABLE,
    usage: '<handle> <region> <lat> <lng> <name>',
    args: [5, 100],
    desc: 'Add a new gym to the roost.',
  },
  raid: {
    perms: Permission.NONE,
    usage: '<gym-handle>',
    args: [1, 1],
    desc: 'Get information about the current raid at a gym.',
  },
  'ls-raids': {
    perms: Permission.NONE,
    usage: '<region-name>',
    args: [1, 100],
    desc: 'List all active raids in a region.',
  },
  'spot-egg': {
    perms: Permission.NONE,
    usage: '<gym-handle> <tier> <time-til-hatch MM:SS>',
    args: [3, 3],
    desc: 'Announce a raid egg.',
  },
  'spot-raid': {
    perms: Permission.NONE,
    usage: '<gym-handle> <boss> <time-til-despawn MM:SS>',
    args: [3, 3],
    desc: 'Announce a hatched raid boss.',
  },
  'call-time': {
    perms: Permission.NONE,
    usage: '<gym-handle> <HH:MM> [num-accounts]',
    args: [2, 3],
    desc: 'Call a time for a raid.',
  },
  /*
  'join': {
    perms: Permission.NONE,
    usage: '<gym-handle> [HH:MM] [num-accounts]',
    args: [1, 3],
    desc: 'Join a called raid time.',
  },
  'unjoin': {
    perms: Permission.NONE,
    usage: '<gym-handle> [HH:MM] [num-accounts]',
    args: [1, 3],
    desc: 'Back out of a raid.',
  },
  */
};

const unrestricted_cmds = new Set([
  'gym',
]);

const raid_tiers = {
  snorunt: 1,
  swablu: 1,
  wailmer: 1,
  magikarp: 1,

  manectric: 2,
  mawile: 2,
  sableye: 2,
  electabuzz: 2,
  exeggutor: 2,

  piloswine: 3,
  jolteon: 3,
  jynx: 3,
  gengar: 3,
  machamp: 3,

  absol: 4,
  aggron: 4,
  tyranitar: 4,
  golem: 4,

  lugia: 5,
};

///////////////////////////////////////////////////////////////////////////////
// Discord utilities.

/*
 * Avoid polluting the rest of the file with emoji.
 */
const emoji_by_name = {
  no_entry_sign: '🚫',
  no_good: '🙅',
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

  msg.channel.fetchMessage(msg.id)
    .then(m => {
      m.react(emoji)
        .then(r => { chain_reaccs(r.message, ...tail); })
        .catch(console.error);
    })
    .catch(console.error);
}

/*
 * Get a Role by `name' for the guild `msg' belongs to.
 */
function get_role(msg, name) {
  return msg.guild.roles.find('name', name);
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
function log_impl(msg, str, reacc) {
  if (str !== null) {
    let log = moltres.channels.get(config.log_id);
    do_send(log, str);
  }
  if (reacc !== null) {
    msg.react(reacc).catch(console.error);
  }
};

/*
 * Log a successful request, an invalid request, or an internal error.
 */
function log_success(msg, str, reacc = null) {
  log_impl(msg, str, reacc);
};
function react_success(msg, reacc = null) {
  log_impl(msg, null, reacc || get_emoji('approved'));
};
function log_invalid(msg, str, reacc = null) {
  log_impl(msg, str, reacc || emoji_by_name.no_good);
};
function log_error(msg, str, reacc = null) {
  log_impl(msg, str, reacc || emoji_by_name.no_good);
};

/*
 * Get the usage string for `cmd'.
 */
function usage_string(cmd) {
  if (!(cmd in cmds)) return null;
  return `Usage: \`${cmd} ${cmds[cmd].usage}\``;
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

/*
 * Wrapper around send().
 */
function do_send(channel, content) {
  return channel.send(content).catch(console.error);
}

///////////////////////////////////////////////////////////////////////////////
// MySQL utilities.

/*
 * MySQL handler which logs any error, or otherwise delegates to a callback.
 */
function errwrap(fn = null) {
  return function (err, ...rest) {
    if (err) {
      console.error(e);
      return log_error(msg, `MySQL error: ${e.code}.`);
    }
    if (fn !== null) fn(...rest);
  };
}

///////////////////////////////////////////////////////////////////////////////
// Time utilities.

/*
 * Extract the minutes and seconds from a raid countdown timer.
 */
function parse_timer(timer) {
  let matches = timer.match(/^(\d{1,2}):(\d\d)$/);
  if (matches === null) return null;

  return {
    mins: parseInt(matches[1]),
    secs: parseInt(matches[2]),
  };
}

/*
 * Parse a time given by HH:MM as a Date object.
 */
function parse_hour_minute(time) {
  // Re-use parse_timer() even though it thinks in MM:SS.
  let meta = parse_timer(time);
  if (meta === null) return null;

  let now = new Date(Date.now());
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    meta.mins + (now.getHours() - (now.getHours() % 12)),
    meta.secs
  );
}

/*
 * Stringify a Date object according to our whims.
 */
function time_to_string(date) {
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
          '  Please type `$` followed by your request:\n\n';
    for (let cmd of cmd_order) {
      out += `\`${cmd}\`:  ${cmds[cmd].desc}\n`;
    }
  } else {
    let [cmd] = args;
    out = `\`${cmd}\`:  ${cmds[cmd].desc}\n${usage_string(cmd)}`;
  }
  do_send(msg.channel, out.trim());
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
    chain_reaccs(msg, 'no_entry_sign');
    return log_invalid(msg, `No gyms/raids matching ${handle}.`);
  } else if (results.length > 1) {
    return log_invalid(msg, `Multiple gyms/raids matching ${handle}.`);
  }
  return true;
}

/*
 * Stringify a row from the gyms table.
 */
function gym_row_to_string(msg, gym) {
  return `\`[${gym.handle}]\`
name: **${gym.name}**
region: ${msg.guild.roles.get(gym.region).name}
coords: <https://maps.google.com/maps?q=${gym.lat},${gym.lng}>`;
}

function handle_gym(msg, args) {
  let [handle] = args;

  conn.query(
    'SELECT * FROM gyms WHERE handle LIKE ?',
    [`%${handle}%`],

    errwrap(function (results, fields) {
      if (!check_one_gym(msg, handle, results)) return;
      let [gym] = results;

      do_send(msg.channel, gym_row_to_string(msg, gym))
      .then(m => log_success(msg, `Handled \`gym\` from ${msg.author.tag}.`));
    })
  );
}

function handle_ls_gyms(msg, args) {
  let role_name = args.join(' ');
  let role = get_role(msg, role_name);
  if (role === null) {
    return log_invalid(msg, `Invalid region name ${role_name}.`);
  }

  conn.query(
    'SELECT * FROM gyms WHERE region = ?', [role.id],

    errwrap(function (results, fields) {
      if (results.length === 0) {
        return chain_reaccs(msg, 'no_entry_sign');
      }

      let output = `Gyms in **${role_name}**:\n`;
      for (let gym of results) {
        output += `\n\`[${gym.handle}]\` ${gym.name}`;
      }
      do_send(msg.channel, output);
    })
  );
}

function handle_add_gym(msg, args) {
  if (total_mentions(msg) !== 1) {
    return log_invalid(msg, usage_string('add-gym'));
  }
  let [handle, region, lat, lng, ...name] = args;

  if (!region.match(Discord.MessageMentions.ROLES_PATTERN) ||
      msg.mentions.roles.size !== 1) {
    return log_invalid(msg, `Invalid region ${region}.`);
  }
  region = msg.mentions.roles.first().id;

  name = name.join(' ');

  conn.query(
    'INSERT INTO gyms SET ?',
    { handle: handle,
      name: name,
      region: region,
      lat: lat,
      lng: lng, },
    errwrap((..._) => react_success(msg))
  );
}

///////////////////////////////////////////////////////////////////////////////
// Raid handlers.

function handle_raid(msg, args) {
  let [handle] = args;

  let now = new Date(Date.now());

  conn.query(
    'SELECT * FROM gyms ' +
    '   INNER JOIN raids ON gyms.id = raids.gym_id ' +
    '   LEFT JOIN calls ON raids.gym_id = calls.raid_id ' +
    '   WHERE gyms.handle LIKE ? ' +
    '   AND calls.time > ?',
    [`%${handle}%`, now],

    errwrap(function (results, fields) {
      if (results.length < 1) {
        chain_reaccs(msg, 'no_entry_sign');
        return log_invalid(msg, `No gyms/raids matching ${handle}.`);
      }
      let [raid] = results;

      if (raid.despawn < now) {
        conn.query(
          'DELETE FROM raids WHERE gym_id = ?',
          [raid.gym_id],
          errwrap()
        );
        return chain_reaccs(msg, 'no_entry_sign', 'RaidEgg');
      }

      let hatch = hatch_from_despawn(raid.despawn);

      let output = gym_row_to_string(msg, raid) + '\n';

      if (now >= hatch) {
        output +=`
raid: **${fmt_boss(raid.boss)}** (T${raid.tier})
despawn: ${time_to_string(raid.despawn)}`;
      } else {
        output +=`
raid egg: **T${raid.tier}**
hatch: ${time_to_string(hatch)}`;
      }

      output += '\ncall times:';

      // Now grab all the existing raid calls.
      for (let call of results) {
        let member = msg.guild.members.get(call.caller);
        output +=
          `\n  - ${time_to_string(call.time)} ` +
          `with ${member ? member.user.tag : 'unknown'}`;
      }

      do_send(msg.channel, output)
      .then(m => log_success(msg, `Handled \`raid\` from ${msg.author.tag}.`));
    })
  );
}

function handle_ls_raids(msg, args) {
  let role_name = args.join(' ');
  let role = get_role(msg, role_name);
  if (role === null) {
    return log_invalid(msg, `Invalid region name ${role_name}.`);
  }

  let now = new Date(Date.now());

  conn.query(
    'SELECT * FROM gyms INNER JOIN raids ' +
    'ON gyms.id = raids.gym_id ' +
    'WHERE gyms.region = ? AND raids.despawn > ?',
    [role.id, now],

    errwrap(function (results, fields) {
      if (results.length === 0) {
        return chain_reaccs(msg, 'no_entry_sign', 'RaidEgg');
      }

      let output = `Active raids in **${role_name}**:\n`;
      for (let raid of results) {
        let hatch = hatch_from_despawn(raid.despawn);
        let boss = hatch > now ? 'egg' : fmt_boss(raid.boss);
        let timer_str = hatch > now
          ? `hatches at ${time_to_string(hatch)}`
          : `despawns at ${time_to_string(raid.despawn)}`

        output +=
          `\n\`[${raid.handle}]\` **T${raid.tier} ${boss}** ${timer_str}`;
      }
      do_send(msg.channel, output);
    })
  );
}

function handle_spot(msg, handle, tier, boss, timer) {
  timer = parse_timer(timer);
  if (timer === null) {
    return log_invalid(msg, `Invalid timer ${timer}.`);
  }

  let egg_adjust = boss === null ? 45 : 0;

  let despawn = new Date(Date.now());
  despawn.setMinutes(despawn.getMinutes() + timer.mins + egg_adjust);
  despawn.setSeconds(despawn.getSeconds() + timer.secs);

  let pop = pop_from_despawn(despawn);

  conn.query(
    'REPLACE INTO raids (gym_id, tier, boss, despawn, spotter) ' +
    '   SELECT gyms.id, ?, ?, ?, ? FROM gyms ' +
    '   WHERE ' +
    '     gyms.handle LIKE ? ' +
    '   AND ' +
    '     NOT EXISTS ( ' +
    '       SELECT * FROM raids ' +
    '         WHERE gym_id = gyms.id ' +
    '         AND despawn > ? ' +
    '     ) ',
    [tier, boss, despawn, msg.author.id, `%${handle}%`, pop],
    errwrap((..._) => react_success(msg))
  );
}

function handle_spot_egg(msg, args) {
  let [handle, tier, timer] = args;

  if (tier.startsWith('T')) tier = tier.substr(1);

  handle_spot(msg, handle, tier, null, timer);
}

function handle_spot_raid(msg, args) {
  let [handle, boss, timer] = args;
  boss = boss.toLowerCase();

  if (!(boss in raid_tiers)) {
    return log_invalid(msg, `Unrecognized raid boss ${boss}.`);
  }

  handle_spot(msg, handle, raid_tiers[boss], boss, timer);
}

///////////////////////////////////////////////////////////////////////////////
// Raid calls.

function handle_call_time(msg, args) {
  let [handle, time, naccts] = args;

  let call_time = parse_hour_minute(time);
  if (call_time === null) {
    return log_invalid(msg, `Unrecognized HH:MM time ${time}.`);
  }
  naccts = naccts || 1;

  let later = new Date(call_time.getTime());
  later.setMinutes(later.getMinutes() + 45);

  conn.query(
    'INSERT INTO calls (raid_id, caller, time) ' +
    '   SELECT raids.gym_id, ?, ? FROM gyms INNER JOIN raids ' +
    '     ON gyms.id = raids.gym_id ' +
    '   WHERE gyms.handle LIKE ? ' +
    '   AND raids.despawn > ? ' +
    '   AND raids.despawn <= ?',
    [msg.author.id, call_time, `%${handle}%`, call_time, later],

    errwrap(function (result) {
      let call_id = result.insertId;

      conn.query(
        'INSERT INTO rsvps SET ?',
        { call_id: call_id,
          user_id: msg.author.id,
          accounts: naccts,
          maybe: false },
        errwrap()
      );

      conn.query(
        'SELECT * FROM gyms INNER JOIN raids ON gyms.id = raids.gym_id ' +
        '   WHERE handle LIKE ?',
        [`%${handle}%`],

        errwrap(function (results, fields) {
          if (!check_one_gym(msg, handle, results)) return;
          let [raid] = results;

          let role = msg.guild.roles.get(raid.region);
          if (role === null) {
            return log_invalid(msg, `Malformed gym entry for ${raid.handle}.`);
          }

          let role_str = raid.silent ? role.name : role.toString();
          let boss_str = later > raid.despawn
            ? `${fmt_boss(raid.boss)} raid`
            : 'egg';

          let output =
            `${role_str} **T${raid.tier} ${boss_str}** ` +
            `at \`[${raid.handle}]\` ` +
            `called for ${time_to_string(call_time)} by ${msg.author}`;
          do_send(msg.channel, output);
        })
      );
    })
  );
}

function handle_join(msg, args) {
}

function handle_unjoin(msg, args) {
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Do the work of `request'.
 */
function handle_request(msg, request, args) {
  let params_range = cmds[request].args;

  if (args.length < params_range[0] || args.length > params_range[1]) {
    return log_invalid(msg, usage_string(request));
  }

  switch (request) {
    case 'help':      return handle_help(msg, args);

    case 'gym':       return handle_gym(msg, args);
    case 'ls-gyms':   return handle_ls_gyms(msg, args);
    case 'add-gym':   return handle_add_gym(msg, args);

    case 'raid':      return handle_raid(msg, args);
    case 'ls-raids':  return handle_ls_raids(msg, args);
    case 'spot-egg':  return handle_spot_egg(msg, args);
    case 'spot-raid': return handle_spot_raid(msg, args);

    case 'call-time': return handle_call_time(msg, args);
    case 'join':      return handle_join(msg, args);
    case 'unjoin':    return handle_unjoin(msg, args);
    default:
      return log_invalid(msg, `Invalid request ${request}.`);
  }
}

/*
 * Check whether the user who sent `msg' has the proper permissions to make
 * `request', and make it if so.
 */
function handle_request_with_check(msg, request, args) {
  let user_id = msg.author.id;

  if (!(request in cmds)) return;

  if (config.admin_ids.has(user_id) ||
      cmds[request].perms === Permission.NONE) {
    return handle_request(msg, request, args);
  }

  conn.query(
    'SELECT * FROM permissions WHERE (cmd = ? AND user_id = ?)',
    [request, user_id],

    errwrap(function (results, fields) {
      if (results.length === 1) {
        return handle_request(msg, request, args);
      }

      return log_invalid(
        msg,
        `User ${msg.author.tag} does not have permissions for ${request}.`,
        get_emoji('dealwithit')
      );
    })
  );
}

/*
 * Process a user request.
 */
function process_request(msg) {
  if (msg.content.charAt(0) !== '$') return;
  let [request, ...rest] = msg.content.substr(1).split(' ');

  handle_request_with_check(msg, request, rest);
}

///////////////////////////////////////////////////////////////////////////////

/*
 * Main reader event.
 */
moltres.on('message', msg => {
  if (config.channels.has(msg.channel.id)) {
    try {
      process_request(msg);
    } catch (e) {
      console.error(e);
    }
  }
});

moltres.login(config.moltres);
