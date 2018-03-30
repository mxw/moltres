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
  'gym', 'add-gym',
  'raid', 'spot-egg', 'spot-raid',
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
  'spot-egg': {
    perms: Permission.NONE,
    usage: '<gym-handle> <tier> <MM:SS-til-hatch>',
    args: [3, 3],
    desc: 'Announce a raid egg.'
  },
  'spot-raid': {
    perms: Permission.NONE,
    usage: '<gym-handle> <boss> <MM:SS-til-despawn>',
    args: [3, 3],
    desc: 'Announce a hatched raid boss.'
  },
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
  no_good: '🙅',
  no_entry_sign: '🚫',
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

  msg.react(emoji)
  .then(r => { chain_reaccs(r.message, ...tail); })
  .catch(console.error);
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
    log.send(str);
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

///////////////////////////////////////////////////////////////////////////////
// MySQL utilities.

/*
 * MySQL handler which logs any error, or otherwise delegates to a callback.
 */
function errwrap(fn = null) {
  return function (err, results, fields) {
    if (err) {
      console.error(e);
      return log_error(msg, `MySQL error: ${e.code}.`);
    }
    if (fn !== null) fn(results, fields);
  };
}

///////////////////////////////////////////////////////////////////////////////
// General handlers.

function handle_help(msg, args) {
  let out = null;

  if (args.length === 0) {
    out = get_emoji('valor') +
          '  Please type `:>` followed by your request:\n\n';
    for (let cmd of cmd_order) {
      out += `\`${cmd}\`:  ${cmds[cmd].desc}\n`;
    }
  } else {
    let [cmd] = args;
    out = `\`${cmd}\`:  ${cmds[cmd].desc}\n${usage_string(cmd)}`;
  }
  msg.channel.send(out.trim());
}

///////////////////////////////////////////////////////////////////////////////
// Gym handlers.

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
      if (results.length !== 1) {
        return log_invalid(msg, `Multiple gyms matching ${handle}.`);
      }
      let [gym] = results;

      msg.channel.send(gym_row_to_string(msg, gym)).then(m => {
        log_success(msg, `Handled \`gym\` from ${msg.author.tag}.`);
      }).catch(console.error);
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

function handle_edit_gym(msg, args) {
  return false;
}

function handle_rm_gym(msg, args) {
  return false;
}

///////////////////////////////////////////////////////////////////////////////
// Raid handlers.

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

function handle_raid(msg, args) {
  let [handle] = args;

  conn.query(
    'SELECT * FROM gyms INNER JOIN raids ON gyms.id = raids.gym_id ' +
    'WHERE handle LIKE ?',
    [`%${handle}%`],

    errwrap(function (results, fields) {
      if (results.length !== 1) {
        chain_reaccs(msg, 'no_entry_sign', 'RaidEgg');
      }
      let [raid] = results;

      let now = new Date(Date.now());

      if (raid.despawn < now) {
        console.log('yo');
        conn.query(
          'DELETE FROM raids WHERE gym_id = ?',
          [raid.gym_id],
          errwrap()
        );
        return chain_reaccs(msg, 'no_entry_sign', 'RaidEgg');
      }

      let hatch = new Date(raid.despawn.getTime());
      hatch.setMinutes(hatch.getMinutes() - 45);

      let output = gym_row_to_string(msg, raid) + '\n';

      if (now >= hatch) {
        output +=`
raid: ${raid.boss === null ? 'unknown' : raid.boss} (T${raid.tier})
despawn: ${time_to_string(raid.despawn)}`;
      } else {
        output +=`
raid egg: T${raid.tier}
hatch: ${time_to_string(hatch)}`;
      }

      msg.channel.send(output).then(m => {
        log_success(msg, `Handled \`raid\` from ${msg.author.tag}.`);
      }).catch(console.error);
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

  let pop = new Date(despawn.getTime());
  pop.setMinutes(pop.getMinutes() - 60 - 45);

  let foo = conn.query(
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
  console.log(foo.sql);
}

function handle_spot_egg(msg, args) {
  let [handle, tier, timer] = args;

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
    case 'add-gym':   return handle_add_gym(msg, args);
    case 'edit-gym':  return handle_edit_gym(msg, args);
    case 'rm-gym':    return handle_rm_gym(msg, args);

    case 'raid':      return handle_raid(msg, args);
    case 'spot-egg':  return handle_spot_egg(msg, args);
    case 'spot-raid': return handle_spot_raid(msg, args);
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
  let [prefix, request, ...rest] = msg.content.split(' ');

  if (prefix !== ':>') return;

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
